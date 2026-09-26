import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import childGuard from "./child-guard.ts";
import { emptyUsage } from "./subprocess.ts";
import { ALLOWED_FILE_TOOLS, BUDGET_TELEMETRY_ENV, buildChildPolicy, POLICY_ENV, READY_ENV, SOFT_DEADLINE_ENV } from "./shared.ts";

// Match package-discovery.mjs: 0.85.0's unbundled SDK imports undeclared pi-server.
const sdkEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const bundledEntry = new URL("./bundle/index.js", sdkEntry);
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } =
  await import(existsSync(bundledEntry) ? bundledEntry.href : sdkEntry) as typeof import("@earendil-works/pi-coding-agent");

const model: Model<"openai-completions"> = {
  id: "offline-retry", name: "Offline Retry", provider: "offline-test", api: "openai-completions",
  baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16_000, maxTokens: 1_000,
};

// Exercise Pi's real post-agent retry/continuation handling, not a copied event loop.
for (const scenario of ["retry", "length"] as const) {
  test(`real Pi session preserves guard lifecycle across ${scenario}`, { timeout: 15_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-subagent-retry-"));
    const env = {
      [POLICY_ENV]: join(root, "policy.json"),
      [READY_ENV]: join(root, "guard.ready"),
      [BUDGET_TELEMETRY_ENV]: join(root, "budget.json"),
      [SOFT_DEADLINE_ENV]: String(Date.now() + 60_000),
    };
    const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
    let session: AgentSession | undefined;
    try {
      await writeFile(join(root, "evidence.txt"), "Synthetic evidence\n");
      await writeFile(env[POLICY_ENV]!, JSON.stringify(await buildChildPolicy(root, ["evidence.txt"], "local")), { mode: 0o600 });
      Object.assign(process.env, env);
      const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: false }, retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
      });
      const resourceLoader = new DefaultResourceLoader({
        cwd: root, agentDir: root, settingsManager,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        systemPrompt: "Offline lifecycle test.",
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
        const activeTools = (context.tools ?? []).map((tool) => tool.name);
        if (scenario === "retry" || requests === 1) assert.deepEqual(activeTools.sort(), [...ALLOWED_FILE_TOOLS].sort());
        else assert.deepEqual(activeTools, []);
        const message: AssistantMessage = {
          role: "assistant", api: model.api, provider: model.provider, model: model.id,
          usage: emptyUsage(), timestamp: Date.now(), stopReason: "stop",
          content: [{ type: "text", text: "Final answer based on evidence." }],
        };
        if (requests === 1) {
          message.stopReason = scenario === "retry" ? "error" : "length";
          message.content = [{ type: "text", text: "Incomplete answer" }];
          if (scenario === "retry") message.errorMessage = "503 service unavailable";
        } else if (scenario === "retry" && requests === 2) {
          message.stopReason = "toolUse";
          message.content = [{ type: "toolCall", id: "retry-read", name: "read", arguments: { path: "evidence.txt" } }];
        }
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          if (message.stopReason === "error") stream.push({ type: "error", reason: "error", error: message });
          else stream.push({ type: "done", reason: message.stopReason as "stop" | "length" | "toolUse", message });
        });
        return stream;
      };
      await session.prompt("Read the synthetic evidence and answer.");
      assert.equal(requests, scenario === "retry" ? 3 : 2, JSON.stringify({ messages: session.messages, extensionErrors }));
      assert.equal(retries, scenario === "retry" ? 1 : 0);
      assert.equal(reads, scenario === "retry" ? 1 : 0);
      assert.equal(session.getLastAssistantText(), "Final answer based on evidence.");
      assert.deepEqual(extensionErrors, []);
      const budget = JSON.parse(await readFile(env[BUDGET_TELEMETRY_ENV]!, "utf8"));
      assert.equal(budget.toolCallsExecuted, reads);
      assert.equal(budget.hardLimitReached, false);
    } finally {
      // Release the guard timer before deleting its temporary runtime files.
      await session?.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
      session?.dispose();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
}
