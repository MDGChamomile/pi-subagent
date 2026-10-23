import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import childGuard from "../child-guard.ts";
import { ALLOWED_FILE_TOOLS } from "../shared.ts";

const handlers = new Map();
let active = [];
childGuard({
  on: (name, handler) => handlers.set(name, handler),
  getAllTools: () => ALLOWED_FILE_TOOLS.map((name) => ({ name, sourceInfo: { source: "builtin" } })),
  setActiveTools: (names) => { active = names; },
  sendUserMessage: () => {},
});
for await (const chunk of process.stdin) {}
await handlers.get("session_start")();
assert.deepEqual(active, ALLOWED_FILE_TOOLS);
await handlers.get("session_shutdown")();

// A remaining handle can keep a one-shot Pi process alive after session shutdown.
const descendant = spawn(process.execPath, [
  "-e", "process.on('SIGTERM', () => {}); process.send('ready'); setTimeout(() => process.exit(9), 8000);",
], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
await once(descendant, "message");
descendant.disconnect();
writeFileSync(process.argv[2], JSON.stringify({ childPid: process.pid, descendantPid: descendant.pid }));
setTimeout(() => process.exit(9), 8000);
