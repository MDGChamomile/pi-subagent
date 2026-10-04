// Isolated offline contract: real SDK -> built-in Codex SSE API -> onPayload -> guard.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scenario = process.argv[2];
const root = mkdtempSync(join(tmpdir(), "pi-subagent-provider-contract-"));
Object.assign(process.env, { HOME: root, PI_CODING_AGENT_DIR: root, PI_OFFLINE: "1", PI_TELEMETRY: "0" });
let requests = 0;
let hooks = 0;
let networkAttempts = 0;
let extensionErrors = 0;
let answered = false;
let readyFile;
let marker;
process.on("exit", () => {
  let guardReady = false;
  try { guardReady = readFileSync(readyFile, "utf8") === marker; } catch {}
  console.log(JSON.stringify({ requests, hooks, networkAttempts, extensionErrors, answered, guardReady }));
  rmSync(root, { recursive: true, force: true });
});
// Fail closed if upstream changes transport or attempts discovery. No live
// socket, WebSocket, provider credential, or inherited user config is needed.
const denyNetwork = () => { networkAttempts++; throw new Error("Offline fixture forbids network sockets"); };
net.Socket.prototype.connect = denyNetwork;
tls.connect = denyNetwork;
syncBuiltinESMExports();
globalThis.WebSocket = class { constructor() { denyNetwork(); } };
globalThis.fetch = async (_url, options) => {
  requests++;
  assert.equal(hooks, 1, "the actual provider must invoke onPayload before fetch");
  assert.equal(options?.method, "POST");
  assert.equal(readFileSync(readyFile, "utf8"), marker);
  const item = { id: "msg_offline", type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: "Offline contract answer.", annotations: [] }] };
  const events = [
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "resp_offline", status: "completed", output: [item],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200, headers: { "content-type": "text/event-stream" },
  });
};

// Import only after the isolated environment and network tripwires exist.
const { default: childGuard } = await import("../child-guard.ts");
const { ALLOWED_FILE_TOOLS, BUDGET_TELEMETRY_ENV, MODEL_SELECTION_ENV, POLICY_ENV, READY_ENV, READY_MARKER } = await import("../shared.ts");
const sdkEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const bundled = new URL("./bundle/index.js", sdkEntry);
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } =
  await import(existsSync(bundled) ? bundled.href : sdkEntry);
readyFile = join(root, "guard.ready");
marker = READY_MARKER;
Object.assign(process.env, {
  [POLICY_ENV]: join(root, "policy.json"), [READY_ENV]: readyFile,
  [BUDGET_TELEMETRY_ENV]: join(root, "budget.json"),
  [MODEL_SELECTION_ENV]: JSON.stringify({
    model: scenario === "model-mismatch" ? "openai-codex/gpt-6.1-sol" : "openai-codex/gpt-6-luna",
    thinking: scenario === "thinking-mismatch" ? "high" : "medium",
  }),
});
writeFileSync(process.env[POLICY_ENV], JSON.stringify({ version: 1, cwd: root, capability: "local",
  roots: [{ path: root, kind: "directory" }] }), { mode: 0o600 });
const settingsManager = SettingsManager.inMemory({
  transport: "sse", cacheWarming: "off", compaction: { enabled: false },
  retry: { enabled: false, provider: { maxRetries: 0 } },
});
const resourceLoader = new DefaultResourceLoader({
  cwd: root, agentDir: root, settingsManager,
  noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  systemPrompt: "Offline provider contract fixture.",
  extensionFactories: [
    (pi) => pi.on("before_provider_request", (event) => {
      hooks++;
      assert.equal(event.payload.model, "gpt-6-luna");
      if (scenario === "throwing-hook") throw new Error("Synthetic hook exception");
    }),
    (pi) => childGuard(pi, () => () => undefined),
  ],
});
await resourceLoader.reload();
assert.deepEqual(resourceLoader.getExtensions().errors, []);
// Deliberately invalid, synthetic OAuth/JWT-shaped data. Use the built-in
// provider's OAuth shape without reading auth files, refreshing, or persisting.
const { InMemoryCredentialStore } = await import("@earendil-works/pi-ai");
const credentials = new InMemoryCredentialStore();
const syntheticPayload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline-fixture" } })).toString("base64url");
await credentials.modify("openai-codex", async () => ({
  type: "oauth", access: `offline.${syntheticPayload}.unsigned`, refresh: "offline-unused",
  expires: Date.now() + 86_400_000,
}));
const modelRuntime = await ModelRuntime.create({
  credentials, modelsPath: join(root, "models.json"),
  modelsStorePath: join(root, "models-store.json"), allowModelNetwork: false,
});
const model = modelRuntime.getModel("openai-codex", "gpt-6-luna");
assert.ok(model);
assert.equal(model.api, "openai-codex-responses");
const { session } = await createAgentSession({
  cwd: root, agentDir: root, model, modelRuntime, resourceLoader, settingsManager,
  sessionManager: SessionManager.inMemory(root), tools: [...ALLOWED_FILE_TOOLS], thinkingLevel: "medium",
});
try {
  await session.bindExtensions({ onError: () => { extensionErrors++; } });
  await session.prompt("Return the offline fixture answer.");
  answered = session.getLastAssistantText() === "Offline contract answer.";
  assert.ok(answered, "the real provider must parse the stubbed SSE response");
} finally {
  await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
}
