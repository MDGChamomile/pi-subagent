import assert from "node:assert/strict";
import { test } from "node:test";
import { releaseUrls, renderExtensionReadme, renderPackageReadme } from "./build.mjs";
import {
  checkReadmeBody, futureVersion, maintainedManifest, rawRoot, sourceExtensionReadme, sourceReadme,
} from "./test-support.mjs";

const futureAssets = `${rawRoot}/v${futureVersion}/extensions/pi-subagent/assets/`;
const futureBlob = `https://github.com/MDGChamomile/pi-subagent/blob/v${futureVersion}`;

test("a future version updates every release URL without source edits", () => {
  assert.equal(
    releaseUrls(maintainedManifest.pi.image, futureVersion),
    `${futureAssets}pi-subagent-cover.png`,
    "gallery must use the cover image at the selected version",
  );
  const futureReadme = renderPackageReadme(sourceReadme, futureVersion);
  const maintainedUrls = renderPackageReadme(sourceReadme, maintainedManifest.version)
    .match(/https:\/\/[^\s)]+\/v\d+\.\d+\.\d+\/[^\s)]+/g) ?? [];
  assert.ok(maintainedUrls.length >= 8, "exercise images, architecture, guides, and license URLs");
  for (const url of maintainedUrls) {
    assert.ok(futureReadme.includes(url.replace(/\/v\d+\.\d+\.\d+\//, `/v${futureVersion}/`)));
  }
});

test("release URLs of other repositories and relative paths are left alone", () => {
  const unrelated = "https://github.com/other/project/blob/v0.5.0/README.md extensions/pi-subagent/assets/pi-subagent-automatic.gif";
  assert.equal(releaseUrls(unrelated, futureVersion), unrelated);
});

test("rendering requires a stable release version", () => {
  assert.throws(() => renderPackageReadme(sourceReadme, "1.0.0-beta.1"), /stable release version/);
  assert.throws(() => renderExtensionReadme(sourceExtensionReadme, "1.0.0-beta.1"), /stable release version/);
});

test("the package README rebases relative images and documents only", () => {
  const links = '![Preview](extensions/pi-subagent/assets/pi-subagent-automatic.gif)\n[Guide](extensions/pi-subagent/README.md#presets)\n[Here](#presets)\n[Remote](https://example.com/guide)\n[Mail](mailto:help@example.com)';
  assert.equal(renderPackageReadme(links, futureVersion),
    `![Preview](${futureAssets}pi-subagent-automatic.gif)\n[Guide](${futureBlob}/extensions/pi-subagent/README.md#presets)\n[Here](#presets)\n[Remote](https://example.com/guide)\n[Mail](mailto:help@example.com)`);
});

test("the extension guide rebases assets and development links and keeps bundled links local", () => {
  const links = '[Development](DEVELOPMENT.md)\n[Verification](DEVELOPMENT.md#verification)\n![Demo](assets/pi-subagent-automatic.gif)\n[![Architecture](assets/pi-subagent-architecture.png)](assets/pi-subagent-architecture.png)\n[Skill](../../skills/pi-subagent/README.md)\n[Here](#presets)\n[Remote](https://example.com/image.png)';
  assert.equal(renderExtensionReadme(links, futureVersion),
    `[Development](${futureBlob}/extensions/pi-subagent/DEVELOPMENT.md)\n[Verification](${futureBlob}/extensions/pi-subagent/DEVELOPMENT.md#verification)\n![Demo](${futureAssets}pi-subagent-automatic.gif)\n[![Architecture](${futureAssets}pi-subagent-architecture.png)](${futureAssets}pi-subagent-architecture.png)\n[Skill](../../skills/pi-subagent/README.md)\n[Here](#presets)\n[Remote](https://example.com/image.png)`);
});

test("rendering is idempotent", () => {
  const packageReadme = renderPackageReadme(sourceReadme, futureVersion);
  assert.equal(renderPackageReadme(packageReadme, futureVersion), packageReadme);
  const extensionReadme = renderExtensionReadme(sourceExtensionReadme, futureVersion);
  assert.equal(renderExtensionReadme(extensionReadme, futureVersion), extensionReadme);
});

test("rendering preserves prose, including already-absolute and literal release URLs", () => {
  const absoluteLinks = `\n[Pinned](${rawRoot}/v${maintainedManifest.version}/README.md)\nLiteral URL: ${rawRoot}/v${maintainedManifest.version}/README.md\n[Mail](mailto:help@example.com)\n`;
  for (const [source, render] of [[sourceReadme, renderPackageReadme], [sourceExtensionReadme, renderExtensionReadme]]) {
    const fixture = source + absoluteLinks;
    const rendered = render(fixture, futureVersion);
    checkReadmeBody(fixture, rendered);
    assert.throws(() => checkReadmeBody(fixture, rendered.replace("Literal URL:", "Changed prose:")), /preserve canonical prose/);
  }
});
