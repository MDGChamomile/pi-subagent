import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  buildChildPolicy,
  MAX_SCOPE_ROOTS,
  ModelInvocationGate,
  PROFILE_MODELS,
  resolveWebExtensionPath,
  TOOL_NAME,
  type Capability,
  type ChildPolicy,
  type Profile,
  type Thinking,
} from "./shared.ts";
import { runChild } from "./subprocess.ts";

const ProfileSchema = StringEnum(["lookup", "analysis", "review"] as const, {
  description: "lookup=luna, analysis=terra, review=sol",
});
const ThinkingSchema = StringEnum(["medium", "high", "xhigh", "max"] as const);
const CapabilitySchema = StringEnum(["local", "web", "both"] as const, {
  description: "local=files only, web=public web only, both=files and public web",
});
const Parameters = Type.Object({
  task: Type.String({ minLength: 1, maxLength: 12_000, description: "One focused local and/or web investigation and required deliverable" }),
  scope: Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), {
    minItems: 0,
    maxItems: MAX_SCOPE_ROOTS,
    description: "Existing local files/directories inside cwd; use [] for web-only research",
  }),
  capability: CapabilitySchema,
  profile: ProfileSchema,
  thinking: ThinkingSchema,
}, { additionalProperties: false });

export default function piSubagentExtension(pi: ExtensionAPI): void {
  const gate = new ModelInvocationGate();
  const authorizedCalls = new Set<string>();
  let ownSourcePath: string | undefined;

  const currentOwnSource = () => pi.getAllTools().find((tool) => tool.name === TOOL_NAME)?.sourceInfo?.path;
  const clearRun = () => {
    gate.endRun();
    authorizedCalls.clear();
  };

  pi.registerTool({
    name: TOOL_NAME,
    label: "Pi Subagent",
    executionMode: "sequential",
    description: "Delegate one focused, noisy local-file and/or public-web investigation to an isolated child Pi context and return only a bounded report. Use when intermediate discovery, reads, searches, or fetched pages would be large; use the parent directly for simple lookups, implementation, or tests.",
    parameters: Parameters,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const currentSource = currentOwnSource();
      if (!authorizedCalls.delete(toolCallId) || !ownSourcePath || currentSource !== ownSourcePath) {
        throw new Error("pi_subagent allows only one model-selected call per parent agent run");
      }
      const capability = params.capability as Capability;
      const profile = params.profile as Profile;
      const thinking = params.thinking as Thinking;
      const model = PROFILE_MODELS[profile];
      let webExtensionPath: string | undefined;
      let policy: ChildPolicy;
      try {
        if (params.task.includes("\0")) throw new Error("task must not contain NUL bytes");
        const [provider, modelId] = model.split("/", 2);
        if (!ctx.modelRegistry.find(provider!, modelId!)) throw new Error(`Configured subagent model is unavailable: ${model}`);
        if (capability !== "local") webExtensionPath = await resolveWebExtensionPath(pi.getAllTools());
        policy = await buildChildPolicy(ctx.cwd, params.scope, capability);
      } catch (error) {
        gate.rejectPreflight(toolCallId);
        throw error;
      }
      if (!gate.commit(toolCallId)) throw new Error("pi_subagent invocation permit is invalid or already consumed");

      const tempDir = await mkdtemp(join(tmpdir(), "pi-subagent-"));
      try {
        await chmod(tempDir, 0o700);
        const policyFile = join(tempDir, "policy.json");
        await writeFile(policyFile, JSON.stringify(policy), { encoding: "utf8", mode: 0o600, flag: "wx" });
        const result = await runChild({
          policy,
          policyFile,
          webExtensionPath,
          task: params.task,
          model,
          thinking,
          signal,
          onUpdate,
        });
        return {
          content: [{ type: "text", text: result.output }],
          details: {
            capability,
            profile,
            model,
            thinking,
            scopeRoots: policy.roots.length,
            webEnabled: capability !== "local",
            durationMs: result.durationMs,
            exitCode: result.exitCode,
            stopReason: result.stopReason,
            outputTruncated: result.outputTruncated,
            usage: result.usage,
          },
          usage: result.usage,
        };
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    },
  });

  pi.on("session_start", () => {
    ownSourcePath = currentOwnSource();
    clearRun();
  });
  pi.on("agent_start", () => {
    authorizedCalls.clear();
    gate.startRun();
  });
  pi.on("tool_call", (event) => {
    if (event.toolName !== TOOL_NAME) return;
    const currentSource = currentOwnSource();
    if (!ownSourcePath || currentSource !== ownSourcePath || !gate.authorize(event.toolCallId)) {
      return {
        block: true,
        reason: "pi_subagent allows one successful call per parent agent run, plus one retry after preflight validation failure",
        terminate: true,
      };
    }
    authorizedCalls.add(event.toolCallId);
  });
  pi.on("agent_settled", clearRun);
  pi.on("session_shutdown", clearRun);
}
