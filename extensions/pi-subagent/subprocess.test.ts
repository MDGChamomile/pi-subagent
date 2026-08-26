import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { assertChildReady, ChildJsonCollector, formatElapsed } from "./subprocess.ts";
import { MAX_JSON_LINE_BYTES, READY_MARKER, REPORT_TOOL_NAME, sanitizeDisplayText } from "./shared.ts";

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
  function toolResultEvent(toolName: string, text: string, overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      type: "message_end",
      message: {
        role: "toolResult",
        toolName,
        content: [{ type: "text", text }],
        isError: false,
        usage: {
          input: 5,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 6,
          cost: { input: 0.5, output: 0.5, cacheRead: 0, cacheWrite: 0, total: 1 },
        },
        ...overrides,
      },
    });
  }

  test("handles fragmented records and retains only one structured report", () => {
    let updates = 0;
    const collector = new ChildJsonCollector(() => updates++);
    const first = assistantEvent("intermediate");
    const noisyToolResult = toolResultEvent("read", "noisy tool output");
    const rawAssistantFinal = assistantEvent("to=read code: should not reach parent");
    const report = toolResultEvent(REPORT_TOOL_NAME, '{"conclusion":"final report","findings":[]}');
    const stream = `${first}\n${noisyToolResult}\n${rawAssistantFinal}\n${report}\n`;
    collector.push(Buffer.from(stream.slice(0, 37)));
    collector.push(Buffer.from(stream.slice(37, 151)));
    collector.push(Buffer.from(stream.slice(151)));
    collector.finish();

    const result = collector.snapshot();
    assert.equal(result.protocolError, undefined);
    assert.equal(result.finalOutput, '{"conclusion":"final report","findings":[]}');
    assert.equal(result.reportCount, 1);
    assert.equal(result.usage.input, 30);
    assert.equal(result.usage.totalTokens, 44);
    assert.equal(result.usage.cost.total, 22);
    assert.equal(updates, 2);
  });

  test("preserves optional reasoning and long-cache usage only when providers report them", () => {
    const withoutBreakdown = new ChildJsonCollector();
    withoutBreakdown.push(`${assistantEvent("ordinary usage")}\n`);
    withoutBreakdown.finish();
    assert.equal(withoutBreakdown.snapshot().usage.reasoning, undefined);
    assert.equal(withoutBreakdown.snapshot().usage.cacheWrite1h, undefined);

    const withBreakdown = new ChildJsonCollector();
    const usage = (reasoning: number, cacheWrite1h: number) => ({
      input: 10,
      output: 5,
      cacheRead: 2,
      cacheWrite: 3,
      cacheWrite1h,
      reasoning,
      totalTokens: 20,
      cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
    });
    withBreakdown.push(`${assistantEvent("first", { usage: usage(4, 2) })}\n`);
    withBreakdown.push(`${assistantEvent("second", { usage: usage(6, 3) })}\n`);
    withBreakdown.finish();
    assert.equal(withBreakdown.snapshot().usage.reasoning, 10);
    assert.equal(withBreakdown.snapshot().usage.cacheWrite1h, 5);
    assert.equal(withBreakdown.snapshot().usage.totalTokens, 40);
  });

  test("does not treat ordinary assistant text as a final report", () => {
    const collector = new ChildJsonCollector();
    collector.push(`${assistantEvent("intermediate")}\n${assistantEvent("to=read code: raw syntax")}\n`);
    collector.finish();
    assert.equal(collector.snapshot().finalOutput, "");
    assert.equal(collector.snapshot().reportCount, 0);
  });

  test("discards an oversized aggregate agent_end record without failing", () => {
    const collector = new ChildJsonCollector();
    const hugeIgnoredEvent = `{"type":"agent_end","messages":"${"x".repeat(MAX_JSON_LINE_BYTES + 1024)}"}\n`;
    collector.push(Buffer.from(hugeIgnoredEvent));
    collector.push(Buffer.from(`${toolResultEvent(REPORT_TOOL_NAME, "bounded final")}\n`));
    collector.finish();
    const result = collector.snapshot();
    assert.equal(result.protocolError, undefined);
    assert.equal(result.finalOutput, "bounded final");
    assert.equal(result.reportCount, 1);
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

  test("counts only successful structured report submissions", () => {
    const collector = new ChildJsonCollector();
    collector.push(`${toolResultEvent(REPORT_TOOL_NAME, "rejected", { isError: true })}\n`);
    collector.push(`${toolResultEvent(REPORT_TOOL_NAME, "first")}\n`);
    collector.push(`${toolResultEvent(REPORT_TOOL_NAME, "second")}\n`);
    collector.finish();
    assert.equal(collector.snapshot().reportCount, 2);
    assert.equal(collector.snapshot().finalOutput, "second");
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
  test("formats live progress time as mm:ss", () => {
    assert.equal(formatElapsed(0), "00:00");
    assert.equal(formatElapsed(59_999), "00:59");
    assert.equal(formatElapsed(60_000), "01:00");
    assert.equal(formatElapsed(15 * 60_000), "15:00");
  });

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
