export const MAX_SUBAGENT_CALLS = 3;

export function invocationLimitBlock(): { block: true; reason: string } {
  return {
    block: true,
    reason: `pi_subagent allows at most ${MAX_SUBAGENT_CALLS} calls per parent agent run, including calls that fail preflight validation. Do not retry; continue with successful sibling results or investigate in the parent`,
  };
}

export class ModelInvocationGate {
  private runOpen = false;
  private readonly calls = new Map<string, "authorized" | "started">();

  startRun(): void {
    this.runOpen = true;
  }

  endRun(): void {
    this.runOpen = false;
    this.calls.clear();
  }

  authorize(toolCallId: string): boolean {
    if (!this.runOpen || this.calls.has(toolCallId) || this.calls.size >= MAX_SUBAGENT_CALLS) return false;
    this.calls.set(toolCallId, "authorized");
    return true;
  }

  // Claim execution once; a call that then fails preflight still counts toward the limit.
  start(toolCallId: string): boolean {
    if (this.calls.get(toolCallId) !== "authorized") return false;
    this.calls.set(toolCallId, "started");
    return true;
  }

  releaseUnstarted(toolCallId: string): boolean {
    if (this.calls.get(toolCallId) !== "authorized") return false;
    return this.calls.delete(toolCallId);
  }
}
