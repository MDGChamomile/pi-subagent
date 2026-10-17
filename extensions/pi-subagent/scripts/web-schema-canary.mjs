import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

if (process.argv[2] !== "--worker") {
  const root = mkdtempSync(join(tmpdir(), "pi-subagent-web-schema-"));
  try {
    const result = childProcess.spawnSync(process.execPath, [
      "--import", fileURLToPath(new URL("./pi-sdk-test-loader.mjs", import.meta.url)),
      "--experimental-strip-types", fileURLToPath(import.meta.url), "--worker",
    ], {
      cwd: root, encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024,
      // No inherited credentials, NODE_OPTIONS, custom config, or active Pi resources.
      env: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: root,
        XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root, XDG_DATA_HOME: root,
        PI_OFFLINE: "1", PI_TELEMETRY: "0" },
    });
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    assert.ifError(result.error);
    assert.equal(result.status, 0, "offline web schema worker failed");
    const report = JSON.parse(result.stdout);
    assert.match(report.package, /^pi-web-access@\d+\.\d+\.\d+/);
    assert.ok(report.tools > 0 && report.samples > 0, "missing schema-check results");
    assert.equal(report.forbiddenAttempts, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
} else {
  // Registration only: never start a session or invoke a tool. Tripwires catch
  // accidental transport/process use during import/init, even if upstream catches
  // the thrown error. This is not an OS sandbox for an untrusted dependency.
  let forbiddenAttempts = 0;
  const deny = () => { forbiddenAttempts++; throw new Error("Schema canary forbids network and subprocess calls"); };
  net.Socket.prototype.connect = deny;
  tls.connect = deny;
  for (const method of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
    childProcess[method] = deny;
  }
  syncBuiltinESMExports();
  globalThis.fetch = deny;
  globalThis.WebSocket = class { constructor() { deny(); } };

  const manifestPath = fileURLToPath(import.meta.resolve("pi-web-access/package.json"));
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.name, "pi-web-access");
  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:\+[0-9A-Za-z.-]+)?$/, "expected a stable upstream release");
  assert.equal(manifest.pi?.extensions?.length, 1, "expected one declared Pi extension entry");
  const entry = resolve(dirname(manifestPath), manifest.pi.extensions[0]);
  const { DefaultResourceLoader, SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const { checkWebSchemas } = await import("./web-schema-contract.ts");
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR,
    settingsManager: SettingsManager.inMemory(), additionalExtensionPaths: [entry],
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await loader.reload();
  const { extensions, errors } = loader.getExtensions();
  assert.deepEqual(errors, [], "upstream Pi extension registration failed");
  assert.equal(extensions.length, 1, "expected only the upstream extension");
  const tools = [...extensions[0].tools.values()].map((tool) => tool.definition);
  const report = checkWebSchemas(tools);
  assert.equal(forbiddenAttempts, 0, "upstream attempted I/O during schema discovery");
  console.log(JSON.stringify({ package: `pi-web-access@${manifest.version}`, ...report, forbiddenAttempts }));
}
