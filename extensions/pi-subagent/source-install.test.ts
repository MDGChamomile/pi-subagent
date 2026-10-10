import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const loader = fileURLToPath(new URL("./scripts/pi-sdk-test-loader.mjs", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/source-install.mjs", import.meta.url));
for (const scope of ["user", "local"]) {
  test(`source checkout install/list/remove and discovery: ${scope}`, () => {
    const result = spawnSync(process.execPath, ["--import", loader, "--experimental-strip-types", fixture, scope], {
      env: { PATH: process.env.PATH, PI_OFFLINE: "1", NO_COLOR: "1" },
      encoding: "utf8", timeout: 120_000,
    });
    assert.equal(result.status, 0, result.stderr || String(result.error) || result.stdout);
    assert.match(result.stdout, /source installation verified/);
  });
}
