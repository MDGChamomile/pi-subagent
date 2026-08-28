import { lstat, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

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
export const LIFETIME_WEB_QUERY_LIMIT = 32;
export const LIFETIME_WEB_FETCH_TARGET_LIMIT = 50;
export const PINNED_WEB_EXTENSION_VERSION = "0.26.0";
export const MAX_SCOPE_ROOTS = 8;
export const MAX_SUBAGENT_CALLS = 3;
export const MAX_FINAL_BYTES = 12 * 1024;
export const MAX_PARENT_ERROR_BYTES = 4 * 1024;
export const MAX_JSON_LINE_BYTES = 2 * 1024 * 1024;
export const CHILD_TIMEOUT_MS = 20 * 60 * 1000;
export const CHILD_FINALIZATION_GRACE_MS = 2 * 60 * 1000;
export const POLICY_ENV = "PI_SUBAGENT_POLICY_FILE";
export const READY_ENV = "PI_SUBAGENT_READY_FILE";
export const READY_MARKER = "pi-subagent-guard-ready-v1\n";
export const BUDGET_TELEMETRY_ENV = "PI_SUBAGENT_BUDGET_TELEMETRY_FILE";
export const WEB_EXTENSION_ENV = "PI_SUBAGENT_WEB_EXTENSION_PATH";
export const SOFT_DEADLINE_ENV = "PI_SUBAGENT_SOFT_DEADLINE_EPOCH_MS";

export function invocationLimitBlock(): { block: true; reason: string } {
  return {
    block: true,
    reason: `pi_subagent allows at most ${MAX_SUBAGENT_CALLS} started calls per parent agent run, plus one corrected retry after preflight validation failure. Do not retry; continue with successful sibling results or investigate in the parent`,
  };
}

export type Thinking = "low" | "medium";

export const SUBAGENT_PRESETS = {
  "lookup-standard": { model: "openai-codex/gpt-5.6-luna", thinking: "low" },
  "analysis-standard": { model: "openai-codex/gpt-5.6-terra", thinking: "medium" },
  "review-standard": { model: "openai-codex/gpt-5.6-sol", thinking: "medium" },
} as const satisfies Record<string, { model: string; thinking: Thinking }>;
export type Preset = keyof typeof SUBAGENT_PRESETS;
export const PRESET_NAMES = Object.keys(SUBAGENT_PRESETS) as Preset[];

const LEGACY_PRESETS: Readonly<Record<string, Preset>> = {
  "lookup-standard": "lookup-standard",
  "lookup-balanced": "lookup-standard",
  "lookup-deep": "lookup-standard",
  "analysis-standard": "analysis-standard",
  "analysis-deep": "analysis-standard",
  "analysis-exhaustive": "analysis-standard",
  "review-standard": "review-standard",
  "review-deep": "review-standard",
  "review-exhaustive": "review-standard",
};

export function normalizePreset(preset: unknown, profile: unknown): Preset | undefined {
  if (preset !== undefined) return typeof preset === "string" ? LEGACY_PRESETS[preset] : undefined;
  return typeof profile === "string" ? LEGACY_PRESETS[`${profile}-standard`] : undefined;
}

export type Capability = "local" | "web";
export type ResultStatus = "complete" | "partial";
export type PartialReason = "tool_budget";
export type BudgetTelemetry = {
  version: 1;
  toolCallsAttempted: number;
  toolCallsExecuted: number;
  deniedCalls: number;
  queryCount: number;
  fetchTargetCount: number;
  softLimitReached: boolean;
  hardLimitReached: boolean;
  partialReason?: PartialReason;
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
  | "process"
  | "readiness"
  | "model"
  | "output"
  | "cleanup";

export type SubagentFailureDiagnostics = {
  phase: SubagentFailurePhase;
  exitCode?: number;
  stopReason?: string;
  durationMs?: number;
  assistantMessages?: number;
  lastAssistantMode?: "none" | "empty" | "text" | "tool" | "mixed";
  toolErrors?: number;
  lastToolError?: string;
};

export function toolsForCapability(capability: Capability): string[] {
  return capability === "local" ? [...ALLOWED_FILE_TOOLS] : [...ALLOWED_WEB_TOOLS];
}

const PATH_CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const UNICODE_SPACES = /[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g;

export function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export async function makeCanonicalTempDirectory(prefix: string): Promise<string> {
  const created = await mkdtemp(prefix);
  try {
    return await realpath(created);
  } catch (error) {
    await rm(created, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export function normalizeInputPath(input: string, cwd: string): string {
  if (!input || input === "@" || PATH_CONTROL_RE.test(input)) throw new Error("Scope path is empty or contains a control character");
  let normalized = input.replace(UNICODE_SPACES, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  if (normalized === "~") normalized = homedir();
  else if (normalized.startsWith("~/")) normalized = join(homedir(), normalized.slice(2));
  if (normalized.startsWith("file://")) {
    try {
      normalized = fileURLToPath(normalized);
    } catch {
      throw new Error(`Invalid file URL: ${input}`);
    }
  }
  return isAbsolute(normalized) ? resolve(normalized) : resolve(cwd, normalized);
}

export async function buildChildPolicy(
  cwdInput: string,
  scopeInputs: readonly string[],
  capability: Capability = "local",
): Promise<ChildPolicy> {
  if (capability !== "local" && capability !== "web") {
    throw new Error("capability must be local or web");
  }
  if (scopeInputs.length > MAX_SCOPE_ROOTS) {
    throw new Error(`scope must contain 0-${MAX_SCOPE_ROOTS} paths`);
  }
  if (capability === "web" && scopeInputs.length !== 0) {
    throw new Error("web capability requires an empty local scope");
  }
  if (capability === "local" && scopeInputs.length === 0) {
    throw new Error("local capability requires at least one local scope path");
  }
  const cwd = await realpath(resolve(cwdInput));
  const cwdInfo = await stat(cwd);
  if (!cwdInfo.isDirectory()) throw new Error("Current working directory is not a directory");

  const roots: ScopeRoot[] = [];
  for (const raw of scopeInputs) {
    if (typeof raw !== "string" || raw.length > 4096) throw new Error("Each scope path must be a string of at most 4096 characters");
    const logical = normalizeInputPath(raw, cwd);
    const canonical = await realpath(logical).catch(() => {
      throw new Error(`Scope path does not exist or cannot be resolved: ${raw}`);
    });
    if (!isWithin(cwd, canonical)) {
      throw new Error(`Scope path must stay inside the current working directory: ${raw}`);
    }
    const info = await lstat(canonical);
    if (!info.isFile() && !info.isDirectory()) throw new Error(`Scope path must be a regular file or directory: ${raw}`);
    const root: ScopeRoot = { path: canonical, kind: info.isDirectory() ? "directory" : "file" };
    if (roots.some((existing) => existing.path === root.path || (existing.kind === "directory" && isWithin(existing.path, root.path)))) {
      continue;
    }
    for (let index = roots.length - 1; index >= 0; index--) {
      if (root.kind === "directory" && isWithin(root.path, roots[index]!.path)) roots.splice(index, 1);
    }
    roots.push(root);
  }
  return { version: 1, cwd, capability, roots };
}

export async function authorizeReadPath(policy: ChildPolicy, rawPath: string): Promise<string> {
  const logical = normalizeInputPath(rawPath, policy.cwd);
  const canonical = await realpath(logical).catch(() => {
    throw new Error(`Path does not exist or cannot be resolved: ${rawPath}`);
  });
  const allowed = policy.roots.some((root) =>
    root.kind === "file" ? canonical === root.path : isWithin(root.path, canonical),
  );
  if (!allowed) throw new Error(`Subagent cannot access a path outside its explicit scope: ${rawPath}`);
  return canonical;
}

export function buildChildPrompt(task: string, policy: ChildPolicy): string {
  const visibleRoots = policy.roots.map((root) => {
    const rel = relative(policy.cwd, root.path);
    const portablePath = (rel === "" ? "." : rel).split(sep).join("/");
    return `- ${JSON.stringify(portablePath)} (${root.kind})`;
  });
  return [
    "Objective",
    task,
    "",
    "Authorized local scope (runtime enforced)",
    ...(visibleRoots.length > 0 ? visibleRoots : ["- (none; web-only investigation)"]),
    "",
    "Stay within this runtime-enforced capability and scope. Return only the requested deliverable.",
  ].join("\n");
}

export type ToolSourceDescriptor = {
  name: string;
  sourceInfo?: { path?: string; baseDir?: string };
};

async function verifyWebPackageEntrypoint(canonical: string): Promise<boolean> {
  for (let directory = dirname(canonical);;) {
    try {
      const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as {
        name?: unknown;
        version?: unknown;
        pi?: { extensions?: unknown };
      };
      if (
        manifest.name !== "pi-web-access"
        || manifest.version !== PINNED_WEB_EXTENSION_VERSION
        || !Array.isArray(manifest.pi?.extensions)
      ) return false;
      for (const entry of manifest.pi.extensions) {
        if (typeof entry !== "string") continue;
        try {
          if (await realpath(resolve(directory, entry)) === canonical) return true;
        } catch {
          // Ignore malformed or missing manifest entries.
        }
      }
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    }
    const parent = dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
}

export async function resolveWebExtensionPath(tools: readonly ToolSourceDescriptor[]): Promise<string> {
  const selected = ALLOWED_WEB_TOOLS.map((name) => tools.find((tool) => tool.name === name));
  if (selected.some((tool) => !tool)) {
    throw new Error(`Web subagent capability requires enabled tools: ${ALLOWED_WEB_TOOLS.join(", ")}`);
  }
  const sourceKeys = new Set(selected.map((tool) => `${tool!.sourceInfo?.path ?? ""}\n${tool!.sourceInfo?.baseDir ?? ""}`));
  if (sourceKeys.size !== 1) throw new Error("Web subagent tools must come from one trusted extension source");

  const source = selected[0]!.sourceInfo;
  const candidates = [source?.path, source?.baseDir ? join(source.baseDir, "index.ts") : undefined].filter(
    (value): value is string => Boolean(value),
  );
  for (const candidate of candidates) {
    try {
      const canonical = await realpath(candidate);
      const info = await lstat(canonical);
      if (info.isFile() && await verifyWebPackageEntrypoint(canonical)) return canonical;
    } catch {
      // Try the source base directory fallback.
    }
  }
  throw new Error(`Web tools must come from the installed pi-web-access ${PINNED_WEB_EXTENSION_VERSION} package entry point`);
}

export class ModelInvocationGate {
  private runOpen = false;
  private startedCalls = 0;
  private preflightFailures = 0;
  private preflightReplacementPending = false;
  private replacementToolCallId: string | undefined;
  private readonly authorizedToolCallIds = new Set<string>();

  startRun(): void {
    if (this.runOpen) return;
    this.runOpen = true;
    this.startedCalls = 0;
    this.preflightFailures = 0;
    this.preflightReplacementPending = false;
    this.replacementToolCallId = undefined;
    this.authorizedToolCallIds.clear();
  }

  endRun(): void {
    this.runOpen = false;
    this.startedCalls = 0;
    this.preflightFailures = 0;
    this.preflightReplacementPending = false;
    this.replacementToolCallId = undefined;
    this.authorizedToolCallIds.clear();
  }

  authorize(toolCallId: string): boolean {
    if (
      !this.runOpen
      || this.preflightFailures > 1
      || (this.preflightReplacementPending && this.replacementToolCallId !== undefined)
      || this.authorizedToolCallIds.has(toolCallId)
      || this.startedCalls + this.authorizedToolCallIds.size >= MAX_SUBAGENT_CALLS
    ) return false;
    this.authorizedToolCallIds.add(toolCallId);
    if (this.preflightReplacementPending) this.replacementToolCallId = toolCallId;
    return true;
  }

  commit(toolCallId: string): boolean {
    if (!this.authorizedToolCallIds.delete(toolCallId)) return false;
    this.startedCalls += 1;
    if (this.replacementToolCallId === toolCallId) {
      this.preflightReplacementPending = false;
      this.replacementToolCallId = undefined;
    }
    return true;
  }

  rejectPreflight(toolCallId: string): boolean {
    if (!this.authorizedToolCallIds.delete(toolCallId)) return false;
    this.preflightFailures += 1;
    if (this.preflightFailures === 1) this.preflightReplacementPending = true;
    if (this.replacementToolCallId === toolCallId) this.replacementToolCallId = undefined;
    return true;
  }

  releaseUnstarted(toolCallId: string): boolean {
    if (!this.authorizedToolCallIds.delete(toolCallId)) return false;
    if (this.replacementToolCallId === toolCallId) this.replacementToolCallId = undefined;
    return true;
  }
}

export function sanitizeDisplayText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "?");
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
  let end = budget;
  while (end > 0 && (source[end]! & 0xc0) === 0x80) end--;
  return { text: Buffer.concat([source.subarray(0, end), marker]).toString("utf8"), truncated: true };
}

export function truncateUtf8(text: string, maxBytes = MAX_FINAL_BYTES): { text: string; truncated: boolean } {
  return truncateUtf8WithMarker(text, maxBytes, "\n\n[Subagent output truncated]");
}

function safeDiagnosticText(value: string): string {
  return sanitizeDisplayText(value).replace(/\s+/g, " ").slice(0, 80);
}

function failureDiagnosticSuffix(diagnostics: SubagentFailureDiagnostics): string {
  const safe = {
    phase: diagnostics.phase,
    ...(Number.isInteger(diagnostics.exitCode) ? { exitCode: diagnostics.exitCode } : {}),
    ...(diagnostics.stopReason ? { stopReason: safeDiagnosticText(diagnostics.stopReason) } : {}),
    ...(Number.isFinite(diagnostics.durationMs) ? { durationMs: Math.max(0, Math.round(diagnostics.durationMs!)) } : {}),
    ...(Number.isInteger(diagnostics.assistantMessages) ? { assistantMessages: diagnostics.assistantMessages } : {}),
    ...(diagnostics.lastAssistantMode ? { lastAssistantMode: diagnostics.lastAssistantMode } : {}),
    ...(Number.isInteger(diagnostics.toolErrors) ? { toolErrors: diagnostics.toolErrors } : {}),
    ...(diagnostics.lastToolError ? { lastToolError: safeDiagnosticText(diagnostics.lastToolError) } : {}),
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
