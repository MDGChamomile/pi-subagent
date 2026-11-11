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
