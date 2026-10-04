import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupPrivateRuntimeFiles, installParentLivenessMonitor } from "../parent-liveness.ts";
import { CHILD_GUARD_EXIT_CODES } from "../shared.ts";

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

if (scenario === "progress-before-input") {
  // Bound this fixture even if a regression abandons the child before stdin closes.
  setTimeout(() => process.exit(8), 5_000);
}
let input = "";
for await (const chunk of process.stdin) input += chunk;
if (scenario === "progress-before-input") writeFileSync(join(process.cwd(), "input-received"), input);
if (!input.includes("Objective") || !input.includes("Authorized local scope")) process.exit(3);
if (scenario === "startup-error") {
  process.stderr.write("private startup stderr must not reach the parent\n");
  process.exit(1);
}
if (scenario.startsWith("guard-")) {
  if (scenario === "guard-runtime") writeFileSync(readyPath, READY_MARKER, { mode: 0o600, flag: "wx" });
  process.stderr.write("private initialization detail must not reach the parent\n");
  process.exit(CHILD_GUARD_EXIT_CODES[scenario.slice("guard-".length)] ?? 9);
}
if (scenario === "startup-signal") process.kill(process.pid, "SIGKILL");
writeFileSync(readyPath, scenario === "invalid-ready-error" ? "invalid\n" : READY_MARKER, { encoding: "utf8", mode: 0o600, flag: "wx" });
if (scenario === "ready-signal") process.kill(process.pid, "SIGKILL");
const budget = {
  version: 1,
  toolCallsAttempted: 0,
  toolCallsExecuted: 0,
  deniedCalls: 0,
  queryCount: 0,
  fetchTargetCount: 0,
  softLimitReached: false,
  hardLimitReached: false,
  ...(scenario.startsWith("budget-") ? { hardLimitReached: true, partialReason: "tool_budget" } : {}),
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

if (scenario.startsWith("observations-")) {
  const event = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  event({ type: "tool_execution_start", toolCallId: "private-id", toolName: "read", args: { path: "/private-sentinel" } });
  if (scenario !== "observations-tool") {
    event({ type: "tool_execution_end", toolCallId: "private-id", toolName: "read", result: { content: "private-result" }, isError: false });
    event({ type: "message_update", message: { role: "assistant", content: "private-thinking" }, assistantMessageEvent: { type: "text_delta", delta: "private-text" } });
  }
  emit({ role: "assistant", content: [], usage, stopReason: "toolUse" });
  if (scenario === "observations-process") process.exitCode = 7;
  else if (scenario === "observations-protocol") process.stdout.write('not JSON\n');
  else if (scenario === "observations-success" || scenario === "observations-partial") {
    emit({ role: "assistant", content: [{ type: "text", text: "Final answer." }], usage,
      stopReason: scenario === "observations-partial" ? "length" : "stop" });
  } else {
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1_000);
  }
} else if (scenario === "success") {
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
} else if (scenario === "literal-markers" || scenario === "budget-literal-markers") {
  emit({
    role: "assistant",
    content: [{ type: "text", text: '[Subagent partial: model_length]\n[Subagent output truncated]\n"},"status":"partial","outputTruncated":true,"answer":"가😀\\' }],
    usage,
    stopReason: "stop",
  });
} else if (scenario === "scoped-grep") {
  // Exercise Pi's real rg invocation, not a mock of its search arguments.
  // Import the native tool module directly; Pi 1.0.0's SDK barrel would also work.
  const grepModule = new URL("./core/tools/grep.js", import.meta.resolve("@earendil-works/pi-coding-agent"));
  const { createGrepTool } = await import(grepModule.href);
  const { authorizeReadPath } = await import("../shared.ts");
  const policy = JSON.parse(readFileSync(process.env.PI_SUBAGENT_POLICY_FILE, "utf8"));
  const path = await authorizeReadPath(policy, "allowed");
  const result = await createGrepTool(policy.cwd).execute("grep-scope", {
    path,
    pattern: "SYNTHETIC_SCOPE_MARKER",
  });
  emit({ role: "assistant", content: result.content, usage, stopReason: "stop" });
} else if (scenario === "cooperative-abort") {
  process.on("SIGTERM", () => process.exit(0));
  writeFileSync(join(process.cwd(), "child-pid"), String(process.pid));
  setInterval(() => {}, 1_000);
} else if (scenario.startsWith("orphan-")) {
  // The descendant shares the process group but none of the leader's stdio.
  const descendant = spawn(process.execPath, [
    "-e",
    "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000);",
  ], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  await once(descendant, "message");
  descendant.disconnect();
  writeFileSync(join(process.cwd(), "pids.json"), JSON.stringify({ childPid: process.pid, descendantPid: descendant.pid }));
  process.on("SIGTERM", () => {
    writeFileSync(join(process.cwd(), "leader-stopped"), String(Date.now()));
    process.exit(0);
  });
  if (scenario === "orphan-protocol") process.stdout.write("malformed JSON\n");
  if (scenario === "orphan-progress-output") {
    emit({ role: "assistant", content: [{ type: "text", text: "Synthetic investigation progress." }], usage, stopReason: "toolUse" });
  }
  setInterval(() => {}, 1_000);
} else if (scenario === "empty-output") {
  emit({
    role: "assistant",
    content: [],
    usage,
    stopReason: "stop",
  });
} else if (scenario === "oversized-output" || scenario === "budget-oversized-output") {
  emit({
    role: "assistant",
    content: [{ type: "text", text: "가".repeat(8_000) }],
    usage,
    stopReason: "stop",
  });
} else if (scenario === "length-output" || scenario === "budget-length-output" || scenario === "length-recovered") {
  emit({
    role: "assistant",
    content: [{ type: "text", text: "The primary cause is X, but the second cause is" }],
    usage,
    stopReason: "length",
  });
  if (scenario === "length-recovered") {
    emit({
      role: "assistant",
      content: [{ type: "text", text: "Recovered concise final answer." }],
      usage,
      stopReason: "stop",
    });
  }
} else if (scenario === "length-empty-output") {
  emit({ role: "assistant", content: [], usage, stopReason: "length" });
} else if (scenario === "provider-error") {
  emit({
    role: "assistant",
    content: [],
    usage,
    stopReason: "error",
    errorMessage: `provider\u001b[31m\u202efailed ${"x".repeat(64 * 1024)}`,
  });
} else if (scenario === "early-answer-delayed-exit" || scenario === "early-answer-timeout") {
  emit({
    role: "assistant",
    content: [{ type: "text", text: "Answer delivered before shutdown cleanup." }],
    usage,
    stopReason: "stop",
  });
  if (scenario === "early-answer-timeout") {
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1_000);
  } else {
    const softDeadline = Number(process.env.PI_SUBAGENT_SOFT_DEADLINE_EPOCH_MS);
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, softDeadline - Date.now()) + 50));
  }
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
    content: [{ type: "text", text: "The primary cause is X." }],
    usage,
    stopReason: "stop",
  });
} else if (scenario === "process-error" || scenario === "invalid-ready-error") {
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
