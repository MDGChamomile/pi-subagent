import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ALLOWED_FILE_TOOLS, CHILD_GUARD_EXIT_CODES } from "./shared.ts";
const fixture = fileURLToPath(new URL("./fixtures/selection-guard.mjs", import.meta.url));
const sdkLoader = fileURLToPath(new URL("./scripts/pi-sdk-test-loader.mjs", import.meta.url));
const failures = {
  provider: "modelSelection", thinking: "modelSelection", unsupported: "modelSelection",
  "missing-entry": "modelSelection", malformed: "modelSelection", missing: "modelSelection",
  "missing-policy": "initialization", "malformed-policy": "initialization",
  "liveness-failure": "initialization", "invalid-deadline": "initialization",
  "missing-web-extension": "initialization", "before-session-start": "initialization",
  "local-owner": "toolOwnership", "web-owner": "toolOwnership",
  "readiness-failure": "readiness", "budget-failure": "readiness",
  "tool-notice-failure": "runtime", "final-answer-failure": "runtime",
} as const;
for (const scenario of ["match", ...Object.keys(failures)]) {
  test(`real Pi request dispatch: ${scenario}`, () => {
    const result = spawnSync(process.execPath, ["--import", sdkLoader, "--experimental-strip-types", fixture, scenario], {
      encoding: "utf8", timeout: 15_000,
      env: { PATH: process.env.PATH, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
    });
    assert.ifError(result.error);
    assert.equal(result.stderr, "", "guard failures must not be module-loading errors");
    const output = JSON.parse(result.stdout);
    if (scenario === "match") {
      assert.equal(result.status, 0);
      assert.deepEqual(output, { requests: 1, guardReady: true, activeTools: [...ALLOWED_FILE_TOOLS] });
    } else {
      const reason = failures[scenario as keyof typeof failures];
      assert.equal(result.status, CHILD_GUARD_EXIT_CODES[reason]);
      assert.equal(output.requests, 0, "failure must exit before the transport spy, not throw and continue");
      assert.equal(output.guardReady, reason === "modelSelection" || reason === "runtime");
      if (reason !== "modelSelection" && scenario !== "before-session-start") assert.deepEqual(output.activeTools, []);
    }
  });
}
