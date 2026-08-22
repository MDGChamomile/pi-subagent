import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { assertChildReady, ChildJsonCollector } from "./subprocess.ts";
import { MAX_JSON_LINE_BYTES, READY_MARKER, sanitizeDisplayText } from "./shared.ts";

function assistantEvent(text: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      usage: {
        input: 10,
        output: 2,
        cacheRead: 3,
        cacheWrite: 1,
        totalTokens: 16,
        cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
      },
      stopReason: "stop",
      ...overrides,
    },
  });
}

describe("child JSON stream collector", () => {
  test("handles fragmented records and retains only the latest assistant report", () => {
    let updates = 0;
    const collector = new ChildJsonCollector(() => updates++);
    const first = assistantEvent("intermediate");
    const toolResult = JSON.stringify({
      type: "message_end",
      message: {
        role: "toolResult",
        content: [{ type: "text", text: "noisy tool output" }],
        usage: {
          input: 5,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 6,
          cost: { input: 0.5, output: 0.5, cacheRead: 0, cacheWrite: 0, total: 1 },
        },
      },
    });
    const second = assistantEvent("final report");
    const stream = `${first}\n${toolResult}\n${second}\n`;
    collector.push(Buffer.from(stream.slice(0, 37)));
    collector.push(Buffer.from(stream.slice(37, 151)));
    collector.push(Buffer.from(stream.slice(151)));
    collector.finish();

    const result = collector.snapshot();
    assert.equal(result.protocolError, undefined);
    assert.equal(result.finalOutput, "final report");
    assert.equal(result.usage.input, 25);
    assert.equal(result.usage.totalTokens, 38);
    assert.equal(result.usage.cost.total, 21);
    assert.equal(updates, 2);
  });

  test("does not retain stale intermediate text when the terminal assistant message is empty", () => {
    const collector = new ChildJsonCollector();
    collector.push(`${assistantEvent("intermediate")}\n${assistantEvent("")}\n`);
    collector.finish();
    assert.equal(collector.snapshot().finalOutput, "");
  });

  test("discards an oversized aggregate agent_end record without failing", () => {
    const collector = new ChildJsonCollector();
    const hugeIgnoredEvent = `{"type":"agent_end","messages":"${"x".repeat(MAX_JSON_LINE_BYTES + 1024)}"}\n`;
    collector.push(Buffer.from(hugeIgnoredEvent));
    collector.push(Buffer.from(`${assistantEvent("bounded final")}\n`));
    collector.finish();
    const result = collector.snapshot();
    assert.equal(result.protocolError, undefined);
    assert.equal(result.finalOutput, "bounded final");
  });

  test("fails closed on malformed or oversized message_end records", () => {
    const malformed = new ChildJsonCollector();
    malformed.push('{"type":"message_end",broken}\n');
    malformed.finish();
    assert.match(malformed.snapshot().protocolError ?? "", /malformed JSON/);

    const oversized = new ChildJsonCollector();
    oversized.push(`{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"${"x".repeat(MAX_JSON_LINE_BYTES)}"}]}}\n`);
    oversized.finish();
    assert.match(oversized.snapshot().protocolError ?? "", /message_end record exceeded/);
  });

  test("preserves terminal error metadata for the parent runner", () => {
    const collector = new ChildJsonCollector();
    collector.push(`${assistantEvent("partial", { stopReason: "error", errorMessage: "provider failed" })}\n`);
    collector.finish();
    const result = collector.snapshot();
    assert.equal(result.stopReason, "error");
    assert.equal(result.errorMessage, "provider failed");
  });
});

describe("child completion boundary", () => {
  test("requires the exact guard readiness marker", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-subagent-ready-test-"));
    try {
      const readyFile = join(root, "guard.ready");
      await assert.rejects(() => assertChildReady(readyFile), /did not become ready/);
      await writeFile(readyFile, "wrong\n");
      await assert.rejects(() => assertChildReady(readyFile), /marker is invalid/);
      await writeFile(readyFile, READY_MARKER);
      await assert.doesNotReject(() => assertChildReady(readyFile));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("sanitizes terminal control and bidi characters while preserving layout", () => {
    assert.equal(sanitizeDisplayText("safe\n\t\u001b[31m\u202eevil"), "safe\n\t?[31m?evil");
  });
});
