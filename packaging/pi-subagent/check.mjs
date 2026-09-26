import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPackage, packageFiles, releaseUrls, stagingDirectory } from "./build.mjs";

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
  ["minimum Pi version", /Pi 0\.84\.2 or later/],
  ["provider authentication requirement", /authentication for Pi's `openai-codex` provider/],
  ["minimum web extension version", /pi-web-access` v0\.27\.0 or later/],
  ["npm installation command", /pi install npm:@mdgchamomile\/pi-subagent/],
];
for (const [description, pattern] of sharedRequirementPatterns) {
  assert.match(sourceReadme, pattern, `source README is missing ${description}`);
  assert.match(topLevelReadme, pattern, `package README is missing ${description}`);
}

const presetRows = (markdown) => [...markdown.matchAll(
  /^\| `(lookup-standard|analysis-standard|review-standard)` \| `([^`]+)` \| `([^`]+)` \|/gm,
)].map(([, preset, model, thinking]) => ({ preset, model, thinking }));
const expectedPresets = [
  { preset: "lookup-standard", model: "openai-codex/gpt-5.6-luna", thinking: "medium" },
  { preset: "analysis-standard", model: "openai-codex/gpt-6-sol", thinking: "medium" },
  { preset: "review-standard", model: "openai-codex/gpt-6-sol", thinking: "medium" },
];
assert.deepEqual(presetRows(sourceReadme), expectedPresets, "source README preset contract is inaccurate");
assert.deepEqual(presetRows(topLevelReadme), expectedPresets, "package README preset contract is inaccurate");

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

console.log(`${manifest.name}@${manifest.version}: ${actualFiles.length} package files, Pi discovery, and 3 negative controls verified`);
