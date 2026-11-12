import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { invocationLimitBlock, MAX_SUBAGENT_CALLS, ModelInvocationGate } from "./invocation-gate.ts";

describe("pi-subagent model invocation gate", () => {
  test("claims execution once per authorized call within an open run", () => {
    const gate = new ModelInvocationGate();
    assert.equal(gate.authorize("before-run"), false);
    gate.startRun();
    assert.equal(gate.start("missing"), false);
    assert.equal(gate.authorize("first"), true);
    assert.equal(gate.authorize("first"), false);
    assert.equal(gate.start("first"), true);
    assert.equal(gate.start("first"), false);
    assert.equal(gate.authorize("second"), true);
    gate.endRun();
    assert.equal(gate.start("second"), false);
    gate.startRun();
    assert.equal(gate.start("second"), false);
  });

  test("allows three calls per parent agent run, counting calls that fail after starting", () => {
    const gate = new ModelInvocationGate();
    gate.startRun();
    for (let index = 0; index < MAX_SUBAGENT_CALLS; index++) {
      assert.equal(gate.authorize(`call-${index}`), true);
      assert.equal(gate.start(`call-${index}`), true);
    }
    assert.equal(gate.authorize("after-limit"), false);
    gate.startRun();
    assert.equal(gate.authorize("same-unsettled-run"), false);
    const denied = invocationLimitBlock();
    assert.equal(denied.block, true);
    assert.equal((denied as { terminate?: boolean }).terminate, undefined);
    assert.match(denied.reason, /Do not retry/);
    assert.match(denied.reason, /continue with successful sibling results or investigate in the parent/);

    gate.endRun();
    gate.startRun();
    assert.equal(gate.authorize("next-run"), true);
  });

  test("releases calls blocked before execution without consuming the limit", () => {
    const gate = new ModelInvocationGate();
    gate.startRun();
    assert.equal(gate.releaseUnstarted("missing"), false);
    for (let index = 0; index < MAX_SUBAGENT_CALLS + 1; index++) {
      const id = `blocked-${index}`;
      assert.equal(gate.authorize(id), true);
      assert.equal(gate.releaseUnstarted(id), true);
      assert.equal(gate.releaseUnstarted(id), false);
    }
    for (let index = 0; index < MAX_SUBAGENT_CALLS; index++) {
      const id = `started-after-block-${index}`;
      assert.equal(gate.authorize(id), true);
      assert.equal(gate.start(id), true);
      assert.equal(gate.releaseUnstarted(id), false);
    }
    assert.equal(gate.authorize("over-limit"), false);
  });
});
