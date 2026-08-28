import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { cleanupPrivateRuntimeFiles, installParentLivenessMonitor } from "./parent-liveness.ts";
import {
  ALLOWED_FILE_TOOLS,
  ALLOWED_WEB_TOOLS,
  authorizeReadPath,
  isWithin,
  MAX_SCOPE_ROOTS,
  POLICY_ENV,
  READY_ENV,
  READY_MARKER,
  SOFT_DEADLINE_ENV,
  toolsForCapability,
  WEB_EXTENSION_ENV,
  type ChildPolicy,
} from "./shared.ts";

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
    (parsed.capability !== "local" && parsed.capability !== "web")
  ) {
    throw new Error("child policy is malformed");
  }
  const cwd = realpathSync(parsed.cwd);
  if (cwd !== parsed.cwd || parsed.roots.length > MAX_SCOPE_ROOTS) throw new Error("child policy has invalid roots");
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

function loadSoftDeadline(): number | undefined {
  const raw = process.env[SOFT_DEADLINE_ENV];
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) throw new Error("child soft deadline is malformed");
  const deadline = Number(raw);
  if (!Number.isSafeInteger(deadline) || deadline <= 0) throw new Error("child soft deadline is malformed");
  return deadline;
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
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "fetch_content permits only HTTP(S) URLs";
    }
    if (url.username || url.password) {
      return "fetch_content URLs must not contain embedded credentials";
    }
    return undefined;
  } catch {
    return "fetch_content received an invalid URL";
  }
}

const WEB_INPUT_ALLOWLISTS: Record<string, ReadonlySet<string>> = {
  web_search: new Set(["query", "queries", "numResults", "recencyFilter", "domainFilter", "workflow"]),
  source_check: new Set(["claim", "queries", "numResults", "fetchContent", "recencyFilter", "domainFilter"]),
  fetch_content: new Set(["url", "urls", "mode"]),
  get_search_content: new Set([
    "responseId", "query", "queryIndex", "url", "urlIndex", "offset", "limit", "findText", "findMode",
  ]),
};
const MAX_WEB_QUERIES = 4;
const MAX_WEB_RESULTS_PER_QUERY = 10;
const MAX_FETCH_URLS = 5;

function validateBoundedQueries(toolName: string, input: Record<string, unknown>): string | undefined {
  if (Array.isArray(input.queries) && input.queries.length > MAX_WEB_QUERIES) {
    return `${toolName} permits at most ${MAX_WEB_QUERIES} queries`;
  }
  if (typeof input.numResults === "number" && input.numResults > MAX_WEB_RESULTS_PER_QUERY) {
    return `${toolName} permits at most ${MAX_WEB_RESULTS_PER_QUERY} results per query`;
  }
  return undefined;
}

function validateWebCall(toolName: string, input: Record<string, unknown>): string | undefined {
  const allowed = WEB_INPUT_ALLOWLISTS[toolName];
  if (!allowed) return `${toolName} is not supported in the subagent`;
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    return `${toolName} input ${unknown.sort().join(", ")} is not allowed in the subagent`;
  }

  if (toolName === "web_search") {
    const boundedError = validateBoundedQueries(toolName, input);
    if (boundedError) return boundedError;
    input.workflow = "none";
    return undefined;
  }
  if (toolName === "source_check") return validateBoundedQueries(toolName, input);
  if (toolName === "get_search_content") return undefined;
  if (toolName !== "fetch_content") return `${toolName} is not supported in the subagent`;
  if (input.mode !== undefined && input.mode !== "readable") {
    return "fetch_content permits only readable mode in the subagent";
  }
  const urls: string[] = [];
  if (typeof input.url === "string") urls.push(input.url);
  if (Array.isArray(input.urls)) {
    if (!input.urls.every((value) => typeof value === "string")) {
      return "fetch_content URLs must be strings";
    }
    urls.push(...input.urls as string[]);
  }
  if (urls.length === 0) return "fetch_content requires at least one HTTP(S) URL";
  if (urls.length > MAX_FETCH_URLS) return `fetch_content permits at most ${MAX_FETCH_URLS} URLs`;
  for (const url of urls) {
    const violation = validatePublicHttpUrl(url);
    if (violation) return violation;
  }
  return undefined;
}

export default function childGuard(
  pi: ExtensionAPI,
  installLiveness = installParentLivenessMonitor,
): void {
  let policy: ChildPolicy | undefined;
  let policyPath: string | undefined;
  let readyPath: string | undefined;
  let webExtensionPath: string | undefined;
  let softDeadline: number | undefined;
  let softDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let finalAnswerSeen = false;
  let finalizationRequested = false;
  let policyError: string | undefined;
  let stopParentLivenessMonitor: (() => void) | undefined;

  const timeLimitReached = () => softDeadline !== undefined && Date.now() >= softDeadline;
  const requestFinalAnswer = (content: string, deliverAs: "steer" | "followUp") => {
    if (finalAnswerSeen || finalizationRequested) return;
    finalizationRequested = true;
    pi.setActiveTools([]);
    try {
      pi.sendUserMessage(`${content}\n\nDo not call tools. Return the concise final answer as ordinary assistant text.`, { deliverAs });
    } catch (error) {
      policy = undefined;
      policyError = `could not request the final answer: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
  const requestPartialAnswer = () => {
    requestFinalAnswer(
      "The investigation time limit has been reached. Stop investigating and answer now using only evidence already gathered. Clearly identify unfinished work and coverage gaps; the runtime will mark the result as partial.",
      "steer",
    );
  };

  try {
    stopParentLivenessMonitor = installLiveness(() => cleanupPrivateRuntimeFiles(policyPath, readyPath));
    const loaded = loadPolicy();
    policy = loaded.policy;
    policyPath = loaded.policyPath;
    readyPath = loadReadyPath(loaded.policyPath);
    softDeadline = loadSoftDeadline();
    if (policy.capability === "web") webExtensionPath = loadWebExtensionPath();
  } catch (error) {
    policyError = error instanceof Error ? error.message : String(error);
  }

  pi.on("turn_end", (event) => {
    const content = event.message.content;
    const hasToolCall = content.some((part) => part.type === "toolCall");
    const hasText = content.some((part) => part.type === "text" && part.text.trim().length > 0);
    finalAnswerSeen = hasText
      && !hasToolCall
      && event.message.stopReason !== "error"
      && event.message.stopReason !== "aborted"
      && event.message.stopReason !== "toolUse";
  });

  pi.on("agent_start", () => {
    finalAnswerSeen = false;
  });

  pi.on("agent_end", () => {
    if (!policy || finalAnswerSeen || finalizationRequested) return;
    if (timeLimitReached()) {
      requestPartialAnswer();
      return;
    }
    requestFinalAnswer(
      "The investigation ended without a final answer. Do not investigate further; answer using only evidence already gathered and state any uncertainty or coverage gap.",
      "followUp",
    );
  });

  pi.on("session_shutdown", () => {
    if (softDeadlineTimer) clearTimeout(softDeadlineTimer);
    stopParentLivenessMonitor?.();
  });

  pi.on("session_start", () => {
    if (!policy || !readyPath || (policy.capability === "web" && !webExtensionPath)) {
      pi.setActiveTools([]);
      return;
    }
    const tools = pi.getAllTools();
    const activeTools = toolsForCapability(policy.capability);
    if (policy.capability === "local") {
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
    if (policy.capability === "web") {
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
    if (softDeadline !== undefined) {
      softDeadlineTimer = setTimeout(requestPartialAnswer, Math.max(0, softDeadline - Date.now()));
      softDeadlineTimer.unref?.();
    }
  });

  pi.on("tool_call", async (event) => {
    if (!policy || (policy.capability === "web" && !webExtensionPath)) {
      return { block: true, reason: `Subagent policy is unavailable: ${policyError ?? "unknown error"}`, terminate: true };
    }
    const deadlineExpired = timeLimitReached();
    if (deadlineExpired) requestPartialAnswer();
    if (deadlineExpired || finalizationRequested) {
      return { block: true, reason: "Finalization has started; return the final answer without further tool calls" };
    }
    const allowed = new Set(toolsForCapability(policy.capability));
    if (!allowed.has(event.toolName)) {
      return {
        block: true,
        reason: `Tool ${event.toolName} is not allowed in the subagent. Use an available tool or return the final answer`,
      };
    }

    const tool = pi.getAllTools().find((candidate) => candidate.name === event.toolName);
    if (FILE_TOOLS.has(event.toolName)) {
      if (tool?.sourceInfo?.source !== "builtin") {
        return { block: true, reason: `Tool ${event.toolName} ownership changed`, terminate: true };
      }
      const path = requestedPath(event.toolName, event.input);
      if (path === undefined) return { block: true, reason: `${event.toolName} requires a path` };
      try {
        (event.input as Record<string, unknown>).path = await authorizeReadPath(policy, path);
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
      const violation = validateWebCall(event.toolName, input);
      if (violation) {
        return { block: true, reason: `${violation}. Retry with allowed bounded inputs or return the final answer.` };
      }
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
