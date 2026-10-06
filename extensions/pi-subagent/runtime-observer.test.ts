import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import observeRuntime from "./scripts/observe-runtime.ts";

const TARGET = "https://fixture.invalid/expected";
const PRIVATE = "synthetic-private-content";

async function harness(actor: "child" | "parent", run: (emit: (name: string, event: any, ctx?: any) => void,
  rows: () => Promise<any[]>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-observer-test-"));
  const trace = join(root, "trace.jsonl");
  const keys = ["PI_SUBAGENT_EVAL_TRACE_FILE", "PI_SUBAGENT_EVAL_FETCH_URL", "PI_SUBAGENT_POLICY_FILE"];
  const previous = keys.map((key) => process.env[key]);
  try {
    process.env.PI_SUBAGENT_EVAL_TRACE_FILE = trace;
    process.env.PI_SUBAGENT_EVAL_FETCH_URL = TARGET;
    if (actor === "child") process.env.PI_SUBAGENT_POLICY_FILE = "synthetic-policy";
    else delete process.env.PI_SUBAGENT_POLICY_FILE;
    const handlers = new Map<string, (event: any, ctx?: any) => void>();
    observeRuntime({ on(name: string, handler: (event: any, ctx?: any) => void) { handlers.set(name, handler); } } as any);
    await run((name, event, ctx) => handlers.get(name)?.(event, ctx), async () => {
      try { return (await readFile(trace, "utf8")).trim().split("\n").map((line) => JSON.parse(line)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    });
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
    await rm(root, { recursive: true, force: true });
  }
}

const result = () => ({
  content: [{ type: "text", text: PRIVATE }],
  details: { urls: [TARGET], urlCount: 1, successful: 1, totalChars: 42, responseId: PRIVATE, title: PRIVATE },
});

function fetch(emit: (name: string, event: any) => void, id: string, args: any, value: any = result(), isError = false) {
  emit("tool_execution_start", { toolCallId: id, toolName: "fetch_content", args });
  emit("tool_execution_end", { toolCallId: id, toolName: "fetch_content", result: value, isError });
}

test("provider observer records mismatches without claiming to block transmission", async () => {
  await harness("child", async (emit, rows) => {
    emit("before_provider_request", {
      payload: { model: "wire-other", reasoning: { effort: "low" }, privateInput: PRIVATE },
    }, { model: { provider: "offline", id: "expected" }, thinkingLevel: "high" });
    assert.deepEqual(await rows(), [{ actor: "child", kind: "request", model: "offline/expected",
      thinking: "high", wireModel: "wire-other", wireThinking: "low" }]);
    assert.equal(JSON.stringify(await rows()).includes(PRIVATE), false);
  });
});

test("web observer accepts single-target success and persists only content-free booleans", async () => {
  await harness("child", async (emit, rows) => {
    fetch(emit, "single", { url: TARGET, privateInput: PRIVATE });
    fetch(emit, "array", { urls: [TARGET] });
    assert.deepEqual(await rows(), Array.from({ length: 2 }, () => ({
      actor: "child", kind: "web_fetch", targetMatch: true, success: true,
    })));
    assert.equal(JSON.stringify(await rows()).includes(PRIVATE), false);
    assert.equal(JSON.stringify(await rows()).includes(TARGET), false);
  });
});

test("web observer rejects final tool errors, extraction failures, and incomplete success metadata", async () => {
  await harness("child", async (emit, rows) => {
    fetch(emit, "tool-error", { url: TARGET }, result(), true);
    fetch(emit, "blocked", { url: TARGET }, {}, true);
    for (const [key, value] of [
      ["successful", 0], ["successful", "1"], ["urlCount", 2], ["urls", ["https://fixture.invalid/other"]],
      ["urls", [TARGET, "https://fixture.invalid/other"]], ["totalChars", 0], ["totalChars", "42"],
      ["error", PRIVATE],
    ] as const) {
      const changed = result();
      (changed.details as Record<string, unknown>)[key] = value;
      fetch(emit, String(key), { url: TARGET }, changed);
    }
    fetch(emit, "missing", { url: TARGET }, {});
    assert.equal((await rows()).length, 11);
    assert.ok((await rows()).every((row) => row.targetMatch === true && row.success === false));
  });
});

test("web observer correlates overlapping calls and ignores unstarted or duplicate completions", async () => {
  await harness("child", async (emit, rows) => {
    emit("tool_execution_start", { toolCallId: "target", toolName: "fetch_content", args: { url: TARGET } });
    emit("tool_execution_start", { toolCallId: "other", toolName: "fetch_content", args: { url: "https://fixture.invalid/other" } });
    emit("tool_execution_end", { toolCallId: "other", toolName: "fetch_content", result: result(), isError: false });
    emit("tool_execution_end", { toolCallId: "target", toolName: "fetch_content", result: result(), isError: false });
    emit("tool_execution_end", { toolCallId: "target", toolName: "fetch_content", result: result(), isError: false });
    emit("tool_execution_end", { toolCallId: "unstarted", toolName: "fetch_content", result: result(), isError: false });
    fetch(emit, "batch", { urls: [TARGET, "https://fixture.invalid/other"] });
    assert.deepEqual((await rows()).map((row) => row.targetMatch), [false, true, false]);
  });
});

test("parent fetches and other child tools cannot supply web smoke evidence", async () => {
  await harness("parent", async (emit, rows) => {
    fetch(emit, "parent", { url: TARGET });
    assert.deepEqual(await rows(), []);
  });
  await harness("child", async (emit, rows) => {
    emit("tool_execution_start", { toolCallId: "search", toolName: "web_search", args: { url: TARGET } });
    emit("tool_execution_end", { toolCallId: "search", toolName: "web_search", result: result(), isError: false });
    assert.deepEqual(await rows(), []);
  });
});
