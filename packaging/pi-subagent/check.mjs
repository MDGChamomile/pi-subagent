import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPackage, packageFiles, stagingDirectory } from "./build.mjs";

await buildPackage();

const manifest = JSON.parse(await readFile(join(stagingDirectory, "package.json"), "utf8"));
assert.equal(manifest.name, "@mdgchamomile/pi-subagent");
assert.equal(manifest.private, undefined);
assert.deepEqual(manifest.pi.extensions, ["./index.ts"], "load only the root entrypoint");
assert.deepEqual(manifest.keywords.includes("pi-package"), true);
assert.match(manifest.pi.image, new RegExp(`/v${manifest.version.replaceAll(".", "\\.")}/`));

const topLevelReadme = await readFile(join(stagingDirectory, "README.md"), "utf8");
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
