import { rmdirSync, unlinkSync } from "node:fs";
import { Socket } from "node:net";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { RuntimeFiles } from "./shared.ts";

export const PARENT_LIVENESS_ENV = "PI_SUBAGENT_PARENT_LIVENESS_FD";
export const PARENT_LIVENESS_FD = 3;

export function cleanupPrivateRuntimeFiles(files: RuntimeFiles): void {
  for (const path of [files.budgetTelemetry, files.ready, files.policy]) {
    try { unlinkSync(path); } catch {}
  }
  try { rmdirSync(dirname(files.policy)); } catch {}
}

export function killProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  // A failed group signal must not target a potentially reused single PID.
  try { process.kill(-pid, signal); } catch {}
}

/** Only ESRCH proves that the POSIX process group has disappeared. */
export function isProcessGroupGone(pid: number | undefined): boolean {
  // A missing PID retains the full escalation grace period.
  if (!pid) return false;
  try {
    process.kill(-pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
  return false;
}

/** Sends SIGTERM to the group, then SIGKILL after `graceMs` unless the group is confirmed gone. */
export async function terminateProcessGroup(pid: number | undefined, graceMs: number): Promise<void> {
  killProcessGroup(pid, "SIGTERM");
  // The leader may close while descendants survive. Only confirmed group
  // disappearance can end cleanup early; uncertain probes retain escalation.
  const deadline = performance.now() + graceMs;
  while (!isProcessGroupGone(pid)) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      killProcessGroup(pid, "SIGKILL");
      return;
    }
    // Keep this timer referenced until the entire group is gone or killed.
    await delay(Math.min(100, remaining));
  }
}

function terminateOwnProcessGroup(): void {
  killProcessGroup(process.pid, "SIGKILL");
  process.exit(1);
}

/**
 * Keeps the child coupled to its parent without keeping the child event loop alive.
 * The parent owns the write end; abrupt parent death closes it and produces EOF here.
 */
export function installParentLivenessMonitor(beforeTerminate?: () => void): void {
  if (process.env[PARENT_LIVENESS_ENV] !== String(PARENT_LIVENESS_FD)) {
    throw new Error("parent liveness pipe is unavailable");
  }

  const pipe = new Socket({ fd: PARENT_LIVENESS_FD, readable: true, writable: false });
  let armed = true;
  const terminate = () => {
    if (!armed) return;
    armed = false;
    try {
      beforeTerminate?.();
    } finally {
      terminateOwnProcessGroup();
    }
  };

  pipe.once("end", terminate);
  pipe.once("error", terminate);
  pipe.resume();
  pipe.unref();
}
