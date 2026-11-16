import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildPackage, packageFiles, renderExtensionReadme, renderPackageReadme, stagingDirectory } from "./build.mjs";
import {
  checkReadmeBody, extensionReadmePath, futureVersion, maintainedManifest, maintainedManifestText, packageRoot,
  rawRoot, sourceExtensionReadme, sourceReadme, sourceRoot,
} from "./test-support.mjs";

const relativeMarkdownTargets = (markdown) => [...markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)]
  .map((match) => match[1])
  .filter((target) => !/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(target))
  .map((target) => target.split("#", 1)[0]).filter(Boolean);

let manifest;
let topLevelReadme;
let bundledExtensionReadme;
let temporary;

before(async () => {
  await buildPackage();
  manifest = JSON.parse(await readFile(join(stagingDirectory, "package.json"), "utf8"));
  topLevelReadme = await readFile(join(stagingDirectory, "README.md"), "utf8");
  bundledExtensionReadme = await readFile(join(stagingDirectory, extensionReadmePath), "utf8");
  temporary = await realpath(await mkdtemp(join(tmpdir(), "pi-subagent-package-check-")));
  await mkdir(join(temporary, "home"));
});

after(async () => {
  await rm(temporary, { recursive: true, force: true });
});

function packDryRun() {
  const packed = spawnSync("npm", ["pack", "--dry-run", "--json"], { cwd: stagingDirectory, encoding: "utf8" });
  assert.equal(packed.status, 0, `npm pack --dry-run failed:\n${packed.stderr || packed.stdout}`);
  const report = JSON.parse(packed.stdout);
  assert.equal(report.length, 1);
  return report[0];
}

// Do not inherit credentials, active Pi configuration, or Node preload hooks.
function discover(directory) {
  const home = join(temporary, "home");
  const script = fileURLToPath(new URL("../../extensions/pi-subagent/scripts/package-discovery.mjs", import.meta.url));
  return spawnSync(process.execPath, [script, directory], {
    cwd: temporary,
    encoding: "utf8",
    timeout: 30_000,
    env: { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: join(home, ".pi/agent"), PI_OFFLINE: "1" },
  });
}

test("building leaves the maintained sources unchanged", async () => {
  assert.equal(await readFile(join(packageRoot, "manifest.json"), "utf8"), maintainedManifestText);
  assert.equal(await readFile(join(sourceRoot, "README.md"), "utf8"), sourceReadme);
  assert.equal(await readFile(join(sourceRoot, extensionReadmePath), "utf8"), sourceExtensionReadme);
});

test("the staged manifest declares the package, its resources and its gallery image", async () => {
  assert.equal(manifest.name, "@mdgchamomile/pi-subagent");
  assert.equal(manifest.private, undefined);
  assert.deepEqual(manifest.pi.extensions, ["./index.ts"], "load only the root entrypoint");
  assert.ok(manifest.keywords.includes("pi-package"));
  assert.equal(manifest.pi.image, `${rawRoot}/v${manifest.version}/extensions/pi-subagent/assets/pi-subagent-cover.png`);
  for (const resource of [...manifest.pi.extensions, ...manifest.pi.skills]) {
    const info = await stat(join(stagingDirectory, resource));
    assert.equal(info.isFile() || info.isDirectory(), true, `missing Pi resource: ${resource}`);
  }
});

test("the staged READMEs are the rendered sources with their prose preserved", () => {
  assert.equal(topLevelReadme, renderPackageReadme(sourceReadme, manifest.version));
  checkReadmeBody(sourceReadme, topLevelReadme);
  assert.equal(bundledExtensionReadme, renderExtensionReadme(sourceExtensionReadme, manifest.version));
  checkReadmeBody(sourceExtensionReadme, bundledExtensionReadme);
});

test("the staged READMEs load repository assets from the matching release", async () => {
  for (const [asset, readmes] of [
    ["pi-subagent-automatic.gif", [topLevelReadme]],
    ["pi-subagent-architecture.png", [topLevelReadme, bundledExtensionReadme]],
    ["pi-subagent-cover.png", [topLevelReadme]],
  ]) {
    assert.equal((await stat(join(sourceRoot, "extensions/pi-subagent/assets", asset))).isFile(), true,
      "repository assets must remain available for tagged URLs");
    for (const readme of readmes) {
      assert.ok(readme.includes(`${rawRoot}/v${manifest.version}/extensions/pi-subagent/assets/${asset}`));
    }
  }
});

test("the package README pins its guides and release URLs to the manifest version", () => {
  const links = new Map(
    [...topLevelReadme.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)].map(([, label, target]) => [label, target]),
  );
  const releaseRoot = `https://github.com/MDGChamomile/pi-subagent/blob/v${manifest.version}`;
  assert.equal(links.get("Extension guide"), `${releaseRoot}/extensions/pi-subagent/README.md`,
    "top-level extension guide must use the version-matched absolute GitHub URL");
  assert.equal(links.get("Skill guide"), `${releaseRoot}/skills/pi-subagent/README.md`,
    "top-level skill guide must use the version-matched absolute GitHub URL");

  const pinnedReleaseUrls = topLevelReadme.match(
    /https:\/\/(?:raw\.githubusercontent\.com\/MDGChamomile\/pi-subagent\/v[^/]+|github\.com\/MDGChamomile\/pi-subagent\/(?:blob|tree)\/v[^/]+)/g,
  ) ?? [];
  assert.ok(pinnedReleaseUrls.length >= 4, "package README must pin its release assets and documentation links");
  for (const url of pinnedReleaseUrls) {
    assert.ok(url.endsWith(`/v${manifest.version}`), `package README release URL does not match ${manifest.version}: ${url}`);
  }
});

test("the npm tarball contains exactly the declared files", () => {
  const report = packDryRun();
  assert.equal(report.name, manifest.name);
  assert.equal(report.version, manifest.version);
  const actualFiles = report.files.map(({ path }) => path).sort();
  assert.deepEqual(actualFiles, packageFiles.map(([, target]) => target).sort(), "npm tarball contains an unexpected file set");
  assert.equal(actualFiles.some((path) => path.startsWith("extensions/pi-subagent/assets/")), false,
    "repository presentation assets must not be bundled in the npm package");
});

test("relative link detection separates local files from URI schemes and anchors", () => {
  assert.deepEqual(relativeMarkdownTargets(
    '[Mail](mailto:help@example.com) [Remote](https://example.com) [Protocol](//example.com/path) [Here](#anchor) [Local](README.md#anchor)',
  ), ["README.md"]);
  assert.deepEqual(relativeMarkdownTargets('[Missing](missing.md)'), ["missing.md"]);
});

test("bundled Markdown links resolve inside the package", async () => {
  for (const [, markdownPath] of packageFiles.filter(([, target]) => target.endsWith(".md"))) {
    const markdown = await readFile(join(stagingDirectory, markdownPath), "utf8");
    for (const relativePath of relativeMarkdownTargets(markdown)) {
      await stat(join(stagingDirectory, dirname(markdownPath), relativePath));
    }
  }
});

test("version-only and body-only source changes propagate through the real builder", async () => {
  const fixtureRoot = join(temporary, "version-only");
  for (const source of [...packageFiles.map(([source]) => source), "packaging/pi-subagent/build.mjs"]) {
    const target = join(fixtureRoot, source);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(sourceRoot, source), target);
  }
  const fixturePackage = join(fixtureRoot, "packaging/pi-subagent");
  const build = () => {
    const built = spawnSync(process.execPath, [join(fixturePackage, "build.mjs")], { encoding: "utf8", timeout: 30_000 });
    assert.ifError(built.error);
    assert.equal(built.status, 0, built.stderr);
  };
  const staged = (path) => readFile(join(fixturePackage, "dist", path), "utf8");

  await writeFile(join(fixturePackage, "manifest.json"), JSON.stringify({ ...maintainedManifest, version: futureVersion }));
  build();
  const futureManifest = JSON.parse(await staged("package.json"));
  assert.equal(futureManifest.version, futureVersion);
  assert.equal(futureManifest.pi.image, `${rawRoot}/v${futureVersion}/extensions/pi-subagent/assets/pi-subagent-cover.png`);
  assert.equal(await staged("README.md"), renderPackageReadme(sourceReadme, futureVersion));
  assert.equal(await staged(extensionReadmePath), renderExtensionReadme(sourceExtensionReadme, futureVersion));
  assert.equal(await readFile(join(fixtureRoot, "README.md"), "utf8"), sourceReadme);
  assert.equal(await readFile(join(fixtureRoot, extensionReadmePath), "utf8"), sourceExtensionReadme);

  // The builder must not need a second maintained README, nor overwrite its input.
  const absoluteLinks = `\n[Pinned](${rawRoot}/v${maintainedManifest.version}/README.md)\nLiteral URL: ${rawRoot}/v${maintainedManifest.version}/README.md\n[Mail](mailto:help@example.com)\n`;
  const editedReadme = `${sourceReadme}\nCanonical body fixture.\n${absoluteLinks}`;
  const editedExtensionReadme = `${sourceExtensionReadme}\nExtension guide body fixture.\n${absoluteLinks}`;
  await writeFile(join(fixtureRoot, "README.md"), editedReadme);
  await writeFile(join(fixtureRoot, extensionReadmePath), editedExtensionReadme);
  build();
  assert.equal(await staged("README.md"), renderPackageReadme(editedReadme, futureVersion));
  assert.equal(await readFile(join(fixtureRoot, "README.md"), "utf8"), editedReadme);
  assert.equal(await staged(extensionReadmePath), renderExtensionReadme(editedExtensionReadme, futureVersion));
  assert.equal(await readFile(join(fixtureRoot, extensionReadmePath), "utf8"), editedExtensionReadme);
});

test("Pi discovers the staged parent extension, child guard and companion skill", () => {
  const loaded = discover(stagingDirectory);
  assert.ok(!loaded.error && loaded.status === 0 && !loaded.stderr,
    `Pi package discovery failed:\n${loaded.error || loaded.stderr || loaded.stdout}`);
});

// Negative controls run the same subprocess and assertions as the release check,
// on a copy: never corrupt the release candidate to test the checker.
for (const [name, mutate, expectedError] of [
  ["broken-import", async (directory) => {
    await writeFile(join(directory, "index.ts"), 'import "./missing-extension.ts";\n');
  }, /Pi extension loading failed/],
  ["broken-child-import", async (directory) => {
    const child = join(directory, "extensions/pi-subagent/child-guard.ts");
    await writeFile(child, 'import "./missing-child-dependency.ts";\n' + await readFile(child, "utf8"));
  }, /Pi child extension loading failed/],
  ["missing-path-policy", async (directory) => {
    await rm(join(directory, "extensions/pi-subagent/path-policy.ts"));
  }, /Pi extension loading failed/],
  ["missing-web-provenance", async (directory) => {
    await rm(join(directory, "extensions/pi-subagent/web-provenance.ts"));
  }, /Pi extension loading failed/],
  ["missing-tool", async (directory) => {
    await writeFile(join(directory, "index.ts"), "export default function () {}\n");
  }, /expected pi_subagent tool registration/],
  ["missing-skill", async (directory) => {
    await writeFile(join(directory, "package.json"), JSON.stringify({ ...manifest, pi: { ...manifest.pi, skills: [] } }));
  }, /expected exactly one companion skill/],
]) {
  test(`discovery rejects a package with ${name}`, async () => {
    const directory = join(temporary, name);
    await cp(stagingDirectory, directory, { recursive: true });
    await mutate(directory);
    const rejected = discover(directory);
    assert.ifError(rejected.error);
    assert.equal(rejected.status, 1, `${name} must fail package discovery`);
    assert.match(rejected.stderr, expectedError, `${name} must fail for the intended reason`);
  });
}
