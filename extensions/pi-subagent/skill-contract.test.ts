import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { TOOL_NAME } from "./shared.ts";

const skillDirectory = new URL("../../skills/pi-subagent/", import.meta.url);

test("Pi discovers the companion skill for model invocation", () => {
  const { skills, diagnostics } = loadSkillsFromDir({ dir: fileURLToPath(skillDirectory), source: "user" });
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(skills.filter((skill) => !skill.disableModelInvocation).map((skill) => skill.name), ["pi-subagent"]);
});

test("delegation guidance names the tool, result fields, and partial reasons", async () => {
  const text = await readFile(new URL("SKILL.md", skillDirectory), "utf8");
  const identifiers = new Set(Array.from(text.matchAll(/`([^`\n]+)`/g), (match) => match[1]));
  for (const name of [
    TOOL_NAME, "status", "partialReason", "outputTruncated", "answer",
    "tool_budget", "time_limit", "model_length",
  ]) {
    assert.ok(identifiers.has(name), `Missing runtime identifier: ${name}`);
  }
});
