import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getCurrentTools } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import childGuard from "./child-guard.ts";
import {
  ALLOWED_FILE_TOOLS, BUDGET_TELEMETRY_ENV, CHILD_GUARD_EXIT_CODES, LIFETIME_TOOL_CALL_LIMITS,
  MODEL_SELECTION_ENV, POLICY_ENV, READY_ENV, runtimeFilesIn, SOFT_DEADLINE_ENV,
} from "./shared.ts";
import { buildChildPolicy } from "./path-policy.ts";
import { assistantMessage, createOfflineSession, offlineModel, setEnv, streamMessage } from "./test-support.ts";

const model = offlineModel("offline-budget", "Offline Budget");

// The parent labels tool_budget results only from persisted telemetry. Pi records
// tool_execution_start handler errors and continues, so a lost hard-limit snapshot
// must still stop tools and must not let the child finish with an answer.
for (const failure of ["once", "persistent"] as const) {
  test(`real Pi session cannot finish after a ${failure} hard-limit telemetry write failure`, { timeout: 30_000 }, async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pi-subagent-budget-")));
    const files = runtimeFilesIn(root);
    const writeFileSync = fs.writeFileSync;
    let failedWrites = 0;
    t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
      if (String(args[0]) === files.budgetTelemetry && String(args[1]).includes('"hardLimitReached":true')
        && (failure === "persistent" || failedWrites === 0)) {
        failedWrites++;
        throw Object.assign(new Error("synthetic telemetry write failure"), { code: "EIO" });
      }
      return writeFileSync(...args);
    });
    syncBuiltinESMExports();
    // The guard exits synchronously before transmission. Record the code and stop
    // serving responses, as the terminated child process would.
    const exits: number[] = [];
    t.mock.method(process, "exit", ((code?: number | string | null) => {
      exits.push(Number(code ?? 0));
    }) as typeof process.exit);
    const restoreEnv = setEnv({
      [POLICY_ENV]: files.policy,
      [READY_ENV]: files.ready,
      [BUDGET_TELEMETRY_ENV]: files.budgetTelemetry,
      [SOFT_DEADLINE_ENV]: String(Date.now() + 60_000),
      [MODEL_SELECTION_ENV]: JSON.stringify({ model: `${model.provider}/${model.id}`, thinking: "off" }),
    });
    let session: AgentSession | undefined;
    try {
      await writeFile(join(root, "evidence.txt"), "Synthetic evidence\n");
      await writeFile(files.policy, JSON.stringify(await buildChildPolicy(root, ["evidence.txt"], "local")), { mode: 0o600 });
      session = await createOfflineSession({
        root, model, tools: [...ALLOWED_FILE_TOOLS], systemPrompt: "Offline budget test.",
        extensionFactories: [(pi) => childGuard(pi, () => () => undefined)],
      });
      await session.bindExtensions({ onError: () => undefined });
      const hardLimit = LIFETIME_TOOL_CALL_LIMITS.local.hard;
      let reads = 0;
      let finalAnswers = 0;
      let requests = 0;
      session.subscribe((event) => {
        if (event.type === "tool_execution_end" && event.toolName === "read" && !event.isError) reads++;
      });
      session.agent.streamFunction = (_model, context) => {
        requests++;
        // Replacing the stream function bypasses Pi's provider hook; dispatch it as the CLI would.
        void session!.extensionRunner!.emitBeforeProviderRequest({});
        const message = assistantMessage(model, "stop", [{ type: "text", text: "Final answer based on evidence." }]);
        if (exits.length > 0) {
          message.stopReason = "error";
          message.errorMessage = "guard exited";
          message.content = [];
        } else if (getCurrentTools(context.messages).length > 0 && requests <= hardLimit + 10) {
          message.stopReason = "toolUse";
          message.content = [{ type: "toolCall", id: `read-${requests}`, name: "read", arguments: { path: "evidence.txt" } }];
        } else {
          finalAnswers++;
        }
        return streamMessage(message);
      };
      await session.prompt("Read the synthetic evidence repeatedly.");
      assert.ok(failedWrites > 0, "the hard-limit snapshot write must have been attempted");
      assert.equal(reads, hardLimit, "no read may execute beyond the hard limit");
      assert.equal(finalAnswers, 0, "the child must not answer while the guard accepts provider requests");
      assert.ok(exits.every((code) => code === CHILD_GUARD_EXIT_CODES.runtime), JSON.stringify(exits));
      // A persistent failure leaves Pi able to request another turn; the guard must end it.
      if (failure === "persistent") assert.ok(exits.length > 0, "the next provider request must exit");
    } finally {
      await session?.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
      session?.dispose();
      t.mock.restoreAll();
      syncBuiltinESMExports();
      restoreEnv();
      await rm(root, { recursive: true, force: true });
    }
  });
}
