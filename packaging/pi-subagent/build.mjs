import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(packageRoot, "../..");

export const stagingDirectory = join(packageRoot, "dist");

export const packageFiles = [
  ["packaging/pi-subagent/manifest.json", "package.json"],
  ["packaging/pi-subagent/README.md", "README.md"],
  ["LICENSE", "LICENSE"],
  ["live/extensions/pi-subagent/index.ts", "extensions/pi-subagent/index.ts"],
  ["live/extensions/pi-subagent/shared.ts", "extensions/pi-subagent/shared.ts"],
  ["live/extensions/pi-subagent/subprocess.ts", "extensions/pi-subagent/subprocess.ts"],
  ["live/extensions/pi-subagent/child-guard.ts", "extensions/pi-subagent/child-guard.ts"],
  ["live/extensions/pi-subagent/parent-liveness.ts", "extensions/pi-subagent/parent-liveness.ts"],
  ["live/extensions/pi-subagent/README.md", "extensions/pi-subagent/README.md"],
  [
    "live/extensions/pi-subagent/assets/pi-subagent-running.png",
    "extensions/pi-subagent/assets/pi-subagent-running.png",
  ],
  [
    "live/extensions/pi-subagent/assets/pi-subagent-complete.png",
    "extensions/pi-subagent/assets/pi-subagent-complete.png",
  ],
  ["live/skills/pi-subagent/SKILL.md", "skills/pi-subagent/SKILL.md"],
  ["live/skills/pi-subagent/README.md", "skills/pi-subagent/README.md"],
];

export async function buildPackage() {
  await rm(stagingDirectory, { recursive: true, force: true });
  for (const [source, target] of packageFiles) {
    const output = join(stagingDirectory, target);
    await mkdir(dirname(output), { recursive: true });
    await copyFile(join(repositoryRoot, source), output);
  }
  return stagingDirectory;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  await buildPackage();
  console.log(stagingDirectory);
}
