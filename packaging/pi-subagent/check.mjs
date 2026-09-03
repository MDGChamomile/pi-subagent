import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildPackage, packageFiles, stagingDirectory } from "./build.mjs";

await buildPackage();

const manifest = JSON.parse(await readFile(join(stagingDirectory, "package.json"), "utf8"));
assert.equal(manifest.name, "@mdgchamomile/pi-subagent");
assert.equal(manifest.private, undefined);
assert.deepEqual(manifest.keywords.includes("pi-package"), true);
assert.match(manifest.pi.image, new RegExp(`/v${manifest.version.replaceAll(".", "\\.")}/`));

const topLevelReadme = await readFile(join(stagingDirectory, "README.md"), "utf8");
const topLevelLinks = new Map(
  [...topLevelReadme.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)].map(([, label, target]) => [label, target]),
);
const releaseRoot = `https://github.com/MDGChamomile/pi-agent-kit/blob/v${manifest.version}/live`;
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
  /https:\/\/(?:raw\.githubusercontent\.com\/MDGChamomile\/pi-agent-kit\/v[^/]+|github\.com\/MDGChamomile\/pi-agent-kit\/(?:blob|tree)\/v[^/]+)/g,
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
  const loaded = spawnSync("pi", ["-e", stagingDirectory, "--list-models"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: join(temporaryConfig, "agent"),
      PI_OFFLINE: "1",
    },
  });
  if (loaded.status !== 0 || loaded.stderr) {
    throw new Error(`Pi package discovery failed:\n${loaded.stderr || loaded.stdout}`);
  }
} finally {
  await rm(temporaryConfig, { recursive: true, force: true });
}

console.log(`${manifest.name}@${manifest.version}: ${actualFiles.length} package files and Pi discovery verified`);
