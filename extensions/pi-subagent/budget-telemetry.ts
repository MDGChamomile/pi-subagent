import { writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isRecord } from "./shared.ts";

export type BudgetTelemetry = {
  version: 1;
  toolCallsAttempted: number;
  toolCallsExecuted: number;
  deniedCalls: number;
  queryCount: number;
  fetchTargetCount: number;
  softLimitReached: boolean;
  hardLimitReached: boolean;
};

/** Child-side budget state and the call IDs it counts; persisted snapshots are the parent's only budget source. */
export class BudgetLedger {
  readonly budget: BudgetTelemetry = {
    version: 1,
    toolCallsAttempted: 0,
    toolCallsExecuted: 0,
    deniedCalls: 0,
    queryCount: 0,
    fetchTargetCount: 0,
    softLimitReached: false,
    hardLimitReached: false,
  };
  readonly validatedToolCallIds = new Set<string>();
  readonly permittedToolCallIds = new Set<string>();
  readonly deniedToolCallIds = new Set<string>();
  private readonly onPersistFailure: (error: unknown) => void;
  private file: string | undefined;
  private lastPersisted: string | undefined;

  constructor(onPersistFailure: (error: unknown) => void) {
    this.onPersistFailure = onPersistFailure;
  }

  /** Until a file is attached, persist() is a no-op. */
  attach(file: string): void {
    this.file = file;
  }

  /** Creates the telemetry file exclusively; the caller handles a failure. */
  publishInitial(file: string): void {
    const snapshot = JSON.stringify(this.budget);
    writeFileSync(file, snapshot, { encoding: "utf8", mode: 0o600, flag: "wx" });
    this.lastPersisted = snapshot;
  }

  persist(): void {
    if (this.file === undefined) return;
    const snapshot = JSON.stringify(this.budget);
    if (snapshot === this.lastPersisted) return;
    try {
      writeFileSync(this.file, snapshot, { encoding: "utf8", mode: 0o600 });
    } catch (error) {
      // The parent derives tool_budget status only from this file. Pi may continue
      // after a hook error, so a stale snapshot must not let the child finish normally.
      this.onPersistFailure(error);
      throw error;
    }
    // Record only successful writes, so the event that changes a reservation or
    // terminal state always persists it synchronously.
    this.lastPersisted = snapshot;
  }

  markDenied(toolCallId: string): void {
    if (!this.deniedToolCallIds.has(toolCallId)) {
      this.deniedToolCallIds.add(toolCallId);
      this.budget.deniedCalls += 1;
    }
    this.persist();
  }
}

export async function readBudgetTelemetry(path: string): Promise<BudgetTelemetry> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error("Subagent budget telemetry is unavailable or malformed");
  }
  return parseBudgetTelemetry(parsed);
}

function parseBudgetTelemetry(parsed: unknown): BudgetTelemetry {
  if (!isRecord(parsed)) {
    throw new Error("Subagent budget telemetry is malformed");
  }
  const value = parsed as Record<string, unknown>;
  const allowedKeys = new Set<string>([
    "version", "toolCallsAttempted", "toolCallsExecuted", "deniedCalls", "queryCount", "fetchTargetCount",
    "softLimitReached", "hardLimitReached",
  ] satisfies (keyof BudgetTelemetry)[]);
  const integerKeys = [
    "toolCallsAttempted", "toolCallsExecuted", "deniedCalls", "queryCount", "fetchTargetCount",
  ] as const satisfies readonly (keyof BudgetTelemetry)[];
  if (
    Object.keys(value).some((key) => !allowedKeys.has(key))
    || value.version !== 1
    || integerKeys.some((key) => !Number.isSafeInteger(value[key]) || (value[key] as number) < 0)
    || typeof value.softLimitReached !== "boolean"
    || typeof value.hardLimitReached !== "boolean"
  ) {
    throw new Error("Subagent budget telemetry is malformed");
  }
  return value as BudgetTelemetry;
}
