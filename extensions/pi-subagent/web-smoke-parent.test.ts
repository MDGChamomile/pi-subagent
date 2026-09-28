import assert from "node:assert/strict";
import { test } from "node:test";
import webSmokeParent from "./scripts/web-smoke-parent.ts";
import { ALLOWED_WEB_TOOLS, TOOL_NAME } from "./shared.ts";

test("source-owned web smoke helper hides tools without changing their ownership", () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const registered = ALLOWED_WEB_TOOLS.map((name) => ({ name, sourceInfo: { path: "/fixture/pi-web-access/index.ts" } }));
  const original = structuredClone(registered);
  let active = [...ALLOWED_WEB_TOOLS] as string[];
  webSmokeParent({
    on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
    setActiveTools(names: string[]) { active = names; },
    getAllTools() { return registered; },
  } as any);
  handlers.get("session_start")!();
  assert.deepEqual(active, [TOOL_NAME]);
  assert.deepEqual(registered, original);
  assert.equal(handlers.get("tool_call")!({ toolName: TOOL_NAME }), undefined);
  for (const toolName of [...ALLOWED_WEB_TOOLS, "read", "load_web_tools"]) {
    assert.equal(handlers.get("tool_call")!({ toolName }).block, true);
  }
});
