import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateContextTokens, formatElapsed, formatProgress, formatResultSummary } from "./call-display.ts";

test("formats live progress with elapsed time, model, thinking, and reported tokens", () => {
  assert.equal(formatElapsed(0), "00:00");
  assert.equal(formatElapsed(59_999), "00:59");
  assert.equal(formatElapsed(60_000), "01:00");
  assert.equal(formatElapsed(15 * 60_000), "15:00");
  assert.equal(
    formatProgress("openai-codex/gpt-6-luna", "low", 83_000, 4_512),
    "01:23 · gpt-6-luna (low) running · 4,512 reported tokens",
  );
});

test("formats final context injection estimates for complete and partial results", () => {
  assert.equal(estimateContextTokens(""), 0);
  assert.equal(estimateContextTokens("x".repeat(7_280)), 1_820);
  assert.equal(estimateContextTokens("abcde"), 2);
  assert.equal(estimateContextTokens("한글"), 2); // 6 UTF-8 bytes
  assert.equal(estimateContextTokens("😀😀"), 2); // 8 UTF-8 bytes
  assert.equal(estimateContextTokens("A한😀"), 2); // mixed, 8 UTF-8 bytes
  assert.equal(
    formatResultSummary("complete", 14_200, 1_820),
    "✓ Complete · 14.2s · Context injected: ~1,820 tokens",
  );
  assert.equal(
    formatResultSummary("partial", 18 * 60_000 + 4_000, 2_210),
    "⚠ Partial · 18:04 · Context injected: ~2,210 tokens",
  );
});
