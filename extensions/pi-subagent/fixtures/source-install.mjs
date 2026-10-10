// Real CLI package management + SDK discovery, using only a disposable HOME/project.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const local = process.argv[2] === "local";
const checkout = realpathSync(fileURLToPath(new URL("../../..", import.meta.url)));
const sdkEntry = createRequire(import.meta.url).resolve("@earendil-works/pi-coding-agent");
const cli = join(dirname(sdkEntry), "cli.js");
const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-subagent-install-")));
const cwd = join(root, "project");
const agentDir = join(root, "custom-agent");
const env = { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", NO_COLOR: "1" };
mkdirSync(cwd);
const run = (...args) => {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, `${args[0]} failed: ${result.stderr || result.error || result.stdout}`);
  return result.stdout;
};
try {
  // Isolate SDK discovery too; the fixture is a dedicated subprocess.
  Object.assign(process.env, env);
  const { DefaultResourceLoader, SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const discover = async (trusted) => {
    const settingsManager = SettingsManager.create(cwd, agentDir);
    settingsManager.setProjectTrusted(trusted);
    const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
      noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    assert.deepEqual(loader.getSkills().diagnostics, []);
    return loader;
  };
  run("install", ...(local ? ["-l"] : []), checkout);
  const settingsPath = local ? join(cwd, ".pi/settings.json") : join(agentDir, "settings.json");
  const packages = JSON.parse(readFileSync(settingsPath, "utf8")).packages;
  assert.equal(packages.length, 1);
  assert.match(run("list", "--approve"), /pi-subagent/);
  if (local) {
    const untrusted = await discover(false);
    assert.equal(untrusted.getExtensions().extensions.length, 0);
    assert.equal(untrusted.getSkills().skills.length, 0);
    assert.equal(existsSync(join(agentDir, "settings.json")), false);
  }
  const loader = await discover(local);
  const extensions = loader.getExtensions().extensions;
  assert.equal(extensions.length, 1);
  assert.equal(realpathSync(extensions[0].path), join(checkout, "extensions/pi-subagent/index.ts"));
  assert.deepEqual([...extensions[0].tools.keys()], ["pi_subagent"]);
  assert.deepEqual([...extensions[0].commands.keys()], ["pi-subagent-settings"]);
  assert.equal(loader.getSkills().skills.length, 1);
  assert.equal(realpathSync(loader.getSkills().skills[0].filePath), join(checkout, "skills/pi-subagent/SKILL.md"));
  assert.equal(existsSync(join(root, ".pi/agent/settings.json")), false);
  run("remove", ...(local ? ["-l", "--approve"] : []), checkout);
  assert.equal((JSON.parse(readFileSync(settingsPath, "utf8")).packages ?? []).length, 0);
  assert.doesNotMatch(run("list", "--approve"), /pi-subagent/);
  const removed = await discover(local);
  assert.equal(removed.getExtensions().extensions.length, 0);
  assert.equal(removed.getSkills().skills.length, 0);
  assert.ok(existsSync(join(checkout, "extensions/pi-subagent/index.ts")), "removal must preserve the checkout");
  console.log(`source installation verified: ${local ? "project" : "user"}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
