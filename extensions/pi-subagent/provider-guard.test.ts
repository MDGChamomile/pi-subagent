import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CHILD_GUARD_EXIT_CODES } from "./shared.ts";

const fixture = fileURLToPath(new URL("./fixtures/provider-guard.mjs", import.meta.url));
const sdkLoader = fileURLToPath(new URL("./scripts/pi-sdk-test-loader.mjs", import.meta.url));
for (const scenario of ["match", "model-mismatch", "thinking-mismatch", "throwing-hook"]) {
  test(`built-in Codex SSE provider invokes the SDK guard: ${scenario}`, () => {
    const result = spawnSync(process.execPath, ["--import", sdkLoader, "--experimental-strip-types", fixture, scenario], {
      encoding: "utf8", timeout: 15_000,
      // Do not inherit provider credentials, NODE_OPTIONS, user directories, or
      // runtime selection. The fixture assigns a disposable HOME before imports.
      env: { PATH: process.env.PATH, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
    });
    assert.ifError(result.error);
    assert.equal(result.stderr, "", "a dependency/setup error is not successful pre-transmission blocking");
    const output = JSON.parse(result.stdout);
    const mismatch = scenario.endsWith("-mismatch");
    assert.equal(result.status, mismatch ? CHILD_GUARD_EXIT_CODES.modelSelection : 0);
    assert.deepEqual(output, {
      requests: mismatch ? 0 : 1,
      hooks: 1,
      networkAttempts: 0,
      extensionErrors: scenario === "throwing-hook" ? 1 : 0,
      answered: !mismatch,
      guardReady: true,
    });
  });
}
