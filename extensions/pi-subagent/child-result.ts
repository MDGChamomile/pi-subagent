import { readFile } from "node:fs/promises";
import type { Usage } from "@earendil-works/pi-ai";
import { readBudgetTelemetry, type BudgetTelemetry } from "./budget-telemetry.ts";
import { estimateContextTokens } from "./call-display.ts";
import type { ChildJsonSnapshot } from "./child-stream.ts";
import { boundedParentError } from "./diagnostics.ts";
import { formatChildOutput } from "./envelope.ts";
import {
  CHILD_GUARD_EXIT_CODES, CHILD_TIMEOUT_MS, READY_MARKER,
  type PartialReason, type ResultStatus, type RuntimeFiles,
  type SubagentFailureDiagnostics, type SubagentFailurePhase,
} from "./shared.ts";

export type ChildResult = {
  /** Parent-visible JSON envelope with runtime status and an untrusted answer string. */
  output: string;
  outputTruncated: boolean;
  status: ResultStatus;
  exitCode: number;
  stopReason?: string;
  durationMs: number;
  contextTokens: number;
  usage: Usage;
  budget: BudgetTelemetry;
  partialReason?: PartialReason;
};

export class ChildRunError extends Error {
  readonly usage: Usage;

  constructor(message: string, usage: Usage) {
    super(message);
    this.name = "ChildRunError";
    this.usage = usage;
  }
}

type FinishedChild = {
  snapshot: ChildJsonSnapshot;
  files: RuntimeFiles;
  startedAt: number;
  completedAt: number;
  softDeadline: number;
  exitCode: number;
  exitSignal?: NodeJS.Signals;
  progressFailed: boolean;
  aborted: boolean;
  timedOut: boolean;
  effectiveTimeoutMs: number;
  waitError: unknown;
};

function classifyChildInterruption(input: FinishedChild): { message: unknown; phase: SubagentFailurePhase; exitCode?: number } | undefined {
  if (input.progressFailed) return { message: "Subagent stopped because progress reporting failed", phase: "progress" };
  if (input.aborted) return { message: "Subagent invocation was cancelled", phase: "cancelled" };
  if (input.timedOut) return {
    message: input.effectiveTimeoutMs === CHILD_TIMEOUT_MS
      ? `Subagent timed out after ${CHILD_TIMEOUT_MS / 60_000} minutes`
      : `Subagent timed out after ${input.effectiveTimeoutMs} milliseconds`,
    phase: "timeout",
  };
  if (input.waitError) return { message: input.waitError, phase: "spawn" };
  if (input.snapshot.protocolError) return { message: input.snapshot.protocolError, phase: "protocol", exitCode: input.exitCode };
  return undefined;
}

function describeChildExit(
  exitCode: number,
  exitSignal: NodeJS.Signals | undefined,
  guardReady: boolean,
  snapshot: ChildJsonSnapshot,
): string {
  const guardFailure = Object.entries(CHILD_GUARD_EXIT_CODES).find(([, code]) => code === exitCode)?.[0];
  let message = exitSignal ? `Subagent exited with signal ${exitSignal}`
    : guardFailure ? `Subagent guard failed: ${guardFailure}` : `Subagent exited with code ${exitCode}`;
  if (guardReady && !exitSignal && !guardFailure
    && snapshot.assistantMessageCount === 0 && snapshot.toolErrorCount === 0
    && !snapshot.observations.incomplete
    && Object.values(snapshot.observations.receipts).every((count) => count === 0)) {
    // Missing stream activity does not prove an authentication failure.
    message += ". No investigation activity was observed; the cause is unknown. Check the selected preset's provider authentication and model access, or review /pi-subagent-settings.";
  }
  return message;
}

export async function assertChildReady(readyFile: string): Promise<void> {
  let marker: string;
  try {
    marker = await readFile(readyFile, "utf8");
  } catch {
    throw new Error("Subagent guard did not become ready");
  }
  if (marker !== READY_MARKER) throw new Error("Subagent guard readiness marker is invalid");
}

/**
 * Precedence is model_length > tool_budget > time_limit. Decide only after process-group
 * cleanup: time_limit uses the parent's answer receipt time, else the post-cleanup time.
 */
export function selectPartialReason(input: {
  stopReason: string | undefined;
  hardLimitReached: boolean;
  finalOutputReceivedAt: number | undefined;
  completedAt: number;
  softDeadline: number;
}): PartialReason | undefined {
  if (input.stopReason === "length") return "model_length";
  if (input.hardLimitReached) return "tool_budget";
  if ((input.finalOutputReceivedAt ?? input.completedAt) >= input.softDeadline) return "time_limit";
  return undefined;
}

export async function finishChildRun(run: FinishedChild): Promise<ChildResult> {
  const { snapshot, files, startedAt, completedAt, softDeadline, exitCode, exitSignal } = run;
  const childFailure = (
    error: unknown,
    phase: SubagentFailurePhase,
    failureExitCode?: number,
    processDiagnostics: Pick<SubagentFailureDiagnostics, "guardReady" | "exitSignal"> = {},
  ): ChildRunError => {
    const diagnostics: SubagentFailureDiagnostics = {
      phase,
      exitCode: failureExitCode,
      ...processDiagnostics,
      stopReason: snapshot.stopReason,
      durationMs: Date.now() - startedAt,
      assistantMessages: snapshot.assistantMessageCount,
      lastAssistantMode: snapshot.lastAssistantMode,
      toolErrors: snapshot.toolErrorCount,
      lastToolError: snapshot.lastToolError,
      observations: snapshot.observations,
    };
    return new ChildRunError(boundedParentError(error, diagnostics), snapshot.usage);
  };
  const interruption = classifyChildInterruption(run);
  if (interruption) throw childFailure(interruption.message, interruption.phase, interruption.exitCode);
  if (exitCode !== 0) {
    // Readiness is an observation, not a diagnosis of why startup failed.
    const guardReady = await assertChildReady(files.ready).then(() => true, () => false);
    throw childFailure(
      describeChildExit(exitCode, exitSignal, guardReady, snapshot),
      "process",
      exitSignal ? undefined : exitCode,
      { guardReady, exitSignal },
    );
  }
  let budget: BudgetTelemetry;
  try {
    await assertChildReady(files.ready);
    budget = await readBudgetTelemetry(files.budgetTelemetry);
  } catch (error) {
    throw childFailure(error, "readiness", exitCode);
  }
  if (snapshot.stopReason === "error" || snapshot.stopReason === "aborted") {
    throw childFailure(snapshot.errorMessage || `Subagent stopped with reason ${snapshot.stopReason}`, "model", exitCode);
  }
  if (!snapshot.finalOutput.trim()) {
    throw childFailure("Subagent finished without a final assistant answer", "output", exitCode);
  }
  const partialReason = selectPartialReason({
    stopReason: snapshot.stopReason,
    hardLimitReached: budget.hardLimitReached,
    finalOutputReceivedAt: snapshot.finalOutputReceivedAt,
    completedAt,
    softDeadline,
  });
  // Pi sends content, not details, to the parent model. Bound the entire envelope.
  const capped = formatChildOutput(snapshot.finalOutput, partialReason);
  return {
    output: capped.text,
    outputTruncated: capped.truncated,
    status: partialReason ? "partial" : "complete",
    exitCode,
    stopReason: snapshot.stopReason,
    durationMs: Date.now() - startedAt,
    contextTokens: estimateContextTokens(capped.text),
    usage: snapshot.usage,
    budget,
    partialReason,
  };
}
