import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { ALLOWED_WEB_TOOLS, TOOL_NAME } from "./shared.ts";
import { resolveWebExtensionPath } from "./web-provenance.ts";

// The configured test loader selects the bundled SDK when available.
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

for (const filtered of [false, true]) {
  test(`real Pi web smoke registry: CLI allowlist=${filtered}`, { timeout: 15_000 }, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pi-subagent-web-registry-")));
    let session: AgentSession | undefined;
    try {
      const pkg = join(root, "web-package");
      await mkdir(pkg);
      const entry = join(pkg, "index.ts");
      await writeFile(join(pkg, "package.json"), JSON.stringify({
        name: "pi-web-access", version: "0.33.0", pi: { extensions: ["./index.ts"] },
      }));
      await writeFile(entry, `export default function(pi) {
        for (const name of ${JSON.stringify(ALLOWED_WEB_TOOLS)}) pi.registerTool({
          name, label: name, description: "Offline fixture", parameters: {type:"object",properties:{}},
          async execute() { throw new Error("No web tool may execute in this test"); }
        });
      }`);
      const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
      const resourceLoader = new DefaultResourceLoader({
        cwd: root, agentDir: root, settingsManager,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        additionalExtensionPaths: [fileURLToPath(new URL("./index.ts", import.meta.url)), entry,
          fileURLToPath(new URL("./scripts/web-smoke-parent.ts", import.meta.url))],
        systemPrompt: "Offline web registry test.",
      });
      await resourceLoader.reload();
      assert.deepEqual(resourceLoader.getExtensions().errors, []);
      const modelRuntime = await ModelRuntime.create({
        authPath: join(root, "auth.json"), modelsPath: join(root, "models.json"),
        modelsStorePath: join(root, "models-store.json"), allowModelNetwork: false,
      });
      ({ session } = await createAgentSession({
        cwd: root, agentDir: root, resourceLoader, modelRuntime, settingsManager,
        sessionManager: SessionManager.inMemory(root), ...(filtered ? { tools: [TOOL_NAME] } : {}),
      }));
      const errors: unknown[] = [];
      await session.bindExtensions({ onError: (error) => { errors.push(error); } });
      assert.deepEqual(errors, []);
      assert.deepEqual(session.getActiveToolNames(), [TOOL_NAME]);
      if (filtered) {
        await assert.rejects(resolveWebExtensionPath(session.getAllTools()), /requires enabled tools/);
      } else {
        assert.equal(await resolveWebExtensionPath(session.getAllTools()), entry);
        for (const name of ALLOWED_WEB_TOOLS) {
          assert.equal(session.getAllTools().find((tool) => tool.name === name)?.sourceInfo?.path, entry);
        }
        const denied = await session.extensionRunner!.emitToolCall({
          type: "tool_call", toolName: "fetch_content", toolCallId: "offline-parent-call", input: {},
        });
        assert.equal(denied?.block, true);
      }
      // No prompt is sent: registry/provenance checks require no model or web requests.
    } finally {
      session?.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
}
