export const TOOL_NAME = "pi_subagent";
export const ALLOWED_FILE_TOOLS = ["read", "grep", "find", "ls"] as const;
export const ALLOWED_WEB_TOOLS = ["web_search", "source_check", "fetch_content", "get_search_content"] as const;
export const WEB_INPUT_KEYS = {
  web_search: ["query", "queries", "numResults", "recencyFilter", "domainFilter", "workflow"],
  source_check: ["claim", "queries", "numResults", "fetchContent", "recencyFilter", "domainFilter"],
  fetch_content: ["url", "urls", "mode"],
  get_search_content: [
    "responseId", "query", "queryIndex", "url", "urlIndex", "offset", "limit", "findText", "findMode",
  ],
} as const satisfies Record<(typeof ALLOWED_WEB_TOOLS)[number], readonly string[]>;
export const MAX_WEB_QUERIES_PER_CALL = 4;
export const DEFAULT_WEB_RESULTS_PER_QUERY = 5;
export const MAX_WEB_RESULTS_PER_QUERY = 10;
export const MAX_FETCH_URLS_PER_CALL = 5;
export const MAX_SOURCE_CHECK_FETCH_TARGETS_PER_CALL = 5;
export const LIFETIME_TOOL_CALL_LIMITS = {
  local: { soft: 36, hard: 48 },
  web: { soft: 30, hard: 40 },
} as const;
export const LIFETIME_WEB_QUERY_SOFT_LIMIT = 24;
export const LIFETIME_WEB_QUERY_LIMIT = 32;
export const LIFETIME_WEB_FETCH_TARGET_SOFT_LIMIT = 38;
export const LIFETIME_WEB_FETCH_TARGET_LIMIT = 50;
export const MIN_WEB_EXTENSION_VERSION = "0.33.0";
export const MAX_SCOPE_ROOTS = 8;
export const MAX_FINAL_BYTES = 12 * 1024;
export const MAX_PARENT_ERROR_BYTES = 4 * 1024;
// Pi's native read can emit 4.5 MiB of base64 image data in one toolResult.
// Leave room for JSON/text/metadata while keeping every captured record bounded.
export const MAX_JSON_LINE_BYTES = 6 * 1024 * 1024;
export const CHILD_TIMEOUT_MS = 20 * 60 * 1000;
export const CHILD_FINALIZATION_GRACE_MS = 2 * 60 * 1000;
export const POLICY_ENV = "PI_SUBAGENT_POLICY_FILE";
export const READY_ENV = "PI_SUBAGENT_READY_FILE";
export const READY_MARKER = "pi-subagent-guard-ready-v1\n";
// Fixed, content-free child guard diagnostics; never forward raw child stderr.
export const CHILD_GUARD_EXIT_CODES = {
  initialization: 70,
  toolOwnership: 71,
  readiness: 72,
  modelSelection: 73,
  runtime: 74,
} as const;
export const BUDGET_TELEMETRY_ENV = "PI_SUBAGENT_BUDGET_TELEMETRY_FILE";
export const WEB_EXTENSION_ENV = "PI_SUBAGENT_WEB_EXTENSION_PATH";
export const SOFT_DEADLINE_ENV = "PI_SUBAGENT_SOFT_DEADLINE_EPOCH_MS";

export const MODEL_SELECTION_ENV = "PI_SUBAGENT_MODEL_SELECTION";
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Thinking = (typeof THINKING_LEVELS)[number];

export const SUBAGENT_PRESETS = {
  "lookup-standard": { model: "openai-codex/gpt-6-luna", thinking: "medium" },
  "analysis-standard": { model: "openai-codex/gpt-6.1-sol", thinking: "medium" },
  "review-standard": { model: "openai-codex/gpt-6.1-sol", thinking: "high" },
} as const satisfies Record<string, { model: string; thinking: Thinking }>;
export type Preset = keyof typeof SUBAGENT_PRESETS;
export const PRESET_NAMES = Object.keys(SUBAGENT_PRESETS) as Preset[];

export type Capability = "local" | "web";
export type ResultStatus = "complete" | "partial";
export type PartialReason = "tool_budget" | "time_limit" | "model_length";
export type BudgetTelemetry = {
  version: 1;
  toolCallsAttempted: number;
  toolCallsExecuted: number;
  deniedCalls: number;
  queryCount: number;
  fetchTargetCount: number;
  softLimitReached: boolean;
  hardLimitReached: boolean;
  partialReason?: "tool_budget";
};
export type ScopeRoot = { path: string; kind: "file" | "directory" };
export type ChildPolicy = { version: 1; cwd: string; capability: Capability; roots: ScopeRoot[] };

export type SubagentFailurePhase =
  | "preflight"
  | "setup"
  | "spawn"
  | "cancelled"
  | "timeout"
  | "protocol"
  | "progress"
  | "process"
  | "readiness"
  | "model"
  | "output"
  | "cleanup";

// Fixed allowlist and saturating counters: never copy child keys or content.
export const OBSERVED_CHILD_EVENTS = [
  "turn_start", "message_update", "tool_execution_start", "tool_execution_end",
  "auto_retry_start", "auto_retry_end",
] as const;
export type ObservedChildEvent = (typeof OBSERVED_CHILD_EVENTS)[number];
export const MAX_OBSERVATION_COUNT = 1_000_000;
export type ChildFailureObservations = {
  counts: Record<ObservedChildEvent, number>;
  receipts: Record<ObservedChildEvent, number>;
  lastEvent?: ObservedChildEvent;
  lastEventAgeMs?: number;
  lastEventValidated: boolean;
  toolBalance: number | null;
  incomplete: boolean;
};

export type SubagentFailureDiagnostics = {
  phase: SubagentFailurePhase;
  exitCode?: number;
  exitSignal?: NodeJS.Signals;
  guardReady?: boolean;
  stopReason?: string;
  durationMs?: number;
  assistantMessages?: number;
  lastAssistantMode?: "none" | "empty" | "text" | "tool" | "mixed";
  toolErrors?: number;
  lastToolError?: string;
  observations?: ChildFailureObservations;
};

export function toolsForCapability(capability: Capability): string[] {
  return capability === "local" ? [...ALLOWED_FILE_TOOLS] : [...ALLOWED_WEB_TOOLS];
}

export function sanitizeDisplayText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "?");
}
