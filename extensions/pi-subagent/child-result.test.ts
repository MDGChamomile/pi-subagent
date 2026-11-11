import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { assertChildReady, selectPartialReason } from "./child-result.ts";
import { READY_MARKER, runtimeFilesIn, type PartialReason } from "./shared.ts";

describe("child readiness", () => {
  test("requires the exact guard readiness marker", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-subagent-ready-test-"));
    try {
      const readyFile = runtimeFilesIn(root).ready;
      await assert.rejects(() => assertChildReady(readyFile), /did not become ready/);
      await writeFile(readyFile, "wrong\n");
      await assert.rejects(() => assertChildReady(readyFile), /marker is invalid/);
      await writeFile(readyFile, READY_MARKER);
      await assert.doesNotReject(() => assertChildReady(readyFile));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
