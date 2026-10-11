import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream, getCurrentTools, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import childGuard from "./child-guard.ts";
import { emptyUsage } from "./child-stream.ts";
import {
  ALLOWED_FILE_TOOLS, BUDGET_TELEMETRY_ENV, CHILD_GUARD_EXIT_CODES, LIFETIME_TOOL_CALL_LIMITS,
  MODEL_SELECTION_ENV, POLICY_ENV, READY_ENV, SOFT_DEADLINE_ENV,
} from "./shared.ts";
import { buildChildPolicy } from "./path-policy.ts";

// The configured test loader selects the bundled SDK when available.
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const model: Model<"openai-completions"> = {
  id: "offline-budget", name: "Offline Budget", provider: "offline-test", api: "openai-completions",
  baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16_000, maxTokens: 1_000,
};

// The parent labels tool_budget results only from persisted telemetry. Pi records
// tool_execution_start handler errors and continues, so a lost hard-limit snapshot
// must still stop tools and must not let the child finish with an answer.
for (const failure of ["once", "persistent"] as const) {
  test(`real Pi session cannot finish after a ${failure} hard-limit telemetry write failure`, { timeout: 30_000 }, async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pi-subagent-budget-")));
    const env = {
      [POLICY_ENV]: join(root, "policy.json"),
      [READY_ENV]: join(root, "guard.ready"),
      [BUDGET_TELEMETRY_ENV]: join(root, "budget.json"),
      [SOFT_DEADLINE_ENV]: String(Date.now() + 60_000),
      [MODEL_SELECTION_ENV]: JSON.stringify({ model: `${model.provider}/${model.id}`, thinking: "off" }),
    };
    const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
    const writeFileSync = fs.writeFileSync;
    let failedWrites = 0;
    t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
      if (String(args[0]) === env[BUDGET_TELEMETRY_ENV] && String(args[1]).includes('"hardLimitReached":true')
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
    let session: AgentSession | undefined;
    try {
      await writeFile(join(root, "evidence.txt"), "Synthetic evidence\n");
      await writeFile(env[POLICY_ENV]!, JSON.stringify(await buildChildPolicy(root, ["evidence.txt"], "local")), { mode: 0o600 });
      Object.assign(process.env, env);
      const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
      const resourceLoader = new DefaultResourceLoader({
        cwd: root, agentDir: root, settingsManager,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        systemPrompt: "Offline budget test.",
        extensionFactories: [(pi) => childGuard(pi, () => () => undefined)],
      });
      await resourceLoader.reload();
      assert.deepEqual(resourceLoader.getExtensions().errors, []);
      const modelRuntime = await ModelRuntime.create({
        authPath: join(root, "auth.json"), modelsPath: join(root, "models.json"),
        modelsStorePath: join(root, "model-store.json"), allowModelNetwork: false,
      });
      modelRuntime.registerProvider(model.provider, {
        api: model.api, baseUrl: model.baseUrl, apiKey: "offline-placeholder", models: [model],
      });
      ({ session } = await createAgentSession({
        cwd: root, agentDir: root, model, modelRuntime, resourceLoader, settingsManager,
        sessionManager: SessionManager.inMemory(root), tools: [...ALLOWED_FILE_TOOLS], thinkingLevel: "off",
      }));
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
        const message: AssistantMessage = {
          role: "assistant", api: model.api, provider: model.provider, model: model.id,
          usage: emptyUsage(), timestamp: Date.now(), stopReason: "stop",
          content: [{ type: "text", text: "Final answer based on evidence." }],
        };
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
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          if (message.stopReason === "error") stream.push({ type: "error", reason: "error", error: message });
          else stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
        });
        return stream;
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
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
}
