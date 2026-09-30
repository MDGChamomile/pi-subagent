import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { loadPresetSettings, parsePresetSettings, validatePresetSelection } from "./config.ts";
import { SUBAGENT_PRESETS } from "./shared.ts";

const model = (provider: string, id: string, reasoning = true): Model<Api> => ({
  provider, id, name: id, api: "openai-completions", baseUrl: "https://example.invalid",
  reasoning, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 10000, maxTokens: 1000,
});

test("defaults remain independent and review defaults to high", () => {
  const parsed = parsePresetSettings({});
  assert.deepEqual(parsed, SUBAGENT_PRESETS);
  assert.equal(parsed["review-standard"].thinking, "high");
  const another = parsePresetSettings({});
  another["lookup-standard"].thinking = "off";
  assert.equal(SUBAGENT_PRESETS["lookup-standard"].thinking, "medium");
});

test("default models and thinking levels exist in Pi's bundled offline catalog", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-catalog-test-"));
  try {
    const runtime = await ModelRuntime.create({
      authPath: join(root, "auth.json"), modelsPath: join(root, "models.json"),
      modelsStorePath: join(root, "model-store.json"), allowModelNetwork: false,
    });
    const registry = new ModelRegistry(runtime);
    for (const selection of Object.values(parsePresetSettings({}))) {
      validatePresetSelection(selection, registry);
      const [provider, id] = selection.model.split("/");
      const registered = registry.find(provider!, id!);
      assert.equal(registered?.provider, provider);
      assert.equal(registered?.id, id);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit old-model overrides survive a default model upgrade", () => {
  const parsed = parsePresetSettings({ presets: {
    "review-standard": { provider: "openai-codex", model: "gpt-6-sol", thinking: "high" },
  } });
  assert.equal(parsed["review-standard"].model, "openai-codex/gpt-6-sol");
  assert.equal(parsed["review-standard"].thinking, "high");
  assert.equal(parsed["analysis-standard"].model, SUBAGENT_PRESETS["analysis-standard"].model);
  assert.deepEqual(parsePresetSettings({ presets: {} }), SUBAGENT_PRESETS);
});

test("per-preset overrides preserve omitted defaults and OpenRouter model slashes", () => {
  const parsed = parsePresetSettings({ presets: {
    "lookup-standard": { thinking: "low" },
    "analysis-standard": { provider: "anthropic", model: "claude-sonnet-4-5", thinking: "high" },
    "review-standard": { provider: "openrouter", model: "anthropic/claude-sonnet-4.5", thinking: "off" },
  } });
  assert.equal(parsed["lookup-standard"].model, SUBAGENT_PRESETS["lookup-standard"].model);
  for (const name of ["analysis-standard", "review-standard"] as const) {
    const selection = parsed[name];
    validatePresetSelection(selection, { find(provider, id) {
      assert.equal(`${provider}/${id}`, selection.model);
      if (provider === "openrouter") assert.equal(id, "anthropic/claude-sonnet-4.5");
      return model(provider, id);
    } });
  }
});

test("model IDs are preserved verbatim through exact registry lookup", () => {
  for (const id of ["@cf/zai-org/glm-4.7-flash", "anthropic/claude-sonnet-4.5", "llama3.1:8b", "a".repeat(256)]) {
    const selection = parsePresetSettings({ presets: {
      "lookup-standard": { provider: "custom", model: id, thinking: "off" },
    } })["lookup-standard"];
    let lookedUp = false;
    validatePresetSelection(selection, { find(provider, modelId) {
      lookedUp = true;
      assert.equal(provider, "custom");
      assert.equal(modelId, id);
      return model(provider, modelId);
    } });
    assert.equal(lookedUp, true);
    assert.throws(() => validatePresetSelection(selection, { find: () => undefined }), /unavailable/);
  }
});

test("rejects empty, padded, non-string, overlong and control-containing model IDs", () => {
  // Pi trims CLI model references: padded IDs could resolve to a different registered sibling.
  const invalid = ["", "  ", "foo ", " foo", "foo\u00a0", null, 42, [], "a".repeat(257),
    ...[0, 9, 10, 13, 31, 127, 128, 159].map((code) => `model${String.fromCharCode(code)}`)];
  for (const id of invalid) {
    assert.throws(() => parsePresetSettings({ presets: {
      "lookup-standard": { provider: "custom", model: id },
    } }), /Invalid subagent provider\/model settings/);
  }
});

test("rejects malformed settings without echoing input", () => {
  for (const value of [null, [], { unknown: "private-value" }, { presets: [] },
    { presets: { typo: {} } }, ...[null, [], { model: "private-value" }, { provider: "anthropic" },
      { thinking: "automatic" }, { thinking: null }, { key: "private-value" },
      { provider: "anthropic", model: "bad\nprivate-value" }].map((override) => ({ presets: { "review-standard": override } }))]) {
    assert.throws(() => parsePresetSettings(value), (error: Error) => {
      assert.match(error.message, /Invalid subagent/);
      assert.doesNotMatch(error.message, /private-value/);
      return true;
    });
  }
});

test("rejects unavailable models and unsupported thinking without fallback", () => {
  const selection = { model: "test/model", thinking: "high" as const };
  assert.throws(() => validatePresetSelection(selection, { find: () => undefined }), /unavailable/);
  assert.throws(() => validatePresetSelection(selection, { find: () => model("test", "model", false) }), /unsupported/);
  assert.throws(() => validatePresetSelection({ ...selection, thinking: "xhigh" }, { find: () => model("test", "model") }), /unsupported/);
  validatePresetSelection({ ...selection, thinking: "off" }, { find: () => model("test", "model", false) });
  validatePresetSelection({ ...selection, thinking: "max" }, {
    find: () => ({ ...model("test", "model"), thinkingLevelMap: { max: "max" } }),
  });
});

test("loads only explicit agent settings; missing defaults, invalid JSON and IO fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-config-test-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = root;
    assert.deepEqual(await loadPresetSettings(), SUBAGENT_PRESETS);
    const file = join(root, "pi-subagent.json");
    await writeFile(file, JSON.stringify({ presets: { "review-standard": { thinking: "medium" } } }));
    assert.equal((await loadPresetSettings())["review-standard"].thinking, "medium");
    await writeFile(file, "{private-value");
    await assert.rejects(loadPresetSettings(), /Invalid subagent settings JSON/);
    await rm(file);
    await mkdir(file);
    await assert.rejects(loadPresetSettings(), /Could not read subagent settings/);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
