import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALLOWED_WEB_TOOLS, MIN_WEB_EXTENSION_VERSION } from "./shared.ts";
import { resolveWebExtensionPath } from "./web-provenance.ts";

describe("pi-subagent web provenance", () => {
  test("resolves one common installed web extension source", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pi-subagent-test-")));
    try {
      const entry = join(root, "index.ts");
      await writeFile(entry, "export default () => {};\n");
      await writeFile(join(root, "package.json"), JSON.stringify({
        name: "pi-web-access",
        version: MIN_WEB_EXTENSION_VERSION,
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
      for (const version of ["0.33.0", "0.33.1", "0.34.0", "0.100.0", "1.0.0", "2.0.0", "0.33.0+build.1"]) {
        await writeFile(join(root, "package.json"), JSON.stringify({
          name: "pi-web-access", version, pi: { extensions: ["./index.ts"] },
        }));
        assert.equal(await resolveWebExtensionPath(tools), entry, version);
      }
      for (const version of ["0.27.0", "0.32.99", "0.9.0", "0.32.0+build", "0.33.0-rc.1", "0.34.0-beta.1", "1.0.0-rc.1", "0.033.0", "0.33", "v0.34.0", "0.34.0+", "0.34.0\n", "", null, 33]) {
        await writeFile(join(root, "package.json"), JSON.stringify({
          name: "pi-web-access", version, pi: { extensions: ["./index.ts"] },
        }));
        await assert.rejects(
          () => resolveWebExtensionPath(tools),
          /pi-web-access >=0\.33\.0 \(stable releases only\) package entry point/,
          String(version),
        );
      }
      await writeFile(join(root, "package.json"), JSON.stringify({
        name: "pi-web-access", version: "0.33.0", pi: { extensions: ["./other.ts"] },
      }));
      await assert.rejects(() => resolveWebExtensionPath(tools), /package entry point/);
      await writeFile(join(root, "package.json"), JSON.stringify({
        name: "lookalike-web-extension",
        version: "0.33.0",
        pi: { extensions: ["./index.ts"] },
      }));
      await assert.rejects(
        () => resolveWebExtensionPath(tools),
        /installed pi-web-access >=0\.33\.0 \(stable releases only\) package entry point/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("resolves packaged directory entries without trusting sibling files or source fallbacks", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pi-subagent-web-entry-")));
    try {
      const pkg = join(root, "package");
      const dist = join(pkg, "dist");
      await mkdir(dist, { recursive: true });
      const js = join(dist, "index.js");
      const ts = join(dist, "index.ts");
      const helper = join(dist, "helper.js");
      await writeFile(js, "export default () => {};\n");
      await writeFile(helper, "export default () => {};\n");
      const manifest = async (extensions: string[], name = "pi-web-access") => writeFile(
        join(pkg, "package.json"), JSON.stringify({ name, version: "0.33.0", pi: { extensions } }),
      );
      const tools = (path: string, baseDir = dist) => ALLOWED_WEB_TOOLS.map((name) => ({
        name, sourceInfo: { path, baseDir },
      }));
      await manifest(["./dist"]);
      for (const version of ["0.33.0", "0.34.0"]) {
        await writeFile(join(pkg, "package.json"), JSON.stringify({
          name: "pi-web-access", version, pi: { extensions: ["./dist"] },
        }));
        assert.equal(await resolveWebExtensionPath(tools(dist, pkg)), js, version);
      }
      assert.equal(await resolveWebExtensionPath(tools(js)), js);
      await assert.rejects(() => resolveWebExtensionPath(tools(helper)), /package entry point/);
      await assert.rejects(() => resolveWebExtensionPath(tools(join(pkg, "missing.js"))), /package entry point/);
      await assert.rejects(() => resolveWebExtensionPath(ALLOWED_WEB_TOOLS.map((name) => ({
        name, sourceInfo: { baseDir: dist },
      }))), /package entry point/);
      await assert.rejects(() => resolveWebExtensionPath([
        ...tools(js).slice(0, -1), tools(helper).at(-1)!,
      ]), /one trusted extension source/);

      await writeFile(ts, "export default () => {};\n");
      assert.equal(await resolveWebExtensionPath(tools(dist, pkg)), ts);
      await assert.rejects(() => resolveWebExtensionPath(tools(js)), /package entry point/);
      await manifest(["./dist/index.js"]);
      assert.equal(await resolveWebExtensionPath(tools(js)), js);
      await assert.rejects(() => resolveWebExtensionPath(tools(dist, pkg)), /package entry point/);
      await manifest(["./dist"]);
      await symlink(dist, join(pkg, "dist-link"));
      assert.equal(await resolveWebExtensionPath(tools(join(pkg, "dist-link"), pkg)), ts);
      await symlink(helper, join(dist, "other-link.js"));
      await manifest(["./dist/other-link.js"]);
      assert.equal(await resolveWebExtensionPath(tools(helper)), helper);

      const outside = join(root, "outside.js");
      await writeFile(outside, "export default () => {};\n");
      await symlink(outside, join(dist, "escape.js"));
      await manifest(["./dist/escape.js"]);
      await assert.rejects(() => resolveWebExtensionPath(tools(outside)), /package entry point/);
      await manifest(["../outside.js"]);
      await assert.rejects(() => resolveWebExtensionPath(tools(outside)), /package entry point/);
      await manifest(["./dist"], "not-pi-web-access");
      await assert.rejects(() => resolveWebExtensionPath(tools(ts)), /package entry point/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
