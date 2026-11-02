import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { cleanupPrivateRuntimeFiles, installParentLivenessMonitor } from "./parent-liveness.ts";
import { validatePresetSelection, type PresetSelection } from "./config.ts";
import {
  ALLOWED_FILE_TOOLS,
  ALLOWED_WEB_TOOLS,
  BUDGET_TELEMETRY_ENV,
  CHILD_GUARD_EXIT_CODES,
  errorMessage,
  LIFETIME_TOOL_CALL_LIMITS,
  LIFETIME_WEB_FETCH_TARGET_LIMIT,
  LIFETIME_WEB_FETCH_TARGET_SOFT_LIMIT,
  LIFETIME_WEB_QUERY_LIMIT,
  LIFETIME_WEB_QUERY_SOFT_LIMIT,
  MAX_SCOPE_ROOTS,
  modelRef,
  POLICY_ENV,
  MODEL_SELECTION_ENV,
  READY_ENV,
  READY_MARKER,
  SOFT_DEADLINE_ENV,
  toolsForCapability,
  WEB_EXTENSION_ENV,
  type ChildPolicy,
  type RuntimeFiles,
} from "./shared.ts";
import type { BudgetTelemetry } from "./budget-telemetry.ts";
import { authorizeReadPath, isWithin } from "./path-policy.ts";
import { prepareWebCall } from "./web-arguments.ts";

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

function loadRuntimeFiles(policyPath: string): RuntimeFiles {
  return {
    policy: policyPath,
    ready: loadCompanionPath(policyPath, READY_ENV, "readiness"),
    budgetTelemetry: loadCompanionPath(policyPath, BUDGET_TELEMETRY_ENV, "budget telemetry"),
  };
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

export default function childGuard(
  pi: ExtensionAPI,
  installLiveness = installParentLivenessMonitor,
): void {
  let policy: ChildPolicy | undefined;
  let runtimeFiles: RuntimeFiles | undefined;
  let webExtensionPath: string | undefined;
  let softDeadline: number | undefined;
  let softDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let finalAnswerSeen = false;
  let finalizationRequested = false;
  let policyError: string | undefined;
  let guardReady = false;
  let startupExitCode: number = CHILD_GUARD_EXIT_CODES.initialization;
  const validatedToolCallIds = new Set<string>();
  const permittedToolCallIds = new Set<string>();
  const deniedToolCallIds = new Set<string>();
  const warnedWebResources = new Set<"queries" | "content targets">();
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

  // Local tools must be Pi built-ins; web tools must come from the explicitly loaded extension file.
  const ownsTool = (name: string, tools: ToolInfo[]) => {
    const tool = tools.find((candidate) => candidate.name === name);
    if (FILE_TOOLS.has(name)) return tool?.sourceInfo?.source === "builtin";
    return WEB_TOOLS.has(name) && webExtensionPath !== undefined
      && canonicalSourcePath(tool?.sourceInfo?.path) === webExtensionPath;
  };
  const invalidatePolicy = (message: string) => {
    policy = undefined;
    policyError = message;
  };
  const failClosed = (message: string) => {
    invalidatePolicy(message);
    pi.setActiveTools([]);
  };
  let lastPersistedBudget: string | undefined;
  const persistBudget = () => {
    if (!runtimeFiles) return;
    const snapshot = JSON.stringify(budget);
    if (snapshot === lastPersistedBudget) return;
    try {
      writeFileSync(runtimeFiles.budgetTelemetry, snapshot, { encoding: "utf8", mode: 0o600 });
    } catch (error) {
      // The parent derives tool_budget status only from this file. Pi may continue
      // after a hook error, so a stale snapshot must not let the child finish normally.
      failClosed(`could not persist budget telemetry: ${errorMessage(error)}`);
      throw error;
    }
    // Record only successful writes, so the event that changes a reservation or
    // terminal state always persists it synchronously.
    lastPersistedBudget = snapshot;
  };
  const timeLimitReached = () => softDeadline !== undefined && Date.now() >= softDeadline;
  const requestFinalAnswer = (content: string, deliverAs: "steer" | "followUp") => {
    if (finalAnswerSeen || finalizationRequested) return;
    finalizationRequested = true;
    pi.setActiveTools([]);
    try {
      pi.sendUserMessage(`${content}\n\nDo not call tools. Return the concise final answer as ordinary assistant text.`, { deliverAs });
    } catch (error) {
      // Tools were disabled before delivery; retain that ordering on failure.
      invalidatePolicy(`could not request the final answer: ${errorMessage(error)}`);
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
  const sendSoftBudgetNotice = (content = "The child lifetime tool-call soft limit has been reached. Use further calls only for essential missing evidence, then return the concise final answer.") => {
    if (finalizationRequested) return;
    try {
      pi.sendUserMessage(content, { deliverAs: "steer" });
    } catch (error) {
      failClosed(`could not send the tool budget warning: ${errorMessage(error)}`);
    }
  };

  try {
    const loaded = loadPolicy();
    policy = loaded.policy;
    const files = loadRuntimeFiles(loaded.policyPath);
    runtimeFiles = files;
    installLiveness(() => cleanupPrivateRuntimeFiles(files));
    softDeadline = loadSoftDeadline();
    if (policy.capability === "web") webExtensionPath = loadWebExtensionPath();
  } catch (error) {
    policyError = errorMessage(error);
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

  pi.on("agent_end", (event) => {
    if (!policy || finalAnswerSeen || finalizationRequested) return;
    // Pi decides whether to retry after dispatching agent_end. Do not queue a
    // finalization or disable investigation tools for a terminal model error.
    const lastAssistant = [...event.messages].reverse().find((message) => message.role === "assistant");
    if (lastAssistant?.stopReason === "error" || lastAssistant?.stopReason === "aborted") return;
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
    // Session shutdown can precede process exit while other handles remain.
    // The unreferenced liveness pipe must stay armed until the process exits.
  });

  // Pin the effective selection at the request boundary: Pi may otherwise fuzzy-match
  // a model ID or clamp thinking when the child's registry differs from the parent's.
  const expectedSelection = process.env[MODEL_SELECTION_ENV];
  const requireTransmissionAllowed = (ctx: ExtensionContext) => {
    // Tool disabling alone does not prevent a provider request. Require the
    // complete startup path, including readiness publication, before transmission.
    if (!guardReady || !policy || policyError) {
      process.exit(guardReady ? CHILD_GUARD_EXIT_CODES.runtime : startupExitCode);
    }
    try {
      const expected = JSON.parse(expectedSelection ?? "null") as PresetSelection | null;
      if (!expected || typeof expected.model !== "string" || typeof expected.thinking !== "string" ||
        !ctx.model || modelRef(ctx.model) !== expected.model || ctx.thinkingLevel !== expected.thinking) {
        throw new Error("Subagent model/thinking selection mismatch");
      }
      // The CLI can synthesize an unknown ID from a same-provider model. Require
      // an exact child registry entry, not just a matching effective ID.
      validatePresetSelection(expected, ctx.modelRegistry);
    } catch {
      // Pi swallows hook exceptions and continues the request (pinned by provider-guard.test.ts).
      // Exit synchronously instead; the parent observes failure and cleans runtime files.
      process.exit(CHILD_GUARD_EXIT_CODES.modelSelection);
    }
  };
  pi.on("before_provider_request", (_event, ctx) => {
    requireTransmissionAllowed(ctx);
  });
  // Pi sends compaction summaries without before_provider_request. The ephemeral
  // child has no later use for a summary of a run that already answered, and the
  // parent's hard deadline still covers it, so cancel that one. Other compactions
  // (before a later request or for overflow recovery) keep the request checks.
  pi.on("session_before_compact", (_event, ctx) => {
    if (finalAnswerSeen) return { cancel: true };
    requireTransmissionAllowed(ctx);
  });

  pi.on("session_start", () => {
    if (!policy || policyError || !runtimeFiles || (policy.capability === "web" && !webExtensionPath)) {
      pi.setActiveTools([]);
      return;
    }
    const tools = pi.getAllTools();
    const activeTools = toolsForCapability(policy.capability);
    startupExitCode = CHILD_GUARD_EXIT_CODES.toolOwnership;
    for (const name of activeTools) {
      if (!ownsTool(name, tools)) {
        const owner = policy.capability === "local" ? "Pi's built-in tool set" : "the explicitly loaded web extension";
        failClosed(`${name} is not owned by ${owner}`);
        return;
      }
    }
    startupExitCode = CHILD_GUARD_EXIT_CODES.readiness;
    try {
      const snapshot = JSON.stringify(budget);
      writeFileSync(runtimeFiles.budgetTelemetry, snapshot, { encoding: "utf8", mode: 0o600, flag: "wx" });
      lastPersistedBudget = snapshot;
      writeFileSync(runtimeFiles.ready, READY_MARKER, { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch (error) {
      failClosed(`could not publish guard readiness: ${errorMessage(error)}`);
      return;
    }
    pi.setActiveTools(activeTools);
    if (softDeadline !== undefined) {
      softDeadlineTimer = setTimeout(requestPartialAnswer, Math.max(0, softDeadline - Date.now()));
      softDeadlineTimer.unref?.();
    }
    guardReady = true;
  });

  pi.on("tool_execution_start", () => {
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
    const policyUnavailable = () => block(`Subagent policy is unavailable: ${policyError ?? "unknown error"}`, true);

    if (!policy || (policy.capability === "web" && !webExtensionPath)) return policyUnavailable();
    const deadlineExpired = timeLimitReached();
    if (deadlineExpired) requestPartialAnswer();
    if (deadlineExpired || finalizationRequested) {
      const hardLimitExceeded = budget.hardLimitReached
        && budget.toolCallsAttempted > LIFETIME_TOOL_CALL_LIMITS[policy.capability].hard;
      return block(hardLimitExceeded
        ? "The child lifetime tool-call hard limit has been exceeded; finalization has started"
        : "Finalization has started; return the final answer without further tool calls");
    }
    const allowed = policy.capability === "local" ? FILE_TOOLS : WEB_TOOLS;
    if (!allowed.has(event.toolName)) {
      return block(`Tool ${event.toolName} is not allowed in the subagent. Use an available tool or return the final answer`);
    }

    if (!ownsTool(event.toolName, pi.getAllTools())) {
      return block(`Tool ${event.toolName} ownership changed`, true);
    }
    if (FILE_TOOLS.has(event.toolName)) {
      const path = requestedPath(event.toolName, event.input);
      if (path === undefined) return block(`${event.toolName} requires a path`);
      try {
        (event.input as Record<string, unknown>).path = await authorizeReadPath(policy, path);
      } catch (error) {
        return block(errorMessage(error));
      }
      permit();
      return;
    }

    if (WEB_TOOLS.has(event.toolName)) {
      const input = event.input && typeof event.input === "object" ? event.input as Record<string, unknown> : {};
      const prepared = prepareWebCall(event.toolName, input);
      if ("violation" in prepared) {
        return block(`${prepared.violation}. Retry with allowed bounded inputs or return the final answer.`);
      }
      const { cost } = prepared;
      if (
        budget.queryCount + cost.queries > LIFETIME_WEB_QUERY_LIMIT
        || budget.fetchTargetCount + cost.fetchTargets > LIFETIME_WEB_FETCH_TARGET_LIMIT
      ) {
        requestBudgetPartialAnswer();
        return block("The child lifetime web query/fetch budget would be exceeded; finalization has started");
      }
      Object.assign(input, prepared.input);
      // Pi preflights sibling calls sequentially. Reserve synchronously before execution so a parallel batch cannot oversubscribe.
      budget.queryCount += cost.queries;
      budget.fetchTargetCount += cost.fetchTargets;
      for (const [resource, reserved, soft, hard] of [
        ["queries", budget.queryCount, LIFETIME_WEB_QUERY_SOFT_LIMIT, LIFETIME_WEB_QUERY_LIMIT],
        ["content targets", budget.fetchTargetCount, LIFETIME_WEB_FETCH_TARGET_SOFT_LIMIT, LIFETIME_WEB_FETCH_TARGET_LIMIT],
      ] as const) {
        if (reserved >= soft && !warnedWebResources.has(resource)) {
          warnedWebResources.add(resource);
          sendSoftBudgetNotice(
            `The child lifetime web ${resource} soft limit has been reached: ${reserved}/${hard} reserved, ${hard - reserved} remaining. Use further calls only for essential missing evidence, then return the concise final answer.`,
          );
          if (!policy) return policyUnavailable();
        }
      }
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
