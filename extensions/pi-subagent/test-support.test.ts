import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ModelRuntime, type AgentSession } from "@earendil-works/pi-coding-agent";
import { createOfflineSession, offlineModel } from "./test-support.ts";

test("offline session refresh cannot recreate a disposed fixture's directory", { timeout: 15_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-offline-session-"));
  const refresh = ModelRuntime.prototype.refresh;
  const pending: ReturnType<typeof refresh>[] = [];
  let resumeRefresh!: () => void;
  const gate = new Promise<void>((resolve) => { resumeRefresh = resolve; });
  let initialRefresh = true;
  t.mock.method(ModelRuntime.prototype, "refresh", function (
    this: ModelRuntime, options: Parameters<typeof refresh>[0],
  ) {
    if (initialRefresh) {
      initialRefresh = false;
      return refresh.call(this, options);
    }
    const operation = gate.then(() => refresh.call(this, options));
    pending.push(operation);
    return operation;
  });
  let session: AgentSession | undefined;
  try {
    session = await createOfflineSession({
      root, model: offlineModel("offline-cleanup", "Offline cleanup"),
      tools: [], systemPrompt: "Offline cleanup test.",
    });
    assert.ok(pending.length > 0, "provider registration must start a background refresh");
    session.dispose();
    session = undefined;
    await rm(root, { recursive: true, force: true });
    resumeRefresh();
    for (const result of await Promise.all(pending)) assert.equal(result.errors.size, 0);
    await assert.rejects(readdir(root), { code: "ENOENT" });
  } finally {
    resumeRefresh();
    await Promise.allSettled(pending);
    session?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
