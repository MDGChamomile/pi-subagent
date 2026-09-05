import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Message, Model } from "@earendil-works/pi-ai";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { ChildRunError, emptyUsage, runChild, type ChildResult } from "./subprocess.ts";
import { buildChildPolicy, MAX_FINAL_BYTES, MAX_PARENT_ERROR_BYTES } from "./shared.ts";

const FAKE_CHILD = fileURLToPath(new URL("./fixtures/fake-child.mjs", import.meta.url));
const ABRUPT_PARENT = fileURLToPath(new URL("./fixtures/abrupt-parent.mjs", import.meta.url));

async function withFixture<T>(scenario: string, run: (options: Parameters<typeof runChild>[0]) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-integration-"));
  try {
    const policy = await buildChildPolicy(root, ["."], "local");
    const policyFile = join(root, "policy.json");
    const readyFile = join(root, "guard.ready");
    const budgetTelemetryFile = join(root, "budget-telemetry.json");
    await writeFile(policyFile, JSON.stringify(policy), { encoding: "utf8", mode: 0o600 });
    return await run({
      policy,
      policyFile,
      readyFile,
      budgetTelemetryFile,
      task: "Inspect the deterministic fixture and return the requested final answer.",
      model: "test/fake",
      thinking: "low",
      invocationOverride: {
        command: process.execPath,
        args: ["--experimental-strip-types", FAKE_CHILD, scenario],
      },
      timeoutMs: 2_000,
      killGraceMs: 50,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function modelVisibleOutput(result: ChildResult): string {
  const model: Model<"openai-codex-responses"> = {
    id: "test-parent",
    name: "Test Parent",
    provider: "openai-codex",
    api: "openai-codex-responses",
    baseUrl: "https://example.invalid",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 16_000,
    maxTokens: 1_000,
  };
  // Mirror index.ts's content/details boundary, then use Pi's real provider serializer.
  // No provider request is made; details are deliberately invisible to the parent model.
  const messages: Message[] = [{
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason: "toolUse",
    usage: emptyUsage(),
    timestamp: 0,
    content: [{ type: "toolCall", id: "child-call", name: "pi_subagent", arguments: {} }],
  }, {
    role: "toolResult",
    toolCallId: "child-call",
    toolName: "pi_subagent",
    content: [{ type: "text", text: result.output }],
    details: { status: result.status, partialReason: result.partialReason },
    isError: false,
    timestamp: 0,
  }];
  const serialized = convertResponsesMessages(model, { messages }, new Set([model.provider]));
  const toolOutput = serialized.find((item) => item.type === "function_call_output");
  assert.ok(toolOutput?.type === "function_call_output" && typeof toolOutput.output === "string");
  assert.equal("details" in toolOutput, false);
  assert.equal(result.contextTokens, Math.ceil(toolOutput.output.length / 4));
  return toolOutput.output;
}

async function waitForProcessExit(pid: number, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`process ${pid} remained alive after parent exit`);
}

describe("pi-subagent spawned-child integration", () => {
  test("returns only the final assistant answer from a real child process", async () => {
    const result = await withFixture("success", (options) => runChild(options));
    assert.equal(result.output, "Only this final assistant answer may reach the parent.");
    assert.equal(result.status, "complete");
    assert.equal(result.partialReason, undefined);
    assert.equal(modelVisibleOutput(result), "Only this final assistant answer may reach the parent.");
    assert.doesNotMatch(result.output, /intermediate|noisy child/);
    assert.equal(result.contextTokens, Math.ceil(result.output.length / 4));
    assert.equal(result.usage.totalTokens, 48);
  });

  test("runtime-labels an answer completed after the soft deadline as partial", async () => {
    const result = await withFixture("partial-success", (options) => runChild({
      ...options,
      timeoutMs: 500,
      killGraceMs: 50,
    }));
    assert.equal(result.status, "partial");
    assert.equal(result.partialReason, "time_limit");
    assert.equal(modelVisibleOutput(result),
      "[Subagent partial: time_limit]\n\nThe completed portion remains useful. Coverage is incomplete.");
  });

  test("passes a budget termination to the parent as partial with numeric telemetry", async () => {
    const result = await withFixture("budget-partial", (options) => runChild(options));
    assert.equal(result.status, "partial");
    assert.equal(result.partialReason, "tool_budget");
    assert.equal(result.budget.hardLimitReached, true);
    assert.equal(result.budget.toolCallsAttempted, 0);
    assert.equal(modelVisibleOutput(result), "[Subagent partial: tool_budget]\n\nThe primary cause is X.");
  });

  test("labels token-limited text as partial even when the tool budget was also exhausted", async () => {
    for (const scenario of ["length-output", "budget-length-output"]) {
      const result = await withFixture(scenario, (options) => runChild(options));
      assert.equal(result.status, "partial");
      assert.equal(result.partialReason, "model_length");
      assert.equal(result.stopReason, "length");
      assert.equal(result.budget.hardLimitReached, scenario === "budget-length-output");
      assert.equal(result.outputTruncated, false); // Only the parent's byte cap sets this flag.
      assert.equal(modelVisibleOutput(result),
        "[Subagent partial: model_length]\n\nThe primary cause is X, but the second cause is");
    }
  });

  test("accepts a recovered final answer without retaining the earlier length stop", async () => {
    const result = await withFixture("length-recovered", (options) => runChild(options));
    assert.equal(result.status, "complete");
    assert.equal(result.partialReason, undefined);
    assert.equal(result.stopReason, "stop");
    assert.equal(modelVisibleOutput(result), "Recovered concise final answer.");
    assert.equal(result.usage.totalTokens, 32);
  });

  test("does not turn an empty length-limited answer into a status-only success", async () => {
    await assert.rejects(
      () => withFixture("length-empty-output", (options) => runChild(options)),
      /finished without a final assistant answer/,
    );
  });

  test("keeps the partial status visible within the UTF-8 final-output cap", async () => {
    const result = await withFixture("budget-oversized-output", (options) => runChild(options));
    const output = modelVisibleOutput(result);
    assert.equal(result.status, "partial");
    assert.equal(result.outputTruncated, true);
    assert.ok(Buffer.byteLength(output, "utf8") <= MAX_FINAL_BYTES);
    assert.equal(output.includes("�"), false);
    assert.match(output, /^\[Subagent partial: tool_budget\]\n\n가/);
    assert.match(output, /\[Subagent output truncated\]$/);
  });

  test("sanitizes and truncates a large plain final answer at the parent boundary", async () => {
    const result = await withFixture("oversized-output", (options) => runChild(options));
    assert.equal(result.outputTruncated, true);
    assert.ok(Buffer.byteLength(result.output, "utf8") <= MAX_FINAL_BYTES);
    assert.equal(result.output.includes("�"), false);
    assert.match(result.output, /Subagent output truncated/);
  });

  test("records bounded diagnostics when a zero-exit child has no final answer", async () => {
    await assert.rejects(
      () => withFixture("empty-output", (options) => runChild(options)),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /finished without a final assistant answer/);
        assert.match(message, /Subagent diagnostics/);
        assert.match(message, /"phase":"output"/);
        assert.match(message, /"exitCode":0/);
        assert.match(message, /"stopReason":"stop"/);
        assert.match(message, /"lastAssistantMode":"empty"/);
        return true;
      },
    );
  });

  test("bounds and sanitizes provider errors from a real child process", async () => {
    let message = "";
    try {
      await withFixture("provider-error", (options) => runChild(options));
      assert.fail("provider-error fixture unexpectedly succeeded");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert.ok(Buffer.byteLength(message, "utf8") <= MAX_PARENT_ERROR_BYTES);
    assert.doesNotMatch(message, /\u001b|\u202e/);
    assert.match(message, /Subagent error truncated/);
    assert.match(message, /Subagent diagnostics/);
    assert.match(message, /"phase":"model"/);
    assert.match(message, /"stopReason":"error"/);
  });

  test("discards child stderr on process failure", async () => {
    await assert.rejects(
      () => withFixture("process-error", (options) => runChild(options)),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /Subagent exited with code 7/);
        assert.match(message, /"phase":"process"/);
        assert.doesNotMatch(message, /private child stderr/);
        return true;
      },
    );
  });

  test("terminates a child process that ignores the timeout SIGTERM", async () => {
    const startedAt = Date.now();
    await assert.rejects(
      () => withFixture("timeout", (options) => runChild({ ...options, timeoutMs: 50, killGraceMs: 50 })),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /timed out after 50 milliseconds/);
        assert.match(message, /"phase":"timeout"/);
        return true;
      },
    );
    assert.ok(Date.now() - startedAt < 2_000);
  });

  test("preserves reported usage when a started child later times out", async () => {
    await assert.rejects(
      () => withFixture("timeout-after-usage", (options) => runChild({ ...options, timeoutMs: 200, killGraceMs: 50 })),
      (error: unknown) => {
        assert.ok(error instanceof ChildRunError);
        assert.equal(error.usage.totalTokens, 16);
        assert.equal(error.usage.input, 10);
        assert.equal(error.usage.cost.total, 0.034);
        assert.match(error.message, /"phase":"timeout"/);
        return true;
      },
    );
  });

  test("terminates a running child when the parent aborts", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(
      () => withFixture("timeout", (options) => runChild({ ...options, signal: controller.signal })),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /cancelled/);
        assert.match(message, /"phase":"cancelled"/);
        return true;
      },
    );
  });

  test("terminates the child process group when its parent exits abruptly", {
    skip: process.platform === "win32",
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-subagent-parent-exit-"));
    const pidFile = join(root, "pids.json");
    let childPid: number | undefined;
    let descendantPid: number | undefined;
    try {
      let stderr = "";
      const exitCode = await new Promise<number>((resolve, reject) => {
        const helper = spawn(process.execPath, [
          "--experimental-strip-types",
          ABRUPT_PARENT,
          root,
          pidFile,
        ], { stdio: ["ignore", "ignore", "pipe"] });
        helper.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
        helper.once("error", reject);
        helper.once("close", (code) => resolve(code ?? 1));
      });
      assert.equal(exitCode, 0, stderr);
      ({ childPid, descendantPid } = JSON.parse(await readFile(pidFile, "utf8")) as {
        childPid: number;
        descendantPid: number;
      });
      await Promise.all([
        waitForProcessExit(childPid),
        waitForProcessExit(descendantPid),
      ]);
      await assert.rejects(readFile(join(root, "policy.json"), "utf8"), { code: "ENOENT" });
      await assert.rejects(readFile(join(root, "guard.ready"), "utf8"), { code: "ENOENT" });
      await assert.rejects(readFile(join(root, "budget-telemetry.json"), "utf8"), { code: "ENOENT" });
    } finally {
      if (childPid) {
        try { process.kill(-childPid, "SIGKILL"); } catch {}
      }
      if (descendantPid) {
        try { process.kill(descendantPid, "SIGKILL"); } catch {}
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});
