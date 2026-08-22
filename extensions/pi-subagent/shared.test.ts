import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ALLOWED_WEB_TOOLS,
  authorizeReadPath,
  buildChildPolicy,
  buildChildPrompt,
  ModelInvocationGate,
  PROFILE_MODELS,
  resolveWebExtensionPath,
  truncateUtf8,
} from "./shared.ts";

describe("pi-subagent scope policy", () => {
  test("canonicalizes, deduplicates, and authorizes explicit roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-subagent-test-"));
    try {
      const workspace = join(root, "workspace");
      const nested = join(workspace, "src");
      await mkdir(nested, { recursive: true });
      await writeFile(join(nested, "a.ts"), "export const a = 1;\n");
      const policy = await buildChildPolicy(workspace, ["src/a.ts", "src"]);
      assert.equal(policy.roots.length, 1);
      assert.equal(policy.roots[0]?.kind, "directory");
      assert.equal(await authorizeReadPath(policy, "src/a.ts"), join(nested, "a.ts"));
      const prompt = buildChildPrompt("Inspect the module", policy);
      assert.match(prompt, /"src" \(directory\)/);
      assert.doesNotMatch(prompt, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("supports an empty local scope for web-only research", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-subagent-test-"));
    try {
      const policy = await buildChildPolicy(root, []);
      assert.deepEqual(policy.roots, []);
      assert.match(buildChildPrompt("Research a public API", policy), /none; web-only investigation/);
      await assert.rejects(() => authorizeReadPath(policy, "."), /outside its explicit scope/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects lexical, absolute, and symlink escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-subagent-test-"));
    try {
      const workspace = join(root, "workspace");
      const outside = join(root, "outside.txt");
      await mkdir(workspace);
      await writeFile(join(workspace, "inside.txt"), "inside\n");
      await writeFile(outside, "outside\n");
      await symlink(outside, join(workspace, "escape"));
      await assert.rejects(() => buildChildPolicy(workspace, ["../outside.txt"]), /inside the current working directory/);
      await assert.rejects(() => buildChildPolicy(workspace, [outside]), /inside the current working directory/);
      await assert.rejects(() => buildChildPolicy(workspace, ["escape"]), /inside the current working directory/);
      const policy = await buildChildPolicy(workspace, ["inside.txt"]);
      await assert.rejects(() => authorizeReadPath(policy, outside), /outside its explicit scope/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("preserves exact file scopes", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-subagent-test-"));
    try {
      await writeFile(join(root, "a.txt"), "a\n");
      await writeFile(join(root, "b.txt"), "b\n");
      const policy = await buildChildPolicy(root, ["a.txt"]);
      assert.equal(await authorizeReadPath(policy, "a.txt"), join(root, "a.txt"));
      await assert.rejects(() => authorizeReadPath(policy, "b.txt"), /outside its explicit scope/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("pi-subagent model invocation contract", () => {
  test("authorizes exactly one tool call per parent agent run", () => {
    const gate = new ModelInvocationGate();
    assert.equal(gate.authorize("before-run"), false);
    gate.startRun();
    assert.equal(gate.authorize("call-1"), true);
    assert.equal(gate.authorize("call-2"), false);
    assert.equal(gate.consume("call-2"), false);
    assert.equal(gate.consume("call-1"), true);
    assert.equal(gate.consume("call-1"), false);
    gate.startRun();
    assert.equal(gate.authorize("same-unsettled-run"), false);
    gate.endRun();
    gate.startRun();
    assert.equal(gate.authorize("call-3"), true);
    gate.endRun();
    assert.equal(gate.consume("call-3"), false);
  });

  test("skill is visible for model invocation", async () => {
    const skillPath = fileURLToPath(new URL("../../skills/pi-subagent/SKILL.md", import.meta.url));
    const skill = await readFile(skillPath, "utf8");
    assert.doesNotMatch(skill, /disable-model-invocation:\s*true/);
    assert.match(skill, /The model may select it automatically/);
    assert.match(skill, /public-web investigation/);
  });

  test("resolves one common installed web extension source", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-subagent-test-"));
    try {
      const entry = join(root, "index.ts");
      await writeFile(entry, "export default () => {};\n");
      const tools = ALLOWED_WEB_TOOLS.map((name) => ({
        name,
        sourceInfo: { path: entry, baseDir: root },
      }));
      assert.equal(await resolveWebExtensionPath(tools), entry);
      await assert.rejects(
        () => resolveWebExtensionPath(tools.slice(1)),
        /requires enabled tools/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("pi-subagent public contract", () => {
  test("profile mapping is fixed", () => {
    assert.deepEqual(PROFILE_MODELS, {
      lookup: "openai-codex/gpt-5.6-luna",
      analysis: "openai-codex/gpt-5.6-terra",
      review: "openai-codex/gpt-5.6-sol",
    });
  });

  test("UTF-8 output truncation stays within its byte budget", () => {
    const result = truncateUtf8("가".repeat(100), 80);
    assert.equal(result.truncated, true);
    assert.ok(Buffer.byteLength(result.text, "utf8") <= 80);
    assert.equal(result.text.includes("�"), false);
    assert.match(result.text, /Subagent output truncated/);
  });
});
