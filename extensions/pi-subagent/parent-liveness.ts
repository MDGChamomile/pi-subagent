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
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return;
    } catch {}
  }
  try { process.kill(pid, signal); } catch {}
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
