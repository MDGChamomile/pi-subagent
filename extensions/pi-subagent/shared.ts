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

// Accept stable SemVer releases only; build metadata does not affect precedence.
function meetsWebMinimumVersion(version: unknown): boolean {
  if (typeof version !== "string") return false;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
  if (!match || match[0] !== version) return false;
  const minimum = MIN_WEB_EXTENSION_VERSION.split(".").map(BigInt);
  for (let index = 0; index < 3; index++) {
    const part = BigInt(match[index + 1]!);
    if (part !== minimum[index]) return part > minimum[index]!;
  }
  return true;
}

// Resolve only Pi's supported directory entry points, never an arbitrary sibling file.
async function webEntryFile(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path);
    if (info.isFile()) return realpath(path);
    if (!info.isDirectory()) return undefined;
    for (const name of ["index.ts", "index.js"]) {
      const candidate = join(path, name);
      try {
        // Pi prefers index.ts when both exist. Do not fall through if it exists but is invalid.
        await lstat(candidate);
        return (await stat(candidate)).isFile() ? realpath(candidate) : undefined;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
      }
    }
  } catch {
    // Missing or unusable entry point.
  }
  return undefined;
}

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
        || !meetsWebMinimumVersion(manifest.version)
        || !Array.isArray(manifest.pi?.extensions)
      ) return false;
      const packageRoot = await realpath(directory);
      for (const entry of manifest.pi.extensions) {
        if (typeof entry !== "string") continue;
        const declared = await webEntryFile(resolve(directory, entry));
        if (!declared) continue;
        if (declared === canonical && isWithin(packageRoot, declared)) return true;
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
  // Pi supplies the loaded extension path (which may be a directory) and its
  // baseDir. A baseDir alone cannot establish which file owns the tools.
  if (source?.path) {
    const canonical = await webEntryFile(source.path);
    if (canonical && await verifyWebPackageEntrypoint(canonical)) return canonical;
  }
  throw new Error(`Web tools must come from the installed pi-web-access >=${MIN_WEB_EXTENSION_VERSION} (stable releases only) package entry point`);
}

export function sanitizeDisplayText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "?");
}
