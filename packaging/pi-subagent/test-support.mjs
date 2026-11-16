import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { releaseUrls } from "./build.mjs";

export const packageRoot = dirname(fileURLToPath(import.meta.url));
export const sourceRoot = resolve(packageRoot, "../..");
export const extensionReadmePath = "extensions/pi-subagent/README.md";
export const rawRoot = "https://raw.githubusercontent.com/MDGChamomile/pi-subagent";
export const futureVersion = "99.12.34";

export const maintainedManifestText = await readFile(join(packageRoot, "manifest.json"), "utf8");
export const maintainedManifest = JSON.parse(maintainedManifestText);
export const sourceReadme = await readFile(join(sourceRoot, "README.md"), "utf8");
export const sourceExtensionReadme = await readFile(join(sourceRoot, extensionReadmePath), "utf8");

// Compare prose independently of rebased inline link destinations. Normalizing
// release versions also permits releaseUrls' documented changes to literal URLs;
// stripping generated prefixes would corrupt already-absolute source URLs.
const readmeBody = (markdown) => releaseUrls(markdown, futureVersion)
  .replace(/(\]\()[^\s)]+(\))/g, "$1$2");

export function checkReadmeBody(source, rendered) {
  assert.equal(readmeBody(rendered), readmeBody(source), "package README must preserve canonical prose");
}
