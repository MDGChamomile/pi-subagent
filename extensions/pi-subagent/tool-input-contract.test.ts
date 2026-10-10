import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { prepareWebCall } from "./child-guard.ts";
import { emptyUsage } from "./child-stream.ts";
import { authorizeReadPath, buildChildPolicy } from "./path-policy.ts";

const model: Model<"openai-completions"> = {
  id: "offline-input-contract", name: "Offline Input Contract", provider: "offline-test", api: "openai-completions",
  baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16_000, maxTokens: 1_000,
};
const parameters = Type.Object({
  path: Type.Optional(Type.String()), query: Type.Optional(Type.String()), url: Type.Optional(Type.String()),
  workflow: Type.Optional(Type.String()), mode: Type.Optional(Type.String()),
});

// child-guard.test.ts covers guard policy and its input mutations. This isolates
// the SDK contract they rely on: tool_call must mutate the args used by execute,
// not a hook-only copy. A probe tool observes actual execution without web I/O.
for (const scenario of ["canonical path", "web_search", "fetch_content"] as const) {
  for (const detached of [false, true]) {
    test(`real Pi tool_call forwards ${scenario}${detached ? " (detached-copy negative control)" : ""}`, { timeout: 15_000 }, async () => {
      const root = await mkdtemp(join(tmpdir(), "pi-subagent-input-contract-"));
      let session: AgentSession | undefined;
      try {
        const input: Record<string, string> = scenario === "canonical path" ? { path: "alias.txt" }
          : scenario === "web_search" ? { query: "synthetic query" }
            : { url: "https://example.invalid/evidence" };
        await writeFile(join(root, "evidence.txt"), "Synthetic evidence\n");
        await symlink("evidence.txt", join(root, "alias.txt"));
        const policy = await buildChildPolicy(root, ["evidence.txt"], "local");
        const expected = scenario === "canonical path" ? { path: await realpath(join(root, "evidence.txt")) }
          : scenario === "web_search" ? { ...input, workflow: "none" }
            : { ...input, mode: "readable" };
        assert.notDeepEqual(input, expected, "the fixture must distinguish original from normalized args");

        const executed: Record<string, unknown>[] = [];
        let hookCalls = 0;
        const settingsManager = SettingsManager.inMemory({
          compaction: { enabled: false }, retry: { enabled: false },
        });
        const resourceLoader = new DefaultResourceLoader({
          cwd: root, agentDir: root, settingsManager,
          noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
          systemPrompt: "Offline tool input contract test.",
          extensionFactories: [(pi) => {
            pi.registerTool({
              name: "input_probe", label: "Input probe", description: "Record synthetic execution arguments.", parameters,
              async execute(_id, args) {
                executed.push(structuredClone(args));
                return { content: [{ type: "text", text: "Recorded." }], details: undefined };
              },
            });
            pi.on("tool_call", async (event) => {
              if (event.toolName !== "input_probe") return;
              hookCalls++;
              // The control applies the same normalization to a detached object,
              // simulating a hook/execute boundary that no longer shares args.
              const args = detached ? structuredClone(event.input) : event.input;
              if (scenario === "canonical path") {
                args.path = await authorizeReadPath(policy, String(args.path));
              } else {
                const prepared = prepareWebCall(scenario, args);
                if ("violation" in prepared) throw new Error(prepared.violation);
                Object.assign(args, prepared.input);
              }
            });
          }],
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
          sessionManager: SessionManager.inMemory(root), tools: ["input_probe"], thinkingLevel: "off",
        }));
        const extensionErrors: unknown[] = [];
        await session.bindExtensions({ onError: (error) => { extensionErrors.push(error); } });
        assert.deepEqual(session.getActiveToolNames(), ["input_probe"]);
        const toolErrors: boolean[] = [];
        session.subscribe((event) => {
          if (event.type === "tool_execution_end") toolErrors.push(event.isError);
        });
        let requests = 0;
        session.agent.streamFunction = () => {
          requests++;
          assert.ok(requests <= 2, "unexpected extra continuation");
          const message: AssistantMessage = {
            role: "assistant", api: model.api, provider: model.provider, model: model.id,
            usage: emptyUsage(), timestamp: Date.now(), stopReason: requests === 1 ? "toolUse" : "stop",
            content: requests === 1
              ? [{ type: "toolCall", id: "probe-call", name: "input_probe", arguments: structuredClone(input) }]
              : [{ type: "text", text: "Done." }],
          };
          const stream = createAssistantMessageEventStream();
          queueMicrotask(() => stream.push({ type: "done", reason: message.stopReason as "toolUse" | "stop", message }));
          return stream;
        };
        await session.prompt("Record the synthetic tool input.");
        assert.equal(requests, 2);
        assert.equal(hookCalls, 1);
        assert.deepEqual(extensionErrors, []);
        assert.deepEqual(toolErrors, [false]);
        assert.equal(session.getLastAssistantText(), "Done.");
        const assertForwarded = () => assert.deepEqual(executed, [expected]);
        if (detached) {
          assert.deepEqual(executed, [input], "the control must execute successfully with the original args");
          assert.throws(assertForwarded, { code: "ERR_ASSERTION" });
        } else {
          assertForwarded();
        }
      } finally {
        session?.dispose();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}
