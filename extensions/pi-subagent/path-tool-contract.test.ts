import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { createFindTool, createGrepTool, createLsTool, createReadTool } from "@earendil-works/pi-coding-agent";
import { authorizeReadPath, buildChildPolicy } from "./path-policy.ts";
import type { ChildPolicy } from "./shared.ts";
import { setEnv } from "./test-support.ts";

// Exercise Pi's actual tool path resolution, not a probe that merely echoes the
// guard's argument. Only find's directory enumeration is substituted to avoid
// downloading fd; its SDK path resolution still runs unchanged.
test("canonical authorization preserves identity at the native Pi tool boundary", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-subagent-tool-path-")));
  const restoreEnv = setEnv({ PI_OFFLINE: "1", RIPGREP_CONFIG_PATH: undefined });
  try {
    const stable = join(root, "allowed dir");
    const ambiguous = join(root, "allowed\u00a0dir");
    await mkdir(stable);
    await mkdir(ambiguous);
    await writeFile(join(stable, "evidence.txt"), "SYNTHETIC_MARKER_ORDINARY\n");
    await writeFile(join(ambiguous, "evidence.txt"), "SYNTHETIC_MARKER_UNICODE\n");
    await symlink(ambiguous, join(root, "alias"), "dir");
    const tools = [createReadTool(root), createGrepTool(root), createLsTool(root), createFindTool(root, {
      operations: {
        exists: async (path) => (await stat(path)).isDirectory(),
        glob: async (_pattern, cwd) => (await readdir(cwd)).map((name) => join(cwd, name)),
      },
    })];
    // buildChildPolicy rejects an ambiguous scope during preflight; a policy that
    // bypasses it must still fail at each call boundary.
    const legacyPolicy: ChildPolicy = {
      version: 1, cwd: root, capability: "local", roots: [{ path: ambiguous, kind: "directory" }],
    };
    const stablePolicy = await buildChildPolicy(root, [pathToFileURL(stable).href]);
    for (const tool of tools) {
      const suffix = tool.name === "read" ? "evidence.txt" : "";
      const pattern = tool.name === "find" ? "*.txt" : "SYNTHETIC_MARKER";
      for (const raw of [pathToFileURL(join(ambiguous, suffix)).href, join("alias", suffix)]) {
        await assert.rejects(async () => {
          const path = await authorizeReadPath(legacyPolicy, raw);
          const input = { path, pattern };
          await tool.execute("ambiguous-path", input);
        }, /would change under Pi's tool path normalization/, `${tool.name} must reject ambiguous canonical paths`);
      }
      const path = await authorizeReadPath(stablePolicy, pathToFileURL(join(stable, suffix)).href);
      const input = { path, pattern };
      const result = await tool.execute("stable-path", input);
      const output = result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
      assert.match(output, tool.name === "read" || tool.name === "grep" ? /SYNTHETIC_MARKER_ORDINARY/ : /evidence\.txt/);
      assert.doesNotMatch(output, /SYNTHETIC_MARKER_UNICODE/);
    }
  } finally {
    restoreEnv();
    await rm(root, { recursive: true, force: true });
  }
});
