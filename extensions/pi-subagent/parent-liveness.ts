import { rmdirSync, unlinkSync } from "node:fs";
import { Socket } from "node:net";
import { dirname } from "node:path";

export const PARENT_LIVENESS_ENV = "PI_SUBAGENT_PARENT_LIVENESS_FD";
export const PARENT_LIVENESS_FD = 3;

export function cleanupPrivateRuntimeFiles(
  policyPath: string | undefined,
  readyPath: string | undefined,
  budgetTelemetryPath?: string,
): void {
  for (const path of [budgetTelemetryPath, readyPath, policyPath]) {
    if (!path) continue;
    try { unlinkSync(path); } catch {}
  }
  if (policyPath) {
    try { rmdirSync(dirname(policyPath)); } catch {}
  }
}

export function killProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  // A failed POSIX group signal must not target a potentially reused single PID.
  try { process.kill(process.platform === "win32" ? pid : -pid, signal); } catch {}
}

/** Only ESRCH proves that the POSIX process group has disappeared. */
export function isProcessGroupGone(pid: number | undefined): boolean {
  // Missing PIDs and native Windows retain the full escalation grace period.
  if (!pid || process.platform === "win32") return false;
  try {
    process.kill(-pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
  return false;
}

function terminateOwnProcessGroup(): void {
  killProcessGroup(process.pid, "SIGKILL");
  process.exit(1);
}

/**
 * Keeps the child coupled to its parent without keeping the child event loop alive.
 * The parent owns the write end; abrupt parent death closes it and produces EOF here.
 */
export function installParentLivenessMonitor(beforeTerminate?: () => void): () => void {
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

  return () => {
    if (!armed) return;
    armed = false;
    pipe.destroy();
  };
}
