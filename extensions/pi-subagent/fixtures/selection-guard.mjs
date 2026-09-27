// Isolated process: exercise Pi's actual hook exception handling without a provider request.
import { existsSync } from "node:fs";
import childGuard from "../child-guard.ts";
import { MODEL_SELECTION_ENV } from "../shared.ts";
const sdkEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const bundledEntry = new URL("./bundle/index.js", sdkEntry);
const { ExtensionRunner } = await import(existsSync(bundledEntry) ? bundledEntry.href : sdkEntry);
const scenario = process.argv[2];
const registered = { provider: "openrouter", id: "anthropic/known", reasoning: true };
const expected = { model: "openrouter/anthropic/known", thinking: "high" };
let effective = registered;
let thinkingLevel = "high";
if (scenario === "missing-entry") {
  expected.model = "openrouter/anthropic/parent-only";
  effective = { ...registered, id: "anthropic/parent-only" }; // CLI synthetic fallback
}
if (scenario === "provider") effective = { ...registered, provider: "anthropic" };
if (scenario === "thinking") thinkingLevel = "medium";
if (scenario === "unsupported") registered.reasoning = false;
process.env[MODEL_SELECTION_ENV] = scenario === "malformed" ? "{" : JSON.stringify(expected);
if (scenario === "missing") delete process.env[MODEL_SELECTION_ENV];
const handlers = new Map();
childGuard({ on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); } }, () => () => {});
// Use real Pi dispatch (which catches thrown handlers). Only the context/registry
// and the transport are doubles; neither credentials nor network are involved.
const runner = new ExtensionRunner([{ path: "selection-guard", handlers }], {}, ".", {}, {});
runner.createContext = () => ({ model: effective, thinkingLevel,
  modelRegistry: { find: (provider, id) => provider === registered.provider && id === registered.id ? registered : undefined },
});
let requests = 0;
await runner.emitBeforeProviderRequest({ model: effective.id });
const transportSpy = () => { requests++; };
transportSpy();
console.log(JSON.stringify({ requests }));
