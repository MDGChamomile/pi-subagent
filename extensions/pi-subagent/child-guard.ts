import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { cleanupPrivateRuntimeFiles, installParentLivenessMonitor } from "./parent-liveness.ts";
import {
  ALLOWED_FILE_TOOLS,
  ALLOWED_WEB_TOOLS,
  authorizeReadPath,
  BUDGET_TELEMETRY_ENV,
  DEFAULT_WEB_RESULTS_PER_QUERY,
  isWithin,
  LIFETIME_TOOL_CALL_LIMITS,
  LIFETIME_WEB_FETCH_TARGET_LIMIT,
  LIFETIME_WEB_QUERY_LIMIT,
  MAX_FETCH_URLS_PER_CALL,
  MAX_SCOPE_ROOTS,
  MAX_SOURCE_CHECK_FETCH_TARGETS_PER_CALL,
  MAX_WEB_QUERIES_PER_CALL,
  MAX_WEB_RESULTS_PER_QUERY,
  POLICY_ENV,
  READY_ENV,
  READY_MARKER,
  SOFT_DEADLINE_ENV,
  toolsForCapability,
  WEB_EXTENSION_ENV,
  WEB_INPUT_KEYS,
  type BudgetTelemetry,
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

function loadCompanionPath(policyPath: string, envName: string, label: string): string {
  const raw = process.env[envName];
  if (!raw) throw new Error(`child ${label} path is missing`);
  const resolved = resolve(raw);
  if (dirname(resolved) !== dirname(policyPath)) throw new Error(`child ${label} path must accompany the policy file`);
  return resolved;
}

function loadReadyPath(policyPath: string): string {
  return loadCompanionPath(policyPath, READY_ENV, "readiness");
}

function loadBudgetTelemetryPath(policyPath: string): string {
  return loadCompanionPath(policyPath, BUDGET_TELEMETRY_ENV, "budget telemetry");
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

const WEB_INPUT_ALLOWLISTS: Record<string, ReadonlySet<string>> = Object.fromEntries(
  Object.entries(WEB_INPUT_KEYS).map(([toolName, keys]) => [toolName, new Set(keys)]),
);

function expandedSingleQueryCount(value: unknown): number {
  if (typeof value !== "string" || !value.trim()) return 0;
  const trimmed = value.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")) {
        return parsed.filter((entry) => entry.trim().length > 0).length;
      }
    } catch {
      // pi-web-access treats malformed JSON-shaped strings as one literal query.
    }
  }
  return 1;
}

function webSearchQueryCount(input: Record<string, unknown>): number {
  if (Array.isArray(input.queries)) {
    return input.queries.filter((query) => typeof query === "string" && query.trim().length > 0).length;
  }
  return expandedSingleQueryCount(input.query);
}

function sourceCheckQueryCount(input: Record<string, unknown>): number {
  if (typeof input.claim !== "string" || !input.claim.trim()) return 0;
  const requested = Array.isArray(input.queries)
    ? input.queries.filter((query) => typeof query === "string" && query.trim().length > 0).length
    : 0;
  return requested > 0 ? requested : 1;
}

function fetchContentTargetCount(input: Record<string, unknown>): number {
  const urls = Array.isArray(input.urls)
    ? input.urls.filter((url) => typeof url === "string" && url.trim().length > 0).map((url) => url.trim())
    : [];
  if (urls.length > 0) return new Set(urls).size;
  return typeof input.url === "string" && input.url.trim().length > 0 ? 1 : 0;
}

function validateBoundedQueries(toolName: string, input: Record<string, unknown>): string | undefined {
  if (Array.isArray(input.queries) && input.queries.length > MAX_WEB_QUERIES_PER_CALL) {
    return `${toolName} permits at most ${MAX_WEB_QUERIES_PER_CALL} queries`;
  }
  if (toolName === "web_search" && webSearchQueryCount(input) > MAX_WEB_QUERIES_PER_CALL) {
    return `${toolName} permits at most ${MAX_WEB_QUERIES_PER_CALL} queries`;
  }
  if (typeof input.numResults === "number" && input.numResults > MAX_WEB_RESULTS_PER_QUERY) {
    return `${toolName} permits at most ${MAX_WEB_RESULTS_PER_QUERY} results per query`;
  }
  return undefined;
}

export function webResourceCost(
  toolName: string,
  input: Record<string, unknown>,
): { queries: number; fetchTargets: number } {
  if (toolName === "web_search") return { queries: webSearchQueryCount(input), fetchTargets: 0 };
  if (toolName === "source_check") {
    const queries = sourceCheckQueryCount(input);
    const requestedResults = typeof input.numResults === "number" && Number.isFinite(input.numResults)
      ? Math.min(MAX_WEB_RESULTS_PER_QUERY, Math.max(1, Math.floor(input.numResults)))
      : DEFAULT_WEB_RESULTS_PER_QUERY;
    const fetchTargets = input.fetchContent === true
      ? Math.min(MAX_SOURCE_CHECK_FETCH_TARGETS_PER_CALL, queries * requestedResults)
      : 0;
    return { queries, fetchTargets };
  }
  if (toolName === "fetch_content") return { queries: 0, fetchTargets: fetchContentTargetCount(input) };
  if (toolName === "get_search_content") return { queries: 0, fetchTargets: 1 };
  return { queries: 0, fetchTargets: 0 };
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
  if (urls.length > MAX_FETCH_URLS_PER_CALL) return `fetch_content permits at most ${MAX_FETCH_URLS_PER_CALL} URLs`;
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
  let budgetTelemetryPath: string | undefined;
  let webExtensionPath: string | undefined;
  let softDeadline: number | undefined;
  let softDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let finalAnswerSeen = false;
  let finalizationRequested = false;
  let policyError: string | undefined;
  let stopParentLivenessMonitor: (() => void) | undefined;
  const validatedToolCallIds = new Set<string>();
  const permittedToolCallIds = new Set<string>();
  const deniedToolCallIds = new Set<string>();
  const budget: BudgetTelemetry = {
    version: 1,
    toolCallsAttempted: 0,
    toolCallsExecuted: 0,
    deniedCalls: 0,
    queryCount: 0,
    fetchTargetCount: 0,
    softLimitReached: false,
    hardLimitReached: false,
  };

  const persistBudget = () => {
    if (!budgetTelemetryPath) return;
    writeFileSync(budgetTelemetryPath, JSON.stringify(budget), { encoding: "utf8", mode: 0o600 });
  };
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
  const requestBudgetPartialAnswer = () => {
    budget.hardLimitReached = true;
    budget.partialReason = "tool_budget";
    persistBudget();
    requestFinalAnswer(
      "The child lifetime tool budget has been exhausted. Stop investigating and answer now using only evidence already gathered. Clearly identify unfinished work and coverage gaps; the runtime will mark the result as partial.",
      "steer",
    );
  };
  const sendSoftBudgetNotice = () => {
    if (finalizationRequested) return;
    try {
      pi.sendUserMessage(
        "The child lifetime tool-call soft limit has been reached. Use further calls only for essential missing evidence, then return the concise final answer.",
        { deliverAs: "steer" },
      );
    } catch (error) {
      policy = undefined;
      policyError = `could not send the tool budget warning: ${error instanceof Error ? error.message : String(error)}`;
      pi.setActiveTools([]);
    }
  };

  try {
    const loaded = loadPolicy();
    policy = loaded.policy;
    policyPath = loaded.policyPath;
    readyPath = loadReadyPath(loaded.policyPath);
    budgetTelemetryPath = loadBudgetTelemetryPath(loaded.policyPath);
    stopParentLivenessMonitor = installLiveness(
      () => cleanupPrivateRuntimeFiles(policyPath, readyPath, budgetTelemetryPath),
    );
    softDeadline = loadSoftDeadline();
    if (policy.capability === "web") webExtensionPath = loadWebExtensionPath();
  } catch (error) {
    policyError = error instanceof Error ? error.message : String(error);
  }

  pi.on("turn_end", (event) => {
    if (event.message.role !== "assistant") return;
    const content = event.message.content;
    const hasToolCall = content.some((part) => part.type === "toolCall");
    const hasText = content.some((part) => part.type === "text" && part.text.trim().length > 0);
    finalAnswerSeen = hasText
      && !hasToolCall
      && event.message.stopReason !== "error"
      && event.message.stopReason !== "aborted"
      && event.message.stopReason !== "toolUse"
      && event.message.stopReason !== "length";
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
    persistBudget();
    stopParentLivenessMonitor?.();
  });

  pi.on("session_start", () => {
    if (!policy || !readyPath || !budgetTelemetryPath || (policy.capability === "web" && !webExtensionPath)) {
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
      writeFileSync(budgetTelemetryPath!, JSON.stringify(budget), { encoding: "utf8", mode: 0o600, flag: "wx" });
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

  pi.on("tool_execution_start", (event) => {
    budget.toolCallsAttempted += 1;
    if (policy) {
      const limits = LIFETIME_TOOL_CALL_LIMITS[policy.capability];
      if (!budget.softLimitReached && budget.toolCallsAttempted >= limits.soft) {
        budget.softLimitReached = true;
        persistBudget();
        sendSoftBudgetNotice();
      }
      if (budget.toolCallsAttempted > limits.hard) requestBudgetPartialAnswer();
    }
    persistBudget();
  });

  pi.on("tool_call", async (event) => {
    validatedToolCallIds.add(event.toolCallId);
    const block = (reason: string, terminate?: true) => {
      if (!deniedToolCallIds.has(event.toolCallId)) {
        deniedToolCallIds.add(event.toolCallId);
        budget.deniedCalls += 1;
      }
      persistBudget();
      return { block: true as const, reason, ...(terminate ? { terminate } : {}) };
    };
    const permit = () => {
      permittedToolCallIds.add(event.toolCallId);
      persistBudget();
    };

    if (!policy || (policy.capability === "web" && !webExtensionPath)) {
      return block(`Subagent policy is unavailable: ${policyError ?? "unknown error"}`, true);
    }
    const deadlineExpired = timeLimitReached();
    if (deadlineExpired) requestPartialAnswer();
    if (deadlineExpired || finalizationRequested) {
      const hardLimitExceeded = budget.hardLimitReached
        && budget.toolCallsAttempted > LIFETIME_TOOL_CALL_LIMITS[policy.capability].hard;
      return block(hardLimitExceeded
        ? "The child lifetime tool-call hard limit has been exceeded; finalization has started"
        : "Finalization has started; return the final answer without further tool calls");
    }
    const allowed = new Set(toolsForCapability(policy.capability));
    if (!allowed.has(event.toolName)) {
      return block(`Tool ${event.toolName} is not allowed in the subagent. Use an available tool or return the final answer`);
    }

    const tool = pi.getAllTools().find((candidate) => candidate.name === event.toolName);
    if (FILE_TOOLS.has(event.toolName)) {
      if (tool?.sourceInfo?.source !== "builtin") {
        return block(`Tool ${event.toolName} ownership changed`, true);
      }
      const path = requestedPath(event.toolName, event.input);
      if (path === undefined) return block(`${event.toolName} requires a path`);
      try {
        (event.input as Record<string, unknown>).path = await authorizeReadPath(policy, path);
      } catch (error) {
        return block(error instanceof Error ? error.message : String(error));
      }
      permit();
      return;
    }

    if (WEB_TOOLS.has(event.toolName)) {
      if (canonicalSourcePath(tool?.sourceInfo?.path) !== webExtensionPath) {
        return block(`Tool ${event.toolName} ownership changed`, true);
      }
      const input = event.input && typeof event.input === "object" ? event.input as Record<string, unknown> : {};
      const violation = validateWebCall(event.toolName, input);
      if (violation) {
        return block(`${violation}. Retry with allowed bounded inputs or return the final answer.`);
      }
      const cost = webResourceCost(event.toolName, input);
      if (
        budget.queryCount + cost.queries > LIFETIME_WEB_QUERY_LIMIT
        || budget.fetchTargetCount + cost.fetchTargets > LIFETIME_WEB_FETCH_TARGET_LIMIT
      ) {
        requestBudgetPartialAnswer();
        return block("The child lifetime web query/fetch budget would be exceeded; finalization has started");
      }
      // Pi preflights sibling calls sequentially. Reserve synchronously before execution so a parallel batch cannot oversubscribe.
      budget.queryCount += cost.queries;
      budget.fetchTargetCount += cost.fetchTargets;
      permit();
      return;
    }
  });

  pi.on("tool_result", (event) => {
    if (!permittedToolCallIds.delete(event.toolCallId)) return;
    budget.toolCallsExecuted += 1;
    persistBudget();
  });

  pi.on("tool_execution_end", (event) => {
    if (!validatedToolCallIds.has(event.toolCallId) && !deniedToolCallIds.has(event.toolCallId)) {
      deniedToolCallIds.add(event.toolCallId);
      budget.deniedCalls += 1;
      persistBudget();
    }
    validatedToolCallIds.delete(event.toolCallId);
    permittedToolCallIds.delete(event.toolCallId);
    deniedToolCallIds.delete(event.toolCallId);
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
