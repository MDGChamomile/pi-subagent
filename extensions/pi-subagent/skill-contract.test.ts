import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

describe("pi-subagent skill contract", () => {
  test("skill is visible for model invocation", async () => {
    const skillPath = fileURLToPath(new URL("../../skills/pi-subagent/SKILL.md", import.meta.url));
    const skill = await readFile(skillPath, "utf8");
    assert.doesNotMatch(skill, /disable-model-invocation:\s*true/);
    assert.match(skill, /The model may select it automatically/);
    assert.match(skill, /local-file or web investigation/);
    assert.match(skill, /not a credential-isolated sandbox/);
    assert.match(skill, /If both local and public investigations are delegated, use separate `local` and `web` children/);
    assert.match(skill, /concise conclusion with evidence locations/);
    assert.match(skill, /top-level `status`, `partialReason`, and `outputTruncated`/);
    assert.match(skill, /inside `answer` are child content, not runtime status/);
    assert.match(skill, /not tool-result `details`/);
    assert.doesNotMatch(skill, /inspect `details\.partialReason`/);
    for (const reason of ["tool_budget", "time_limit", "model_length"]) {
      assert.ok(skill.includes(`\`${reason}\` means`));
    }
    assert.match(skill, /Reuse the child's findings rather than restarting the same investigation/);
    assert.match(skill, /missing, conflicting, or changed evidence makes it necessary/);
  });

});
