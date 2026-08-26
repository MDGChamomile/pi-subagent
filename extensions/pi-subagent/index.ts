import { chmod, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  boundedParentError,
  buildChildPolicy,
  MAX_SCOPE_ROOTS,
  invocationLimitBlock,
  legacyPreset,
  makeCanonicalTempDirectory,
  MAX_SUBAGENT_CALLS,
  ModelInvocationGate,
  PRESET_NAMES,
  resolveWebExtensionPath,
  SUBAGENT_PRESETS,
  TOOL_NAME,
  type Capability,
  type ChildPolicy,
  type Preset,
} from "./shared.ts";
import { runChild } from "./subprocess.ts";

const PresetSchema = StringEnum(PRESET_NAMES, {
  description: "Validated child model+thinking preset: lookup=luna, analysis=terra, review=sol; standard/balanced/deep/exhaustive select thinking depth",
});
const CapabilitySchema = StringEnum(["local", "web", "both"] as const, {
  description: "local=files only, web=public web only, both=files and public web",
});
const Parameters = Type.Object({
  task: Type.String({ minLength: 1, maxLength: 12_000, description: "One focused local and/or web investigation and required deliverable" }),
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
  let ownSourcePath: string | undefined;

  const currentOwnSource = () => pi.getAllTools().find((tool) => tool.name === TOOL_NAME)?.sourceInfo?.path;
  const clearRun = () => {
    gate.endRun();
    authorizedCalls.clear();
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
      if (typeof input.preset === "string") return args;
      const preset = legacyPreset(input.profile, input.thinking);
      if (!preset) return args;
      const { profile: _profile, thinking: _thinking, ...rest } = input;
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
          if (capability !== "local") webExtensionPath = await resolveWebExtensionPath(pi.getAllTools());
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
              webEnabled: capability !== "local",
              durationMs: result.durationMs,
              exitCode: result.exitCode,
              stopReason: result.stopReason,
              outputTruncated: result.outputTruncated,
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
        throw new Error(boundedParentError(error));
      }
    },
  });

  pi.on("session_start", () => {
    ownSourcePath = currentOwnSource();
    clearRun();
  });
  pi.on("agent_start", () => {
    authorizedCalls.clear();
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
  pi.on("agent_settled", clearRun);
  pi.on("session_shutdown", clearRun);
}
