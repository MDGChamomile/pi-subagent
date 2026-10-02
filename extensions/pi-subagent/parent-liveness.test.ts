import assert from "node:assert/strict";
import { test } from "node:test";
import { isProcessGroupGone } from "./parent-liveness.ts";

test("only ESRCH proves process-group disappearance", { skip: process.platform === "win32" }, (t) => {
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

test("native Windows retains the full escalation path without a POSIX probe", (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  const kill = t.mock.method(process, "kill", () => { throw new Error("must not probe a POSIX group on Windows"); });
  try {
    Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
    assert.equal(isProcessGroupGone(123), false);
    assert.equal(kill.mock.callCount(), 0);
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
});
