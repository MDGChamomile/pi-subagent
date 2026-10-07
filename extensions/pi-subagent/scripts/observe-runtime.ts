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
    // Observation only: Pi can swallow provider-hook exceptions. The Python
    // runtime_checks verdict validates every request after the run; the production
    // guard separately enforces effective model/thinking before transmission.
    record({ kind: "request", model, thinking: ctx.thinkingLevel, wireModel: payload.model, wireThinking: payload.reasoning?.effort });
  });
  // Keep only a target-match bit while the call runs. Never persist its input,
  // URL, result text, response ID, or error. End events include final isError
  // after tool-result hooks, including failures blocked before execution.
  const fetchUrl = process.env.PI_SUBAGENT_EVAL_FETCH_URL;
  const fetches = new Map<string, boolean>();
  pi.on("tool_execution_start", (event) => {
    if (actor !== "child" || !fetchUrl || event.toolName !== "fetch_content") return;
    const urls = event.args?.urls;
    const url = event.args?.url;
    const targets = Array.isArray(urls) && urls.length > 0 ? urls : url ? [url] : [];
    fetches.set(event.toolCallId, targets.length === 1 && targets[0] === fetchUrl);
  });
  pi.on("tool_execution_end", (event) => {
    const targetMatch = fetches.get(event.toolCallId);
    if (targetMatch === undefined) return;
    fetches.delete(event.toolCallId);
    const details = event.result?.details;
    // pi-web-access can return extraction failures without setting isError.
    // Require its single-target success metadata and nonempty extracted text.
    const success = event.isError === false && details?.successful === 1
      && details?.urlCount === 1 && Array.isArray(details?.urls)
      && details.urls.length === 1 && details.urls[0] === fetchUrl
      && !details.error && typeof details.totalChars === "number" && details.totalChars > 0;
    record({ kind: "web_fetch", targetMatch, success });
  });
  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    record({ kind: "assistant", model: `${event.message.provider}/${event.message.model}`, stopReason: event.message.stopReason });
  });
}
