import { lstat, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const TOOL_NAME = "pi_subagent";
export const ALLOWED_FILE_TOOLS = ["read", "grep", "find", "ls"] as const;
export const ALLOWED_WEB_TOOLS = ["web_search", "source_check", "fetch_content", "get_search_content"] as const;
export const ALLOWED_CHILD_TOOLS = [...ALLOWED_FILE_TOOLS, ...ALLOWED_WEB_TOOLS] as const;
export const MAX_SCOPE_ROOTS = 8;
export const MAX_FINAL_BYTES = 12 * 1024;
export const MAX_STDERR_BYTES = 64 * 1024;
export const MAX_JSON_LINE_BYTES = 2 * 1024 * 1024;
export const CHILD_TIMEOUT_MS = 15 * 60 * 1000;
export const POLICY_ENV = "PI_SUBAGENT_POLICY_FILE";
export const WEB_EXTENSION_ENV = "PI_SUBAGENT_WEB_EXTENSION_PATH";

export const PROFILE_MODELS = {
  lookup: "openai-codex/gpt-5.6-luna",
  analysis: "openai-codex/gpt-5.6-terra",
  review: "openai-codex/gpt-5.6-sol",
} as const;

export type Profile = keyof typeof PROFILE_MODELS;
export type Thinking = "medium" | "high" | "xhigh" | "max";
export type ScopeRoot = { path: string; kind: "file" | "directory" };
export type ChildPolicy = { version: 1; cwd: string; roots: ScopeRoot[] };

const PATH_CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const UNICODE_SPACES = /[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g;

export function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export function normalizeInputPath(input: string, cwd: string): string {
  if (!input || PATH_CONTROL_RE.test(input)) throw new Error("Scope path is empty or contains a control character");
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

export async function buildChildPolicy(cwdInput: string, scopeInputs: readonly string[]): Promise<ChildPolicy> {
  if (scopeInputs.length > MAX_SCOPE_ROOTS) {
    throw new Error(`scope must contain 0-${MAX_SCOPE_ROOTS} paths`);
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
  return { version: 1, cwd, roots };
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
    "Use only the listed local paths and their authorized descendants. Web research may use only the available web tools and public HTTP(S) URLs. Return only the requested deliverable.",
  ].join("\n");
}

export type ToolSourceDescriptor = {
  name: string;
  sourceInfo?: { path?: string; baseDir?: string };
};

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
      if (info.isFile()) return canonical;
    } catch {
      // Try the source base directory fallback.
    }
  }
  throw new Error("Could not resolve the installed web-tool extension entry point");
}

export class ModelInvocationGate {
  private runOpen = false;
  private used = false;
  private authorizedToolCallId: string | undefined;

  startRun(): void {
    if (this.runOpen) return;
    this.runOpen = true;
    this.used = false;
    this.authorizedToolCallId = undefined;
  }

  endRun(): void {
    this.runOpen = false;
    this.used = false;
    this.authorizedToolCallId = undefined;
  }

  authorize(toolCallId: string): boolean {
    if (!this.runOpen || this.used) return false;
    this.used = true;
    this.authorizedToolCallId = toolCallId;
    return true;
  }

  consume(toolCallId: string): boolean {
    if (this.authorizedToolCallId !== toolCallId) return false;
    this.authorizedToolCallId = undefined;
    return true;
  }
}

export function sanitizeDisplayText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "?");
}

export function truncateUtf8(text: string, maxBytes = MAX_FINAL_BYTES): { text: string; truncated: boolean } {
  const source = Buffer.from(text, "utf8");
  if (source.length <= maxBytes) return { text, truncated: false };
  const marker = Buffer.from("\n\n[Subagent output truncated]", "utf8");
  const budget = Math.max(0, maxBytes - marker.length);
  let end = budget;
  while (end > 0 && (source[end]! & 0xc0) === 0x80) end--;
  return { text: Buffer.concat([source.subarray(0, end), marker]).toString("utf8"), truncated: true };
}
