import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { runChild } from "./subprocess.ts";
import { buildChildPolicy, MAX_PARENT_ERROR_BYTES } from "./shared.ts";

const FAKE_CHILD = fileURLToPath(new URL("./fixtures/fake-child.mjs", import.meta.url));

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
      task: "Inspect the deterministic fixture and submit the requested report.",
      model: "test/fake",
      thinking: "low",
      invocationOverride: { command: process.execPath, args: [FAKE_CHILD, scenario] },
      timeoutMs: 2_000,
      killGraceMs: 50,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("pi-subagent spawned-child integration", () => {
  test("returns only the structured report from a real child process", async () => {
    const result = await withFixture("success", (options) => runChild(options));
    assert.deepEqual(JSON.parse(result.output), {
      conclusion: "Only this structured report may reach the parent.",
      findings: [],
    });
    assert.doesNotMatch(result.output, /intermediate|noisy child/);
    assert.equal(result.usage.totalTokens, 48);
  });

  test("records bounded diagnostics when a zero-exit child never submits the report tool", async () => {
    await assert.rejects(
      () => withFixture("missing-report", (options) => runChild(options)),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /exactly one structured final report; received 0/);
        assert.match(message, /Subagent diagnostics/);
        assert.match(message, /"phase":"report"/);
        assert.match(message, /"exitCode":0/);
        assert.match(message, /"stopReason":"stop"/);
        assert.match(message, /"lastAssistantMode":"text"/);
        assert.match(message, /"reportAttempts":0/);
        assert.match(message, /"reportSuccesses":0/);
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
});
