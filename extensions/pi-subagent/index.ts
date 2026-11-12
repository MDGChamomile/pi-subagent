import { chmod, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum, type Usage } from "@earendil-works/pi-ai";
import { Text, TruncatedText, truncateToWidth } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
  MAX_SCOPE_PATH_LENGTH,
  MAX_SCOPE_ROOTS,
  PRESET_NAMES,
  runtimeFilesIn,
  sanitizeDisplayText,
  singleLineDisplayText,
  TOOL_NAME,
  type Capability,
  type ChildPolicy,
  type PartialReason,
  type Preset,
  type ResultStatus,
  type Thinking,
} from "./shared.ts";
import { buildChildPolicy, makeCanonicalTempDirectory } from "./path-policy.ts";
import { resolveWebExtensionPath } from "./web-provenance.ts";
import { invocationLimitBlock, MAX_SUBAGENT_CALLS, ModelInvocationGate } from "./invocation-gate.ts";
import { boundedParentError } from "./diagnostics.ts";
import { formatResultSummary } from "./call-display.ts";
import { runChild } from "./subprocess.ts";
import { ChildRunError } from "./child-result.ts";
import { loadPresetSettings, validatePresetSelection, type PresetSelection } from "./config.ts";
import { registerSubagentSettingsCommand } from "./settings-command.ts";

const PresetSchema = StringEnum(PRESET_NAMES, {
  description: "Child model preset: lookup-standard for fact-finding, analysis-standard for synthesis, or review-standard for adversarial review",
});
const CapabilitySchema = StringEnum(["local", "web"] as const, {
  description: "local=files only, web=web research tools only (not a credential-isolated sandbox); use separate calls if both investigations are delegated",
});
const Parameters = Type.Object({
  task: Type.String({ minLength: 1, maxLength: 12_000, description: "One focused local or web investigation and required deliverable" }),
  scope: Type.Array(Type.String({ minLength: 1, maxLength: MAX_SCOPE_PATH_LENGTH }), {
    minItems: 0,
    maxItems: MAX_SCOPE_ROOTS,
    description: "Existing local files/directories inside cwd; use [] for web-only research",
  }),
  capability: CapabilitySchema,
  preset: PresetSchema,
}, { additionalProperties: false });

type SubagentDetails = {
  capability: Capability;
  preset: Preset;
  model: string;
  thinking: Thinking;
  scopeRoots: number;
  webEnabled: boolean;
  status: ResultStatus;
  partialReason?: PartialReason;
  toolCallsAttempted: number;
  toolCallsExecuted: number;
  deniedCalls: number;
  queryCount: number;
  fetchTargetCount: number;
  softLimitReached: boolean;
  hardLimitReached: boolean;
  durationMs: number;
  exitCode: number;
  stopReason?: string;
  outputTruncated: boolean;
  contextTokens: number;
  usage: Usage;
};

type ExtensionRuntime = { runChild: typeof runChild; removeTempDirectory: typeof rm };

type PreparedRun = {
  capability: Capability;
  preset: Preset;
  model: string;
  thinking: Thinking;
  webExtensionPath: string | undefined;
  policy: ChildPolicy;
};

async function runInTempDirectory(
  runtime: ExtensionRuntime,
  run: PreparedRun & Pick<Parameters<typeof runChild>[0], "task" | "signal" | "onUpdate">,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: SubagentDetails; usage: Usage }> {
  const { capability, preset, model, thinking, webExtensionPath, policy } = run;
  let tempDir: string;
  try {
    tempDir = await makeCanonicalTempDirectory(join(tmpdir(), "pi-subagent-"));
  } catch (error) {
    throw new Error(boundedParentError(error, { phase: "setup" }));
  }
  let executionError: unknown;
  let completedUsage: ChildRunError["usage"] | undefined;
  let childStarted = false;
  try {
    await chmod(tempDir, 0o700);
    const files = runtimeFilesIn(tempDir);
    await writeFile(files.policy, JSON.stringify(policy), { encoding: "utf8", mode: 0o600, flag: "wx" });
    childStarted = true;
    const result = await runtime.runChild({
      policy,
      files,
      webExtensionPath,
      task: run.task,
      model,
      thinking,
      signal: run.signal,
      onUpdate: run.onUpdate,
    });
    completedUsage = result.usage;
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
        partialReason: result.partialReason,
        toolCallsAttempted: result.budget.toolCallsAttempted,
        toolCallsExecuted: result.budget.toolCallsExecuted,
        deniedCalls: result.budget.deniedCalls,
        queryCount: result.budget.queryCount,
        fetchTargetCount: result.budget.fetchTargetCount,
        softLimitReached: result.budget.softLimitReached,
        hardLimitReached: result.budget.hardLimitReached,
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
      await runtime.removeTempDirectory(tempDir, { recursive: true, force: true });
    } catch (cleanupError) {
      if (executionError === undefined) {
        const message = boundedParentError(cleanupError, { phase: "cleanup" });
        throw completedUsage ? new ChildRunError(message, completedUsage) : new Error(message);
      }
    }
  }
}

export default function piSubagentExtension(
  pi: ExtensionAPI,
  runtime: ExtensionRuntime = { runChild, removeTempDirectory: rm },
): void {
  registerSubagentSettingsCommand(pi);
  const gate = new ModelInvocationGate();
  // Pi turns thrown tool errors into fresh results; reattach the child's nested usage in tool_result.
  const failedUsage = new Map<string, ChildRunError["usage"]>();

  const clearRun = () => {
    gate.endRun();
    failedUsage.clear();
  };
  const preflight = async (
    toolCallId: string,
    params: Static<typeof Parameters>,
    ctx: Pick<ExtensionContext, "cwd" | "modelRegistry">,
  ): Promise<PreparedRun> => {
    if (!gate.start(toolCallId)) {
      throw new Error(boundedParentError(
        `pi_subagent allows at most ${MAX_SUBAGENT_CALLS} model-selected calls per parent agent run`,
        { phase: "preflight" },
      ));
    }
    const capability = params.capability as Capability;
    const preset = params.preset as Preset;
    let selection: PresetSelection;
    let webExtensionPath: string | undefined;
    let policy: ChildPolicy;
    try {
      if (params.task.includes("\0")) throw new Error("task must not contain NUL bytes");
      selection = (await loadPresetSettings())[preset];
      validatePresetSelection(selection, ctx.modelRegistry);
      if (capability === "web") webExtensionPath = await resolveWebExtensionPath(pi.getAllTools());
      policy = await buildChildPolicy(ctx.cwd, params.scope, capability);
    } catch (error) {
      throw new Error(boundedParentError(error, { phase: "preflight" }));
    }
    const { model, thinking } = selection;
    return { capability, preset, model, thinking, webExtensionPath, policy };
  };

  pi.registerTool({
    name: TOOL_NAME,
    label: "Pi Subagent",
    executionMode: "parallel",
    description: "Run one bounded investigation in an isolated child context. Use one by default and up to three parallel calls only for distinct, independent research tracks; use the parent for simple lookups, implementation, or tests.",
    parameters: Parameters,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      try {
        const prepared = await preflight(toolCallId, params, ctx);
        return await runInTempDirectory(runtime, { ...prepared, task: params.task, signal, onUpdate });
      } catch (error) {
        if (error instanceof ChildRunError) failedUsage.set(toolCallId, error.usage);
        throw new Error(boundedParentError(error));
      }
    },
    renderCall(args, theme, { expanded }) {
      const title = theme.fg("toolTitle", theme.bold(TOOL_NAME));
      if (expanded) {
        const inputs = Object.entries(args ?? {}).map(([key, value]) =>
          theme.fg("muted", sanitizeDisplayText(`${key}: ${JSON.stringify(value)}`)));
        return new Text([title, ...inputs].join("\n"), 0, 0);
      }
      const task = typeof args?.task === "string"
        ? singleLineDisplayText(args.task).trim()
        : "";
      const preview = truncateToWidth(task, 100);
      return new TruncatedText(title + (preview ? ` ${theme.fg("accent", preview)}` : ""), 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      const text = result.content.find((part) => part.type === "text");
      const output = text?.type === "text" ? text.text : "";
      if (isPartial) return new Text(theme.fg("muted", output), 0, 0);

      const details = result.details as Partial<SubagentDetails> | undefined;
      if (!details?.status || details.durationMs === undefined || details.contextTokens === undefined) {
        return new Text(output, 0, 0);
      }

      const summary = formatResultSummary(details.status, details.durationMs, details.contextTokens);
      const styled = theme.fg(details.status === "partial" ? "warning" : "success", summary)
        + (details.outputTruncated ? theme.fg("warning", " · Output truncated") : "");
      return new Text(expanded && output ? `${styled}\n\n${output}` : styled, 0, 0);
    },
  });

  pi.on("session_start", clearRun);
  pi.on("agent_start", () => {
    failedUsage.clear();
    gate.startRun();
  });
  pi.on("tool_call", (event) => {
    if (event.toolName !== TOOL_NAME) return;
    if (!gate.authorize(event.toolCallId)) return invocationLimitBlock();
  });
  pi.on("tool_result", (event) => {
    if (event.toolName !== TOOL_NAME) return;
    const usage = failedUsage.get(event.toolCallId);
    failedUsage.delete(event.toolCallId);
    if (usage) return { usage };
  });
  pi.on("tool_execution_end", (event) => {
    if (event.toolName !== TOOL_NAME) return;
    gate.releaseUnstarted(event.toolCallId);
  });
  pi.on("agent_settled", clearRun);
  pi.on("session_shutdown", clearRun);
}
