import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
const fixture = fileURLToPath(new URL("./fixtures/selection-guard.mjs", import.meta.url));
const sdkLoader = fileURLToPath(new URL("./scripts/pi-sdk-test-loader.mjs", import.meta.url));
for (const scenario of ["match", "provider", "thinking", "unsupported", "missing-entry", "malformed", "missing"]) {
  test(`real Pi request dispatch: ${scenario}`, () => {
    const result = spawnSync(process.execPath, ["--import", sdkLoader, "--experimental-strip-types", fixture, scenario], {
      encoding: "utf8", timeout: 15_000,
      env: { PATH: process.env.PATH, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
    });
    assert.ifError(result.error);
    assert.equal(result.stderr, "", "guard failures must not be module-loading errors");
    assert.equal(result.status, scenario === "match" ? 0 : 1, result.stderr);
    if (scenario === "match") assert.deepEqual(JSON.parse(result.stdout), { requests: 1 });
    else assert.equal(result.stdout, "", "mismatch must exit before the transport spy, not throw and continue");
  });
}
