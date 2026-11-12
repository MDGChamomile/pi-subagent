import assert from "node:assert/strict";
import { test } from "node:test";
import { isProcessGroupGone, killProcessGroup } from "./parent-liveness.ts";

test("termination never falls back from a process group to a single PID", (t) => {
  let code: string | undefined;
  const signals: Array<[number, string | number | undefined]> = [];
  t.mock.method(process, "kill", (pid: number, signal?: string | number) => {
    signals.push([pid, signal]);
    if (code) throw Object.assign(new Error("synthetic signal failure"), { code });
    return true;
  });
  for (const failure of [undefined, "ESRCH", "EPERM", "EIO"]) {
    code = failure;
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      signals.length = 0;
      assert.doesNotThrow(() => killProcessGroup(123, signal));
      assert.deepEqual(signals, [[-123, signal]], `${failure ?? "existing group"}: ${signal}`);
    }
  }
});

test("termination without a PID sends no signal", (t) => {
  const kill = t.mock.method(process, "kill", () => { throw new Error("must not signal without a PID"); });
  killProcessGroup(undefined, "SIGTERM");
  assert.equal(kill.mock.callCount(), 0);
});

test("only ESRCH proves process-group disappearance", (t) => {
  let code: string | undefined;
  const probes: Array<[number, string | number | undefined]> = [];
  t.mock.method(process, "kill", (pid: number, signal?: string | number) => {
    probes.push([pid, signal]);
    if (code) throw Object.assign(new Error("synthetic probe failure"), { code });
    return true;
  });
  for (const [failure, gone] of [[undefined, false], ["ESRCH", true], ["EPERM", false], ["EIO", false]] as const) {
    code = failure;
    assert.equal(isProcessGroupGone(123), gone, `${failure ?? "existing group"} probe`);
  }
  assert.deepEqual(probes, Array.from({ length: 4 }, () => [-123, 0]));
});

test("a missing PID cannot prove group disappearance", (t) => {
  const kill = t.mock.method(process, "kill", () => { throw new Error("must not probe without a PID"); });
  assert.equal(isProcessGroupGone(undefined), false);
  assert.equal(kill.mock.callCount(), 0);
});
