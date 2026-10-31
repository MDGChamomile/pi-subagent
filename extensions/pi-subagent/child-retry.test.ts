import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getCurrentTools } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import childGuard from "./child-guard.ts";
import {
  ALLOWED_FILE_TOOLS, BUDGET_TELEMETRY_ENV, POLICY_ENV, READY_ENV, runtimeFilesIn, SOFT_DEADLINE_ENV,
} from "./shared.ts";
import { buildChildPolicy } from "./path-policy.ts";
import { assistantMessage, createOfflineSession, offlineModel, setEnv, streamMessage } from "./test-support.ts";

const model = offlineModel("offline-retry", "Offline Retry");

// Exercise Pi's real post-agent retry/continuation handling, not a copied event loop.
for (const scenario of ["retry", "length"] as const) {
  test(`real Pi session preserves guard lifecycle across ${scenario}`, { timeout: 15_000 }, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pi-subagent-retry-")));
    const files = runtimeFilesIn(root);
    const restoreEnv = setEnv({
      [POLICY_ENV]: files.policy,
      [READY_ENV]: files.ready,
      [BUDGET_TELEMETRY_ENV]: files.budgetTelemetry,
      [SOFT_DEADLINE_ENV]: String(Date.now() + 60_000),
    });
    let session: AgentSession | undefined;
    try {
      await writeFile(join(root, "evidence.txt"), "Synthetic evidence\n");
      await writeFile(files.policy, JSON.stringify(await buildChildPolicy(root, ["evidence.txt"], "local")), { mode: 0o600 });
      session = await createOfflineSession({
        root, model, tools: [...ALLOWED_FILE_TOOLS], systemPrompt: "Offline lifecycle test.",
        settings: { compaction: { enabled: false }, retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
        extensionFactories: [(pi) => childGuard(pi, () => () => undefined)],
      });
      const extensionErrors: unknown[] = [];
      await session.bindExtensions({ onError: (error) => { extensionErrors.push(error); } });
      let requests = 0;
      let retries = 0;
      let reads = 0;
      session.subscribe((event) => {
        if (event.type === "auto_retry_start") retries++;
        if (event.type === "tool_execution_end" && event.toolName === "read") {
          assert.equal(event.isError, false);
          reads++;
        }
      });
      session.agent.streamFunction = (_model, context) => {
        requests++;
        assert.ok(requests <= 3, "unexpected extra continuation");
        const activeTools = getCurrentTools(context.messages).map((tool) => tool.name);
        if (scenario === "retry" || requests === 1) assert.deepEqual(activeTools.sort(), [...ALLOWED_FILE_TOOLS].sort());
        else assert.deepEqual(activeTools, []);
        const message = assistantMessage(model, "stop", [{ type: "text", text: "Final answer based on evidence." }]);
        if (requests === 1) {
          message.stopReason = scenario === "retry" ? "error" : "length";
          message.content = [{ type: "text", text: "Incomplete answer" }];
          if (scenario === "retry") message.errorMessage = "503 service unavailable";
        } else if (scenario === "retry" && requests === 2) {
          message.stopReason = "toolUse";
          message.content = [{ type: "toolCall", id: "retry-read", name: "read", arguments: { path: "evidence.txt" } }];
        }
        return streamMessage(message);
      };
      await session.prompt("Read the synthetic evidence and answer.");
      assert.equal(requests, scenario === "retry" ? 3 : 2, JSON.stringify({ messages: session.messages, extensionErrors }));
      assert.equal(retries, scenario === "retry" ? 1 : 0);
      assert.equal(reads, scenario === "retry" ? 1 : 0);
      assert.equal(session.getLastAssistantText(), "Final answer based on evidence.");
      assert.deepEqual(extensionErrors, []);
      const budget = JSON.parse(await readFile(files.budgetTelemetry, "utf8"));
      assert.equal(budget.toolCallsExecuted, reads);
      assert.equal(budget.hardLimitReached, false);
    } finally {
      // Release the guard timer before deleting its temporary runtime files.
      await session?.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
      session?.dispose();
      restoreEnv();
      await rm(root, { recursive: true, force: true });
    }
  });
}
