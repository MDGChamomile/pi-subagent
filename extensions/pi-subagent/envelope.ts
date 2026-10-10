import { MAX_FINAL_BYTES, sanitizeDisplayText, type PartialReason } from "./shared.ts";

/** Runtime-owned fields stay outside the JSON-escaped, untrusted child answer. */
export function formatChildOutput(answer: string, partialReason?: PartialReason): { text: string; truncated: boolean } {
  const clean = sanitizeDisplayText(answer);
  const serialize = (body: string, outputTruncated: boolean) => JSON.stringify({
    status: partialReason ? "partial" : "complete",
    partialReason: partialReason ?? null,
    outputTruncated,
    answer: body,
  });
  const full = serialize(clean, false);
  if (Buffer.byteLength(full, "utf8") <= MAX_FINAL_BYTES) return { text: full, truncated: false };

  // Cap the serialized envelope, not just its body: JSON escaping also costs bytes.
  const source = Buffer.from(clean, "utf8");
  const prefix = (bytes: number) => {
    let end = bytes;
    while (end > 0 && (source[end]! & 0xc0) === 0x80) end--;
    return source.subarray(0, end).toString("utf8");
  };
  let low = 0;
  let high = Math.min(source.length, MAX_FINAL_BYTES);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(serialize(prefix(mid), true), "utf8") <= MAX_FINAL_BYTES) low = mid;
    else high = mid - 1;
  }
  return { text: serialize(prefix(low), true), truncated: true };
}
