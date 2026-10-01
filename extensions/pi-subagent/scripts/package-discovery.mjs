import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

// Resolve the development package's selected Pi version. Prefer its bundled SDK
// when shipped; Pi 0.85.0's unbundled SDK historically imported an undeclared
// pi-server dependency. Never mask a loading failure.
const sdkEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const bundledEntry = new URL("./bundle/index.js", sdkEntry);
const { DefaultResourceLoader, SettingsManager } = await import(
  existsSync(bundledEntry) ? bundledEntry.href : sdkEntry
);
const packageDirectory = resolve(process.argv[2]);
const loader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: process.env.PI_CODING_AGENT_DIR,
  settingsManager: SettingsManager.inMemory(),
  additionalExtensionPaths: [packageDirectory],
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
});
await loader.reload();

const { extensions, errors } = loader.getExtensions();
assert.deepEqual(errors, [], "Pi extension loading failed");
assert.equal(extensions.length, 1, "expected exactly one packaged extension");
assert.equal(resolve(extensions[0].path), join(packageDirectory, "index.ts"));
assert.deepEqual([...extensions[0].tools.keys()], ["pi_subagent"], "expected pi_subagent tool registration");

assert.deepEqual([...extensions[0].commands.keys()], ["pi-subagent-settings"], "expected settings command registration");

const { skills, diagnostics } = loader.getSkills();
assert.deepEqual(diagnostics, [], "Pi skill discovery reported diagnostics");
assert.equal(skills.length, 1, "expected exactly one companion skill");
assert.equal(skills[0].name, "pi-subagent");
assert.equal(resolve(skills[0].filePath), join(packageDirectory, "skills/pi-subagent/SKILL.md"));
// The parent refers to this file by path rather than importing it. Discover it
// independently so a child-only import failure cannot pass the package gate.
// No session starts: missing runtime policy/liveness inputs keep the guard inert.
const childPath = join(packageDirectory, "extensions/pi-subagent/child-guard.ts");
const childLoader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: process.env.PI_CODING_AGENT_DIR,
  settingsManager: SettingsManager.inMemory(),
  additionalExtensionPaths: [childPath],
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
});
await childLoader.reload();
const child = childLoader.getExtensions();
assert.deepEqual(child.errors, [], "Pi child extension loading failed");
assert.equal(child.extensions.length, 1, "expected exactly one packaged child extension");
assert.equal(resolve(child.extensions[0].path), childPath);
console.log("Pi parent/child extension and companion skill discovery verified");
