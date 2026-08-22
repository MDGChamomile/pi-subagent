import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import childGuard from "./child-guard.ts";
import {
  ALLOWED_FILE_TOOLS,
  ALLOWED_WEB_TOOLS,
  buildChildPolicy,
  POLICY_ENV,
  WEB_EXTENSION_ENV,
} from "./shared.ts";

type Handler = (...args: any[]) => any;

async function createHarness(scope: string[]) {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-guard-test-"));
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "allowed"), { recursive: true });
  await writeFile(join(workspace, "allowed", "inside.txt"), "inside\n");
  await writeFile(join(workspace, "outside.txt"), "outside\n");
  const policy = await buildChildPolicy(workspace, scope);
  const policyFile = join(root, "policy.json");
  await writeFile(policyFile, JSON.stringify(policy), { mode: 0o600 });
  const webExtension = join(root, "web-extension.ts");
  await writeFile(webExtension, "export default () => {};\n", { mode: 0o600 });

  const previousPolicy = process.env[POLICY_ENV];
  const previousWeb = process.env[WEB_EXTENSION_ENV];
  process.env[POLICY_ENV] = policyFile;
  process.env[WEB_EXTENSION_ENV] = webExtension;

  const handlers = new Map<string, Handler[]>();
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
  };
  childGuard(pi as any);

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
    tools,
    emit,
    getActiveTools: () => activeTools,
    async cleanup() {
      if (previousPolicy === undefined) delete process.env[POLICY_ENV];
      else process.env[POLICY_ENV] = previousPolicy;
      if (previousWeb === undefined) delete process.env[WEB_EXTENSION_ENV];
      else process.env[WEB_EXTENSION_ENV] = previousWeb;
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe("pi-subagent child guard", () => {
  test("activates only the owned local and web tool allowlist", async () => {
    const harness = await createHarness(["allowed"]);
    try {
      await harness.emit("session_start");
      assert.deepEqual(harness.getActiveTools(), [...ALLOWED_FILE_TOOLS, ...ALLOWED_WEB_TOOLS]);
      const webTool = harness.tools.find((tool) => tool.name === "web_search")!;
      webTool.sourceInfo.path = join(harness.root, "other-extension.ts");
      await writeFile(webTool.sourceInfo.path, "export default () => {};\n");
      const changedOwner = await harness.emit("tool_call", {
        toolName: "web_search",
        toolCallId: "changed",
        input: { query: "test" },
      });
      assert.equal(changedOwner.block, true);
      assert.match(changedOwner.reason, /ownership changed/);
    } finally {
      await harness.cleanup();
    }
  });

  test("allows scoped reads and blocks local path escapes", async () => {
    const harness = await createHarness(["allowed"]);
    try {
      await harness.emit("session_start");
      assert.equal(await harness.emit("tool_call", {
        toolName: "read",
        toolCallId: "inside",
        input: { path: "allowed/inside.txt" },
      }), undefined);
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
    } finally {
      await harness.cleanup();
    }
  });

  test("enforces public-web-only calls and non-interactive search", async () => {
    const harness = await createHarness([]);
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
        toolName: "fetch_content",
        toolCallId: "https",
        input: { url: "https://example.com/page" },
      }), undefined);

      for (const input of [
        { url: "./secret.txt" },
        { url: "file:///etc/passwd" },
        { url: "https://user:pass@example.com" },
        { url: "https://example.com", auth: true },
        { url: "https://github.com/example/huge", forceClone: true },
      ]) {
        const result = await harness.emit("tool_call", {
          toolName: "fetch_content",
          toolCallId: "blocked-fetch",
          input,
        });
        assert.equal(result.block, true, JSON.stringify(input));
      }

      const readWithoutScope = await harness.emit("tool_call", {
        toolName: "read",
        toolCallId: "no-scope",
        input: { path: "." },
      });
      assert.equal(readWithoutScope.block, true);
    } finally {
      await harness.cleanup();
    }
  });
});
