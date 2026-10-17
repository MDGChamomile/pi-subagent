import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  CHILD_FINALIZATION_GRACE_MS, CHILD_GUARD_EXIT_CODES, CHILD_TIMEOUT_MS,
  LIFETIME_TOOL_CALL_LIMITS, LIFETIME_WEB_FETCH_TARGET_LIMIT, LIFETIME_WEB_QUERY_LIMIT,
  MIN_WEB_EXTENSION_VERSION, PRESET_NAMES, SUBAGENT_PRESETS, sanitizeDisplayText,
} from "./shared.ts";
import { MAX_SUBAGENT_CALLS } from "./invocation-gate.ts";

describe("pi-subagent public contract", () => {
  test("exposes bounded runtime and three standard model presets", () => {
    assert.equal(CHILD_TIMEOUT_MS, 20 * 60 * 1000);
    assert.equal(CHILD_FINALIZATION_GRACE_MS, 2 * 60 * 1000);
    assert.equal(MAX_SUBAGENT_CALLS, 3);
    assert.deepEqual(LIFETIME_TOOL_CALL_LIMITS, {
      local: { soft: 36, hard: 48 },
      web: { soft: 30, hard: 40 },
    });
    assert.equal(LIFETIME_WEB_QUERY_LIMIT, 32);
    assert.equal(LIFETIME_WEB_FETCH_TARGET_LIMIT, 50);
    assert.equal(MIN_WEB_EXTENSION_VERSION, "0.33.0");
    const expectedPresets = {
      "lookup-standard": { model: "openai-codex/gpt-6-luna", thinking: "medium" },
      "analysis-standard": { model: "openai-codex/gpt-6.1-sol", thinking: "medium" },
      "review-standard": { model: "openai-codex/gpt-6.1-sol", thinking: "high" },
    };
    assert.deepEqual(SUBAGENT_PRESETS, expectedPresets);
    assert.deepEqual(PRESET_NAMES, Object.keys(expectedPresets));
  });

  test("keeps the documented guard exit codes", () => {
    // Literal values from the extension README. The fixture and integration tests
    // read the same constant, so only this assertion catches renumbering.
    assert.deepEqual(CHILD_GUARD_EXIT_CODES, {
      initialization: 70,
      toolOwnership: 71,
      readiness: 72,
      modelSelection: 73,
      runtime: 74,
    });
  });

  test("sanitizes terminal control and bidi characters while preserving layout", () => {
    assert.equal(sanitizeDisplayText("safe\n\t\u001b[31m\u202eevil"), "safe\n\t?[31m?evil");
  });
});
