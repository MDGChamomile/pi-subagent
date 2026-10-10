import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertChildReady,
  buildChildInvocation,
  estimateContextTokens,
  formatElapsed,
  formatProgress,
  formatResultSummary,
  readBudgetTelemetry,
  selectPartialReason,
} from "./subprocess.ts";
import { READY_MARKER, type ChildPolicy, type PartialReason } from "./shared.ts";

describe("child completion boundary", () => {
  test("formats live progress with elapsed time, model, thinking, and reported tokens", () => {
    assert.equal(formatElapsed(0), "00:00");
    assert.equal(formatElapsed(59_999), "00:59");
    assert.equal(formatElapsed(60_000), "01:00");
    assert.equal(formatElapsed(15 * 60_000), "15:00");
    assert.equal(
      formatProgress("openai-codex/gpt-6-luna", "low", 83_000, 4_512),
      "01:23 · gpt-6-luna (low) running · 4,512 reported tokens",
    );
  });

  test("formats final context injection estimates for complete and partial results", () => {
    assert.equal(estimateContextTokens(""), 0);
    assert.equal(estimateContextTokens("x".repeat(7_280)), 1_820);
    assert.equal(estimateContextTokens("abcde"), 2);
    assert.equal(estimateContextTokens("한글"), 2); // 6 UTF-8 bytes
    assert.equal(estimateContextTokens("😀😀"), 2); // 8 UTF-8 bytes
    assert.equal(estimateContextTokens("A한😀"), 2); // mixed, 8 UTF-8 bytes
    assert.equal(
      formatResultSummary("complete", 14_200, 1_820),
      "✓ Complete · 14.2s · Context injected: ~1,820 tokens",
    );
    assert.equal(
      formatResultSummary("partial", 18 * 60_000 + 4_000, 2_210),
      "⚠ Partial · 18:04 · Context injected: ~2,210 tokens",
    );
  });

  test("requires the exact guard readiness marker", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-subagent-ready-test-"));
    try {
      const readyFile = join(root, "guard.ready");
      await assert.rejects(() => assertChildReady(readyFile), /did not become ready/);
      await writeFile(readyFile, "wrong\n");
      await assert.rejects(() => assertChildReady(readyFile), /marker is invalid/);
      await writeFile(readyFile, READY_MARKER);
      await assert.doesNotReject(() => assertChildReady(readyFile));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("accepts only content-free budget telemetry fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-subagent-budget-test-"));
    try {
      const telemetryFile = join(root, "budget.json");
      const telemetry = {
        version: 1,
        toolCallsAttempted: 12,
        toolCallsExecuted: 10,
        deniedCalls: 2,
        queryCount: 4,
        fetchTargetCount: 5,
        softLimitReached: false,
        hardLimitReached: true,
        partialReason: "tool_budget",
      };
      await writeFile(telemetryFile, JSON.stringify(telemetry));
      assert.deepEqual(await readBudgetTelemetry(telemetryFile), telemetry);

      await writeFile(telemetryFile, JSON.stringify({ ...telemetry, task: "private task" }));
      await assert.rejects(() => readBudgetTelemetry(telemetryFile), /malformed/);
      await writeFile(telemetryFile, JSON.stringify({ ...telemetry, queryCount: -1 }));
      await assert.rejects(() => readBudgetTelemetry(telemetryFile), /malformed/);
      for (const partialReason of ["time_limit", "model_length"]) {
        await writeFile(telemetryFile, JSON.stringify({ ...telemetry, partialReason }));
        await assert.rejects(() => readBudgetTelemetry(telemetryFile), /malformed/);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });


});

describe("child invocation", () => {
  const GUARD = fileURLToPath(new URL("./child-guard.ts", import.meta.url));
  const launcher = { command: "/synthetic/node", args: ["/synthetic/pi.js"] };
  const policy = (capability: "local" | "web"): ChildPolicy => ({
    version: 1, cwd: "/synthetic/project", capability,
    roots: capability === "local" ? [{ path: "/synthetic/project", kind: "directory" }] : [],
  });
  const build = (capability: "local" | "web", parentEnv: NodeJS.ProcessEnv) => buildChildInvocation({
    policy: policy(capability),
    policyFile: "/synthetic/run/policy.json",
    readyFile: "/synthetic/run/guard.ready",
    budgetTelemetryFile: "/synthetic/run/budget-telemetry.json",
    webExtensionPath: capability === "web" ? "/synthetic/pi-web-access/index.ts" : undefined,
    model: "provider/model",
    thinking: "high",
    softDeadline: 1_234,
  }, launcher, parentEnv);
  const inheritedOverrides = {
    PI_SESSION_ID: "parent-session",
    PI_SESSION_FILE: "/parent/session.jsonl",
    PI_PROVIDER: "parent-provider",
    PI_MODEL: "parent-model",
    PI_REASONING_LEVEL: "low",
    PI_ALLOW_BROWSER_COOKIES: "1",
    FEYNMAN_ALLOW_BROWSER_COOKIES: "1",
  };

  test("keeps the launcher prefix separate and appends the restrictive Pi arguments once", () => {
    for (const capability of ["local", "web"] as const) {
      const { command, args } = build(capability, {});
      assert.equal(command, "/synthetic/node");
      assert.equal(args[0], "/synthetic/pi.js");
      const piArgs = args.slice(1);
      assert.equal(piArgs.includes("/synthetic/pi.js"), false);
      for (const flag of [
        "--print", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates",
        "--no-themes", "--no-context-files", "--no-approve",
      ]) {
        assert.equal(piArgs.filter((arg) => arg === flag).length, 1, `${capability}: ${flag}`);
      }
      const value = (flag: string) => piArgs[piArgs.indexOf(flag) + 1];
      assert.equal(value("--mode"), "json");
      assert.equal(value("--model"), "provider/model");
      assert.equal(value("--thinking"), "high");
      assert.ok(value("--system-prompt").length > 0);
    }
  });

  test("selects capability tools and loads only the web extension and guard after --no-extensions", () => {
    const local = build("local", {}).args;
    assert.equal(local[local.indexOf("--tools") + 1], "read,grep,find,ls");
    const localExtensions = local.flatMap((arg, index) => arg === "--extension" ? [local[index + 1]] : []);
    assert.deepEqual(localExtensions, [GUARD]);
    assert.ok(local.indexOf("--no-extensions") < local.indexOf("--extension"));

    const web = build("web", {}).args;
    assert.equal(web[web.indexOf("--tools") + 1], "web_search,source_check,fetch_content,get_search_content");
    const webExtensions = web.flatMap((arg, index) => arg === "--extension" ? [web[index + 1]] : []);
    assert.deepEqual(webExtensions, ["/synthetic/pi-web-access/index.ts", GUARD]);
    assert.ok(web.indexOf("--no-extensions") < web.indexOf("--extension"));
  });

  test("removes inherited session, provider, and cookie overrides without changing the parent environment", () => {
    for (const capability of ["local", "web"] as const) {
      const parentEnv: NodeJS.ProcessEnv = {
        ...inheritedOverrides,
        PATH: "/synthetic/bin",
        PI_OFFLINE: "0",
        RIPGREP_CONFIG_PATH: "/synthetic/rg.conf",
        PI_SUBAGENT_WEB_EXTENSION_PATH: "/stale/web.ts",
      };
      const before = { ...parentEnv };
      const { env } = build(capability, parentEnv);
      assert.deepEqual(parentEnv, before, "the parent environment object must not be mutated");
      for (const name of Object.keys(inheritedOverrides)) assert.equal(name in env, false, `${capability}: ${name}`);
      assert.equal(env.PATH, "/synthetic/bin");
      assert.equal(env.PI_OFFLINE, "1");
      assert.equal(env.PI_SUBAGENT_POLICY_FILE, "/synthetic/run/policy.json");
      assert.equal(env.PI_SUBAGENT_READY_FILE, "/synthetic/run/guard.ready");
      assert.equal(env.PI_SUBAGENT_BUDGET_TELEMETRY_FILE, "/synthetic/run/budget-telemetry.json");
      assert.equal(env.PI_SUBAGENT_SOFT_DEADLINE_EPOCH_MS, "1234");
      assert.equal(env.PI_SUBAGENT_PARENT_LIVENESS_FD, "3");
      assert.deepEqual(JSON.parse(env.PI_SUBAGENT_MODEL_SELECTION!), { model: "provider/model", thinking: "high" });
      // rg config is removed only for local children; web children keep the parent value.
      assert.equal(env.RIPGREP_CONFIG_PATH, capability === "local" ? undefined : "/synthetic/rg.conf");
      assert.equal(env.PI_SUBAGENT_WEB_EXTENSION_PATH, capability === "web" ? "/synthetic/pi-web-access/index.ts" : undefined);
    }
  });

  test("defaults to the current process environment without mutating it", () => {
    const before = { ...process.env };
    buildChildInvocation({
      policy: policy("local"), policyFile: "p", readyFile: "r", budgetTelemetryFile: "b",
      model: "provider/model", thinking: "off", softDeadline: 1,
    });
    assert.deepEqual({ ...process.env }, before);
  });
});

// README "Result and lifecycle": model_length > tool_budget > time_limit. time_limit follows the
// parent's receipt time of the answer (post-cleanup time when absent), inclusive of the deadline.
describe("partial reason selection", () => {
  const softDeadline = 10_000;
  // [case, stopReason, hardLimitReached, finalOutputReceivedAt, completedAt, expected]
  const cases: Array<[string, string, boolean, number | undefined, number, PartialReason | undefined]> = [
    ["complete before the soft deadline", "stop", false, softDeadline - 2, softDeadline - 1, undefined],
    ["length outranks budget and time together", "length", true, softDeadline + 1, softDeadline + 2, "model_length"],
    ["length outranks budget", "length", true, softDeadline - 2, softDeadline - 1, "model_length"],
    ["length outranks time", "length", false, softDeadline + 1, softDeadline + 2, "model_length"],
    ["budget outranks time", "stop", true, softDeadline + 1, softDeadline + 2, "tool_budget"],
    ["budget before the soft deadline", "stop", true, softDeadline - 2, softDeadline - 1, "tool_budget"],
    ["receipt after the soft deadline", "stop", false, softDeadline + 1, softDeadline + 2, "time_limit"],
    ["receipt exactly at the soft deadline", "stop", false, softDeadline, softDeadline + 1, "time_limit"],
    ["receipt before the soft deadline despite late cleanup", "stop", false, softDeadline - 1, softDeadline + 60_000, undefined],
    ["no receipt: cleanup after the soft deadline", "stop", false, undefined, softDeadline + 1, "time_limit"],
    ["no receipt: cleanup exactly at the soft deadline", "stop", false, undefined, softDeadline, "time_limit"],
    ["no receipt: cleanup before the soft deadline", "stop", false, undefined, softDeadline - 1, undefined],
  ];

  for (const [name, stopReason, hardLimitReached, finalOutputReceivedAt, completedAt, expected] of cases) {
    test(name, () => {
      assert.equal(
        selectPartialReason({ stopReason, hardLimitReached, finalOutputReceivedAt, completedAt, softDeadline }),
        expected,
      );
    });
  }
});
