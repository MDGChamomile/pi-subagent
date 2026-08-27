import { lstat, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const TOOL_NAME = "pi_subagent";
export const REPORT_TOOL_NAME = "submit_subagent_report";
export const ALLOWED_FILE_TOOLS = ["read", "grep", "find", "ls"] as const;
export const ALLOWED_WEB_TOOLS = ["web_search", "source_check", "fetch_content", "get_search_content"] as const;
export const ALLOWED_CHILD_TOOLS = [...ALLOWED_FILE_TOOLS, ...ALLOWED_WEB_TOOLS] as const;
export const MAX_SCOPE_ROOTS = 8;
export const MAX_SUBAGENT_CALLS = 3;
export const MAX_FINAL_BYTES = 12 * 1024;
export const MAX_STRUCTURED_REPORT_BYTES = 8 * 1024;
export const MAX_PARENT_ERROR_BYTES = 4 * 1024;
export const MAX_STDERR_BYTES = 64 * 1024;
export const MAX_JSON_LINE_BYTES = 2 * 1024 * 1024;
export const CHILD_TIMEOUT_MS = 20 * 60 * 1000;
export const POLICY_ENV = "PI_SUBAGENT_POLICY_FILE";
export const READY_ENV = "PI_SUBAGENT_READY_FILE";
export const READY_MARKER = "pi-subagent-guard-ready-v1\n";
export const WEB_EXTENSION_ENV = "PI_SUBAGENT_WEB_EXTENSION_PATH";

export function invocationLimitBlock(): { block: true; reason: string } {
  return {
    block: true,
    reason: `pi_subagent allows at most ${MAX_SUBAGENT_CALLS} started calls per parent agent run, plus one corrected retry after preflight validation failure. Do not retry; continue with successful sibling results or investigate in the parent`,
  };
}

export const THINKING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Thinking = (typeof THINKING_LEVELS)[number];

export const SUBAGENT_PRESETS = {
  "lookup-standard": { model: "openai-codex/gpt-5.6-luna", thinking: "low" },
  "lookup-balanced": { model: "openai-codex/gpt-5.6-luna", thinking: "medium" },
  "lookup-deep": { model: "openai-codex/gpt-5.6-luna", thinking: "high" },
  "analysis-standard": { model: "openai-codex/gpt-5.6-terra", thinking: "high" },
  "analysis-deep": { model: "openai-codex/gpt-5.6-terra", thinking: "xhigh" },
  "review-standard": { model: "openai-codex/gpt-5.6-sol", thinking: "high" },
  "review-deep": { model: "openai-codex/gpt-5.6-sol", thinking: "xhigh" },
  "review-exhaustive": { model: "openai-codex/gpt-5.6-sol", thinking: "max" },
} as const satisfies Record<string, { model: string; thinking: Thinking }>;
export type Preset = keyof typeof SUBAGENT_PRESETS;
export const PRESET_NAMES = Object.keys(SUBAGENT_PRESETS) as Preset[];

export function legacyPreset(profile: unknown, thinking: unknown): Preset | undefined {
  if (profile === "lookup") {
    if (thinking === "low") return "lookup-standard";
    if (thinking === "medium") return "lookup-balanced";
    if (thinking === "high" || thinking === "xhigh" || thinking === "max") return "lookup-deep";
  }
  if (profile === "analysis") {
    if (thinking === "xhigh" || thinking === "max") return "analysis-deep";
    if (THINKING_LEVELS.includes(thinking as Thinking)) return "analysis-standard";
  }
  if (profile === "review") {
    if (thinking === "max") return "review-exhaustive";
    if (thinking === "xhigh") return "review-deep";
    if (THINKING_LEVELS.includes(thinking as Thinking)) return "review-standard";
  }
  return undefined;
}
export type Capability = "local" | "web" | "both";
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
  | "report"
  | "output"
  | "cleanup";

export type SubagentFailureDiagnostics = {
  phase: SubagentFailurePhase;
  exitCode?: number;
  stopReason?: string;
  durationMs?: number;
  assistantMessages?: number;
  lastAssistantMode?: "none" | "empty" | "text" | "tool" | "mixed";
  reportAttempts?: number;
  reportSuccesses?: number;
  reportErrors?: number;
  toolErrors?: number;
  lastToolError?: string;
};

export function toolsForCapability(capability: Capability): string[] {
  if (capability === "local") return [...ALLOWED_FILE_TOOLS, REPORT_TOOL_NAME];
  if (capability === "web") return [...ALLOWED_WEB_TOOLS, REPORT_TOOL_NAME];
  return [...ALLOWED_CHILD_TOOLS, REPORT_TOOL_NAME];
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
  capability: Capability = "both",
): Promise<ChildPolicy> {
  if (scopeInputs.length > MAX_SCOPE_ROOTS) {
    throw new Error(`scope must contain 0-${MAX_SCOPE_ROOTS} paths`);
  }
  if (capability === "web" && scopeInputs.length !== 0) {
    throw new Error("web capability requires an empty local scope");
  }
  if ((capability === "local" || capability === "both") && scopeInputs.length === 0) {
    throw new Error(`${capability} capability requires at least one local scope path`);
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
    "Use only the listed local paths and their authorized descendants. Web research may use only the available web tools and HTTP(S) access allowed by the installed web extension's SSRF policy. Return only the requested deliverable.",
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
        pi?: { extensions?: unknown };
      };
      if (manifest.name !== "pi-web-access" || !Array.isArray(manifest.pi?.extensions)) return false;
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
  throw new Error("Web tools must come from the installed pi-web-access package entry point");
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
    ...(Number.isInteger(diagnostics.reportAttempts) ? { reportAttempts: diagnostics.reportAttempts } : {}),
    ...(Number.isInteger(diagnostics.reportSuccesses) ? { reportSuccesses: diagnostics.reportSuccesses } : {}),
    ...(Number.isInteger(diagnostics.reportErrors) ? { reportErrors: diagnostics.reportErrors } : {}),
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
