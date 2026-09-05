// Test-only observer: never register tools or persist prompts, headers, credentials, or response text.
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function observeRuntime(pi: ExtensionAPI): void {
  const trace = process.env.PI_SUBAGENT_EVAL_TRACE_FILE;
  if (!trace) throw new Error("Evaluation trace path is required");
  const actor = process.env.PI_SUBAGENT_POLICY_FILE ? "child" : "parent";
  const record = (value: Record<string, unknown>) => {
    appendFileSync(trace, `${JSON.stringify({ actor, ...value })}\n`, { encoding: "utf8", mode: 0o600 });
  };
  pi.on("before_provider_request", (event, ctx) => {
    const payload = event.payload as { model?: unknown; reasoning?: { effort?: unknown } };
    const model = `${ctx.model?.provider}/${ctx.model?.id}`;
    const expectedModel = process.env.PI_SUBAGENT_EVAL_EXPECT_MODEL;
    const expectedThinking = process.env.PI_SUBAGENT_EVAL_EXPECT_THINKING;
    record({ kind: "request", model, thinking: ctx.thinkingLevel, wireModel: payload.model, wireThinking: payload.reasoning?.effort });
    if (actor === "child" && (
      (expectedModel && (model !== expectedModel || payload.model !== expectedModel.split("/").slice(1).join("/")))
      || (expectedThinking && (ctx.thinkingLevel !== expectedThinking || payload.reasoning?.effort !== expectedThinking))
    )) throw new Error("Evaluation child model/thinking mismatch; refusing the request");
  });
  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    record({ kind: "assistant", model: `${event.message.provider}/${event.message.model}`, stopReason: event.message.stopReason });
  });
}
