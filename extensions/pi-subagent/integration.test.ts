import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { ChildRunError, runChild } from "./subprocess.ts";
import { buildChildPolicy, MAX_FINAL_BYTES, MAX_PARENT_ERROR_BYTES } from "./shared.ts";

const FAKE_CHILD = fileURLToPath(new URL("./fixtures/fake-child.mjs", import.meta.url));
const ABRUPT_PARENT = fileURLToPath(new URL("./fixtures/abrupt-parent.mjs", import.meta.url));

async function withFixture<T>(scenario: string, run: (options: Parameters<typeof runChild>[0]) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-integration-"));
  try {
    const policy = await buildChildPolicy(root, ["."], "local");
    const policyFile = join(root, "policy.json");
    const readyFile = join(root, "guard.ready");
    await writeFile(policyFile, JSON.stringify(policy), { encoding: "utf8", mode: 0o600 });
    return await run({
      policy,
      policyFile,
      readyFile,
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
    assert.equal(result.output, "The completed portion remains useful. Coverage is incomplete.");
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
