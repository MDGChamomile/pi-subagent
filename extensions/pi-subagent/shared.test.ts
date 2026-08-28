import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ALLOWED_WEB_TOOLS,
  authorizeReadPath,
  boundedParentError,
  buildChildPolicy,
  buildChildPrompt,
  CHILD_FINALIZATION_GRACE_MS,
  CHILD_TIMEOUT_MS,
  invocationLimitBlock,
  makeCanonicalTempDirectory,
  MAX_PARENT_ERROR_BYTES,
  MAX_SUBAGENT_CALLS,
  ModelInvocationGate,
  normalizeInputPath,
  normalizePreset,
  PRESET_NAMES,
  resolveWebExtensionPath,
  SUBAGENT_PRESETS,
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

  test("separates local and web capabilities", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-subagent-test-"));
    try {
      await writeFile(join(root, "local.txt"), "local\n");
      const webPolicy = await buildChildPolicy(root, [], "web");
      assert.deepEqual(webPolicy.roots, []);
      assert.match(buildChildPrompt("Research a public API", webPolicy), /none; web-only investigation/);
      await assert.rejects(() => authorizeReadPath(webPolicy, "."), /outside its explicit scope/);
      const localPolicy = await buildChildPolicy(root, ["local.txt"], "local");
      assert.equal(localPolicy.capability, "local");
      await assert.rejects(() => buildChildPolicy(root, [], "local"), /requires at least one local scope/);
      await assert.rejects(() => buildChildPolicy(root, ["local.txt"], "web"), /requires an empty local scope/);
      await assert.rejects(() => buildChildPolicy(root, ["local.txt"], "both" as any), /must be local or web/);
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
      const policy = await buildChildPolicy(workspace, ["inside.txt"], "local");
      await assert.rejects(() => authorizeReadPath(policy, outside), /outside its explicit scope/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a bare @ scope without changing explicit cwd and @file scopes", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-subagent-test-"));
    try {
      await writeFile(join(root, "a.txt"), "a\n");
      assert.throws(() => normalizeInputPath("@", root), /Scope path is empty/);
      await assert.rejects(() => buildChildPolicy(root, ["@"], "local"), /Scope path is empty/);
      assert.equal(normalizeInputPath("@a.txt", root), join(root, "a.txt"));
      const cwdPolicy = await buildChildPolicy(root, ["."], "local");
      assert.equal(cwdPolicy.roots[0]?.path, await realpath(root));
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

  test("canonicalizes temporary directories created beneath a symlink base", async () => {
    const realBase = await mkdtemp(join(tmpdir(), "pi-subagent-temp-base-"));
    const linkBase = `${realBase}-link`;
    let childDir: string | undefined;
    try {
      await symlink(realBase, linkBase, "dir");
      childDir = await makeCanonicalTempDirectory(join(linkBase, "child-"));
      assert.equal(childDir, await realpath(childDir));
      assert.equal(dirname(childDir), await realpath(realBase));
    } finally {
      if (childDir) await rm(childDir, { recursive: true, force: true });
      await rm(linkBase, { force: true });
      await rm(realBase, { recursive: true, force: true });
    }
  });
});

describe("pi-subagent model invocation contract", () => {
  test("allows three started children plus one corrected preflight retry per parent agent run", () => {
    const gate = new ModelInvocationGate();
    assert.equal(gate.authorize("before-run"), false);
    gate.startRun();
    assert.equal(gate.authorize("call-1"), true);
    assert.equal(gate.authorize("call-2"), true);
    assert.equal(gate.authorize("call-3"), true);
    assert.equal(gate.authorize("call-4"), false);
    assert.equal(gate.rejectPreflight("wrong-id"), false);
    assert.equal(gate.rejectPreflight("call-1"), true);
    assert.equal(gate.authorize("retry-1"), true);
    assert.equal(gate.authorize("parallel-retry"), false);
    assert.equal(gate.rejectPreflight("retry-1"), true);
    assert.equal(gate.authorize("third-attempt"), false);
    assert.equal(gate.commit("call-2"), true);
    assert.equal(gate.commit("call-3"), true);
    gate.startRun();
    assert.equal(gate.authorize("same-unsettled-run"), false);
    gate.endRun();
    assert.equal(gate.commit("call-2"), false);

    gate.startRun();
    for (let index = 0; index < MAX_SUBAGENT_CALLS; index++) {
      const id = `started-${index}`;
      assert.equal(gate.authorize(id), true);
      assert.equal(gate.commit(id), true);
    }
    assert.equal(gate.authorize("after-limit"), false);
    const denied = invocationLimitBlock();
    assert.equal(denied.block, true);
    assert.equal((denied as { terminate?: boolean }).terminate, undefined);
    assert.match(denied.reason, /Do not retry/);
    assert.match(denied.reason, /continue with successful sibling results or investigate in the parent/);
  });

  test("allows remaining started calls after a corrected preflight retry succeeds", () => {
    const gate = new ModelInvocationGate();
    gate.startRun();
    assert.equal(gate.authorize("invalid"), true);
    assert.equal(gate.rejectPreflight("invalid"), true);
    assert.equal(gate.authorize("replacement"), true);
    assert.equal(gate.commit("replacement"), true);
    assert.equal(gate.authorize("second"), true);
    assert.equal(gate.commit("second"), true);
    assert.equal(gate.authorize("third"), true);
    assert.equal(gate.commit("third"), true);
    assert.equal(gate.authorize("fourth"), false);

    gate.endRun();
    gate.startRun();
    assert.equal(gate.authorize("first-invalid"), true);
    assert.equal(gate.rejectPreflight("first-invalid"), true);
    assert.equal(gate.authorize("first-replacement"), true);
    assert.equal(gate.commit("first-replacement"), true);
    assert.equal(gate.authorize("second-invalid"), true);
    assert.equal(gate.rejectPreflight("second-invalid"), true);
    assert.equal(gate.authorize("second-replacement"), false);
  });

  test("skill is visible for model invocation", async () => {
    const skillPath = fileURLToPath(new URL("../../skills/pi-subagent/SKILL.md", import.meta.url));
    const skill = await readFile(skillPath, "utf8");
    assert.doesNotMatch(skill, /disable-model-invocation:\s*true/);
    assert.match(skill, /The model may select it automatically/);
    assert.match(skill, /public-web investigation/);
    assert.match(skill, /separate `local` and `web` calls/);
    assert.match(skill, /up to 10 material findings/);
    assert.match(skill, /result marked `partial`/);
    assert.match(skill, /Do not repeat broad reads/);
  });

  test("resolves one common installed web extension source", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-subagent-test-"));
    try {
      const entry = join(root, "index.ts");
      await writeFile(entry, "export default () => {};\n");
      await writeFile(join(root, "package.json"), JSON.stringify({
        name: "pi-web-access",
        pi: { extensions: ["./index.ts"] },
      }));
      const tools = ALLOWED_WEB_TOOLS.map((name) => ({
        name,
        sourceInfo: { path: entry, baseDir: root },
      }));
      assert.equal(await resolveWebExtensionPath(tools), entry);
      await assert.rejects(
        () => resolveWebExtensionPath(tools.slice(1)),
        /requires enabled tools/,
      );
      await writeFile(join(root, "package.json"), JSON.stringify({
        name: "lookalike-web-extension",
        pi: { extensions: ["./index.ts"] },
      }));
      await assert.rejects(
        () => resolveWebExtensionPath(tools),
        /installed pi-web-access package entry point/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("pi-subagent public contract", () => {
  test("exposes bounded runtime and three standard model presets", () => {
    assert.equal(CHILD_TIMEOUT_MS, 20 * 60 * 1000);
    assert.equal(CHILD_FINALIZATION_GRACE_MS, 2 * 60 * 1000);
    assert.equal(MAX_SUBAGENT_CALLS, 3);
    const expectedPresets = {
      "lookup-standard": { model: "openai-codex/gpt-5.6-luna", thinking: "low" },
      "analysis-standard": { model: "openai-codex/gpt-5.6-terra", thinking: "medium" },
      "review-standard": { model: "openai-codex/gpt-5.6-sol", thinking: "medium" },
    };
    assert.deepEqual(SUBAGENT_PRESETS, expectedPresets);
    assert.deepEqual(PRESET_NAMES, Object.keys(expectedPresets));
    assert.equal(normalizePreset(undefined, "lookup"), "lookup-standard");
    assert.equal(normalizePreset(undefined, "analysis"), "analysis-standard");
    assert.equal(normalizePreset(undefined, "review"), "review-standard");
    assert.equal(normalizePreset("lookup-balanced", undefined), "lookup-standard");
    assert.equal(normalizePreset("analysis-deep", undefined), "analysis-standard");
    assert.equal(normalizePreset("review-exhaustive", undefined), "review-standard");
    assert.equal(normalizePreset("unknown", "analysis"), undefined);
  });

  test("UTF-8 output truncation stays within its byte budget", () => {
    const result = truncateUtf8("가".repeat(100), 80);
    assert.equal(result.truncated, true);
    assert.ok(Buffer.byteLength(result.text, "utf8") <= 80);
    assert.equal(result.text.includes("�"), false);
    assert.match(result.text, /Subagent output truncated/);
  });

  test("bounds and sanitizes every error that can reach the parent", () => {
    const result = boundedParentError(`provider\u001b[31m\u202efailed ${"가".repeat(MAX_PARENT_ERROR_BYTES)}`);
    assert.ok(Buffer.byteLength(result, "utf8") <= MAX_PARENT_ERROR_BYTES);
    assert.doesNotMatch(result, /\u001b|\u202e/);
    assert.equal(result.includes("�"), false);
    assert.match(result, /Subagent error truncated/);
  });

  test("reserves room for content-free failure diagnostics under the same error bound", () => {
    const result = boundedParentError(`provider failed ${"가".repeat(MAX_PARENT_ERROR_BYTES)}`, {
      phase: "output",
      exitCode: 0,
      stopReason: "stop\u202eunsafe",
      durationMs: 123.6,
      assistantMessages: 4,
      lastAssistantMode: "text",
      toolErrors: 2,
      lastToolError: "read\u001b[31m",
    });
    assert.ok(Buffer.byteLength(result, "utf8") <= MAX_PARENT_ERROR_BYTES);
    assert.doesNotMatch(result, /\u001b|\u202e/);
    assert.equal(result.includes("�"), false);
    assert.match(result, /Subagent error truncated/);
    assert.match(result, /Subagent diagnostics/);
    assert.match(result, /"phase":"output"/);
    assert.match(result, /"durationMs":124/);
    assert.match(result, /"toolErrors":2/);
  });
});
