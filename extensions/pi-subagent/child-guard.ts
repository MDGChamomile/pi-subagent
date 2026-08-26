import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  ALLOWED_FILE_TOOLS,
  ALLOWED_WEB_TOOLS,
  authorizeReadPath,
  isWithin,
  MAX_STRUCTURED_REPORT_BYTES,
  POLICY_ENV,
  READY_ENV,
  READY_MARKER,
  REPORT_TOOL_NAME,
  toolsForCapability,
  WEB_EXTENSION_ENV,
  type ChildPolicy,
} from "./shared.ts";

export const CHILD_GUARD_SOURCE_PATH = fileURLToPath(import.meta.url);

const FindingSchema = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 1, maxLength: 120 },
    detail: { type: "string", minLength: 1, maxLength: 700 },
    evidence: {
      type: "array",
      items: { type: "string", minLength: 1, maxLength: 400 },
      maxItems: 3,
    },
  },
  required: ["title", "detail", "evidence"],
  additionalProperties: false,
} as const;

const boundedList = (maxItems: number) => ({
  type: "array",
  items: { type: "string", minLength: 1, maxLength: 500 },
  maxItems,
}) as const;

// Pi consumes TypeBox-compatible JSON Schema at runtime. Keeping the literal
// local avoids adding a child-only package dependency solely for schema builders.
const StructuredReportSchema = {
  type: "object",
  properties: {
    conclusion: { type: "string", minLength: 1, maxLength: 1200 },
    findings: { type: "array", items: FindingSchema, maxItems: 10 },
    alternatives: boundedList(4),
    uncertainties: boundedList(4),
    coverageGaps: boundedList(4),
  },
  required: ["conclusion", "findings"],
  additionalProperties: false,
} as any;

const FILE_TOOLS = new Set<string>(ALLOWED_FILE_TOOLS);
const WEB_TOOLS = new Set<string>(ALLOWED_WEB_TOOLS);

function loadPolicy(): { policy: ChildPolicy; policyPath: string } {
  const policyPath = process.env[POLICY_ENV];
  if (!policyPath) throw new Error("child policy path is missing");
  const resolved = resolve(policyPath);
  const info = lstatSync(resolved);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new Error("child policy file is not a private regular file");
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error("child policy file is owned by another user");
  }
  if (realpathSync(resolved) !== resolved) throw new Error("child policy path changed");
  const parsed = JSON.parse(readFileSync(resolved, "utf8")) as Partial<ChildPolicy>;
  if (
    parsed.version !== 1 ||
    typeof parsed.cwd !== "string" ||
    !Array.isArray(parsed.roots) ||
    (parsed.capability !== "local" && parsed.capability !== "web" && parsed.capability !== "both")
  ) {
    throw new Error("child policy is malformed");
  }
  const cwd = realpathSync(parsed.cwd);
  if (cwd !== parsed.cwd || parsed.roots.length > 8) throw new Error("child policy has invalid roots");
  const roots = parsed.roots.map((root) => {
    if (!root || typeof root.path !== "string" || (root.kind !== "file" && root.kind !== "directory")) {
      throw new Error("child policy root is malformed");
    }
    const canonical = realpathSync(root.path);
    if (canonical !== root.path || !isWithin(cwd, canonical)) throw new Error("child policy root escapes cwd");
    return { path: canonical, kind: root.kind };
  });
  return { policy: { version: 1, cwd, capability: parsed.capability, roots }, policyPath: resolved };
}

function loadReadyPath(policyPath: string): string {
  const raw = process.env[READY_ENV];
  if (!raw) throw new Error("child readiness path is missing");
  const resolved = resolve(raw);
  if (dirname(resolved) !== dirname(policyPath)) throw new Error("child readiness path must accompany the policy file");
  return resolved;
}

function loadWebExtensionPath(): string {
  const raw = process.env[WEB_EXTENSION_ENV];
  if (!raw) throw new Error("web extension path is missing");
  const resolved = resolve(raw);
  const info = lstatSync(resolved);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("web extension path is not a regular file");
  const canonical = realpathSync(resolved);
  if (canonical !== resolved) throw new Error("web extension path changed");
  return canonical;
}

function requestedPath(toolName: string, input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const path = (input as { path?: unknown }).path;
  if (typeof path === "string") return path;
  return toolName === "grep" || toolName === "find" || toolName === "ls" ? "." : undefined;
}

function canonicalSourcePath(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  try {
    return realpathSync(resolve(raw));
  } catch {
    return undefined;
  }
}

function validatePublicHttpUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "fetch_content permits only HTTP(S) URLs";
    if (url.username || url.password) return "fetch_content URLs must not contain embedded credentials";
    return undefined;
  } catch {
    return "fetch_content received an invalid URL";
  }
}

function validateWebCall(toolName: string, input: Record<string, unknown>): string | undefined {
  if (toolName === "web_search") {
    input.workflow = "none";
    return undefined;
  }
  if (toolName !== "fetch_content") return undefined;
  if (input.auth !== undefined && input.auth !== false) {
    return "Authenticated browser-cookie fetching is disabled in the subagent";
  }
  if (input.forceClone === true) return "Forced large GitHub cloning is disabled in the subagent";
  const urls: string[] = [];
  if (typeof input.url === "string") urls.push(input.url);
  if (Array.isArray(input.urls)) {
    if (!input.urls.every((value) => typeof value === "string")) return "fetch_content URLs must be strings";
    urls.push(...input.urls as string[]);
  }
  if (urls.length === 0) return "fetch_content requires at least one HTTP(S) URL";
  for (const url of urls) {
    const error = validatePublicHttpUrl(url);
    if (error) return error;
  }
  return undefined;
}

export default function childGuard(pi: ExtensionAPI): void {
  pi.registerTool({
    name: REPORT_TOOL_NAME,
    label: "Submit Subagent Report",
    description: "Submit the one final structured investigation report. Use exactly once as the last action after all investigation is complete.",
    parameters: StructuredReportSchema,
    async execute(_toolCallId, params) {
      const output = JSON.stringify(params);
      if (Buffer.byteLength(output, "utf8") > MAX_STRUCTURED_REPORT_BYTES) {
        throw new Error(`Structured report exceeds ${MAX_STRUCTURED_REPORT_BYTES} UTF-8 bytes; reduce it and submit once more`);
      }
      return {
        content: [{ type: "text", text: output }],
        details: { structured: true, findingCount: params.findings.length },
        terminate: true,
      };
    },
  });

  let policy: ChildPolicy | undefined;
  let readyPath: string | undefined;
  let webExtensionPath: string | undefined;
  let policyError: string | undefined;
  try {
    const loaded = loadPolicy();
    policy = loaded.policy;
    readyPath = loadReadyPath(loaded.policyPath);
    if (policy.capability !== "local") webExtensionPath = loadWebExtensionPath();
  } catch (error) {
    policyError = error instanceof Error ? error.message : String(error);
  }

  pi.on("session_start", () => {
    if (!policy || !readyPath || (policy.capability !== "local" && !webExtensionPath)) {
      pi.setActiveTools([]);
      return;
    }
    const tools = pi.getAllTools();
    const activeTools = toolsForCapability(policy.capability);
    if (policy.capability !== "web") {
      for (const name of ALLOWED_FILE_TOOLS) {
        const tool = tools.find((candidate) => candidate.name === name);
        if (!tool || tool.sourceInfo?.source !== "builtin") {
          policy = undefined;
          policyError = `${name} is not owned by Pi's built-in tool set`;
          pi.setActiveTools([]);
          return;
        }
      }
    }
    if (policy.capability !== "local") {
      for (const name of ALLOWED_WEB_TOOLS) {
        const tool = tools.find((candidate) => candidate.name === name);
        const sourcePath = canonicalSourcePath(tool?.sourceInfo?.path);
        if (!tool || sourcePath !== webExtensionPath) {
          policy = undefined;
          policyError = `${name} is not owned by the explicitly loaded web extension`;
          pi.setActiveTools([]);
          return;
        }
      }
    }
    try {
      writeFileSync(readyPath, READY_MARKER, { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch (error) {
      policy = undefined;
      policyError = `could not publish guard readiness: ${error instanceof Error ? error.message : String(error)}`;
      pi.setActiveTools([]);
      return;
    }
    pi.setActiveTools(activeTools);
  });

  pi.on("tool_call", async (event) => {
    if (!policy || (policy.capability !== "local" && !webExtensionPath)) {
      return { block: true, reason: `Subagent policy is unavailable: ${policyError ?? "unknown error"}`, terminate: true };
    }
    const allowed = new Set(toolsForCapability(policy.capability));
    if (!allowed.has(event.toolName)) {
      return { block: true, reason: `Tool ${event.toolName} is not allowed in the subagent`, terminate: true };
    }

    const tool = pi.getAllTools().find((candidate) => candidate.name === event.toolName);
    if (event.toolName === REPORT_TOOL_NAME) {
      if (canonicalSourcePath(tool?.sourceInfo?.path) !== canonicalSourcePath(CHILD_GUARD_SOURCE_PATH)) {
        return { block: true, reason: "Structured report tool ownership changed", terminate: true };
      }
      return;
    }
    if (FILE_TOOLS.has(event.toolName)) {
      if (tool?.sourceInfo?.source !== "builtin") {
        return { block: true, reason: `Tool ${event.toolName} ownership changed`, terminate: true };
      }
      const path = requestedPath(event.toolName, event.input);
      if (path === undefined) return { block: true, reason: `${event.toolName} requires a path`, terminate: true };
      try {
        await authorizeReadPath(policy, path);
      } catch (error) {
        return { block: true, reason: error instanceof Error ? error.message : String(error) };
      }
      return;
    }

    if (WEB_TOOLS.has(event.toolName)) {
      if (canonicalSourcePath(tool?.sourceInfo?.path) !== webExtensionPath) {
        return { block: true, reason: `Tool ${event.toolName} ownership changed`, terminate: true };
      }
      const input = event.input && typeof event.input === "object" ? event.input as Record<string, unknown> : {};
      const error = validateWebCall(event.toolName, input);
      if (error) return { block: true, reason: error, terminate: true };
      return;
    }
  });

  pi.on("user_bash", () => ({
    result: {
      output: "User Bash is disabled in the subagent.",
      exitCode: 126,
      cancelled: false,
      truncated: false,
    },
  }));
}
