import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

// Resolve the development package's selected Pi version. Prefer its bundled SDK
// when shipped (0.85.x): the unbundled 0.85.0 SDK imports an undeclared pi-server
// dependency. Pi 0.84.2 ships only the regular SDK. Never mask a loading failure.
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

const { skills, diagnostics } = loader.getSkills();
assert.deepEqual(diagnostics, [], "Pi skill discovery reported diagnostics");
assert.equal(skills.length, 1, "expected exactly one companion skill");
assert.equal(skills[0].name, "pi-subagent");
assert.equal(resolve(skills[0].filePath), join(packageDirectory, "skills/pi-subagent/SKILL.md"));
console.log("Pi package extension and companion skill discovery verified");
