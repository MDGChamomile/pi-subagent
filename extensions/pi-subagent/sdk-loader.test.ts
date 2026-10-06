import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const loader = fileURLToPath(new URL("./scripts/pi-sdk-test-loader.mjs", import.meta.url));
const inspect = (preload: boolean) => {
  const result = spawnSync(process.execPath, [
    ...(preload ? ["--import", loader] : []), "--input-type=module", "--eval",
    'import { existsSync } from "node:fs"; const entry = import.meta.resolve("@earendil-works/pi-coding-agent"); '
      + 'const bundled = new URL("./bundle/index.js", entry); '
      + 'console.log(JSON.stringify({entry, bundled: bundled.href, hasBundle: existsSync(bundled)}));',
  ], { encoding: "utf8", timeout: 15_000, cwd: fileURLToPath(new URL(".", import.meta.url)),
    env: { PATH: process.env.PATH, PI_OFFLINE: "1" } });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as { entry: string; bundled: string; hasBundle: boolean };
};

test("the test preload alone maps the SDK package to its selected entry", () => {
  const plain = inspect(false);
  const mapped = inspect(true);
  assert.equal(mapped.entry, plain.hasBundle ? plain.bundled : plain.entry);
});
