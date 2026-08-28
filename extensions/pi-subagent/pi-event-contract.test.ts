import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { runAgentLoop, type AgentEvent, type AgentTool } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const MODEL = {
  id: "event-contract",
  name: "Event Contract",
  provider: "test",
  api: "openai-completions",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 16_000,
  maxTokens: 1_000,
} as any;

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const NESTED_USAGE: Usage = {
  input: 10,
  output: 2,
  cacheRead: 3,
  cacheWrite: 1,
  totalTokens: 16,
  cost: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0.001, total: 0.034 },
};

function assistantToolCall(toolCallId: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: toolCallId, name: "contract_tool", arguments: {} }],
    api: "openai-completions",
    provider: "test",
    model: "event-contract",
    usage: EMPTY_USAGE,
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

function oneMessageStream(message: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  const reason = message.stopReason;
  if (reason === "pending" || reason === "error" || reason === "aborted") {
    throw new Error(`Cannot complete a message stream with stop reason: ${reason}`);
  }
  queueMicrotask(() => stream.push({ type: "done", reason, message }));
  return stream;
}

async function runOneToolTurn(options: {
  tool: AgentTool;
  beforeToolCall?: (...args: any[]) => any;
  afterToolCall?: (...args: any[]) => any;
  trace: string[];
}) {
  const events: AgentEvent[] = [];
  const toolCallId = "contract-call";
  const messages = await runAgentLoop(
    [{ role: "user", content: "run the contract tool", timestamp: Date.now() }],
    { systemPrompt: "test", messages: [], tools: [options.tool] },
    {
      model: MODEL,
      convertToLlm: (input) => input as any,
      shouldStopAfterTurn: () => true,
      beforeToolCall: options.beforeToolCall,
      afterToolCall: options.afterToolCall,
    },
    (event) => {
      events.push(event);
      options.trace.push(event.type);
    },
    undefined,
    () => oneMessageStream(assistantToolCall(toolCallId)),
  );
  return { events, messages, toolCallId };
}

function contractTool(execute: AgentTool["execute"]): AgentTool {
  return {
    name: "contract_tool",
    label: "Contract Tool",
    description: "Exercise the Pi tool event contract",
    parameters: Type.Object({}),
    execute,
  };
}

describe("Pi tool event contract (real agent loop)", () => {
  test("a pre-execution block emits tool_execution_end but skips execute and tool_result", async () => {
    const trace: string[] = [];
    let executions = 0;
    let toolResultHooks = 0;
    const { events, messages } = await runOneToolTurn({
      trace,
      tool: contractTool(async () => {
        executions += 1;
        return { content: [{ type: "text", text: "unexpected" }], details: {} };
      }),
      beforeToolCall: () => {
        trace.push("tool_call hook");
        return { block: true, reason: "blocked downstream" };
      },
      afterToolCall: () => {
        toolResultHooks += 1;
        trace.push("tool_result hook");
      },
    });

    assert.equal(executions, 0);
    assert.equal(toolResultHooks, 0);
    assert.equal(events.filter((event) => event.type === "tool_execution_end").length, 1);
    assert.equal(trace.includes("tool_result hook"), false);
    assert.ok(trace.indexOf("tool_call hook") < trace.indexOf("tool_execution_end"));
    const result = messages.find((message) => message.role === "toolResult");
    assert.equal(result?.role, "toolResult");
    if (result?.role === "toolResult") {
      assert.equal(result.isError, true);
      assert.equal(result.usage, undefined);
    }
  });

  test("a started child failure attaches nested usage before tool_execution_end and the final result message", async () => {
    const trace: string[] = [];
    const { events, messages } = await runOneToolTurn({
      trace,
      tool: contractTool(async () => {
        trace.push("execute");
        throw new Error("started child failed");
      }),
      beforeToolCall: () => {
        trace.push("tool_call hook");
      },
      afterToolCall: ({ isError }: any) => {
        trace.push("tool_result hook");
        assert.equal(isError, true);
        return { usage: NESTED_USAGE };
      },
    });

    assert.ok(trace.indexOf("execute") < trace.indexOf("tool_result hook"));
    assert.ok(trace.indexOf("tool_result hook") < trace.indexOf("tool_execution_end"));
    const end = events.find((event) => event.type === "tool_execution_end");
    assert.equal(end?.type, "tool_execution_end");
    if (end?.type === "tool_execution_end") {
      assert.equal(end.isError, true);
      assert.deepEqual(end.result.usage, NESTED_USAGE);
    }
    const result = messages.find((message) => message.role === "toolResult");
    assert.equal(result?.role, "toolResult");
    if (result?.role === "toolResult") {
      assert.equal(result.isError, true);
      assert.deepEqual(result.usage, NESTED_USAGE);
    }
  });
});
