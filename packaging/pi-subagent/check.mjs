import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPackage, packageFiles, releaseUrls, stagingDirectory } from "./build.mjs";
import { SUBAGENT_PRESETS } from "../../extensions/pi-subagent/shared.ts";

// A future version must update every maintained release URL without source edits.
const packageRoot = dirname(fileURLToPath(import.meta.url));
const maintainedManifestText = await readFile(join(packageRoot, "manifest.json"), "utf8");
const maintainedReadme = await readFile(join(packageRoot, "README.md"), "utf8");
const maintainedManifest = JSON.parse(maintainedManifestText);
const futureVersion = "99.12.34";
const rawRoot = "https://raw.githubusercontent.com/MDGChamomile/pi-subagent";
assert.equal(
  releaseUrls(maintainedManifest.pi.image, futureVersion),
  `${rawRoot}/v${futureVersion}/extensions/pi-subagent/assets/pi-subagent-automatic.gif`,
  "gallery must use the model-invoked demo at the selected version",
);
const futureReadme = releaseUrls(maintainedReadme, futureVersion);
const maintainedUrls = maintainedReadme.match(/https:\/\/[^\s)]+\/v\d+\.\d+\.\d+\/[^\s)]+/g) ?? [];
assert.ok(maintainedUrls.length >= 8, "exercise images, architecture, guides, and license URLs");
for (const url of maintainedUrls) {
  assert.ok(futureReadme.includes(url.replace(/\/v\d+\.\d+\.\d+\//, `/v${futureVersion}/`)));
}
const unrelated = "https://github.com/other/project/blob/v0.5.0/README.md extensions/pi-subagent/assets/pi-subagent-automatic.gif";
assert.equal(releaseUrls(unrelated, futureVersion), unrelated);
assert.equal(releaseUrls(futureReadme, futureVersion), futureReadme, "URL rendering is idempotent");
assert.throws(() => releaseUrls(maintainedReadme, "1.0.0-beta.1"), /stable release version/);

await buildPackage();
assert.equal(await readFile(join(packageRoot, "manifest.json"), "utf8"), maintainedManifestText);
assert.equal(await readFile(join(packageRoot, "README.md"), "utf8"), maintainedReadme);

const manifest = JSON.parse(await readFile(join(stagingDirectory, "package.json"), "utf8"));
assert.equal(manifest.name, "@mdgchamomile/pi-subagent");
assert.equal(manifest.private, undefined);
assert.deepEqual(manifest.pi.extensions, ["./index.ts"], "load only the root entrypoint");
assert.deepEqual(manifest.keywords.includes("pi-package"), true);
assert.equal(manifest.pi.image, `${rawRoot}/v${manifest.version}/extensions/pi-subagent/assets/pi-subagent-automatic.gif`);

const topLevelReadme = await readFile(join(stagingDirectory, "README.md"), "utf8");
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourceReadme = await readFile(join(sourceRoot, "README.md"), "utf8");
assert.equal(topLevelReadme, releaseUrls(maintainedReadme, manifest.version));
const demoSection = (text) => text.split("### See it in action\n")[1].split("\n## Why use it?")[0];
assert.equal(
  demoSection(topLevelReadme).replaceAll(`${rawRoot}/v${manifest.version}/`, ""),
  demoSection(sourceReadme),
  "source and package demo descriptions must agree",
);

const sharedRequirementPatterns = [
  ["minimum Pi version", /Pi 0\.99\.1 or later/],
  ["provider authentication requirement", /authentication for the configured child provider/],
  ["minimum web extension version", /pi-web-access` v0\.33\.0 or later/],
  ["npm installation command", /pi install npm:@mdgchamomile\/pi-subagent/],
];
for (const [description, pattern] of sharedRequirementPatterns) {
  assert.match(sourceReadme, pattern, `source README is missing ${description}`);
  assert.match(topLevelReadme, pattern, `package README is missing ${description}`);
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
for (const [name, markdown] of [["source", sourceReadme], ["package", topLevelReadme]]) {
  const checkPresets = (text) => assert.deepEqual(
    presetRows(text), expectedPresets, `${name} README preset contract is inaccurate`,
  );
  checkPresets(markdown);

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
    assert.throws(() => checkPresets(markdown.replace(row, replacement)), {
      code: "ERR_ASSERTION",
      message: new RegExp(`${name} README preset contract is inaccurate`),
    });
  }
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

for (const markdownPath of actualFiles.filter((path) => path.endsWith(".md"))) {
  const markdown = await readFile(join(stagingDirectory, markdownPath), "utf8");
  for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1];
    if (target.includes("://") || target.startsWith("#")) continue;
    const relativePath = target.split("#", 1)[0];
    if (!relativePath) continue;
    await stat(join(stagingDirectory, dirname(markdownPath), relativePath));
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
  assert.equal(await readFile(join(fixturePackage, "README.md"), "utf8"), maintainedReadme);

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
