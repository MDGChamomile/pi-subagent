import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(packageRoot, "../..");

export const stagingDirectory = join(packageRoot, "dist");

export const packageFiles = [
  ["packaging/pi-subagent/manifest.json", "package.json"],
  ["packaging/pi-subagent/index.ts", "index.ts"],
  ["README.md", "README.md"],
  ["LICENSE", "LICENSE"],
  ["extensions/pi-subagent/index.ts", "extensions/pi-subagent/index.ts"],
  ["extensions/pi-subagent/shared.ts", "extensions/pi-subagent/shared.ts"],
  ["extensions/pi-subagent/invocation-gate.ts", "extensions/pi-subagent/invocation-gate.ts"],
  ["extensions/pi-subagent/envelope.ts", "extensions/pi-subagent/envelope.ts"],
  ["extensions/pi-subagent/diagnostics.ts", "extensions/pi-subagent/diagnostics.ts"],
  ["extensions/pi-subagent/config.ts", "extensions/pi-subagent/config.ts"],
  ["extensions/pi-subagent/settings-command.ts", "extensions/pi-subagent/settings-command.ts"],
  ["extensions/pi-subagent/settings-picker.ts", "extensions/pi-subagent/settings-picker.ts"],
  ["extensions/pi-subagent/subprocess.ts", "extensions/pi-subagent/subprocess.ts"],
  ["extensions/pi-subagent/child-guard.ts", "extensions/pi-subagent/child-guard.ts"],
  ["extensions/pi-subagent/parent-liveness.ts", "extensions/pi-subagent/parent-liveness.ts"],
  ["extensions/pi-subagent/README.md", "extensions/pi-subagent/README.md"],
  ["skills/pi-subagent/SKILL.md", "skills/pi-subagent/SKILL.md"],
  ["skills/pi-subagent/README.md", "skills/pi-subagent/README.md"],
];

// Rebase only this repository's version-pinned presentation/documentation URLs.
// Maintained files stay readable; manifest.version is authoritative for the artifact.
export function releaseUrls(text, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("Package URL generation requires a stable release version");
  }
  return text.replace(
    /(https:\/\/(?:raw\.githubusercontent\.com\/MDGChamomile\/pi-subagent|github\.com\/MDGChamomile\/pi-subagent\/(?:blob|tree))\/)v\d+\.\d+\.\d+(?=\/)/g,
    `$1v${version}`,
  );
}

// The root README is the sole maintained body. Rebase its inline image and
// document links for npm without changing prose or adding another template.
export function renderPackageReadme(source, version) {
  const versioned = releaseUrls(source, version);
  const rawRoot = `https://raw.githubusercontent.com/MDGChamomile/pi-subagent/v${version}/`;
  const releaseRoot = `https://github.com/MDGChamomile/pi-subagent/blob/v${version}/`;
  const rebase = (target, root) => /^(?:[a-z][a-z\d+.-]*:|[/#])/i.test(target) ? target : `${root}${target}`;
  return versioned
    .replace(/(!\[[^\]]*\]\()([^\s)]+)(\))/g, (_, prefix, target, suffix) => `${prefix}${rebase(target, rawRoot)}${suffix}`)
    .replace(/(\]\()([^\s)]+)(\))/g, (_, prefix, target, suffix) => `${prefix}${rebase(target, releaseRoot)}${suffix}`);
}

// Keep the bundled guide's document links local, but serve its images from
// the same tagged repository assets as the top-level README and gallery.
export function renderExtensionReadme(source, version) {
  const rawAssets = `https://raw.githubusercontent.com/MDGChamomile/pi-subagent/v${version}/extensions/pi-subagent/`;
  return releaseUrls(source, version).replace(
    /(\]\()(assets\/[^\s)]+)(\))/g,
    (_, prefix, target, suffix) => `${prefix}${rawAssets}${target}${suffix}`,
  );
}

export async function buildPackage() {
  const manifest = JSON.parse(await readFile(join(packageRoot, "manifest.json"), "utf8"));
  const image = releaseUrls(manifest.pi.image, manifest.version);
  const readme = renderPackageReadme(await readFile(join(repositoryRoot, "README.md"), "utf8"), manifest.version);
  await rm(stagingDirectory, { recursive: true, force: true });
  for (const [source, target] of packageFiles) {
    const output = join(stagingDirectory, target);
    await mkdir(dirname(output), { recursive: true });
    await copyFile(join(repositoryRoot, source), output);
  }
  await writeFile(join(stagingDirectory, "package.json"), `${JSON.stringify({
    ...manifest, pi: { ...manifest.pi, image },
  }, null, 2)}\n`);
  await writeFile(join(stagingDirectory, "README.md"), readme);
  const extensionReadme = "extensions/pi-subagent/README.md";
  await writeFile(join(stagingDirectory, extensionReadme), renderExtensionReadme(
    await readFile(join(repositoryRoot, extensionReadme), "utf8"), manifest.version,
  ));
  return stagingDirectory;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  await buildPackage();
  console.log(stagingDirectory);
}
