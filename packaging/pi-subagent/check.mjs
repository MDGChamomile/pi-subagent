import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPackage, packageFiles, releaseUrls, renderExtensionReadme, renderPackageReadme, stagingDirectory } from "./build.mjs";
import { SUBAGENT_PRESETS } from "../../extensions/pi-subagent/shared.ts";

// A future version must update every generated release URL without source edits.
const packageRoot = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(packageRoot, "../..");
const maintainedManifestText = await readFile(join(packageRoot, "manifest.json"), "utf8");
const sourceReadme = await readFile(join(sourceRoot, "README.md"), "utf8");
const extensionReadmePath = "extensions/pi-subagent/README.md";
const sourceExtensionReadme = await readFile(join(sourceRoot, extensionReadmePath), "utf8");
const maintainedManifest = JSON.parse(maintainedManifestText);
const futureVersion = "99.12.34";
const rawRoot = "https://raw.githubusercontent.com/MDGChamomile/pi-subagent";
assert.equal(
  releaseUrls(maintainedManifest.pi.image, futureVersion),
  `${rawRoot}/v${futureVersion}/extensions/pi-subagent/assets/pi-subagent-automatic.gif`,
  "gallery must use the model-invoked demo at the selected version",
);
const futureReadme = renderPackageReadme(sourceReadme, futureVersion);
const maintainedUrls = renderPackageReadme(sourceReadme, maintainedManifest.version).match(/https:\/\/[^\s)]+\/v\d+\.\d+\.\d+\/[^\s)]+/g) ?? [];
assert.ok(maintainedUrls.length >= 8, "exercise images, architecture, guides, and license URLs");
for (const url of maintainedUrls) {
  assert.ok(futureReadme.includes(url.replace(/\/v\d+\.\d+\.\d+\//, `/v${futureVersion}/`)));
}
const unrelated = "https://github.com/other/project/blob/v0.5.0/README.md extensions/pi-subagent/assets/pi-subagent-automatic.gif";
assert.equal(releaseUrls(unrelated, futureVersion), unrelated);
assert.equal(renderPackageReadme(futureReadme, futureVersion), futureReadme, "URL rendering is idempotent");
assert.throws(() => renderPackageReadme(sourceReadme, "1.0.0-beta.1"), /stable release version/);
const inlineLinks = '![Preview](extensions/pi-subagent/assets/pi-subagent-automatic.gif)\n[Guide](extensions/pi-subagent/README.md#presets)\n[Here](#presets)\n[Remote](https://example.com/guide)\n[Mail](mailto:help@example.com)';
assert.equal(renderPackageReadme(inlineLinks, futureVersion),
  `![Preview](${rawRoot}/v${futureVersion}/extensions/pi-subagent/assets/pi-subagent-automatic.gif)\n[Guide](https://github.com/MDGChamomile/pi-subagent/blob/v${futureVersion}/extensions/pi-subagent/README.md#presets)\n[Here](#presets)\n[Remote](https://example.com/guide)\n[Mail](mailto:help@example.com)`);

const guideLinks = '![Demo](assets/pi-subagent-automatic.gif)\n[![Architecture](assets/pi-subagent-architecture.png)](assets/pi-subagent-architecture.png)\n[Skill](../../skills/pi-subagent/README.md)\n[Here](#presets)\n[Remote](https://example.com/image.png)';
const futureAssets = `${rawRoot}/v${futureVersion}/extensions/pi-subagent/assets/`;
assert.equal(renderExtensionReadme(guideLinks, futureVersion),
  `![Demo](${futureAssets}pi-subagent-automatic.gif)\n[![Architecture](${futureAssets}pi-subagent-architecture.png)](${futureAssets}pi-subagent-architecture.png)\n[Skill](../../skills/pi-subagent/README.md)\n[Here](#presets)\n[Remote](https://example.com/image.png)`);
const futureExtensionReadme = renderExtensionReadme(sourceExtensionReadme, futureVersion);
assert.equal(renderExtensionReadme(futureExtensionReadme, futureVersion), futureExtensionReadme);
assert.throws(() => renderExtensionReadme(sourceExtensionReadme, "1.0.0-beta.1"), /stable release version/);

await buildPackage();
assert.equal(await readFile(join(packageRoot, "manifest.json"), "utf8"), maintainedManifestText);
assert.equal(await readFile(join(sourceRoot, "README.md"), "utf8"), sourceReadme);
assert.equal(await readFile(join(sourceRoot, extensionReadmePath), "utf8"), sourceExtensionReadme);

const manifest = JSON.parse(await readFile(join(stagingDirectory, "package.json"), "utf8"));
assert.equal(manifest.name, "@mdgchamomile/pi-subagent");
assert.equal(manifest.private, undefined);
assert.deepEqual(manifest.pi.extensions, ["./index.ts"], "load only the root entrypoint");
assert.deepEqual(manifest.keywords.includes("pi-package"), true);
assert.equal(manifest.pi.image, `${rawRoot}/v${manifest.version}/extensions/pi-subagent/assets/pi-subagent-automatic.gif`);

const topLevelReadme = await readFile(join(stagingDirectory, "README.md"), "utf8");
assert.equal(topLevelReadme, renderPackageReadme(sourceReadme, manifest.version));
assert.equal(
  topLevelReadme
    .replaceAll(`${rawRoot}/v${manifest.version}/`, "")
    .replaceAll(`https://github.com/MDGChamomile/pi-subagent/blob/v${manifest.version}/`, ""),
  sourceReadme,
  "package README must preserve the entire canonical body, changing only link destinations",
);

const bundledExtensionReadme = await readFile(join(stagingDirectory, extensionReadmePath), "utf8");
assert.equal(bundledExtensionReadme, renderExtensionReadme(sourceExtensionReadme, manifest.version));
assert.equal(
  bundledExtensionReadme.replaceAll(`${rawRoot}/v${manifest.version}/extensions/pi-subagent/`, ""),
  sourceExtensionReadme,
  "bundled extension guide must preserve its body and document links, rebasing only asset links",
);
for (const asset of ["pi-subagent-automatic.gif", "pi-subagent-architecture.png"]) {
  assert.equal((await stat(join(sourceRoot, "extensions/pi-subagent/assets", asset))).isFile(), true,
    "repository assets must remain available for tagged URLs");
  assert.ok(bundledExtensionReadme.includes(`${rawRoot}/v${manifest.version}/extensions/pi-subagent/assets/${asset}`));
}

const sharedRequirementPatterns = [
  ["minimum Pi version", /Pi 0\.99\.1 or later/],
  ["provider authentication requirement", /authentication for the configured child provider/],
  ["minimum web extension version", /pi-web-access` v0\.33\.0 or later/],
  ["npm installation command", /pi install npm:@mdgchamomile\/pi-subagent/],
];
for (const [description, pattern] of sharedRequirementPatterns) {
  assert.match(sourceReadme, pattern, `source README is missing ${description}`);
}
for (const path of ["extensions/pi-subagent/README.md", "skills/pi-subagent/README.md", "skills/pi-subagent/SKILL.md"]) {
  const guide = await readFile(join(sourceRoot, path), "utf8");
  assert.match(guide, /Pi 0\.99\.1 or later/, `${path} has an outdated Pi minimum`);
  assert.match(guide, /pi-web-access(?:`)? v0\.33\.0 or later/, `${path} has an outdated web minimum`);
}
const sharedSource = await readFile(join(sourceRoot, "extensions/pi-subagent/shared.ts"), "utf8");
assert.match(sharedSource, /MIN_WEB_EXTENSION_VERSION = "0\.33\.0"/, "runtime web minimum is out of sync");

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

// Negative controls must reject stale values and missing or unexpected rows.
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

const topLevelLinks = new Map(
  [...topLevelReadme.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)].map(([, label, target]) => [label, target]),
);
const releaseRoot = `https://github.com/MDGChamomile/pi-subagent/blob/v${manifest.version}`;
assert.equal(
  topLevelLinks.get("extension guide"),
  `${releaseRoot}/extensions/pi-subagent/README.md`,
  "top-level extension guide must use the version-matched absolute GitHub URL",
);
assert.equal(
  topLevelLinks.get("skill guide"),
  `${releaseRoot}/skills/pi-subagent/README.md`,
  "top-level skill guide must use the version-matched absolute GitHub URL",
);

const pinnedReleaseUrls = topLevelReadme.match(
  /https:\/\/(?:raw\.githubusercontent\.com\/MDGChamomile\/pi-subagent\/v[^/]+|github\.com\/MDGChamomile\/pi-subagent\/(?:blob|tree)\/v[^/]+)/g,
) ?? [];
assert.ok(pinnedReleaseUrls.length >= 4, "package README must pin its release assets and documentation links");
for (const url of pinnedReleaseUrls) {
  assert.ok(url.endsWith(`/v${manifest.version}`), `package README release URL does not match ${manifest.version}: ${url}`);
}

for (const resource of [...manifest.pi.extensions, ...manifest.pi.skills]) {
  const info = await stat(join(stagingDirectory, resource));
  assert.equal(info.isFile() || info.isDirectory(), true, `missing Pi resource: ${resource}`);
}

const packed = spawnSync("npm", ["pack", "--dry-run", "--json"], {
  cwd: stagingDirectory,
  encoding: "utf8",
});
if (packed.status !== 0) {
  throw new Error(`npm pack --dry-run failed:\n${packed.stderr || packed.stdout}`);
}

const report = JSON.parse(packed.stdout);
assert.equal(report.length, 1);
assert.equal(report[0].name, manifest.name);
assert.equal(report[0].version, manifest.version);

const actualFiles = report[0].files.map(({ path }) => path).sort();
const expectedFiles = packageFiles.map(([, target]) => target).sort();
assert.deepEqual(actualFiles, expectedFiles, "npm tarball contains an unexpected file set");
assert.equal(actualFiles.some((path) => path.startsWith("extensions/pi-subagent/assets/")), false,
  "repository presentation assets must not be bundled in the npm package");

for (const [markdownPath, root] of [
  ["README.md", sourceRoot],
  ...actualFiles.filter((path) => path.endsWith(".md")).map((path) => [path, stagingDirectory]),
]) {
  const markdown = await readFile(join(root, markdownPath), "utf8");
  for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1];
    if (target.includes("://") || target.startsWith("#")) continue;
    const relativePath = target.split("#", 1)[0];
    if (!relativePath) continue;
    await stat(join(root, dirname(markdownPath), relativePath));
  }
}

const temporaryConfig = await mkdtemp(join(tmpdir(), "pi-subagent-package-check-"));
try {
  // Exercise a version-only change through the real builder in a disposable tree.
  const fixtureRoot = join(temporaryConfig, "version-only");
  for (const source of [...packageFiles.map(([source]) => source), "packaging/pi-subagent/build.mjs"]) {
    const target = join(fixtureRoot, source);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(sourceRoot, source), target);
  }
  const fixturePackage = join(fixtureRoot, "packaging/pi-subagent");
  await writeFile(join(fixturePackage, "manifest.json"), JSON.stringify({ ...maintainedManifest, version: futureVersion }));
  const built = spawnSync(process.execPath, [join(fixturePackage, "build.mjs")], { encoding: "utf8", timeout: 30_000 });
  assert.ifError(built.error);
  assert.equal(built.status, 0, built.stderr);
  const futureManifest = JSON.parse(await readFile(join(fixturePackage, "dist/package.json"), "utf8"));
  assert.equal(futureManifest.version, futureVersion);
  assert.equal(futureManifest.pi.image, `${rawRoot}/v${futureVersion}/extensions/pi-subagent/assets/pi-subagent-automatic.gif`);
  assert.equal(await readFile(join(fixturePackage, "dist/README.md"), "utf8"), futureReadme);
  assert.equal(await readFile(join(fixturePackage, "dist", extensionReadmePath), "utf8"), futureExtensionReadme);
  assert.equal(await readFile(join(fixtureRoot, "README.md"), "utf8"), sourceReadme);
  assert.equal(await readFile(join(fixtureRoot, extensionReadmePath), "utf8"), sourceExtensionReadme);

  // A body-only source edit must propagate through the real builder without a
  // second maintained README, and the builder must not overwrite its input.
  const editedReadme = `${sourceReadme}\nCanonical body fixture.\n`;
  const editedExtensionReadme = `${sourceExtensionReadme}\nExtension guide body fixture.\n`;
  await writeFile(join(fixtureRoot, "README.md"), editedReadme);
  await writeFile(join(fixtureRoot, extensionReadmePath), editedExtensionReadme);
  const rebuilt = spawnSync(process.execPath, [join(fixturePackage, "build.mjs")], { encoding: "utf8", timeout: 30_000 });
  assert.ifError(rebuilt.error);
  assert.equal(rebuilt.status, 0, rebuilt.stderr);
  assert.equal(await readFile(join(fixturePackage, "dist/README.md"), "utf8"), renderPackageReadme(editedReadme, futureVersion));
  assert.equal(await readFile(join(fixtureRoot, "README.md"), "utf8"), editedReadme);
  assert.equal(await readFile(join(fixturePackage, "dist", extensionReadmePath), "utf8"), renderExtensionReadme(editedExtensionReadme, futureVersion));
  assert.equal(await readFile(join(fixtureRoot, extensionReadmePath), "utf8"), editedExtensionReadme);

  const home = join(temporaryConfig, "home");
  await mkdir(home);
  const discoveryScript = fileURLToPath(new URL("../../extensions/pi-subagent/scripts/package-discovery.mjs", import.meta.url));
  const discover = (directory) => spawnSync(process.execPath, [discoveryScript, directory], {
    cwd: temporaryConfig,
    encoding: "utf8",
    timeout: 30_000,
    // Do not inherit credentials, active Pi configuration, or Node preload hooks.
    env: {
      PATH: process.env.PATH,
      HOME: home,
      PI_CODING_AGENT_DIR: join(home, ".pi/agent"),
      PI_OFFLINE: "1",
    },
  });
  const loaded = discover(stagingDirectory);
  if (loaded.error || loaded.status !== 0 || loaded.stderr) {
    throw new Error(`Pi package discovery failed:\n${loaded.error || loaded.stderr || loaded.stdout}`);
  }

  // Negative controls exercise the same subprocess and assertions as the release check.
  // Copy the staged package: never corrupt the release candidate to test the checker.
  for (const [name, mutate, expectedError] of [
    ["broken-import", async (directory) => {
      await writeFile(join(directory, "index.ts"), 'import "./missing-extension.ts";\n');
    }, /Pi extension loading failed/],
    ["broken-child-import", async (directory) => {
      const child = join(directory, "extensions/pi-subagent/child-guard.ts");
      await writeFile(child, 'import "./missing-child-dependency.ts";\n' + await readFile(child, "utf8"));
    }, /Pi child extension loading failed/],
    ["missing-tool", async (directory) => {
      await writeFile(join(directory, "index.ts"), "export default function () {}\n");
    }, /expected pi_subagent tool registration/],
    ["missing-skill", async (directory) => {
      await writeFile(join(directory, "package.json"), JSON.stringify({
        ...manifest, pi: { ...manifest.pi, skills: [] },
      }));
    }, /expected exactly one companion skill/],
  ]) {
    const directory = join(temporaryConfig, name);
    await cp(stagingDirectory, directory, { recursive: true });
    await mutate(directory);
    const rejected = discover(directory);
    assert.ifError(rejected.error);
    assert.equal(rejected.status, 1, `${name} must fail package discovery`);
    assert.match(rejected.stderr, expectedError, `${name} must fail for the intended reason`);
  }
} finally {
  await rm(temporaryConfig, { recursive: true, force: true });
}

console.log(`${manifest.name}@${manifest.version}: ${actualFiles.length} package files, Pi parent/child discovery, and 4 negative controls verified`);
