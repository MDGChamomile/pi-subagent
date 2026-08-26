import { writeFileSync } from "node:fs";

const READY_MARKER = "pi-subagent-guard-ready-v1\n";
const REPORT_TOOL_NAME = "submit_subagent_report";
const scenario = process.argv[2] ?? "success";
const readyPath = process.env.PI_SUBAGENT_READY_FILE;
if (!readyPath) process.exit(2);

let input = "";
for await (const chunk of process.stdin) input += chunk;
if (!input.includes("Objective") || !input.includes("Authorized local scope")) process.exit(3);
writeFileSync(readyPath, READY_MARKER, { encoding: "utf8", mode: 0o600, flag: "wx" });

const usage = {
  input: 10,
  output: 2,
  cacheRead: 3,
  cacheWrite: 1,
  totalTokens: 16,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const emit = (message) => process.stdout.write(`${JSON.stringify({ type: "message_end", message })}\n`);

if (scenario === "success") {
  emit({
    role: "assistant",
    content: [{ type: "text", text: "intermediate text that must be discarded" }],
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
    role: "toolResult",
    toolName: REPORT_TOOL_NAME,
    content: [{ type: "text", text: JSON.stringify({ conclusion: "Only this structured report may reach the parent.", findings: [] }) }],
    isError: false,
    usage,
  });
} else if (scenario === "missing-report") {
  emit({
    role: "assistant",
    content: [{ type: "text", text: "to=read code: malformed final" }],
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
} else if (scenario === "timeout") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000);
} else {
  process.exit(4);
}
