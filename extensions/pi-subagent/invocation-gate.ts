export const MAX_SUBAGENT_CALLS = 3;

export function invocationLimitBlock(): { block: true; reason: string } {
  return {
    block: true,
    reason: `pi_subagent allows at most ${MAX_SUBAGENT_CALLS} started calls per parent agent run, plus one corrected retry after preflight validation failure. Do not retry; continue with successful sibling results or investigate in the parent`,
  };
}

export class ModelInvocationGate {
  private runOpen = false;
  private startedCalls = 0;
  private preflightFailures = 0;
  private preflightReplacementPending = false;
  private replacementToolCallId: string | undefined;
  private readonly authorizedToolCallIds = new Map<string, "authorized" | "preflight">();

  startRun(): void {
    if (this.runOpen) return;
    this.runOpen = true;
  }

  endRun(): void {
    this.runOpen = false;
    this.startedCalls = 0;
    this.preflightFailures = 0;
    this.preflightReplacementPending = false;
    this.replacementToolCallId = undefined;
    this.authorizedToolCallIds.clear();
  }

  authorize(toolCallId: string): boolean {
    if (
      !this.runOpen
      || this.preflightFailures > 1
      || (this.preflightReplacementPending && this.replacementToolCallId !== undefined)
      || this.authorizedToolCallIds.has(toolCallId)
      || this.startedCalls + this.authorizedToolCallIds.size >= MAX_SUBAGENT_CALLS
    ) return false;
    this.authorizedToolCallIds.set(toolCallId, "authorized");
    if (this.preflightReplacementPending) this.replacementToolCallId = toolCallId;
    return true;
  }

  // Claim execution once, while retaining the reservation until preflight settles.
  beginPreflight(toolCallId: string): boolean {
    if (this.authorizedToolCallIds.get(toolCallId) !== "authorized") return false;
    this.authorizedToolCallIds.set(toolCallId, "preflight");
    return true;
  }

  commit(toolCallId: string): boolean {
    if (this.authorizedToolCallIds.get(toolCallId) !== "preflight") return false;
    this.authorizedToolCallIds.delete(toolCallId);
    this.startedCalls += 1;
    if (this.replacementToolCallId === toolCallId) {
      this.preflightReplacementPending = false;
      this.replacementToolCallId = undefined;
    }
    return true;
  }

  rejectPreflight(toolCallId: string): boolean {
    if (this.authorizedToolCallIds.get(toolCallId) !== "preflight") return false;
    this.authorizedToolCallIds.delete(toolCallId);
    this.preflightFailures += 1;
    if (this.preflightFailures === 1) this.preflightReplacementPending = true;
    if (this.replacementToolCallId === toolCallId) this.replacementToolCallId = undefined;
    return true;
  }

  releaseUnstarted(toolCallId: string): boolean {
    if (!this.authorizedToolCallIds.delete(toolCallId)) return false;
    if (this.replacementToolCallId === toolCallId) this.replacementToolCallId = undefined;
    return true;
  }
}
