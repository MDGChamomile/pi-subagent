import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
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
