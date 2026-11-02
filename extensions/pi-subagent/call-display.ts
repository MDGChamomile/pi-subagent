import { splitModelRef, type ResultStatus, type Thinking } from "./shared.ts";

export function formatElapsed(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

export function formatProgress(model: string, thinking: Thinking, durationMs: number, reportedTokens: number): string {
  const displayModel = splitModelRef(model).id;
  const tokens = Math.max(0, Math.trunc(reportedTokens)).toLocaleString("en-US");
  return `${formatElapsed(durationMs)} · ${displayModel} (${thinking}) running · ${tokens} reported tokens`;
}

export function estimateContextTokens(text: string): number {
  // Model-independent size heuristic, not tokenizer-measured usage.
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

export function formatResultSummary(status: ResultStatus, durationMs: number, contextTokens: number): string {
  const marker = status === "partial" ? "⚠" : "✓";
  const label = status === "partial" ? "Partial" : "Complete";
  const duration = durationMs < 60_000 ? `${(Math.max(0, durationMs) / 1000).toFixed(1)}s` : formatElapsed(durationMs);
  const tokens = Math.max(0, Math.trunc(contextTokens)).toLocaleString("en-US");
  return `${marker} ${label} · ${duration} · Context injected: ~${tokens} tokens`;
}
