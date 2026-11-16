import {
  ALLOWED_FILE_TOOLS,
  ALLOWED_WEB_TOOLS,
  errorMessage,
  MAX_PARENT_ERROR_BYTES,
  sanitizeDisplayText,
  singleLineDisplayText,
  utf8Prefix,
  type SubagentFailureDiagnostics,
} from "./shared.ts";

const DIAGNOSTIC_TOOL_NAMES = new Set<string>([...ALLOWED_FILE_TOOLS, ...ALLOWED_WEB_TOOLS]);

export function diagnosticToolName(value: unknown): string {
  return typeof value === "string" && DIAGNOSTIC_TOOL_NAMES.has(value) ? value : "unknown";
}

function truncateUtf8WithMarker(
  text: string,
  maxBytes: number,
  markerText: string,
): { text: string; truncated: boolean } {
  const source = Buffer.from(text, "utf8");
  if (source.length <= maxBytes) return { text, truncated: false };
  const marker = Buffer.from(markerText, "utf8");
  const budget = Math.max(0, maxBytes - marker.length);
  return { text: Buffer.concat([utf8Prefix(source, budget), marker]).toString("utf8"), truncated: true };
}

function safeDiagnosticText(value: string): string {
  return singleLineDisplayText(value).slice(0, 80);
}

// A fixed field list, never a spread: failure diagnostics must stay content-free.
function failureDiagnosticSuffix(diagnostics: SubagentFailureDiagnostics): string {
  const { stopReason, durationMs, lastToolError } = diagnostics;
  const safe = {
    phase: diagnostics.phase,
    exitCode: diagnostics.exitCode,
    exitSignal: diagnostics.exitSignal,
    guardReady: diagnostics.guardReady,
    stopReason: stopReason ? safeDiagnosticText(stopReason) : undefined,
    durationMs: durationMs === undefined ? undefined : Math.max(0, Math.round(durationMs)),
    assistantMessages: diagnostics.assistantMessages,
    lastAssistantMode: diagnostics.lastAssistantMode,
    toolErrors: diagnostics.toolErrors,
    lastToolError: lastToolError ? diagnosticToolName(lastToolError) : undefined,
    observations: diagnostics.observations,
  };
  return `\n\n[Subagent diagnostics ${JSON.stringify(safe)}]`;
}

export function boundedParentError(error: unknown, diagnostics?: SubagentFailureDiagnostics): string {
  const raw = sanitizeDisplayText(errorMessage(error));
  if (!diagnostics) {
    return truncateUtf8WithMarker(raw, MAX_PARENT_ERROR_BYTES, "\n\n[Subagent error truncated]").text;
  }
  const suffix = failureDiagnosticSuffix(diagnostics);
  const messageBudget = Math.max(0, MAX_PARENT_ERROR_BYTES - Buffer.byteLength(suffix, "utf8"));
  const message = truncateUtf8WithMarker(raw, messageBudget, "\n\n[Subagent error truncated]").text;
  return `${message}${suffix}`;
}
