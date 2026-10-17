import { lstat, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_SCOPE_ROOTS, type Capability, type ChildPolicy, type ScopeRoot } from "./shared.ts";

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
