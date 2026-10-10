import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MAX_PARENT_ERROR_BYTES } from "./shared.ts";
import { boundedParentError } from "./diagnostics.ts";

describe("pi-subagent failure diagnostics", () => {
  test("bounds and sanitizes every error that can reach the parent", () => {
    const result = boundedParentError(`provider\u001b[31m\u202efailed ${"가".repeat(MAX_PARENT_ERROR_BYTES)}`);
    assert.ok(Buffer.byteLength(result, "utf8") <= MAX_PARENT_ERROR_BYTES);
    assert.doesNotMatch(result, /\u001b|\u202e/);
    assert.equal(result.includes("�"), false);
    assert.match(result, /Subagent error truncated/);
  });

  test("reserves room for content-free failure diagnostics under the same error bound", () => {
    const result = boundedParentError(`provider failed ${"가".repeat(MAX_PARENT_ERROR_BYTES)}`, {
      phase: "output",
      exitCode: 0,
      stopReason: "stop\u202eunsafe",
      durationMs: 123.6,
      assistantMessages: 4,
      lastAssistantMode: "text",
      toolErrors: 2,
      lastToolError: "read\u001b[31m",
    });
    assert.ok(Buffer.byteLength(result, "utf8") <= MAX_PARENT_ERROR_BYTES);
    assert.doesNotMatch(result, /\u001b|\u202e/);
    assert.equal(result.includes("�"), false);
    assert.match(result, /Subagent error truncated/);
    assert.match(result, /Subagent diagnostics/);
    assert.match(result, /"phase":"output"/);
    assert.match(result, /"durationMs":124/);
    assert.match(result, /"toolErrors":2/);
  });
});
