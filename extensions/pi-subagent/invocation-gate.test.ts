import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { invocationLimitBlock, MAX_SUBAGENT_CALLS, ModelInvocationGate } from "./invocation-gate.ts";

describe("pi-subagent model invocation gate", () => {
  test("claims preflight once and keeps its reservation until commit or cleanup", () => {
    const gate = new ModelInvocationGate();
    gate.startRun();
    assert.equal(gate.beginPreflight("missing"), false);
    assert.equal(gate.authorize("first"), true);
    assert.equal(gate.commit("first"), false);
    assert.equal(gate.rejectPreflight("first"), false);
    assert.equal(gate.beginPreflight("first"), true);
    assert.equal(gate.beginPreflight("first"), false);
    assert.equal(gate.authorize("first"), false);
    assert.equal(gate.authorize("second"), true);
    assert.equal(gate.authorize("third"), true);
    assert.equal(gate.authorize("overflow"), false);
    assert.equal(gate.commit("first"), true);
    assert.equal(gate.commit("first"), false);
    assert.equal(gate.beginPreflight("first"), false);
    assert.equal(gate.beginPreflight("second"), true);
    gate.endRun();
    assert.equal(gate.beginPreflight("third"), false);
    assert.equal(gate.commit("second"), false);
    gate.startRun();
    assert.equal(gate.beginPreflight("second"), false);
  });

  test("allows three started children plus one corrected preflight retry per parent agent run", () => {
    const gate = new ModelInvocationGate();
    assert.equal(gate.authorize("before-run"), false);
    gate.startRun();
    assert.equal(gate.authorize("call-1"), true);
    assert.equal(gate.authorize("call-2"), true);
    assert.equal(gate.authorize("call-3"), true);
    for (const id of ["call-1", "call-2", "call-3"]) assert.equal(gate.beginPreflight(id), true);
    assert.equal(gate.authorize("call-4"), false);
    assert.equal(gate.rejectPreflight("wrong-id"), false);
    assert.equal(gate.rejectPreflight("call-1"), true);
    assert.equal(gate.authorize("retry-1"), true);
    assert.equal(gate.beginPreflight("retry-1"), true);
    assert.equal(gate.authorize("parallel-retry"), false);
    assert.equal(gate.rejectPreflight("retry-1"), true);
    assert.equal(gate.authorize("third-attempt"), false);
    assert.equal(gate.commit("call-2"), true);
    assert.equal(gate.commit("call-3"), true);
    gate.startRun();
    assert.equal(gate.authorize("same-unsettled-run"), false);
    gate.endRun();
    assert.equal(gate.commit("call-2"), false);

    gate.startRun();
    for (let index = 0; index < MAX_SUBAGENT_CALLS; index++) {
      const id = `started-${index}`;
      assert.equal(gate.authorize(id), true);
      assert.equal(gate.beginPreflight(id), true);
      assert.equal(gate.commit(id), true);
    }
    assert.equal(gate.authorize("after-limit"), false);
    const denied = invocationLimitBlock();
    assert.equal(denied.block, true);
    assert.equal((denied as { terminate?: boolean }).terminate, undefined);
    assert.match(denied.reason, /Do not retry/);
    assert.match(denied.reason, /continue with successful sibling results or investigate in the parent/);
  });

  test("allows remaining started calls after a corrected preflight retry succeeds", () => {
    const gate = new ModelInvocationGate();
    gate.startRun();
    assert.equal(gate.authorize("invalid"), true);
    assert.equal(gate.beginPreflight("invalid"), true);
    assert.equal(gate.rejectPreflight("invalid"), true);
    assert.equal(gate.authorize("replacement"), true);
    assert.equal(gate.beginPreflight("replacement"), true);
    assert.equal(gate.commit("replacement"), true);
    assert.equal(gate.authorize("second"), true);
    assert.equal(gate.beginPreflight("second"), true);
    assert.equal(gate.commit("second"), true);
    assert.equal(gate.authorize("third"), true);
    assert.equal(gate.beginPreflight("third"), true);
    assert.equal(gate.commit("third"), true);
    assert.equal(gate.authorize("fourth"), false);

    gate.endRun();
    gate.startRun();
    assert.equal(gate.authorize("first-invalid"), true);
    assert.equal(gate.beginPreflight("first-invalid"), true);
    assert.equal(gate.rejectPreflight("first-invalid"), true);
    assert.equal(gate.authorize("first-replacement"), true);
    assert.equal(gate.beginPreflight("first-replacement"), true);
    assert.equal(gate.commit("first-replacement"), true);
    assert.equal(gate.authorize("second-invalid"), true);
    assert.equal(gate.beginPreflight("second-invalid"), true);
    assert.equal(gate.rejectPreflight("second-invalid"), true);
    assert.equal(gate.authorize("second-replacement"), false);
  });

  test("releases calls blocked before execution without consuming the started-call limit", () => {
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
      assert.equal(gate.beginPreflight(id), true);
      assert.equal(gate.commit(id), true);
      assert.equal(gate.releaseUnstarted(id), false);
    }
    assert.equal(gate.authorize("over-started-limit"), false);
  });

  test("keeps a corrected preflight retry available when its replacement is blocked before execution", () => {
    const gate = new ModelInvocationGate();
    gate.startRun();
    assert.equal(gate.authorize("invalid"), true);
    assert.equal(gate.beginPreflight("invalid"), true);
    assert.equal(gate.rejectPreflight("invalid"), true);
    assert.equal(gate.authorize("blocked-replacement"), true);
    assert.equal(gate.releaseUnstarted("blocked-replacement"), true);
    assert.equal(gate.authorize("next-replacement"), true);
    assert.equal(gate.beginPreflight("next-replacement"), true);
    assert.equal(gate.commit("next-replacement"), true);
  });

});
