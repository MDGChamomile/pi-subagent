import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  CHILD_FINALIZATION_GRACE_MS,
  CHILD_TIMEOUT_MS,
  LIFETIME_TOOL_CALL_LIMIT,
  MAX_FINAL_BYTES,
  MAX_JSON_LINE_BYTES,
  MAX_OBSERVATION_COUNT,
  MAX_PARENT_ERROR_BYTES,
  MAX_SCOPE_PATH_LENGTH,
  MAX_SCOPE_ROOTS,
  MIN_WEB_EXTENSION_VERSION,
  SUBAGENT_PRESETS,
} from "../../extensions/pi-subagent/shared.ts";
import { sourceExtensionReadme, sourceReadme, sourceRoot } from "./test-support.mjs";

// Documentation must state the pinned Pi minimum and the runtime's values, not
// separately maintained copies.

const devDependencies = JSON.parse(
  await readFile(join(sourceRoot, "extensions/pi-subagent/package.json"), "utf8"),
).devDependencies;
const piMinimum = devDependencies["@earendil-works/pi-coding-agent"];
const piMinimumPattern = new RegExp(`Pi ${piMinimum.replaceAll(".", "\\.")} or later`);
const webMinimum = MIN_WEB_EXTENSION_VERSION.replaceAll(".", "\\.");

test("development dependencies pin one exact Pi minimum", () => {
  assert.match(piMinimum, /^\d+\.\d+\.\d+$/, "development Pi dependency must pin the exact minimum");
  for (const [name, version] of Object.entries(devDependencies)) {
    if (name.startsWith("@earendil-works/pi-")) assert.equal(version, piMinimum, `${name} must pin the Pi minimum`);
  }
});

test("the README states the requirements and installation command", () => {
  for (const [description, pattern] of [
    ["minimum Pi version", piMinimumPattern],
    ["provider authentication requirement", /authentication for the configured child provider/],
    ["minimum web extension version", new RegExp(`pi-web-access\` v${webMinimum} or later`)],
    ["npm installation command", /pi install npm:@mdgchamomile\/pi-subagent/],
  ]) {
    assert.match(sourceReadme, pattern, `source README is missing ${description}`);
  }
});

test("the model-loaded skill declares the same minimums", async () => {
  const skill = await readFile(join(sourceRoot, "skills/pi-subagent/SKILL.md"), "utf8");
  assert.match(skill, piMinimumPattern, "SKILL.md has an outdated Pi minimum");
  assert.match(skill, new RegExp(`pi-web-access(?:\`)? v${webMinimum} or later`), "SKILL.md has an outdated web minimum");
});

test("the README preset table matches the runtime presets", () => {
  const presetRows = (markdown) => {
    const section = markdown.split("\n## Presets\n")[1]?.split(/\n## /)[0] ?? "";
    // Count every table row, including cells without inline-code formatting.
    const rows = section.split("\n").filter((line) => line.trimStart().startsWith("|")).slice(2);
    return rows.map((line) => {
      const [preset, model, thinking] = line.trim().split("|").slice(1)
        .map((cell) => cell.trim().replace(/^`(.*)`$/, "$1"));
      return { preset, model, thinking };
    });
  };
  const expectedPresets = Object.entries(SUBAGENT_PRESETS).map(([preset, settings]) => ({ preset, ...settings }));
  const checkPresets = (text) => assert.deepEqual(
    presetRows(text), expectedPresets, "canonical README preset contract is inaccurate",
  );
  checkPresets(sourceReadme);

  const { preset, model, thinking } = expectedPresets[0];
  const row = `| \`${preset}\` | \`${model}\` | \`${thinking}\` |`;
  for (const replacement of [
    `| \`${preset}\` | \`fixture/stale-model\` | \`${thinking}\` |`,
    `| \`${preset}\` | \`${model}\` | \`fixture-stale-thinking\` |`,
    "",
    `${row}\n| \`fixture-unexpected-preset\` | \`${model}\` | \`${thinking}\` |`,
    `${row}\n| \`fixture-unexpected-preset\` | \`${model}\` | ${thinking} |`,
    `${row}\n| fixture-unexpected-preset | ${model} | ${thinking} |`,
  ]) {
    assert.throws(() => checkPresets(sourceReadme.replace(row, replacement)), {
      code: "ERR_ASSERTION",
      message: /canonical README preset contract is inaccurate/,
    });
  }
});

test("the extension guide states the runtime limits", () => {
  const documentedLimits = {
    scopeRoots: MAX_SCOPE_ROOTS,
    scopePathLength: MAX_SCOPE_PATH_LENGTH,
    finalizationMinutes: CHILD_FINALIZATION_GRACE_MS / 60_000,
    hardLimitMinutes: CHILD_TIMEOUT_MS / 60_000,
    localToolCalls: LIFETIME_TOOL_CALL_LIMIT.local,
    webToolCalls: LIFETIME_TOOL_CALL_LIMIT.web,
    finalKiB: MAX_FINAL_BYTES / 1024,
    jsonRecordMiB: MAX_JSON_LINE_BYTES / 1024 / 1024,
    parentErrorKiB: MAX_PARENT_ERROR_BYTES / 1024,
    observationCount: MAX_OBSERVATION_COUNT,
  };
  const limitPhrases = (limits) => [
    `returns at most ${limits.finalKiB} KiB of runtime-owned status fields`,
    `It requires 1–${limits.scopeRoots} existing files or directories`,
    `each scope path is limited to ${limits.scopePathLength.toLocaleString("en-US")} characters`,
    `then a ${limits.finalizationMinutes}-minute text-finalization window within the ${limits.hardLimitMinutes}-minute hard limit`,
    // The limit allows that many attempts; the guard stops the next one.
    `| Tool-call budget | Stop before attempt ${limits.localToolCalls + 1} | Stop before attempt ${limits.webToolCalls + 1} |`,
    `| Final answer | ${limits.finalKiB} KiB | ${limits.finalKiB} KiB |`,
    `| Captured JSON record | ${limits.jsonRecordMiB} MiB | ${limits.jsonRecordMiB} MiB |`,
    `fits within the ${limits.finalKiB} KiB cap`,
    `capped at ${limits.parentErrorKiB} KiB`,
    `the ${limits.jsonRecordMiB} MiB-bounded JSON fallback`,
    `Counters saturate at ${limits.observationCount.toLocaleString("en-US")}`,
    `within the ${limits.parentErrorKiB} KiB total failure-error cap`,
    `the ${limits.jsonRecordMiB} MiB JSON record cap`,
  ];
  const checkLimits = (text) => {
    for (const phrase of limitPhrases(documentedLimits)) {
      assert.ok(text.includes(phrase), `extension README limits do not match shared.ts; expected: ${phrase}`);
    }
  };
  checkLimits(sourceExtensionReadme);

  for (const key of Object.keys(documentedLimits)) {
    const stalePhrases = limitPhrases({ ...documentedLimits, [key]: documentedLimits[key] + 1 });
    const staleReadme = limitPhrases(documentedLimits).reduce(
      (text, phrase, index) => text.replace(phrase, stalePhrases[index]), sourceExtensionReadme,
    );
    assert.throws(() => checkLimits(staleReadme), {
      code: "ERR_ASSERTION",
      message: /extension README limits do not match shared\.ts/,
    });
  }
});
