import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadPresetSettings, presetSettingsPath, readPresetSettingsSnapshot } from "./config.ts";
import { configureSubagentSettings, savePresetSettings } from "./settings-command.ts";
import { SUBAGENT_PRESETS } from "./shared.ts";

let root: string;
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
before(async () => { root = await mkdtemp(join(tmpdir(), "subagent-settings-")); });
after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(root, { recursive: true, force: true });
});
async function directory() {
  const dir = await mkdtemp(join(root, "case-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  return dir;
}
const model: Model<Api> = {
  provider: "custom", id: "@cf/example/model", name: "Example", api: "openai-completions",
  baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 1000,
};
const override = { provider: model.provider, model: model.id, thinking: "off" as const };
function context(options: { cancelAt?: number; confirm?: boolean; hasUI?: boolean; models?: Model<Api>[];
  beforeConfirm?: () => Promise<void>; unavailable?: () => boolean } = {}) {
  const choices: { title: string; options: string[] }[] = [];
  const notifications: { text: string; type: string }[] = [];
  const confirmations: string[] = [];
  const models = options.models ?? [model];
  const ctx = {
    hasUI: options.hasUI ?? true,
    modelRegistry: {
      getAll: () => models,
      find: (provider: string, id: string) => options.unavailable?.() ? undefined : models.find((m) => m.provider === provider && m.id === id),
    },
    ui: {
      async select(title: string, items: string[]) {
        choices.push({ title, options: items });
        return choices.length === options.cancelAt ? undefined : items[0];
      },
      async confirm(_title: string, message: string) {
        confirmations.push(message);
        await options.beforeConfirm?.();
        return options.confirm ?? true;
      },
      notify(text: string, type: string) { notifications.push({ text, type }); },
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, choices, notifications, confirmations };
}

test("command saves only the selected user default and next-call loading sees it", async () => {
  const dir = await directory();
  const path = presetSettingsPath();
  const existing = { presets: { "review-standard": { thinking: "low" } } };
  await writeFile(path, JSON.stringify(existing));
  const harness = context();
  await configureSubagentSettings(harness.ctx);
  assert.equal(harness.choices.length, 3);
  assert.deepEqual(harness.choices[1].options, ["custom/@cf/example/model"]);
  assert.deepEqual(harness.choices[2].options, ["off"]);
  assert.match(harness.confirmations[0], /Before:.*\nAfter:/);
  assert.match(harness.confirmations[0], /future subagent calls/);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { presets: {
    ...existing.presets, "lookup-standard": override,
  } });
  const saved = await loadPresetSettings();
  assert.equal(saved["lookup-standard"].model, "custom/@cf/example/model");
  assert.equal(saved["review-standard"].thinking, "low");
  assert.deepEqual(saved["analysis-standard"], SUBAGENT_PRESETS["analysis-standard"]);
  assert.deepEqual(await readdir(dir), ["pi-subagent.json"]);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(harness.notifications.at(-1)?.type, "info");
});

test("cancellation at any dialog and non-UI use never writes settings", async () => {
  for (const options of [{ cancelAt: 1 }, { cancelAt: 2 }, { cancelAt: 3 }, { confirm: false }, { hasUI: false }]) {
    const dir = await directory();
    const harness = context(options);
    await configureSubagentSettings(harness.ctx);
    assert.deepEqual(await readdir(dir), []);
    if (options.hasUI === false) assert.equal(harness.choices.length, 0);
  }
});

test("declining confirmation preserves existing bytes, not only effective settings", async () => {
  await directory();
  const original = '{ "presets": { "lookup-standard": { "thinking": "low" } } }\n';
  await writeFile(presetSettingsPath(), original);
  await configureSubagentSettings(context({ confirm: false }).ctx);
  assert.equal(await readFile(presetSettingsPath(), "utf8"), original);
});

test("invalid settings are reported without overwrite or dialogs", async () => {
  for (const text of ["{broken", '{"unknown":true}', '{"presets":{"typo":{}}}']) {
    await directory();
    await writeFile(presetSettingsPath(), text);
    const harness = context();
    await configureSubagentSettings(harness.ctx);
    assert.equal(harness.choices.length, 0);
    assert.equal(harness.notifications.at(-1)?.type, "error");
    assert.equal(await readFile(presetSettingsPath(), "utf8"), text);
  }
});

test("empty registry and a model removed during confirmation do not save", async () => {
  let unavailable = false;
  for (const options of [{ models: [] }, {
    unavailable: () => unavailable, beforeConfirm: async () => { unavailable = true; },
  }]) {
    const dir = await directory();
    const harness = context(options);
    await configureSubagentSettings(harness.ctx);
    assert.deepEqual(await readdir(dir), []);
    assert.notEqual(harness.notifications.at(-1)?.type, "info");
  }
});

test("thinking choices include extended levels only when model metadata supports them", async () => {
  const dir = await directory();
  const reasoningModel = { ...model, reasoning: true, thinkingLevelMap: { max: "max" } };
  const harness = context({ models: [reasoningModel] });
  await configureSubagentSettings(harness.ctx);
  assert.ok(harness.choices[2].options.includes("max"));
  assert.equal(harness.notifications.at(-1)?.type, "info");
  assert.deepEqual(await readdir(dir), ["pi-subagent.json"]);
});

test("concurrent edits during dialogs are preserved and require reopening", async () => {
  const dir = await directory();
  const edited = '{"presets":{"review-standard":{"thinking":"off"}}}';
  const harness = context({ beforeConfirm: async () => { await writeFile(presetSettingsPath(), edited); } });
  await configureSubagentSettings(harness.ctx);
  assert.match(harness.notifications.at(-1)!.text, /changed while the dialog/);
  assert.equal(await readFile(presetSettingsPath(), "utf8"), edited);
  assert.deepEqual(await readdir(dir), ["pi-subagent.json"]);
});

test("stale snapshots and competing locks fail without overwriting", async () => {
  const dir = await directory();
  const snapshot = await readPresetSettingsSnapshot();
  savePresetSettings(snapshot, "lookup-standard", override);
  assert.throws(() => savePresetSettings(snapshot, "review-standard", override), /changed/);
  const current = await readPresetSettingsSnapshot();
  await writeFile(`${current.path}.lock`, "owned by another writer");
  assert.throws(() => savePresetSettings(current, "review-standard", override), /locked/);
  assert.equal(await readFile(`${current.path}.lock`, "utf8"), "owned by another writer");
  assert.deepEqual((await readdir(dir)).sort(), ["pi-subagent.json", "pi-subagent.json.lock"]);
});

test("save refuses symlink targets and directories and cleans its lock", async () => {
  const dir = await directory();
  const target = join(dir, "target.json");
  const path = presetSettingsPath();
  await writeFile(target, "{}");
  await symlink(target, path);
  const snapshot = await readPresetSettingsSnapshot();
  assert.throws(() => savePresetSettings(snapshot, "lookup-standard", override), /regular file/);
  assert.equal(await readFile(target, "utf8"), "{}");
  await rm(path);
  await mkdir(path);
  assert.throws(() => savePresetSettings(snapshot, "lookup-standard", override), /regular file/);
  assert.equal((await readdir(dir)).includes("pi-subagent.json.lock"), false);
});

test("new agent directories are created only on save; other defaults stay implicit", async () => {
  const dir = await directory();
  const path = presetSettingsPath(join(dir, "new-agent"));
  const snapshot = await readPresetSettingsSnapshot(path);
  savePresetSettings(snapshot, "lookup-standard", override);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { presets: { "lookup-standard": override } });
});

test("getAgentDir controls default paths and explicit tilde injection stays supported", async () => {
  const dir = await directory();
  assert.equal(presetSettingsPath(), join(dir, "pi-subagent.json"));
  process.env.PI_CODING_AGENT_DIR = "~/custom-agent";
  assert.equal(presetSettingsPath(), join(homedir(), "custom-agent", "pi-subagent.json"));
  delete process.env.PI_CODING_AGENT_DIR;
  assert.equal(presetSettingsPath(), join(homedir(), ".pi", "agent", "pi-subagent.json"));
  assert.equal(presetSettingsPath("~"), join(homedir(), "pi-subagent.json"));
  assert.equal(presetSettingsPath("~/explicit"), join(homedir(), "explicit", "pi-subagent.json"));
});
