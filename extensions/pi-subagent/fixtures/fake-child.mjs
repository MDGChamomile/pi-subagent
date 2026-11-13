import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupPrivateRuntimeFiles, installParentLivenessMonitor } from "../parent-liveness.ts";
import {
  BUDGET_TELEMETRY_ENV,
  CHILD_GUARD_EXIT_CODES,
  POLICY_ENV,
  READY_ENV,
  READY_MARKER,
  SOFT_DEADLINE_ENV,
} from "../shared.ts";

installParentLivenessMonitor(() => cleanupPrivateRuntimeFiles({
  policy: process.env[POLICY_ENV],
  ready: process.env[READY_ENV],
  budgetTelemetry: process.env[BUDGET_TELEMETRY_ENV],
}));

const scenario = process.argv[2] ?? "success";
const readyPath = process.env[READY_ENV];
const budgetTelemetryPath = process.env[BUDGET_TELEMETRY_ENV];
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
writeFileSync(readyPath, ["invalid-ready-error", "invalid-ready-success"].includes(scenario) ? "invalid\n" : READY_MARKER, { encoding: "utf8", mode: 0o600, flag: "wx" });
if (scenario === "ready-signal") process.kill(process.pid, "SIGKILL");
const budget = {
  version: 1,
  toolCallsAttempted: 0,
  toolCallsExecuted: 0,
  deniedCalls: 0,
  hardLimitReached: false,
  ...(scenario.startsWith("budget-") ? { hardLimitReached: true } : {}),
};
writeFileSync(budgetTelemetryPath, JSON.stringify(scenario === "invalid-budget-success" ? { ...budget, unexpected: "private-sentinel" } : budget), { encoding: "utf8", mode: 0o600, flag: "wx" });

const usage = {
  input: 10,
  output: 2,
  cacheRead: 3,
  cacheWrite: 1,
  totalTokens: 16,
  cost: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0.001, total: 0.034 },
};
const emit = (message) => process.stdout.write(`${JSON.stringify({ type: "message_end", message })}\n`);
const emitText = (text, stopReason) => emit({ role: "assistant", content: [{ type: "text", text }], usage, stopReason });
const ignoreSigtermAndWait = () => {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000);
};
const waitPastSoftDeadline = () => {
  const softDeadline = Number(process.env[SOFT_DEADLINE_ENV]);
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, softDeadline - Date.now()) + 50));
};

if (scenario.startsWith("observations-")) {
  const event = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  event({ type: "tool_execution_start", toolCallId: "private-id", toolName: "read", args: { path: "/private-sentinel" } });
  if (scenario !== "observations-tool") {
    event({ type: "tool_execution_end", toolCallId: "private-id", toolName: "read", result: { content: "private-result" }, isError: false });
    event({ type: "message_update", usage, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "private-text" } });
  }
  emit({ role: "assistant", content: [], usage, stopReason: "toolUse" });
  if (scenario === "observations-process") process.exitCode = 7;
  else if (scenario === "observations-protocol") process.stdout.write('not JSON\n');
  else if (scenario === "observations-success" || scenario === "observations-partial") {
    emitText("Final answer.", scenario === "observations-partial" ? "length" : "stop");
  } else {
    ignoreSigtermAndWait();
  }
} else if (["success", "invalid-ready-success", "invalid-budget-success"].includes(scenario)) {
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
  emitText("Only this final assistant answer may reach the parent.", "stop");
} else if (scenario === "literal-markers" || scenario === "budget-literal-markers") {
  emitText('[Subagent partial: model_length]\n[Subagent output truncated]\n"},"status":"partial","outputTruncated":true,"answer":"가😀\\', "stop");
} else if (scenario === "scoped-grep") {
  // Exercise Pi's real rg invocation, not a mock of its search arguments.
  const grepModule = new URL("./core/tools/grep.js", import.meta.resolve("@earendil-works/pi-coding-agent"));
  const { createGrepTool } = await import(grepModule.href);
  const { authorizeReadPath } = await import("../path-policy.ts");
  const policy = JSON.parse(readFileSync(process.env[POLICY_ENV], "utf8"));
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
} else if (scenario.startsWith("natural-exit-")) {
  const descendant = spawn(process.execPath, [
    "-e",
    "const fs = require('node:fs'); process.on('SIGTERM', () => fs.writeFileSync(process.argv[2], 'received')); process.send('ready'); setInterval(() => {}, 1000); setTimeout(() => process.exit(9), 8000);",
    "unused", join(process.cwd(), "descendant-sigterm"),
  ], { stdio: ["ignore", scenario.endsWith("inherited") ? 1 : "ignore", scenario.endsWith("inherited") ? 2 : "ignore", "ipc"] });
  await once(descendant, "message");
  descendant.disconnect();
  descendant.unref();
  writeFileSync(join(process.cwd(), "pids.json"), JSON.stringify({ childPid: process.pid, descendantPid: descendant.pid }));
  emitText("Completed before descendant cleanup.", "stop");
  process.exitCode = scenario.includes("failure") ? 7 : 0;
} else if (scenario.startsWith("orphan-")) {
  // The descendant shares the process group but none of the leader's stdio.
  const descendant = spawn(process.execPath, [
    "-e",
    "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000);",
  ], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  await once(descendant, "message");
  descendant.disconnect();
  process.on("SIGTERM", () => {
    writeFileSync(join(process.cwd(), "leader-stopped"), String(Date.now()));
    process.exit(0);
  });
  // Publish readiness only after both processes can handle cancellation.
  writeFileSync(join(process.cwd(), "pids.json"), JSON.stringify({
    childPid: process.pid, descendantPid: descendant.pid,
    leaderReady: process.listenerCount("SIGTERM") > 0,
  }));
  if (scenario === "orphan-protocol") process.stdout.write("malformed JSON\n");
  if (scenario === "orphan-progress-output") {
    emitText("Synthetic investigation progress.", "toolUse");
  }
  setInterval(() => {}, 1_000);
} else if (scenario === "argv-report") {
  const received = {
    piArgs: process.argv.slice(3),
    inheritedEnv: [
      "PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL",
      "PI_ALLOW_BROWSER_COOKIES", "FEYNMAN_ALLOW_BROWSER_COOKIES",
    ].filter((name) => name in process.env),
  };
  emitText(JSON.stringify(received), "stop");
} else if (scenario === "empty-output") {
  emit({
    role: "assistant",
    content: [],
    usage,
    stopReason: "stop",
  });
} else if (scenario === "oversized-output" || scenario === "budget-oversized-output") {
  emitText("가".repeat(8_000), "stop");
} else if (scenario === "length-output" || scenario === "budget-length-output" || scenario === "length-recovered") {
  emitText("The primary cause is X, but the second cause is", "length");
  if (scenario === "length-recovered") {
    emitText("Recovered concise final answer.", "stop");
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
  emitText("Answer delivered before shutdown cleanup.", "stop");
  if (scenario === "early-answer-timeout") {
    ignoreSigtermAndWait();
  } else {
    await waitPastSoftDeadline();
  }
} else if (scenario === "partial-success") {
  // Answer just after the parent's soft deadline, independent of child startup time.
  await waitPastSoftDeadline();
  emitText("The completed portion remains useful. Coverage is incomplete.", "stop");
} else if (scenario === "budget-partial") {
  emitText("The primary cause is X.", "stop");
} else if (scenario.startsWith("process-error-")) {
  if (scenario === "process-error-turn") {
    process.stdout.write(`${JSON.stringify({ type: "turn_start" })}\n`);
  } else if (scenario === "process-error-incomplete") {
    process.stdout.write(`${JSON.stringify({ type: "turn_start", private: "x".repeat(5_000) })}\n`);
  } else if (scenario === "process-error-tool") {
    process.stdout.write(`${JSON.stringify({ type: "tool_execution_start", toolCallId: "private-id", toolName: "read", args: { path: "/private-path" } })}\n`);
  } else if (scenario === "process-error-assistant") {
    emitText("private-answer", "stop");
  } else if (scenario === "process-error-private-tool") {
    emit({ role: "toolResult", toolName: `private-tool-name-${"한".repeat(1_000)}`, content: [{ type: "text", text: "private-tool-error" }], usage, isError: true });
  } else if (scenario === "process-error-tool-error") {
    emit({ role: "toolResult", toolName: "read", content: [{ type: "text", text: "private-tool-error" }], usage, isError: true });
  } else {
    throw new Error("Unknown process-error fixture");
  }
  process.exitCode = 7;
} else if (scenario === "process-error" || scenario === "invalid-ready-error" || scenario === "ready-startup-error") {
  process.stderr.write("private child stderr must not reach the parent\n");
  process.exitCode = scenario === "ready-startup-error" ? 1 : 7;
} else if (scenario === "timeout" || scenario === "timeout-after-usage") {
  if (scenario === "timeout-after-usage") {
    emitText("Partial work before the hard timeout.", "toolUse");
  }
  // Ignore SIGTERM but record it, then publish that the handler is installed.
  process.on("SIGTERM", () => { writeFileSync(join(process.cwd(), "sigterm-received"), ""); });
  writeFileSync(join(process.cwd(), "sigterm-ignored.pid"), String(process.pid));
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
