import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildChildPolicy } from "../path-policy.ts";
import { runChild } from "../subprocess.ts";

const FAKE_CHILD = fileURLToPath(new URL("./fake-child.mjs", import.meta.url));
const SHUTDOWN_CHILD = fileURLToPath(new URL("./shutdown-child.mjs", import.meta.url));
const SDK_LOADER = fileURLToPath(new URL("../scripts/pi-sdk-test-loader.mjs", import.meta.url));
const root = process.argv[2];
const pidFile = process.argv[3];
const shutdown = process.argv[4] === "shutdown";
if (!root || !pidFile) process.exit(2);

const policy = await buildChildPolicy(root, ["."], "local");
// Match the runtime's canonical private paths, including macOS temporary aliases.
const policyFile = join(policy.cwd, "policy.json");
const readyFile = join(policy.cwd, "guard.ready");
const budgetTelemetryFile = join(policy.cwd, "budget-telemetry.json");
await writeFile(policyFile, JSON.stringify(policy), { encoding: "utf8", mode: 0o600 });

void runChild({
  policy,
  policyFile,
  readyFile,
  budgetTelemetryFile,
  task: "Wait for the deterministic parent-death fixture.",
  model: "test/fake",
  thinking: "low",
  launcherOverride: {
    command: process.execPath,
    args: shutdown
      ? ["--import", SDK_LOADER, "--experimental-strip-types", SHUTDOWN_CHILD, pidFile]
      : ["--experimental-strip-types", FAKE_CHILD, "parent-death", pidFile],
  },
}).catch((error) => {
  console.error(error);
  process.exit(4);
});

for (let attempt = 0; attempt < 500; attempt += 1) {
  try {
    await access(pidFile);
    process.exit(0);
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
process.exit(3);
