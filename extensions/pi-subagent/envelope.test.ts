import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MAX_FINAL_BYTES } from "./shared.ts";
import { formatChildOutput } from "./envelope.ts";

describe("pi-subagent result envelope", () => {
  test("result envelopes cap escaped bytes and preserve Unicode at boundary positions", () => {
    for (const reason of [undefined, "tool_budget", "time_limit", "model_length"] as const) {
      for (const unit of ["x", "가", "😀", '"\\\n\t', "[Subagent output truncated]"]) {
        for (const padding of [0, 1, 2, 3]) {
          const answer = "x".repeat(padding) + unit.repeat(MAX_FINAL_BYTES);
          const result = formatChildOutput(answer, reason);
          const envelope = JSON.parse(result.text);
          assert.equal(result.truncated, true);
          assert.ok(Buffer.byteLength(result.text, "utf8") <= MAX_FINAL_BYTES);
          assert.equal(envelope.status, reason ? "partial" : "complete");
          assert.equal(envelope.partialReason, reason ?? null);
          assert.equal(envelope.outputTruncated, true);
          assert.ok(answer.startsWith(envelope.answer));
          assert.ok(envelope.answer.length > 0);
          assert.equal(envelope.answer.includes("�"), false);
          // One more complete code point must exceed the serialized cap.
          const next = Array.from(answer.slice(envelope.answer.length))[0];
          assert.ok(Buffer.byteLength(JSON.stringify({ ...envelope, answer: envelope.answer + next }), "utf8") > MAX_FINAL_BYTES);
        }
      }
    }
  });

  test("result envelopes account for overhead at the exact cap and sanitize controls", () => {
    const overhead = Buffer.byteLength(formatChildOutput("").text, "utf8");
    const exact = formatChildOutput("x".repeat(MAX_FINAL_BYTES - overhead));
    assert.equal(Buffer.byteLength(exact.text, "utf8"), MAX_FINAL_BYTES);
    assert.equal(exact.truncated, false);
    assert.equal(formatChildOutput("x".repeat(MAX_FINAL_BYTES - overhead + 1)).truncated, true);
    assert.equal(JSON.parse(formatChildOutput("가\u001b\u202e😀").text).answer, "가??😀");
  });

});
