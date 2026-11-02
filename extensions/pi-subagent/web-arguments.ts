import {
  ALLOWED_WEB_TOOLS,
  DEFAULT_WEB_RESULTS_PER_QUERY,
  MAX_FETCH_URLS_PER_CALL,
  MAX_SOURCE_CHECK_FETCH_TARGETS_PER_CALL,
  MAX_WEB_QUERIES_PER_CALL,
  MAX_WEB_RESULTS_PER_QUERY,
  WEB_INPUT_KEYS,
  type WebTool,
} from "./shared.ts";

type WebCost = { queries: number; fetchTargets: number };
type WebRule = {
  validate(input: Record<string, unknown>): string | undefined;
  pinned?: Record<string, unknown>;
  cost(input: Record<string, unknown>): WebCost;
};

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

function sourceCheckCost(input: Record<string, unknown>): WebCost {
  const queries = sourceCheckQueryCount(input);
  const requestedResults = typeof input.numResults === "number" && Number.isFinite(input.numResults)
    ? Math.min(MAX_WEB_RESULTS_PER_QUERY, Math.max(1, Math.floor(input.numResults)))
    : DEFAULT_WEB_RESULTS_PER_QUERY;
  const fetchTargets = input.fetchContent === true
    ? Math.min(MAX_SOURCE_CHECK_FETCH_TARGETS_PER_CALL, queries * requestedResults)
    : 0;
  return { queries, fetchTargets };
}

function validateFetchContent(input: Record<string, unknown>): string | undefined {
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

const WEB_RULES = {
  web_search: {
    validate: (input) => validateBoundedQueries("web_search", input),
    pinned: { workflow: "none" },
    cost: (input) => ({ queries: webSearchQueryCount(input), fetchTargets: 0 }),
  },
  source_check: {
    validate: (input) => validateBoundedQueries("source_check", input),
    cost: sourceCheckCost,
  },
  fetch_content: {
    validate: validateFetchContent,
    pinned: { mode: "readable" },
    cost: (input) => ({ queries: 0, fetchTargets: fetchContentTargetCount(input) }),
  },
  get_search_content: {
    validate: () => undefined,
    cost: () => ({ queries: 0, fetchTargets: 1 }),
  },
} satisfies Record<WebTool, WebRule>;

// Unlike an object index, a Map never resolves prototype names such as "constructor".
const WEB_TOOL_RULES = new Map<string, WebRule & { allowed: ReadonlySet<string> }>(
  ALLOWED_WEB_TOOLS.map((name) => [name, { ...WEB_RULES[name], allowed: new Set<string>(WEB_INPUT_KEYS[name]) }]),
);

// Keep validation side-effect free; apply prepared arguments only after budget admission.
export function prepareWebCall(
  toolName: string,
  input: Record<string, unknown>,
): { violation: string } | { input: Record<string, unknown>; cost: WebCost } {
  const rule = WEB_TOOL_RULES.get(toolName);
  if (!rule) return { violation: `${toolName} is not supported in the subagent` };
  const unknown = Object.keys(input).filter((key) => !rule.allowed.has(key));
  if (unknown.length > 0) {
    return { violation: `${toolName} input ${unknown.sort().join(", ")} is not allowed in the subagent` };
  }
  const violation = rule.validate(input);
  if (violation) return { violation };
  const normalizedInput = { ...input, ...rule.pinned };
  return { input: normalizedInput, cost: rule.cost(normalizedInput) };
}
