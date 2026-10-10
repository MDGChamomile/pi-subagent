import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import piSubagentExtension from "./index.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { MAX_FINAL_BYTES, TOOL_NAME } from "./shared.ts";
import { MAX_SUBAGENT_CALLS } from "./invocation-gate.ts";
import { formatChildOutput } from "./envelope.ts";
import { boundedParentError } from "./diagnostics.ts";
import { ChildRunError, type ChildResult } from "./subprocess.ts";
import { emptyUsage } from "./child-stream.ts";

const SOURCE_PATH = "/test/pi-subagent/index.ts";
let agentDir: string;
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
before(async () => {
  agentDir = await mkdtemp(join(tmpdir(), "pi-subagent-index-test-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
});
after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(agentDir, { recursive: true, force: true });
});

type Handler = (event: any, ctx: any) => any;

function createExtensionHarness(runtime?: Parameters<typeof piSubagentExtension>[1]) {
  const handlers = new Map<string, Handler[]>();
  const tools: any[] = [];
  const commands = new Map<string, any>();
  let toolDefinition: any;

  const pi = {
    registerCommand(name: string, command: any) { commands.set(name, command); },
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

  piSubagentExtension(pi as any, runtime);
  return {
    fire,
    commands,
    get toolDefinition() {
      return toolDefinition;
    },
  };
}

async function startHarness(runtime?: Parameters<typeof piSubagentExtension>[1]) {
  const harness = createExtensionHarness(runtime);
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

describe("pi-subagent call rendering", () => {
  const theme = { fg(_color: string, text: string) { return text; }, bold(text: string) { return text; } };
  const render = (args: any, expanded = false, width = 200) =>
    createExtensionHarness().toolDefinition.renderCall(args, theme, { expanded }).render(width).join("\n").trim();

  test("shows a compact task without scope or other arguments until expanded", () => {
    const args = { task: "Investigate retry handling", scope: ["src/client.ts"], capability: "local", preset: "lookup-standard" };
    const before = structuredClone(args);
    assert.equal(render(args), "pi_subagent Investigate retry handling");
    const expanded = render(args, true);
    for (const [key, value] of Object.entries(args)) assert.ok(expanded.includes(`${key}: ${JSON.stringify(value)}`));
    assert.deepEqual(args, before, "display changes must not mutate execution inputs");
  });

  test("bounds and flattens a long task while preserving full inputs on expansion", () => {
    const task = "Inspect\n\t" + "retry handling ".repeat(30);
    const collapsed = render({ task });
    assert.equal(collapsed.split("\n").length, 1);
    assert.ok(visibleWidth(collapsed) <= visibleWidth("pi_subagent ") + 100);
    assert.match(collapsed, /Inspect retry handling/);
    assert.ok(!collapsed.includes("\\n"));
    assert.ok(render({ task }, true, 2000).includes(`task: ${JSON.stringify(task)}`));
  });

  test("keeps collapsed calls on one row across terminal resizes", () => {
    const component = createExtensionHarness().toolDefinition.renderCall(
      { task: "Investigate retry handling ".repeat(30) }, theme, { expanded: false });
    for (const width of [1, 8, 32, 80, 200, 32]) {
      const lines = component.render(width);
      assert.equal(lines.length, 1);
      assert.ok(visibleWidth(lines[0]) <= width);
      if (width >= 32) assert.match(stripVTControlCharacters(lines[0]), /^pi_subagent Investigate/);
    }
  });

  test("tolerates missing or incomplete streaming arguments, including web scope", () => {
    for (const args of [undefined, {}, { scope: ["src"] }, { task: null }]) assert.equal(render(args), "pi_subagent");
    const args = { task: "Inspect a public reference", scope: [], capability: "web", preset: "analysis-standard" };
    assert.equal(render(args), "pi_subagent Inspect a public reference");
    assert.match(render(args, true), /scope: \[\]/);
  });

  test("sanitizes terminal controls and fits Unicode previews in narrow terminals", () => {
    const args = { task: "조사\u001b[31m\u202e " + "경계😀 ".repeat(50), scope: ["src\u001b/file.ts"] };
    for (const expanded of [false, true]) {
      const rendered = render(args, expanded, 32);
      if (!expanded) assert.equal(rendered.split("\n").length, 1);
      assert.doesNotMatch(rendered, /\u001b\[31m|\u202e/);
      assert.doesNotMatch(stripVTControlCharacters(rendered), /\u001b/);
      for (const line of rendered.split("\n")) assert.ok(visibleWidth(line) <= 32);
      assert.doesNotMatch(rendered, /\ufffd/);
    }
  });
});

describe("pi-subagent result rendering", () => {
  for (const partialReason of [undefined, "tool_budget"] as const) {
    for (const truncated of [false, true]) {
      test(`${partialReason ?? "complete"} result with truncation=${truncated}`, () => {
        const harness = createExtensionHarness();
        const formatted = formatChildOutput(truncated ? "x".repeat(MAX_FINAL_BYTES * 2) : "answer", partialReason);
        const envelope = JSON.parse(formatted.text);
        const result = {
          content: [{ type: "text", text: formatted.text }],
          details: {
            status: envelope.status,
            outputTruncated: formatted.truncated,
            durationMs: 1000,
            contextTokens: 3072,
          },
        };
        const colors: string[] = [];
        const theme = { fg(color: string, text: string) { colors.push(color); return text; } };
        for (const expanded of [false, true]) {
          colors.length = 0;
          const component = harness.toolDefinition.renderResult(result, { expanded, isPartial: false }, theme);
          const rendered = component.render(200).join("\n");
          assert.match(rendered, partialReason ? /⚠ Partial/ : /✓ Complete/);
          assert.equal(rendered.includes("Output truncated"), truncated);
          assert.equal(colors.includes("warning"), truncated || !!partialReason);
          assert.equal(rendered.includes('"outputTruncated":'), expanded);
        }
        assert.equal(result.details.status, partialReason ? "partial" : "complete");
      });
    }
  }

  test("keeps streaming and metadata-free fallback output unchanged", () => {
    const harness = createExtensionHarness();
    const theme = { fg(_color: string, text: string) { return text; } };
    const result = { content: [{ type: "text", text: "progress or diagnostic" }] };
    for (const isPartial of [false, true]) {
      const component = harness.toolDefinition.renderResult(result, { expanded: false, isPartial }, theme);
      assert.equal(component.render(100).join("\n").trim(), "progress or diagnostic");
    }
  });
});

describe("pi-subagent cleanup usage", () => {
  for (const childFails of [false, true]) {
    for (const cleanupFails of [false, true]) {
      test(`preserves usage with child failure=${childFails}, cleanup failure=${cleanupFails}`, async () => {
        const usage = { ...emptyUsage(), input: 11, output: 7, totalTokens: 18 };
        const childResult: ChildResult = {
          output: formatChildOutput("answer").text, outputTruncated: false,
          status: "complete", durationMs: 1, contextTokens: 20, exitCode: 0, usage,
          budget: { version: 1, toolCallsAttempted: 0, toolCallsExecuted: 0, deniedCalls: 0,
            queryCount: 0, fetchTargetCount: 0, softLimitReached: false, hardLimitReached: false },
        };
        const childError = new ChildRunError(boundedParentError("child failed", { phase: "process" }), usage);
        let cleanupPath: Parameters<typeof rm>[0] | undefined;
        const harness = await startHarness({
          async runChild() {
            if (childFails) throw childError;
            return childResult;
          },
          async removeTempDirectory(path, options) {
            cleanupPath = path;
            assert.deepEqual(options, { recursive: true, force: true });
            if (cleanupFails) throw new Error("cleanup failed");
            await rm(path, options);
          },
        });
        const id = "cleanup-usage";
        await harness.fire("tool_call", { toolName: TOOL_NAME, toolCallId: id, input: {} });
        try {
          const execution = harness.toolDefinition.execute(id, {
            task: "lookup", scope: ["."], capability: "local", preset: "lookup-standard",
          }, undefined, undefined, { cwd: process.cwd(), modelRegistry: {
            find: () => ({ provider: "test", id: "test", api: "openai-completions", reasoning: true }),
          } });
          if (childFails || cleanupFails) {
            await assert.rejects(execution, (error: Error) => {
              if (childFails) assert.equal(error.message, childError.message);
              else assert.match(error.message, /"phase":"cleanup"/);
              return true;
            });
            assert.deepEqual(await harness.fire("tool_result", toolEvent(id, true)), { usage });
          } else {
            const result = await execution;
            assert.deepEqual(result.usage, usage);
            assert.deepEqual(result.details.usage, usage);
            assert.equal(result.content[0].text, childResult.output);
          }
          assert.ok(cleanupPath, "temporary directory cleanup was attempted");
          assert.equal(await harness.fire("tool_result", toolEvent(id, true)), undefined,
            "failure usage is attached only once, never leaked from a successful call");
        } finally {
          if (cleanupPath) await rm(cleanupPath, { recursive: true, force: true });
        }
      });
    }
  }
});

describe("pi-subagent extension wiring", () => {
  test("registers settings as a user command, not a model tool", () => {
    const harness = createExtensionHarness();
    assert.deepEqual([...harness.commands.keys()], ["pi-subagent-settings"]);
    assert.equal(harness.toolDefinition.name, TOOL_NAME);
    assert.equal(typeof harness.commands.get("pi-subagent-settings").handler, "function");
  });
  test("preflight uses configured provider and full model ID before starting a child", async () => {
    const file = join(agentDir, "pi-subagent.json");
    await writeFile(file, JSON.stringify({ presets: {
      "review-standard": { provider: "openrouter", model: "anthropic/claude-sonnet-4.5", thinking: "high" },
    } }));
    try {
      const harness = await startHarness();
      await harness.fire("tool_call", { toolName: TOOL_NAME, toolCallId: "configured", input: {} });
      let checked = false;
      await assert.rejects(harness.toolDefinition.execute("configured", {
        task: "lookup", scope: ["."], capability: "local", preset: "review-standard",
      }, undefined, undefined, { cwd: process.cwd(), modelRegistry: { find(provider: string, id: string) {
        assert.equal(provider, "openrouter");
        assert.equal(id, "anthropic/claude-sonnet-4.5");
        checked = true;
        return { reasoning: false }; // high is unsupported; no child or network request starts
      } } }), /thinking level is unsupported/);
      assert.equal(checked, true);
    } finally { await rm(file); }
  });
  test("describes web mode without promising credential-isolated public-only access", async () => {
    const harness = await startHarness();
    const capability = harness.toolDefinition.parameters.properties.capability;
    assert.match(capability.description, /web research tools only/);
    assert.match(capability.description, /not a credential-isolated sandbox/);
    assert.doesNotMatch(capability.description, /public web only/);
  });

  test("rejects duplicate execution before the first preflight finishes", async () => {
    const harness = await startHarness();
    const id = "duplicate";
    const params = { task: "lookup", scope: ["."], capability: "local", preset: "lookup-standard" };
    await harness.fire("tool_call", { toolName: TOOL_NAME, toolCallId: id, input: {} });
    let duplicate: Promise<unknown> | undefined;
    const ctx = {
      cwd: process.cwd(),
      modelRegistry: { find: () => {
        duplicate = assert.rejects(
          () => harness.toolDefinition.execute(id, params, undefined, undefined, ctx),
          /at most 3 model-selected calls/,
        );
        return undefined;
      } },
    };
    await assert.rejects(
      () => harness.toolDefinition.execute(id, params, undefined, undefined, ctx),
      /Configured subagent model is unavailable/,
    );
    assert.ok(duplicate);
    await duplicate;
  });

  for (const event of ["agent_settled", "session_shutdown"]) {
    test(`${event} invalidates an unused execution permit`, async () => {
      const harness = await startHarness();
      await harness.fire("tool_call", { toolName: TOOL_NAME, toolCallId: "stale", input: {} });
      await harness.fire(event);
      await assert.rejects(
        () => harness.toolDefinition.execute("stale", {}, undefined, undefined, {}),
        /at most 3 model-selected calls/,
      );
    });
  }

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
