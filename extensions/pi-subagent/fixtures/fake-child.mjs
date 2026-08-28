import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { cleanupPrivateRuntimeFiles, installParentLivenessMonitor } from "../parent-liveness.ts";

installParentLivenessMonitor(() => cleanupPrivateRuntimeFiles(
  process.env.PI_SUBAGENT_POLICY_FILE,
  process.env.PI_SUBAGENT_READY_FILE,
  process.env.PI_SUBAGENT_BUDGET_TELEMETRY_FILE,
));

const READY_MARKER = "pi-subagent-guard-ready-v1\n";
const scenario = process.argv[2] ?? "success";
const readyPath = process.env.PI_SUBAGENT_READY_FILE;
const budgetTelemetryPath = process.env.PI_SUBAGENT_BUDGET_TELEMETRY_FILE;
if (!readyPath || !budgetTelemetryPath) process.exit(2);
if (process.env.PI_OFFLINE !== "1") process.exit(5);

let input = "";
for await (const chunk of process.stdin) input += chunk;
if (!input.includes("Objective") || !input.includes("Authorized local scope")) process.exit(3);
writeFileSync(readyPath, READY_MARKER, { encoding: "utf8", mode: 0o600, flag: "wx" });
const budget = {
  version: 1,
  toolCallsAttempted: 0,
  toolCallsExecuted: 0,
  deniedCalls: 0,
  queryCount: 0,
  fetchTargetCount: 0,
  softLimitReached: false,
  hardLimitReached: false,
  ...(scenario === "budget-partial" ? { hardLimitReached: true, partialReason: "tool_budget" } : {}),
};
writeFileSync(budgetTelemetryPath, JSON.stringify(budget), { encoding: "utf8", mode: 0o600, flag: "wx" });

const usage = {
  input: 10,
  output: 2,
  cacheRead: 3,
  cacheWrite: 1,
  totalTokens: 16,
  cost: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0.001, total: 0.034 },
};
const emit = (message) => process.stdout.write(`${JSON.stringify({ type: "message_end", message })}\n`);

if (scenario === "success") {
  emit({
    role: "assistant",
    content: [
      { type: "text", text: "intermediate text that must be discarded" },
      { type: "toolCall", id: "read-1", name: "read", arguments: { path: "." } },
    ],
    usage,
    stopReason: "toolUse",
  });
  emit({
    role: "toolResult",
    toolName: "read",
    content: [{ type: "text", text: "noisy child file contents" }],
    isError: false,
    usage,
  });
  emit({
    role: "assistant",
    content: [{ type: "text", text: "Only this final assistant answer may reach the parent." }],
    usage,
    stopReason: "stop",
  });
} else if (scenario === "empty-output") {
  emit({
    role: "assistant",
    content: [],
    usage,
    stopReason: "stop",
  });
} else if (scenario === "oversized-output") {
  emit({
    role: "assistant",
    content: [{ type: "text", text: "가".repeat(8_000) }],
    usage,
    stopReason: "stop",
  });
} else if (scenario === "provider-error") {
  emit({
    role: "assistant",
    content: [],
    usage,
    stopReason: "error",
    errorMessage: `provider\u001b[31m\u202efailed ${"x".repeat(64 * 1024)}`,
  });
} else if (scenario === "partial-success") {
  await new Promise((resolve) => setTimeout(resolve, 300));
  emit({
    role: "assistant",
    content: [{ type: "text", text: "The completed portion remains useful. Coverage is incomplete." }],
    usage,
    stopReason: "stop",
  });
} else if (scenario === "budget-partial") {
  emit({
    role: "assistant",
    content: [{ type: "text", text: "Budget-limited final answer with explicit coverage gaps." }],
    usage,
    stopReason: "stop",
  });
} else if (scenario === "process-error") {
  process.stderr.write("private child stderr must not reach the parent\n");
  process.exitCode = 7;
} else if (scenario === "timeout" || scenario === "timeout-after-usage") {
  if (scenario === "timeout-after-usage") {
    emit({
      role: "assistant",
      content: [{ type: "text", text: "Partial work before the hard timeout." }],
      usage,
      stopReason: "toolUse",
    });
  }
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000);
} else if (scenario === "parent-death") {
  const pidFile = process.argv[3];
  if (!pidFile) process.exit(6);
  const descendant = spawn(process.execPath, [
    "-e",
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
  ], { stdio: "ignore" });
  writeFileSync(pidFile, JSON.stringify({ childPid: process.pid, descendantPid: descendant.pid }));
} else {
  process.exit(4);
}
