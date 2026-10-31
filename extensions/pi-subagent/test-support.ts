import assert from "node:assert/strict";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
// The configured test loader selects the bundled SDK when available.
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { emptyUsage } from "./child-stream.ts";

/** Applies environment overrides (undefined deletes) and returns a function that restores the previous values. */
export function setEnv(values: Record<string, string | undefined>): () => void {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  const apply = (entries: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(entries)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(values);
  return () => apply(previous);
}

export function offlineModel(id: string, name: string): Model<"openai-completions"> {
  return {
    id, name, provider: "offline-test", api: "openai-completions",
    baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16_000, maxTokens: 1_000,
  };
}

/** A real Pi session without ambient resources, stored credentials, or model network access. */
export async function createOfflineSession(options: {
  root: string;
  systemPrompt: string;
  settings?: Parameters<typeof SettingsManager.inMemory>[0];
  extensionFactories?: ExtensionFactory[];
  additionalExtensionPaths?: string[];
  model?: Model<"openai-completions">;
  tools?: string[];
}): Promise<AgentSession> {
  const { root, model } = options;
  const settingsManager = SettingsManager.inMemory(
    options.settings ?? { compaction: { enabled: false }, retry: { enabled: false } },
  );
  const resourceLoader = new DefaultResourceLoader({
    cwd: root, agentDir: root, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: options.systemPrompt,
    extensionFactories: options.extensionFactories,
    additionalExtensionPaths: options.additionalExtensionPaths,
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(root, "auth.json"), modelsPath: join(root, "models.json"),
    modelsStorePath: join(root, "model-store.json"), allowModelNetwork: false,
  });
  if (model) {
    modelRuntime.registerProvider(model.provider, {
      api: model.api, baseUrl: model.baseUrl, apiKey: "offline-placeholder", models: [model],
    });
  }
  const { session } = await createAgentSession({
    cwd: root, agentDir: root, model, modelRuntime, resourceLoader, settingsManager,
    sessionManager: SessionManager.inMemory(root), tools: options.tools, thinkingLevel: model ? "off" : undefined,
  });
  return session;
}

export function assistantMessage(
  model: Model<"openai-completions">,
  stopReason: AssistantMessage["stopReason"],
  content: AssistantMessage["content"],
): AssistantMessage {
  return {
    role: "assistant", api: model.api, provider: model.provider, model: model.id,
    usage: emptyUsage(), timestamp: Date.now(), stopReason, content,
  };
}

/** A scripted provider response that completes asynchronously, as a real stream would. */
export function streamMessage(message: AssistantMessage) {
  const reason = message.stopReason;
  if (reason === "pending") throw new Error("A scripted response needs a final stop reason");
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => stream.push(reason === "error" || reason === "aborted"
    ? { type: "error", reason, error: message }
    : { type: "done", reason, message }));
  return stream;
}
