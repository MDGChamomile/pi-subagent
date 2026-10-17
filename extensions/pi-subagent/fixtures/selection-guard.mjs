// Isolated process: exercise Pi's actual hook exception handling without a provider request.
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import childGuard from "../child-guard.ts";
import {
  ALLOWED_FILE_TOOLS, ALLOWED_WEB_TOOLS, BUDGET_TELEMETRY_ENV, LIFETIME_TOOL_CALL_LIMITS,
  MODEL_SELECTION_ENV, POLICY_ENV, READY_ENV, READY_MARKER,
  SOFT_DEADLINE_ENV, WEB_EXTENSION_ENV,
} from "../shared.ts";
// The spawning test preloads the SDK mapper.
const { ExtensionRunner } = await import("@earendil-works/pi-coding-agent");
const scenario = process.argv[2];
const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-subagent-request-guard-")));
let requests = 0;
let activeTools = [];
process.on("exit", () => {
  let guardReady = false;
  try { guardReady = readFileSync(process.env[READY_ENV], "utf8") === READY_MARKER; } catch {}
  console.log(JSON.stringify({ requests, guardReady, activeTools }));
  rmSync(root, { recursive: true, force: true });
});
const web = scenario === "web-owner" || scenario === "missing-web-extension";
const policyFile = join(root, "policy.json");
const readyFile = join(root, "guard.ready");
const budgetFile = join(root, "budget.json");
process.env[POLICY_ENV] = policyFile;
process.env[READY_ENV] = readyFile;
process.env[BUDGET_TELEMETRY_ENV] = budgetFile;
if (scenario !== "missing-policy") {
  writeFileSync(policyFile, scenario === "malformed-policy" ? "{" : JSON.stringify({
    version: 1, cwd: root, capability: web ? "web" : "local",
    roots: web ? [] : [{ path: root, kind: "directory" }],
  }), { mode: 0o600 });
}
if (scenario === "readiness-failure") writeFileSync(readyFile, "invalid\n", { mode: 0o600 });
if (scenario === "budget-failure") writeFileSync(budgetFile, "{}", { mode: 0o600 });
if (scenario === "invalid-deadline") process.env[SOFT_DEADLINE_ENV] = "invalid";
const webExtension = join(root, "web.ts");
if (web && scenario !== "missing-web-extension") {
  writeFileSync(webExtension, "export default () => {};\n", { mode: 0o600 });
  process.env[WEB_EXTENSION_ENV] = webExtension;
}
const registered = { provider: "test", id: "known", reasoning: true };
const expected = { model: "test/known", thinking: "high" };
let effective = registered;
let thinkingLevel = "high";
if (scenario === "missing-entry") {
  expected.model = "test/parent-only";
  effective = { ...registered, id: "parent-only" }; // CLI synthetic fallback
}
if (scenario === "provider") effective = { ...registered, provider: "other" };
if (scenario === "thinking") thinkingLevel = "medium";
if (scenario === "unsupported") registered.reasoning = false;
process.env[MODEL_SELECTION_ENV] = scenario === "malformed" ? "{" : JSON.stringify(expected);
if (scenario === "missing") delete process.env[MODEL_SELECTION_ENV];
const handlers = new Map();
childGuard({
  on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
  getAllTools() {
    return web
      ? ALLOWED_WEB_TOOLS.map((name) => ({ name, sourceInfo: { path: scenario === "web-owner" ? policyFile : webExtension } }))
      : ALLOWED_FILE_TOOLS.map((name) => ({ name, sourceInfo: { source: scenario === "local-owner" ? "local" : "builtin" } }));
  },
  setActiveTools(names) { activeTools = names; },
  sendUserMessage() { throw new Error("private runtime message failure"); },
}, () => {
  if (scenario === "liveness-failure") throw new Error("synthetic liveness failure");
  return () => {};
});
// Use real Pi dispatch (which catches thrown handlers). Only the context/registry
// and the transport are doubles; neither credentials nor network are involved.
const runner = new ExtensionRunner([{ path: "selection-guard", handlers }], {}, ".", {}, {});
runner.createContext = () => ({ model: effective, thinkingLevel,
  modelRegistry: { find: (provider, id) => provider === registered.provider && id === registered.id ? registered : undefined },
});
if (scenario !== "before-session-start") await runner.emit({ type: "session_start" });
if (scenario === "tool-notice-failure") {
  for (let index = 0; index < LIFETIME_TOOL_CALL_LIMITS.local.soft; index++) {
    await runner.emit({ type: "tool_execution_start", toolCallId: `read-${index}`, toolName: "read", args: {} });
  }
}
if (scenario === "final-answer-failure") await runner.emit({ type: "agent_end", messages: [] });
await runner.emitBeforeProviderRequest({ model: effective.id });
const transportSpy = () => { requests++; };
transportSpy();
