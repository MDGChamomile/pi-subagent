import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildChildPolicy } from "../shared.ts";
import { runChild } from "../subprocess.ts";

const FAKE_CHILD = fileURLToPath(new URL("./fake-child.mjs", import.meta.url));
const root = process.argv[2];
const pidFile = process.argv[3];
if (!root || !pidFile) process.exit(2);

const policy = await buildChildPolicy(root, ["."], "local");
const policyFile = join(root, "policy.json");
const readyFile = join(root, "guard.ready");
const budgetTelemetryFile = join(root, "budget-telemetry.json");
await writeFile(policyFile, JSON.stringify(policy), { encoding: "utf8", mode: 0o600 });

void runChild({
  policy,
  policyFile,
  readyFile,
  budgetTelemetryFile,
  task: "Wait for the deterministic parent-death fixture.",
  model: "test/fake",
  thinking: "low",
  invocationOverride: {
    command: process.execPath,
    args: ["--experimental-strip-types", FAKE_CHILD, "parent-death", pidFile],
  },
}).catch(() => undefined);

for (let attempt = 0; attempt < 200; attempt += 1) {
  try {
    await access(pidFile);
    process.exit(0);
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
process.exit(3);
