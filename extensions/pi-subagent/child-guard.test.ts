import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import childGuard from "./child-guard.ts";
import {
  ALLOWED_FILE_TOOLS,
  ALLOWED_WEB_TOOLS,
  buildChildPolicy,
  POLICY_ENV,
  READY_ENV,
  READY_MARKER,
  SOFT_DEADLINE_ENV,
  WEB_EXTENSION_ENV,
} from "./shared.ts";

type Handler = (...args: any[]) => any;

async function createHarness(
  scope: string[],
  capability: "local" | "web" = "local",
  softDeadline = Date.now() + 60_000,
) {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-guard-test-"));
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "allowed"), { recursive: true });
  await writeFile(join(workspace, "allowed", "inside.txt"), "inside\n");
  await writeFile(join(workspace, "outside.txt"), "outside\n");
  const policy = await buildChildPolicy(workspace, scope, capability);
  const policyFile = join(root, "policy.json");
  await writeFile(policyFile, JSON.stringify(policy), { mode: 0o600 });
  const webExtension = join(root, "web-extension.ts");
  const readyFile = join(root, "guard.ready");
  await writeFile(webExtension, "export default () => {};\n", { mode: 0o600 });

  const previousPolicy = process.env[POLICY_ENV];
  const previousReady = process.env[READY_ENV];
  const previousWeb = process.env[WEB_EXTENSION_ENV];
  const previousDeadline = process.env[SOFT_DEADLINE_ENV];
  process.env[POLICY_ENV] = policyFile;
  process.env[READY_ENV] = readyFile;
  process.env[WEB_EXTENSION_ENV] = webExtension;
  process.env[SOFT_DEADLINE_ENV] = String(softDeadline);

  const handlers = new Map<string, Handler[]>();
  const sentUserMessages: Array<{ content: string; options: unknown }> = [];
  let activeTools: string[] = [];
  const tools = [
    ...ALLOWED_FILE_TOOLS.map((name) => ({ name, sourceInfo: { source: "builtin", path: `<builtin:${name}>` } })),
    ...ALLOWED_WEB_TOOLS.map((name) => ({ name, sourceInfo: { source: "local", path: webExtension } })),
  ];
  const pi = {
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    getAllTools() {
      return tools;
    },
    setActiveTools(names: string[]) {
      activeTools = names;
    },
    sendUserMessage(content: string, options: unknown) {
      sentUserMessages.push({ content, options });
    },
  };
  childGuard(pi as any, () => () => undefined);

  const emit = async (name: string, event: any = {}, ctx: any = {}) => {
    let result: any;
    for (const handler of handlers.get(name) ?? []) {
      const value = await handler(event, ctx);
      if (value !== undefined) result = value;
    }
    return result;
  };

  return {
    root,
    workspace,
    readyFile,
    tools,
    emit,
    getActiveTools: () => activeTools,
    getSentUserMessages: () => sentUserMessages,
    async cleanup() {
      await emit("session_shutdown");
      if (previousPolicy === undefined) delete process.env[POLICY_ENV];
      else process.env[POLICY_ENV] = previousPolicy;
      if (previousReady === undefined) delete process.env[READY_ENV];
      else process.env[READY_ENV] = previousReady;
      if (previousWeb === undefined) delete process.env[WEB_EXTENSION_ENV];
      else process.env[WEB_EXTENSION_ENV] = previousWeb;
      if (previousDeadline === undefined) delete process.env[SOFT_DEADLINE_ENV];
      else process.env[SOFT_DEADLINE_ENV] = previousDeadline;
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe("pi-subagent child guard", () => {
  test("activates only the owned web tool allowlist", async () => {
    const harness = await createHarness([], "web");
    try {
      await harness.emit("session_start");
      assert.deepEqual(harness.getActiveTools(), [...ALLOWED_WEB_TOOLS]);
      assert.equal(await readFile(harness.readyFile, "utf8"), READY_MARKER);
      const webTool = harness.tools.find((tool) => tool.name === "web_search")!;
      webTool.sourceInfo.path = join(harness.root, "other-extension.ts");
      await writeFile(webTool.sourceInfo.path, "export default () => {};\n");
      const changedOwner = await harness.emit("tool_call", {
        toolName: "web_search",
        toolCallId: "changed",
        input: { query: "test" },
      });
      assert.equal(changedOwner.block, true);
      assert.equal(changedOwner.terminate, true);
      assert.match(changedOwner.reason, /ownership changed/);
    } finally {
      await harness.cleanup();
    }
  });

  test("does not publish readiness when tool ownership validation fails", async () => {
    const harness = await createHarness([], "web");
    try {
      const webTool = harness.tools.find((tool) => tool.name === "web_search")!;
      webTool.sourceInfo.path = join(harness.root, "other-extension.ts");
      await writeFile(webTool.sourceInfo.path, "export default () => {};\n");
      await harness.emit("session_start");
      assert.deepEqual(harness.getActiveTools(), []);
      await assert.rejects(() => readFile(harness.readyFile, "utf8"), /ENOENT/);
    } finally {
      await harness.cleanup();
    }
  });

  test("allows scoped reads and keeps ordinary denials recoverable", async () => {
    const harness = await createHarness(["allowed"], "local");
    try {
      await harness.emit("session_start");
      assert.deepEqual(harness.getActiveTools(), [...ALLOWED_FILE_TOOLS]);
      assert.equal(await harness.emit("tool_call", {
        toolName: "read",
        toolCallId: "inside",
        input: { path: "allowed/inside.txt" },
      }), undefined);
      for (const toolName of ["grep", "find", "ls"]) {
        const directoryInput: Record<string, unknown> = { path: "allowed" };
        assert.equal(await harness.emit("tool_call", {
          toolName,
          toolCallId: `canonical-${toolName}`,
          input: directoryInput,
        }), undefined);
        assert.equal(directoryInput.path, join(harness.workspace, "allowed"));
      }
      const outside = await harness.emit("tool_call", {
        toolName: "read",
        toolCallId: "outside",
        input: { path: "outside.txt" },
      });
      assert.equal(outside.block, true);
      assert.match(outside.reason, /outside its explicit scope/);
      const bash = await harness.emit("tool_call", {
        toolName: "bash",
        toolCallId: "bash",
        input: { command: "pwd" },
      });
      assert.equal(bash.block, true);
      assert.equal(bash.terminate, undefined);
      assert.equal(await harness.emit("tool_call", {
        toolName: "read",
        toolCallId: "inside-after-denials",
        input: { path: "allowed/inside.txt" },
      }), undefined);
    } finally {
      await harness.cleanup();
    }
  });

  test("executes file tools with the authorized canonical path", async () => {
    const harness = await createHarness(["allowed"], "local");
    const link = join(harness.workspace, "allowed", "link.txt");
    try {
      await symlink(join(harness.workspace, "allowed", "inside.txt"), link);
      await harness.emit("session_start");
      const input: Record<string, unknown> = { path: "allowed/link.txt" };
      assert.equal(await harness.emit("tool_call", {
        toolName: "read",
        toolCallId: "canonical-read",
        input,
      }), undefined);
      assert.equal(input.path, join(harness.workspace, "allowed", "inside.txt"));

      await rm(link, { force: true });
      await symlink(join(harness.workspace, "outside.txt"), link);
      assert.equal(await readFile(input.path as string, "utf8"), "inside\n");
    } finally {
      await harness.cleanup();
    }
  });

  test("requests final assistant text once after a tool-only ending", async () => {
    const harness = await createHarness(["allowed"], "local");
    const toolOnlyTurn = {
      message: {
        role: "assistant",
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "last-tool", name: "read", arguments: { path: "allowed/inside.txt" } }],
      },
    };
    try {
      await harness.emit("session_start");
      await harness.emit("agent_start");
      await harness.emit("turn_end", toolOnlyTurn);
      await harness.emit("agent_end", { messages: [] });
      assert.equal(harness.getSentUserMessages().length, 1);
      assert.match(harness.getSentUserMessages()[0]!.content, /ended without a final answer/);
      assert.match(harness.getSentUserMessages()[0]!.content, /ordinary assistant text/);
      assert.deepEqual(harness.getSentUserMessages()[0]!.options, { deliverAs: "followUp" });
      assert.deepEqual(harness.getActiveTools(), []);

      await harness.emit("agent_start");
      await harness.emit("turn_end", toolOnlyTurn);
      await harness.emit("agent_end", { messages: [] });
      assert.equal(harness.getSentUserMessages().length, 1);

      const blockedRead = await harness.emit("tool_call", {
        toolName: "read",
        toolCallId: "post-finalization-read",
        input: { path: "allowed/inside.txt" },
      });
      assert.equal(blockedRead.block, true);
      assert.match(blockedRead.reason, /Finalization has started/);
    } finally {
      await harness.cleanup();
    }
  });

  test("accepts an ordinary final answer without requesting another turn", async () => {
    const harness = await createHarness(["allowed"], "local");
    try {
      await harness.emit("session_start");
      await harness.emit("agent_start");
      await harness.emit("turn_end", {
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "Concise conclusion with evidence." }],
        },
      });
      await harness.emit("agent_end", { messages: [] });
      assert.equal(harness.getSentUserMessages().length, 0);
      assert.deepEqual(harness.getActiveTools(), [...ALLOWED_FILE_TOOLS]);
    } finally {
      await harness.cleanup();
    }
  });

  test("steers one text finalization and blocks new tools after the soft deadline", async () => {
    const harness = await createHarness(["allowed"], "local", Date.now() - 1);
    try {
      await harness.emit("session_start");
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(harness.getSentUserMessages().length, 1);
      assert.match(harness.getSentUserMessages()[0]!.content, /time limit has been reached/);
      assert.match(harness.getSentUserMessages()[0]!.content, /coverage gaps/);
      assert.deepEqual(harness.getSentUserMessages()[0]!.options, { deliverAs: "steer" });
      assert.deepEqual(harness.getActiveTools(), []);

      const blockedRead = await harness.emit("tool_call", {
        toolName: "read",
        toolCallId: "late-read",
        input: { path: "allowed/inside.txt" },
      });
      assert.equal(blockedRead.block, true);
      assert.match(blockedRead.reason, /Finalization has started/);
      await harness.emit("agent_end", { messages: [] });
      assert.equal(harness.getSentUserMessages().length, 1);
    } finally {
      await harness.cleanup();
    }
  });

  test("enforces bounded web calls while allowing correction after every denied input", async () => {
    const deniedCalls = [
      ["web_search", { query: "test", includeContent: true }],
      ["web_search", { queries: ["1", "2", "3", "4", "5"] }],
      ["web_search", { query: "test", numResults: 11 }],
      ["web_search", { query: "test", proxy: "http://127.0.0.1:8888" }],
      ["web_search", { query: "test", provider: "all" }],
      ["source_check", { claim: "test", numResults: 11 }],
      ["source_check", { claim: "test", proxy: "http://127.0.0.1:8888" }],
      ["fetch_content", { url: "https://example.com", forceClone: true }],
      ["fetch_content", { url: "https://example.com", mode: "raw" }],
      ["fetch_content", { url: "./secret.txt" }],
      ["fetch_content", { url: "file:///etc/passwd" }],
      ["fetch_content", { url: "https://user:pass@example.com" }],
      ["fetch_content", { url: "https://example.com", auth: true }],
      ["fetch_content", { urls: Array.from({ length: 6 }, (_, index) => `https://example.com/${index}`) }],
      ["get_search_content", { responseId: "response-1", unknownFutureOption: true }],
    ] as const;

    const harness = await createHarness([], "web");
    try {
      await harness.emit("session_start");
      const searchInput: Record<string, unknown> = { query: "Pi documentation", workflow: "summary-review" };
      assert.equal(await harness.emit("tool_call", {
        toolName: "web_search",
        toolCallId: "search",
        input: searchInput,
      }), undefined);
      assert.equal(searchInput.workflow, "none");
      assert.equal(await harness.emit("tool_call", {
        toolName: "source_check",
        toolCallId: "source-check",
        input: { claim: "Pi has a public manual", fetchContent: true },
      }), undefined);
      assert.equal(await harness.emit("tool_call", {
        toolName: "fetch_content",
        toolCallId: "https",
        input: { urls: ["https://example.com/page", "https://example.org/page"], mode: "readable" },
      }), undefined);
      assert.equal(await harness.emit("tool_call", {
        toolName: "get_search_content",
        toolCallId: "stored-content",
        input: { responseId: "response-1", findText: "manual" },
      }), undefined);

      for (const [toolName, input] of deniedCalls) {
        const result = await harness.emit("tool_call", {
          toolName,
          toolCallId: `denied-${toolName}`,
          input,
        });
        assert.equal(result.block, true, `${toolName}: ${JSON.stringify(input)}`);
        assert.equal(result.terminate, undefined);
        assert.match(result.reason, /Retry with allowed bounded inputs/);
        assert.equal(await harness.emit("tool_call", {
          toolName: "web_search",
          toolCallId: `retry-after-${toolName}`,
          input: { query: "still open" },
        }), undefined);
      }
    } finally {
      await harness.cleanup();
    }
  });
});
