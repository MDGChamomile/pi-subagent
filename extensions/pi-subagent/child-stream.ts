import { StringDecoder } from "node:string_decoder";
import type { Usage } from "@earendil-works/pi-ai";
import {
  MAX_JSON_LINE_BYTES,
  MAX_OBSERVATION_COUNT,
  OBSERVED_CHILD_EVENTS,
  type ChildFailureObservations,
  type ObservedChildEvent,
} from "./shared.ts";

export function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function addUsage(total: Usage, value: unknown): void {
  if (!value || typeof value !== "object") return;
  const usage = value as Record<string, unknown>;
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
    const amount = usage[key];
    total[key] += typeof amount === "number" && Number.isFinite(amount) ? amount : 0;
  }
  for (const key of ["cacheWrite1h", "reasoning"] as const) {
    const amount = usage[key];
    if (typeof amount === "number" && Number.isFinite(amount)) total[key] = (total[key] ?? 0) + amount;
  }
  const cost = usage.cost;
  if (cost && typeof cost === "object") {
    const values = cost as Record<string, unknown>;
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
      const amount = values[key];
      total.cost[key] += typeof amount === "number" && Number.isFinite(amount) ? amount : 0;
    }
  }
}

function assistantText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const value = message as { role?: unknown; content?: unknown };
  if (value.role !== "assistant" || !Array.isArray(value.content)) return "";
  return value.content
    .filter((part): part is { type: "text"; text: string } => {
      if (!part || typeof part !== "object") return false;
      const item = part as { type?: unknown; text?: unknown };
      return item.type === "text" && typeof item.text === "string";
    })
    .map((part) => part.text)
    .join("\n");
}

type AssistantMode = "none" | "empty" | "text" | "tool" | "mixed";

function assistantMode(message: { content?: unknown }): AssistantMode {
  if (!Array.isArray(message.content)) return "empty";
  const hasText = message.content.some((part) => {
    if (!part || typeof part !== "object") return false;
    const item = part as { type?: unknown; text?: unknown };
    return item.type === "text" && typeof item.text === "string" && item.text.trim().length > 0;
  });
  const hasTool = message.content.some((part) =>
    Boolean(part && typeof part === "object" && (part as { type?: unknown }).type === "toolCall")
  );
  if (hasText && hasTool) return "mixed";
  if (hasTool) return "tool";
  if (hasText) return "text";
  return "empty";
}

export type ChildJsonSnapshot = {
  finalOutput: string;
  finalOutputReceivedAt?: number;
  toolErrorCount: number;
  lastToolError?: string;
  assistantMessageCount: number;
  lastAssistantMode: AssistantMode;
  stopReason?: string;
  errorMessage?: string;
  protocolError?: string;
  observations: ChildFailureObservations;
  usage: Usage;
};

const MAX_OBSERVED_RECORD_BYTES = 4096;

/**
 * Consumes Pi's LF-delimited JSON stream while retaining only the last eligible
 * assistant answer. Intermediate assistant turns and ordinary child tool output are
 * discarded; large aggregate records are dropped from their bounded type prefix.
 */
export class ChildJsonCollector {
  private readonly decoder = new StringDecoder("utf8");
  private lineBuffer = "";
  private lineBytes = 0;
  private disposition: "unknown" | "capture" | "observe" | "discard" = "unknown";
  private readonly eventCounts = Object.fromEntries(OBSERVED_CHILD_EVENTS.map((key) => [key, 0])) as Record<ObservedChildEvent, number>;
  private readonly eventReceipts = Object.fromEntries(OBSERVED_CHILD_EVENTS.map((key) => [key, 0])) as Record<ObservedChildEvent, number>;
  private pendingObservedType: ObservedChildEvent | undefined;
  private lastEvent: ObservedChildEvent | undefined;
  private lastEventAt: number | undefined;
  private lastEventValidated = false;
  private observationsIncomplete = false;
  private finalOutput = "";
  private finalOutputReceivedAt: number | undefined;
  private toolErrorCount = 0;
  private lastToolError: string | undefined;
  private assistantMessageCount = 0;
  private lastAssistantMode: AssistantMode = "none";
  private stopReason: string | undefined;
  private errorMessage: string | undefined;
  private protocolError: string | undefined;
  private readonly usage = emptyUsage();
  private readonly onAssistantMessage: ((usage: Usage) => void) | undefined;
  private readonly onProtocolError: ((message: string) => void) | undefined;

  constructor(
    onAssistantMessage?: (usage: Usage) => void,
    onProtocolError?: (message: string) => void,
  ) {
    this.onAssistantMessage = onAssistantMessage;
    this.onProtocolError = onProtocolError;
  }

  push(chunk: Buffer | string): void {
    if (this.protocolError) return;
    const text = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    this.consumeText(text);
  }

  finish(): void {
    if (this.protocolError) return;
    this.consumeText(this.decoder.end());
    if (this.disposition === "discard") {
      this.resetLine();
      return;
    }
    if (this.lineBuffer.trim()) this.processLine(this.lineBuffer);
    this.resetLine();
  }

  snapshot(): ChildJsonSnapshot {
    return {
      finalOutput: this.finalOutput,
      finalOutputReceivedAt: this.finalOutputReceivedAt,
      toolErrorCount: this.toolErrorCount,
      lastToolError: this.lastToolError,
      assistantMessageCount: this.assistantMessageCount,
      lastAssistantMode: this.lastAssistantMode,
      stopReason: this.stopReason,
      errorMessage: this.errorMessage,
      protocolError: this.protocolError,
      observations: {
        counts: { ...this.eventCounts },
        receipts: { ...this.eventReceipts },
        lastEvent: this.lastEvent,
        lastEventAgeMs: this.lastEventAt === undefined ? undefined : Math.max(0, performance.now() - this.lastEventAt),
        lastEventValidated: this.lastEventValidated,
        toolBalance: this.observationsIncomplete || this.protocolError ? null
          : Math.max(0, this.eventCounts.tool_execution_start - this.eventCounts.tool_execution_end),
        incomplete: this.observationsIncomplete || this.protocolError !== undefined,
      },
      usage: this.usage,
    };
  }

  private consumeText(text: string): void {
    let start = 0;
    while (start < text.length) {
      const newline = text.indexOf("\n", start);
      const ended = newline >= 0;
      const fragment = text.slice(start, ended ? newline : text.length);
      this.consumeFragment(fragment, ended);
      if (this.protocolError || !ended) return;
      start = newline + 1;
    }
  }

  private consumeFragment(fragment: string, ended: boolean): void {
    if (this.disposition !== "discard" && fragment) {
      if (this.disposition === "unknown") {
        const probeLength = Math.min(fragment.length, 512);
        this.append(fragment.slice(0, probeLength));
        const classified = this.classifyLine();
        if (classified !== "discard") this.append(fragment.slice(probeLength));
      } else {
        this.append(fragment);
      }
      const classified = this.disposition === "unknown" ? this.classifyLine() : this.disposition;
      if (classified !== "discard" && this.lineBytes > MAX_JSON_LINE_BYTES) {
        this.fail(`Subagent JSON message_end record exceeded ${MAX_JSON_LINE_BYTES} bytes`);
        return;
      }
    }

    if (!ended) return;
    if (this.disposition !== "discard" && this.lineBuffer.trim()) this.processLine(this.lineBuffer);
    this.resetLine();
  }

  private append(value: string): void {
    if (!value) return;
    // Observations never need a full streaming message or tool payload. Drop
    // selected records above 4 KiB rather than growing the capture buffer.
    const bytes = Buffer.byteLength(value);
    if (this.disposition === "observe" && this.lineBytes + bytes > MAX_OBSERVED_RECORD_BYTES) {
      this.observationsIncomplete = true;
      this.disposition = "discard";
      this.lineBuffer = "";
      this.lineBytes = 0;
      return;
    }
    this.lineBuffer += value;
    this.lineBytes += bytes;
  }

  private classifyLine(): "unknown" | "capture" | "observe" | "discard" {
    if (this.disposition !== "unknown") return this.disposition;
    const match = /^\s*\{\s*"type"\s*:\s*"([^"\\]+)"/.exec(this.lineBuffer);
    if (!match) return this.disposition;
    if (match[1] === "message_end") {
      this.disposition = "capture";
    } else if (OBSERVED_CHILD_EVENTS.includes(match[1] as ObservedChildEvent)) {
      this.disposition = "observe";
      this.pendingObservedType = match[1] as ObservedChildEvent;
      this.observeReceipt(this.pendingObservedType);
      if (this.lineBytes > MAX_OBSERVED_RECORD_BYTES) {
        this.observationsIncomplete = true;
        this.disposition = "discard";
        this.lineBuffer = "";
        this.lineBytes = 0;
      }
    } else {
      this.disposition = "discard";
      this.lineBuffer = "";
      this.lineBytes = 0;
    }
    return this.disposition;
  }

  private processLine(line: string): void {
    if (this.protocolError || !line.trim()) return;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      if (this.disposition === "observe") this.observationsIncomplete = true;
      else this.fail("Subagent emitted malformed JSON");
      return;
    }
    if (!event || typeof event !== "object") return;
    const record = event as { type?: unknown; message?: unknown };
    if (this.pendingObservedType && record.type !== this.pendingObservedType) {
      this.observationsIncomplete = true;
      return;
    }
    if (OBSERVED_CHILD_EVENTS.includes(record.type as ObservedChildEvent)) {
      if (!this.pendingObservedType) this.observeReceipt(record.type as ObservedChildEvent);
      if (Buffer.byteLength(line) <= MAX_OBSERVED_RECORD_BYTES) this.observe(event as Record<string, unknown>);
      else this.observationsIncomplete = true;
      return;
    }
    if (record.type !== "message_end" || !record.message || typeof record.message !== "object") return;
    const message = record.message as {
      role?: unknown;
      toolName?: unknown;
      content?: unknown;
      isError?: unknown;
      usage?: unknown;
      stopReason?: unknown;
      errorMessage?: unknown;
    };
    if (message.role === "toolResult") {
      addUsage(this.usage, message.usage);
      if (message.isError === true) {
        this.toolErrorCount += 1;
        if (typeof message.toolName === "string") this.lastToolError = message.toolName;
      }
      return;
    }
    if (message.role !== "assistant") return;
    this.assistantMessageCount += 1;
    this.lastAssistantMode = assistantMode(message);
    addUsage(this.usage, message.usage);
    if (typeof message.stopReason === "string") this.stopReason = message.stopReason;
    this.errorMessage = typeof message.errorMessage === "string" ? message.errorMessage : undefined;
    // Keep length-limited text as evidence; runChild marks an unrecovered length stop as partial.
    const eligible = this.lastAssistantMode === "text"
      && message.stopReason !== "toolUse"
      && message.stopReason !== "error"
      && message.stopReason !== "aborted";
    this.finalOutput = eligible ? assistantText(message) : "";
    // Use the parent's receipt clock, never an untrusted child timestamp or exit time.
    this.finalOutputReceivedAt = eligible ? Date.now() : undefined;
    this.onAssistantMessage?.(this.usage);
  }

  private observeReceipt(type: ObservedChildEvent): void {
    // A recognized prefix is evidence of bytes arriving, not of valid JSON or
    // actual execution. Keep these counts separate from validated events.
    if (this.eventReceipts[type] === MAX_OBSERVATION_COUNT) this.observationsIncomplete = true;
    else this.eventReceipts[type]++;
    this.lastEvent = type;
    this.lastEventAt = performance.now();
    this.lastEventValidated = false;
  }

  private observe(event: Record<string, unknown>): void {
    const type = event.type as ObservedChildEvent;
    const object = (value: unknown): value is Record<string, unknown> =>
      value !== null && typeof value === "object" && !Array.isArray(value);
    const positiveInteger = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0;
    const valid = type === "turn_start"
      || (type === "tool_execution_start" && typeof event.toolCallId === "string" && typeof event.toolName === "string" && object(event.args))
      || (type === "tool_execution_end" && typeof event.toolCallId === "string" && typeof event.toolName === "string" && object(event.result) && typeof event.isError === "boolean")
      // Pi's JSON mode emits delta-only updates without the SDK's cumulative message.
      || (type === "message_update" && object(event.assistantMessageEvent) && typeof event.assistantMessageEvent.type === "string"
        && ["start", "text_start", "text_delta", "text_end", "thinking_start", "thinking_delta", "thinking_end", "toolcall_start", "toolcall_delta", "toolcall_end"].includes(event.assistantMessageEvent.type))
      || (type === "auto_retry_start" && positiveInteger(event.attempt) && positiveInteger(event.maxAttempts) && typeof event.delayMs === "number" && Number.isFinite(event.delayMs) && event.delayMs >= 0)
      || (type === "auto_retry_end" && positiveInteger(event.attempt) && typeof event.success === "boolean");
    if (!valid) {
      this.observationsIncomplete = true;
      return;
    }
    if (this.eventCounts[type] === MAX_OBSERVATION_COUNT) this.observationsIncomplete = true;
    else this.eventCounts[type]++;
    if (this.eventCounts.tool_execution_end > this.eventCounts.tool_execution_start) this.observationsIncomplete = true;
    this.lastEvent = type;
    this.lastEventAt = performance.now();
    this.lastEventValidated = true;
  }

  private fail(message: string): void {
    if (this.protocolError) return;
    this.protocolError = message;
    this.onProtocolError?.(message);
  }

  private resetLine(): void {
    this.lineBuffer = "";
    this.lineBytes = 0;
    this.disposition = "unknown";
    this.pendingObservedType = undefined;
  }
}
