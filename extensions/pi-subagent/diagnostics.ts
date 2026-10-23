import {
  ALLOWED_FILE_TOOLS,
  ALLOWED_WEB_TOOLS,
  MAX_OBSERVATION_COUNT,
  MAX_PARENT_ERROR_BYTES,
  OBSERVED_CHILD_EVENTS,
  sanitizeDisplayText,
  utf8Prefix,
  type ChildFailureObservations,
  type ObservedChildEvent,
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
  return sanitizeDisplayText(value).replace(/\s+/g, " ").slice(0, 80);
}

function safeObservations(value: ChildFailureObservations): ChildFailureObservations {
  const bounded = (n: number, max = MAX_OBSERVATION_COUNT) =>
    Number.isFinite(n) ? Math.min(max, Math.max(0, Math.trunc(n))) : 0;
  return {
    counts: Object.fromEntries(OBSERVED_CHILD_EVENTS.map((key) => [key, bounded(value.counts[key])])) as Record<ObservedChildEvent, number>,
    receipts: Object.fromEntries(OBSERVED_CHILD_EVENTS.map((key) => [key, bounded(value.receipts[key])])) as Record<ObservedChildEvent, number>,
    ...(OBSERVED_CHILD_EVENTS.includes(value.lastEvent!) ? { lastEvent: value.lastEvent } : {}),
    ...(Number.isFinite(value.lastEventAgeMs) ? { lastEventAgeMs: bounded(value.lastEventAgeMs!, 2_147_483_647) } : {}),
    lastEventValidated: value.lastEventValidated === true,
    toolBalance: value.incomplete || value.toolBalance === null ? null : bounded(value.toolBalance),
    incomplete: value.incomplete === true,
  };
}

function failureDiagnosticSuffix(diagnostics: SubagentFailureDiagnostics): string {
  const safe = {
    phase: diagnostics.phase,
    ...(Number.isInteger(diagnostics.exitCode) ? { exitCode: diagnostics.exitCode } : {}),
    ...(diagnostics.exitSignal ? { exitSignal: safeDiagnosticText(diagnostics.exitSignal) } : {}),
    ...(typeof diagnostics.guardReady === "boolean" ? { guardReady: diagnostics.guardReady } : {}),
    ...(diagnostics.stopReason ? { stopReason: safeDiagnosticText(diagnostics.stopReason) } : {}),
    ...(Number.isFinite(diagnostics.durationMs) ? { durationMs: Math.max(0, Math.round(diagnostics.durationMs!)) } : {}),
    ...(Number.isInteger(diagnostics.assistantMessages) ? { assistantMessages: diagnostics.assistantMessages } : {}),
    ...(diagnostics.lastAssistantMode ? { lastAssistantMode: diagnostics.lastAssistantMode } : {}),
    ...(Number.isInteger(diagnostics.toolErrors) ? { toolErrors: diagnostics.toolErrors } : {}),
    ...(diagnostics.lastToolError ? { lastToolError: diagnosticToolName(diagnostics.lastToolError) } : {}),
    ...(diagnostics.observations ? { observations: safeObservations(diagnostics.observations) } : {}),
  };
  return `\n\n[Subagent diagnostics ${JSON.stringify(safe)}]`;
}

export function boundedParentError(error: unknown, diagnostics?: SubagentFailureDiagnostics): string {
  const raw = sanitizeDisplayText(error instanceof Error ? error.message : String(error));
  if (!diagnostics) {
    return truncateUtf8WithMarker(raw, MAX_PARENT_ERROR_BYTES, "\n\n[Subagent error truncated]").text;
  }
  const suffix = failureDiagnosticSuffix(diagnostics);
  const messageBudget = Math.max(0, MAX_PARENT_ERROR_BYTES - Buffer.byteLength(suffix, "utf8"));
  const message = truncateUtf8WithMarker(raw, messageBudget, "\n\n[Subagent error truncated]").text;
  return `${message}${suffix}`;
}
