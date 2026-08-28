import { chmod, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  boundedParentError,
  buildChildPolicy,
  MAX_SCOPE_ROOTS,
  invocationLimitBlock,
  makeCanonicalTempDirectory,
  MAX_SUBAGENT_CALLS,
  ModelInvocationGate,
  normalizePreset,
  PRESET_NAMES,
  resolveWebExtensionPath,
  SUBAGENT_PRESETS,
  TOOL_NAME,
  type Capability,
  type ChildPolicy,
  type Preset,
} from "./shared.ts";
import { ChildRunError, formatResultSummary, runChild } from "./subprocess.ts";

const PresetSchema = StringEnum(PRESET_NAMES, {
  description: "Child model preset: lookup-standard for fact-finding, analysis-standard for synthesis, or review-standard for adversarial review",
});
const CapabilitySchema = StringEnum(["local", "web"] as const, {
  description: "local=files only, web=web research tools only (not a credential-isolated sandbox); use separate calls when both sources are needed",
});
const Parameters = Type.Object({
  task: Type.String({ minLength: 1, maxLength: 12_000, description: "One focused local or web investigation and required deliverable" }),
  scope: Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), {
    minItems: 0,
    maxItems: MAX_SCOPE_ROOTS,
    description: "Existing local files/directories inside cwd; use [] for web-only research",
  }),
  capability: CapabilitySchema,
  preset: PresetSchema,
}, { additionalProperties: false });

export default function piSubagentExtension(pi: ExtensionAPI): void {
  const gate = new ModelInvocationGate();
  const authorizedCalls = new Set<string>();
  // Pi turns thrown tool errors into fresh results; reattach the child's nested usage in tool_result.
  const failedUsage = new Map<string, ChildRunError["usage"]>();
  let ownSourcePath: string | undefined;

  const currentOwnSource = () => pi.getAllTools().find((tool) => tool.name === TOOL_NAME)?.sourceInfo?.path;
  const clearRun = () => {
    gate.endRun();
    authorizedCalls.clear();
    failedUsage.clear();
  };

  pi.registerTool({
    name: TOOL_NAME,
    label: "Pi Subagent",
    executionMode: "parallel",
    description: "Run one bounded investigation in an isolated child context. Use one by default and up to three parallel calls only for distinct, independent research tracks; use the parent for simple lookups, implementation, or tests.",
    parameters: Parameters,
    prepareArguments(args) {
      if (!args || typeof args !== "object") return args;
      const input = args as Record<string, unknown>;
      const preset = normalizePreset(input.preset, input.profile);
      if (!preset) return args;
      const { profile: _profile, thinking: _thinking, preset: _preset, ...rest } = input;
      return { ...rest, preset };
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      try {
        const currentSource = currentOwnSource();
        if (!authorizedCalls.delete(toolCallId) || !ownSourcePath || currentSource !== ownSourcePath) {
          throw new Error(boundedParentError(
            `pi_subagent allows at most ${MAX_SUBAGENT_CALLS} model-selected calls per parent agent run`,
            { phase: "preflight" },
          ));
        }
        const capability = params.capability as Capability;
        const preset = params.preset as Preset;
        const { model, thinking } = SUBAGENT_PRESETS[preset];
        let webExtensionPath: string | undefined;
        let policy: ChildPolicy;
        try {
          if (params.task.includes("\0")) throw new Error("task must not contain NUL bytes");
          const [provider, modelId] = model.split("/", 2);
          if (!ctx.modelRegistry.find(provider!, modelId!)) throw new Error(`Configured subagent model is unavailable: ${model}`);
          if (capability === "web") webExtensionPath = await resolveWebExtensionPath(pi.getAllTools());
          policy = await buildChildPolicy(ctx.cwd, params.scope, capability);
        } catch (error) {
          gate.rejectPreflight(toolCallId);
          throw new Error(boundedParentError(error, { phase: "preflight" }));
        }
        if (!gate.commit(toolCallId)) {
          throw new Error(boundedParentError("pi_subagent invocation permit is invalid or already consumed", { phase: "preflight" }));
        }

        let tempDir: string;
        try {
          tempDir = await makeCanonicalTempDirectory(join(tmpdir(), "pi-subagent-"));
        } catch (error) {
          throw new Error(boundedParentError(error, { phase: "setup" }));
        }
        let executionError: unknown;
        let childStarted = false;
        try {
          await chmod(tempDir, 0o700);
          const policyFile = join(tempDir, "policy.json");
          const readyFile = join(tempDir, "guard.ready");
          await writeFile(policyFile, JSON.stringify(policy), { encoding: "utf8", mode: 0o600, flag: "wx" });
          childStarted = true;
          const result = await runChild({
            policy,
            policyFile,
            readyFile,
            webExtensionPath,
            task: params.task,
            model,
            thinking,
            signal,
            onUpdate,
          });
          return {
            content: [{ type: "text", text: result.output }],
            details: {
              capability,
              preset,
              model,
              thinking,
              scopeRoots: policy.roots.length,
              webEnabled: capability === "web",
              status: result.status,
              durationMs: result.durationMs,
              exitCode: result.exitCode,
              stopReason: result.stopReason,
              outputTruncated: result.outputTruncated,
              contextTokens: result.contextTokens,
              usage: result.usage,
            },
            usage: result.usage,
          };
        } catch (error) {
          executionError = error;
          if (!childStarted) throw new Error(boundedParentError(error, { phase: "setup" }));
          throw error;
        } finally {
          try {
            await rm(tempDir, { recursive: true, force: true });
          } catch (cleanupError) {
            if (executionError === undefined) {
              throw new Error(boundedParentError(cleanupError, { phase: "cleanup" }));
            }
          }
        }
      } catch (error) {
        if (error instanceof ChildRunError) failedUsage.set(toolCallId, error.usage);
        throw new Error(boundedParentError(error));
      }
    },
    renderResult(result, { expanded, isPartial }, theme) {
      const text = result.content.find((part) => part.type === "text");
      const output = text?.type === "text" ? text.text : "";
      if (isPartial) return new Text(theme.fg("muted", output), 0, 0);

      const details = result.details as {
        status?: "complete" | "partial";
        durationMs?: number;
        contextTokens?: number;
      } | undefined;
      if (!details?.status || details.durationMs === undefined || details.contextTokens === undefined) {
        return new Text(output, 0, 0);
      }

      const summary = formatResultSummary(details.status, details.durationMs, details.contextTokens);
      const styled = theme.fg(details.status === "partial" ? "warning" : "success", summary);
      return new Text(expanded && output ? `${styled}\n\n${output}` : styled, 0, 0);
    },
  });

  pi.on("session_start", () => {
    ownSourcePath = currentOwnSource();
    clearRun();
  });
  pi.on("agent_start", () => {
    authorizedCalls.clear();
    failedUsage.clear();
    gate.startRun();
  });
  pi.on("tool_call", (event) => {
    if (event.toolName !== TOOL_NAME) return;
    const currentSource = currentOwnSource();
    if (!ownSourcePath || currentSource !== ownSourcePath || !gate.authorize(event.toolCallId)) {
      return invocationLimitBlock();
    }
    authorizedCalls.add(event.toolCallId);
  });
  pi.on("tool_result", (event) => {
    if (event.toolName !== TOOL_NAME) return;
    const usage = failedUsage.get(event.toolCallId);
    failedUsage.delete(event.toolCallId);
    if (usage) return { usage };
  });
  pi.on("tool_execution_end", (event) => {
    if (event.toolName !== TOOL_NAME) return;
    authorizedCalls.delete(event.toolCallId);
    gate.releaseUnstarted(event.toolCallId);
  });
  pi.on("agent_settled", clearRun);
  pi.on("session_shutdown", clearRun);
}
