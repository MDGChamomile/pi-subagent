import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MAX_JSON_LINE_BYTES, MAX_OBSERVATION_COUNT, MAX_PARENT_ERROR_BYTES } from "./shared.ts";
import { boundedParentError } from "./diagnostics.ts";
import { ChildJsonCollector, emptyUsage } from "./child-stream.ts";

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

  test("observations retain only allowlisted counts and parent receipt ages", (t) => {
    let now = 100;
    t.mock.method(performance, "now", () => now);
    const collector = new ChildJsonCollector();
    const events = [
      { type: "turn_start", timestamp: -999 },
      { type: "tool_execution_start", toolName: "private-tool", toolCallId: "private-id", args: { query: "private-query", url: "https://private.invalid" } },
      { type: "tool_execution_end", toolName: "private-tool", toolCallId: "private-id", result: { text: "private-result" }, isError: false },
      { type: "message_update", usage: { input: 1 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "private-delta" } },
      { type: "auto_retry_start", attempt: 1, maxAttempts: 2, delayMs: 5, errorMessage: "private-error" },
      { type: "auto_retry_end", attempt: 1, success: true },
    ];
    for (const event of events) {
      const line = `${JSON.stringify(event)}\n`;
      for (let offset = 0; offset < line.length; offset += 7) collector.push(line.slice(offset, offset + 7));
    }
    now = 150;
    const observations = collector.snapshot().observations;
    assert.deepEqual(Object.values(observations.counts), [1, 1, 1, 1, 1, 1]);
    assert.equal(observations.lastEvent, "auto_retry_end");
    assert.equal(observations.lastEventAgeMs, 50);
    assert.equal(observations.incomplete, false);
    assert.equal(observations.toolBalance, 0);
    assert.doesNotMatch(JSON.stringify(observations), /private|timestamp/);
    observations.counts.turn_start = 999;
    assert.equal(collector.snapshot().observations.counts.turn_start, 1, "snapshots must not alias collector counters");
  });

  test("Pi's JSON-mode message_update serialization yields validated observations", async () => {
    // toJsonEvent is internal to Pi; load the installed serializer by path so the
    // latest-Pi canary fails if the wire shape or its location changes.
    const { toJsonEvent } = await import(new URL(
      "./node_modules/@earendil-works/pi-coding-agent/dist/modes/json-event.js", import.meta.url,
    ).href) as { toJsonEvent: (event: unknown) => Record<string, unknown> };
    const partial = {
      role: "assistant",
      content: [{ type: "text", text: "private-text" }, { type: "toolCall", id: "private-id", name: "read", arguments: {} }],
      usage: emptyUsage(),
      stopReason: "toolUse",
    };
    const updates = [
      { type: "start", partial },
      { type: "text_start", contentIndex: 0, partial },
      { type: "text_delta", contentIndex: 0, delta: "private-delta", partial },
      { type: "text_end", contentIndex: 0, content: "private-text", partial },
      { type: "toolcall_start", contentIndex: 1, partial },
    ];
    const collector = new ChildJsonCollector();
    for (const assistantMessageEvent of updates) {
      const wire = toJsonEvent({ type: "message_update", message: partial, assistantMessageEvent });
      assert.equal("message" in wire, false, "the CLI serializer must stay delta-only");
      collector.push(`${JSON.stringify(wire)}\n`);
    }
    const observations = collector.snapshot().observations;
    assert.equal(observations.counts.message_update, updates.length);
    assert.equal(observations.lastEventValidated, true);
    assert.equal(observations.incomplete, false);
    assert.equal(observations.toolBalance, 0);
    assert.doesNotMatch(JSON.stringify(observations), /private/);
  });

  test("invalid, oversized and unbalanced observations are explicitly incomplete", () => {
    for (const line of [
      '{"type":"tool_execution_start","toolName":"private"}',
      '{"type":"auto_retry_start",broken}',
      JSON.stringify({ type: "message_update", usage: {} }),
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "done" } }),
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: { toString: null } } }),
      JSON.stringify({ type: "tool_execution_end", toolName: "read", toolCallId: "id", result: {}, isError: false }),
      `{"type":"message_update","content":"${"x".repeat(MAX_JSON_LINE_BYTES + 1)}"}`,
    ]) {
      const collector = new ChildJsonCollector();
      for (let offset = 0; offset < line.length; offset += 256) collector.push(line.slice(offset, offset + 256));
      collector.push("\n");
      collector.push(`${assistantEvent("safe final answer")}\n`);
      assert.equal(collector.snapshot().observations.incomplete, true);
      assert.equal(collector.snapshot().protocolError, undefined);
      assert.equal(collector.snapshot().finalOutput, "safe final answer");
      assert.equal(collector.snapshot().observations.toolBalance, null);
      assert.ok(JSON.stringify(collector.snapshot().observations).length < 800);
    }
    const collector = new ChildJsonCollector();
    collector.push('{"type":"turn_start"}\n');
    collector.push('malformed JSON\n');
    collector.push('{"type":"turn_start"}\n');
    assert.equal(collector.snapshot().observations.counts.turn_start, 1);
    assert.equal(collector.snapshot().observations.incomplete, true);
  });

  test("large real-shaped streaming and tool results retain unvalidated receipt signals", (t) => {
    let now = 100;
    t.mock.method(performance, "now", () => now);
    const collector = new ChildJsonCollector();
    collector.push(JSON.stringify({ type: "tool_execution_start", toolName: "read", toolCallId: "id", args: {} }) + "\n");
    for (const event of [
      { type: "tool_execution_end", toolName: "read", toolCallId: "id", result: { content: [{ type: "text", text: "private-result".repeat(1_000) }] }, isError: false },
      { type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "private-sentinel".repeat(1_000) } },
    ]) {
      now += 100;
      const line = JSON.stringify(event) + "\n";
      for (let offset = 0; offset < line.length; offset += 512) collector.push(line.slice(offset, offset + 512));
      now += 50;
      const observations = collector.snapshot().observations;
      assert.equal(observations.receipts[event.type as "tool_execution_end" | "message_update"], 1);
      assert.equal(observations.counts[event.type as "tool_execution_end" | "message_update"], 0);
      assert.equal(observations.lastEvent, event.type);
      assert.equal(observations.lastEventAgeMs, 50);
      assert.equal(observations.lastEventValidated, false);
      assert.equal(observations.incomplete, true);
      assert.equal(observations.toolBalance, null);
      assert.doesNotMatch(JSON.stringify(observations), /private-sentinel|private-result/);
    }
    collector.push('{"type":"turn_start","type":"tool_execution_end"}\n');
    assert.equal(collector.snapshot().observations.counts.turn_start, 0);
    assert.equal(collector.snapshot().observations.counts.tool_execution_end, 0);
  });

  test("observation counters saturate and failure suffixes remain bounded", () => {
    const collector = new ChildJsonCollector();
    const batch = '{"type":"turn_start"}\n'.repeat(10_000);
    for (let i = 0; i <= MAX_OBSERVATION_COUNT / 10_000; i++) collector.push(batch);
    collector.finish();
    assert.equal(collector.snapshot().observations.counts.turn_start, MAX_OBSERVATION_COUNT);
    assert.equal(collector.snapshot().observations.incomplete, true);
    const error = boundedParentError("x".repeat(MAX_PARENT_ERROR_BYTES * 2), {
      phase: "timeout", observations: collector.snapshot().observations,
    });
    assert.ok(Buffer.byteLength(error) <= MAX_PARENT_ERROR_BYTES);
    assert.match(error, /"observations"/);
  });

  test("handles fragmented records and retains only the final assistant answer", () => {
    let updates = 0;
    const collector = new ChildJsonCollector(() => updates++);
    const first = assistantEvent("intermediate", {
      content: [
        { type: "text", text: "intermediate" },
        { type: "toolCall", id: "read-1", name: "read", arguments: { path: "fixture.txt" } },
      ],
      stopReason: "toolUse",
    });
    const noisyToolResult = toolResultEvent("read", "noisy tool output");
    const final = assistantEvent("Concise final answer with fixture.txt:1 evidence.");
    const stream = `${first}\n${noisyToolResult}\n${final}\n`;
    collector.push(Buffer.from(stream.slice(0, 37)));
    collector.push(Buffer.from(stream.slice(37, 151)));
    collector.push(Buffer.from(stream.slice(151)));
    collector.finish();

    const result = collector.snapshot();
    assert.equal(result.protocolError, undefined);
    assert.equal(result.finalOutput, "Concise final answer with fixture.txt:1 evidence.");
    assert.equal(result.toolErrorCount, 0);
    assert.equal(result.assistantMessageCount, 2);
    assert.equal(result.lastAssistantMode, "text");
    assert.equal(result.usage.input, 25);
    assert.equal(result.usage.totalTokens, 38);
    assert.equal(result.usage.cost.total, 21);
    assert.equal(updates, 2);
  });

  test("timestamps the latest eligible answer with the parent clock, not child metadata", (t) => {
    let now = 100;
    t.mock.method(Date, "now", () => now);
    const collector = new ChildJsonCollector();
    assert.equal(collector.snapshot().finalOutputReceivedAt, undefined);
    collector.push(`${assistantEvent("early answer", { timestamp: 99_999 })}\n`);
    assert.equal(collector.snapshot().finalOutputReceivedAt, 100);

    now = 200;
    collector.push(`${toolResultEvent("read", "discarded contents")}\n`);
    collector.finish();
    assert.equal(collector.snapshot().finalOutputReceivedAt, 100);

    collector.push(`${assistantEvent("later answer", { timestamp: 0 })}\n`);
    assert.equal(collector.snapshot().finalOutputReceivedAt, 200);
    assert.equal(collector.snapshot().finalOutput, "later answer");

    for (const ending of [
      { stopReason: "toolUse", content: [{ type: "toolCall", id: "next", name: "read", arguments: {} }] },
      { stopReason: "error" },
      { stopReason: "aborted" },
      { content: [] },
    ]) {
      collector.push(`${assistantEvent("eligible answer")}\n`);
      collector.push(`${assistantEvent("not an answer", ending)}\n`);
      assert.equal(collector.snapshot().finalOutput, "");
      assert.equal(collector.snapshot().finalOutputReceivedAt, undefined);
    }

    now = 300;
    collector.push(`${assistantEvent("truncated answer", { stopReason: "length" })}\n`);
    assert.equal(collector.snapshot().finalOutputReceivedAt, 300);
    now = 400;
    collector.push(`${assistantEvent("recovered answer")}\n`);
    assert.equal(collector.snapshot().finalOutputReceivedAt, 400);
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

  test("accepts ordinary assistant text and requires it to be the last assistant message", () => {
    const accepted = new ChildJsonCollector();
    accepted.push(`${assistantEvent("intermediate")}\n${assistantEvent("Final conclusion with evidence.")}\n`);
    accepted.finish();
    assert.equal(accepted.snapshot().finalOutput, "Final conclusion with evidence.");

    const toolOnlyEnding = new ChildJsonCollector();
    toolOnlyEnding.push(`${assistantEvent("earlier text")}\n${assistantEvent("", {
      content: [{ type: "toolCall", id: "last-read", name: "read", arguments: { path: "fixture.txt" } }],
      stopReason: "toolUse",
    })}\n`);
    toolOnlyEnding.finish();
    assert.equal(toolOnlyEnding.snapshot().finalOutput, "");
    assert.equal(toolOnlyEnding.snapshot().lastAssistantMode, "tool");
  });

  test("retains length-limited answer text but never mixed investigation/tool-call text", () => {
    const collector = new ChildJsonCollector();
    collector.push(`${assistantEvent("Truncated answer text", { stopReason: "length" })}\n`);
    assert.equal(collector.snapshot().finalOutput, "Truncated answer text");
    assert.equal(collector.snapshot().stopReason, "length");

    collector.push(`${assistantEvent("", {
      stopReason: "length",
      content: [
        { type: "text", text: "private intermediate investigation" },
        { type: "toolCall", id: "cut-off-call", name: "read", arguments: {} },
      ],
    })}\n`);
    collector.finish();
    assert.equal(collector.snapshot().finalOutput, "");
    assert.equal(collector.snapshot().lastAssistantMode, "mixed");
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

  test("accepts native-sized image tool results before the final answer", () => {
    // Protocol fixtures: the collector does not decode images. Cover the reported
    // PNG payload size and Pi's default 4.5 MiB base64 ceiling, plus metadata.
    for (const imageBytes of [3_245_812, 4.5 * 1024 * 1024]) {
      for (const chunkBytes of [65_536, Infinity]) {
        const collector = new ChildJsonCollector();
        const image = toolResultEvent("read", "", {
          content: [
            { type: "text", text: "Read image file [image/png]" },
            { type: "image", data: "A".repeat(imageBytes), mimeType: "image/png" },
          ],
        });
        const stream = Buffer.from(`${image}\n${assistantEvent("Image investigation complete.")}\n`);
        for (let offset = 0; offset < stream.length; offset += chunkBytes) {
          collector.push(stream.subarray(offset, Math.min(offset + chunkBytes, stream.length)));
        }
        collector.finish();
        const result = collector.snapshot();
        assert.equal(result.protocolError, undefined);
        assert.equal(result.finalOutput, "Image investigation complete.");
        assert.equal(result.assistantMessageCount, 1);
        assert.equal(result.toolErrorCount, 0);
        assert.equal(result.usage.totalTokens, 22);
      }
    }
  });

  test("keeps a strict byte boundary for image tool results", () => {
    const empty = toolResultEvent("read", "", {
      content: [{ type: "image", data: "", mimeType: "image/png" }],
    });
    const remaining = MAX_JSON_LINE_BYTES - Buffer.byteLength(empty);
    for (const extra of [0, 1]) {
      let failures = 0;
      const collector = new ChildJsonCollector(undefined, () => failures++);
      const record = empty.replace('"data":""', `"data":"${"A".repeat(remaining + extra)}"`);
      assert.equal(Buffer.byteLength(record), MAX_JSON_LINE_BYTES + extra);
      const stream = Buffer.from(`${record}\n${assistantEvent("bounded final")}\n`);
      for (let offset = 0; offset < stream.length; offset += 65_536) {
        collector.push(stream.subarray(offset, offset + 65_536));
      }
      collector.finish();
      assert.equal(failures, extra);
      if (extra) {
        assert.match(collector.snapshot().protocolError ?? "", /message_end record exceeded/);
        assert.equal(collector.snapshot().finalOutput, "");
      } else {
        assert.equal(collector.snapshot().protocolError, undefined);
        assert.equal(collector.snapshot().finalOutput, "bounded final");
      }
    }
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

  test("tracks tool errors without retaining ordinary tool output", () => {
    const collector = new ChildJsonCollector();
    collector.push(`${toolResultEvent("read", "private rejected output", { isError: true })}\n`);
    collector.push(`${toolResultEvent("grep", "private successful output")}\n`);
    collector.push(`${assistantEvent("Supported final answer.")}\n`);
    collector.finish();
    const result = collector.snapshot();
    assert.equal(result.toolErrorCount, 1);
    assert.equal(result.lastToolError, "read");
    assert.equal(result.finalOutput, "Supported final answer.");
    assert.doesNotMatch(result.finalOutput, /private/);
  });

  test("clears stale provider errors on each subsequent assistant message", () => {
    for (const stopReason of ["error", "aborted", "stop"]) {
      for (const errorMessage of [undefined, null, 42]) {
        const collector = new ChildJsonCollector();
        collector.push(`${assistantEvent("", { stopReason: "error", errorMessage: "old provider failure" })}\n`);
        collector.push(`${assistantEvent("next", { stopReason, errorMessage })}\n`);
        collector.finish();
        assert.equal(collector.snapshot().stopReason, stopReason);
        assert.equal(collector.snapshot().errorMessage, undefined);
      }
    }
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
