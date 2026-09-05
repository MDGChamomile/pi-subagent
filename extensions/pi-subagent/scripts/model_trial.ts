// Explicitly invoked evaluation worker; not packaged and never exposed as an agent tool.
import { readFileSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildChildPolicy } from "../shared.ts";
import { ChildRunError, runChild } from "../subprocess.ts";

const spec = JSON.parse(readFileSync(0, "utf8")) as {
  cwd: string; cliWrapper: string; task: string; model: string; thinking: "low" | "medium"; timeoutMs: number;
};
const allowed = new Set(["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol", "gpt-6-astra"].map((id) => `openai-codex/${id}`));
if (!allowed.has(spec.model) || !["low", "medium"].includes(spec.thinking)
  || !Number.isSafeInteger(spec.timeoutMs) || spec.timeoutMs < 1000 || spec.timeoutMs > 240_000) {
  throw new Error("Model evaluation request is outside its bounded Codex configuration");
}
const temporary = await mkdtemp(join(tmpdir(), "pi-subagent-model-trial-"));
try {
  await chmod(temporary, 0o700);
  const policy = await buildChildPolicy(spec.cwd, ["fixture"], "local");
  const policyFile = join(temporary, "policy.json");
  await writeFile(policyFile, JSON.stringify(policy), { mode: 0o600, flag: "wx" });
  // Reuse the ordinary Pi CLI and production child guard through the test-only observer wrapper.
  // invocationOverride remains reserved for deterministic fake-child tests.
  process.argv[1] = spec.cliWrapper;
  try {
    const result = await runChild({
      policy, policyFile, readyFile: join(temporary, "guard.ready"),
      budgetTelemetryFile: join(temporary, "budget.json"),
      task: spec.task, model: spec.model, thinking: spec.thinking, timeoutMs: spec.timeoutMs,
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.log(JSON.stringify({ status: "error", error: error instanceof Error ? error.message : String(error),
      ...(error instanceof ChildRunError ? { usage: error.usage } : {}) }));
    process.exitCode = 1;
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
