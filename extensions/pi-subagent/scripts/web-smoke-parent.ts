// Source-only smoke helper, loaded last in the parent; never load in the child.
// Keep web tools registered for provenance checks but unavailable for parent research.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TOOL_NAME } from "../shared.ts";

export default function webSmokeParent(pi: ExtensionAPI): void {
  pi.on("session_start", () => {
    pi.setActiveTools([TOOL_NAME]);
  });
  pi.on("tool_call", (event) => {
    if (event.toolName !== TOOL_NAME) {
      return { block: true, reason: "Web smoke requires all investigation to stay in the child" };
    }
  });
}
