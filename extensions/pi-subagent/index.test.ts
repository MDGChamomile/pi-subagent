import assert from "node:assert/strict";
import { describe, test } from "node:test";
import piSubagentExtension from "./index.ts";
import { MAX_SUBAGENT_CALLS, TOOL_NAME } from "./shared.ts";

const SOURCE_PATH = "/test/pi-subagent/index.ts";

type Handler = (event: any, ctx: any) => any;

function createExtensionHarness() {
  const handlers = new Map<string, Handler[]>();
  const tools: any[] = [];
  let toolDefinition: any;

  const pi = {
    on(name: string, handler: Handler) {
      const registered = handlers.get(name) ?? [];
      registered.push(handler);
      handlers.set(name, registered);
    },
    registerTool(definition: any) {
      toolDefinition = definition;
      tools.push({
        name: definition.name,
        description: definition.description,
        parameters: definition.parameters,
        sourceInfo: { path: SOURCE_PATH, source: "local" },
      });
    },
    getAllTools() {
      return [...tools];
    },
  };

  const ctx = {
    cwd: process.cwd(),
    modelRegistry: { find: () => undefined },
  };

  const fire = async (name: string, event: any = {}) => {
    let result: any;
    for (const handler of handlers.get(name) ?? []) {
      const next = await handler(event, ctx);
      if (next !== undefined) result = next;
    }
    return result;
  };

  piSubagentExtension(pi as any);
  return {
    fire,
    get toolDefinition() {
      return toolDefinition;
    },
  };
}

async function startHarness() {
  const harness = createExtensionHarness();
  await harness.fire("session_start", { reason: "startup" });
  await harness.fire("agent_start");
  return harness;
}

function toolEvent(toolCallId: string, isError: boolean) {
  return {
    toolCallId,
    toolName: TOOL_NAME,
    args: {},
    result: { content: [{ type: "text", text: "blocked downstream" }], details: {} },
    isError,
  };
}

describe("pi-subagent extension wiring", () => {
  test("describes web mode without promising credential-isolated public-only access", async () => {
    const harness = await startHarness();
    const capability = harness.toolDefinition.parameters.properties.capability;
    assert.match(capability.description, /web research tools only/);
    assert.match(capability.description, /not a credential-isolated sandbox/);
    assert.doesNotMatch(capability.description, /public web only/);
  });

  test("returns permits for downstream blocks regardless of the result error flag", async () => {
    const harness = await startHarness();

    for (let index = 0; index < MAX_SUBAGENT_CALLS + 1; index++) {
      const toolCallId = `downstream-block-${index}`;
      assert.equal(await harness.fire("tool_call", { toolName: TOOL_NAME, toolCallId, input: {} }), undefined);
      await harness.fire("tool_execution_end", toolEvent(toolCallId, index % 2 === 0));
    }
  });

  test("allows another corrected retry when a downstream extension blocks the first replacement", async () => {
    const harness = await startHarness();
    const invalidId = "invalid-preflight";
    assert.equal(await harness.fire("tool_call", { toolName: TOOL_NAME, toolCallId: invalidId, input: {} }), undefined);
    await assert.rejects(
      () => harness.toolDefinition.execute(
        invalidId,
        { task: "bounded lookup", scope: ["."], capability: "local", preset: "lookup-standard" },
        undefined,
        undefined,
        { cwd: process.cwd(), modelRegistry: { find: () => undefined } },
      ),
      /Configured subagent model is unavailable/,
    );
    await harness.fire("tool_execution_end", toolEvent(invalidId, true));

    const blockedReplacement = "blocked-replacement";
    assert.equal(await harness.fire("tool_call", {
      toolName: TOOL_NAME,
      toolCallId: blockedReplacement,
      input: {},
    }), undefined);
    await harness.fire("tool_execution_end", toolEvent(blockedReplacement, true));

    assert.equal(await harness.fire("tool_call", {
      toolName: TOOL_NAME,
      toolCallId: "next-replacement",
      input: {},
    }), undefined);
  });
});
