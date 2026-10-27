import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { authorizeReadPath, buildChildPolicy, makeCanonicalTempDirectory, normalizeInputPath } from "./path-policy.ts";
import { buildChildPrompt } from "./subprocess.ts";

describe("pi-subagent scope policy", () => {
  test("canonicalizes, deduplicates, and authorizes explicit roots", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pi-subagent-test-")));
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
    const root = await realpath(await mkdtemp(join(tmpdir(), "pi-subagent-test-")));
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

  test("rejects tool-path changes introduced by file URLs and canonical symlink targets", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pi-subagent-path-identity-")));
    try {
      const spaces = [0x00a0, ...Array.from({ length: 11 }, (_, i) => 0x2000 + i), 0x202f, 0x205f, 0x3000];
      for (const code of spaces) {
        const directory = join(root, `allowed${String.fromCodePoint(code)}${code}`);
        const alias = join(root, `alias-${code}`);
        await mkdir(directory);
        await symlink(directory, alias, "dir");
        await assert.rejects(buildChildPolicy(root, [pathToFileURL(directory).href]), /would change under Pi's tool path normalization/);
        await assert.rejects(buildChildPolicy(root, [alias]), /would change under Pi's tool path normalization/);
        await assert.rejects(buildChildPolicy(alias, ["."]), /would change under Pi's tool path normalization/);
        // Web children do not execute local tools and need not reject this cwd.
        assert.deepEqual((await buildChildPolicy(alias, [], "web")).roots, []);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("preserves ordinary spaces, Unicode letters, file URLs, and stable aliases", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pi-subagent-path-identity-")));
    try {
      const directory = join(root, "allowed 자료");
      await mkdir(directory);
      const file = join(directory, "evidence.txt");
      await writeFile(file, "synthetic evidence\n");
      await symlink(directory, join(root, "alias"), "dir");
      const policy = await buildChildPolicy(root, [pathToFileURL(directory).href, "alias"]);
      assert.equal(policy.roots.length, 1);
      assert.equal(await authorizeReadPath(policy, pathToFileURL(file).href), await realpath(file));
      assert.equal(await authorizeReadPath(policy, "@alias/evidence.txt"), await realpath(file));
    } finally { await rm(root, { recursive: true, force: true }); }
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
