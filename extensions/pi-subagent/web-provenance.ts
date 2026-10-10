import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ALLOWED_WEB_TOOLS, MIN_WEB_EXTENSION_VERSION } from "./shared.ts";
import { isWithin } from "./path-policy.ts";

export type ToolSourceDescriptor = {
  name: string;
  sourceInfo?: { path?: string; baseDir?: string };
};

// Accept stable SemVer releases only; build metadata does not affect precedence.
function meetsWebMinimumVersion(version: unknown): boolean {
  if (typeof version !== "string") return false;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
  if (!match || match[0] !== version) return false;
  const minimum = MIN_WEB_EXTENSION_VERSION.split(".").map(BigInt);
  for (let index = 0; index < 3; index++) {
    const part = BigInt(match[index + 1]!);
    if (part !== minimum[index]) return part > minimum[index]!;
  }
  return true;
}

// Resolve only Pi's supported directory entry points, never an arbitrary sibling file.
async function webEntryFile(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path);
    if (info.isFile()) return realpath(path);
    if (!info.isDirectory()) return undefined;
    for (const name of ["index.ts", "index.js"]) {
      const candidate = join(path, name);
      try {
        // Pi prefers index.ts when both exist. Do not fall through if it exists but is invalid.
        await lstat(candidate);
        return (await stat(candidate)).isFile() ? realpath(candidate) : undefined;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
      }
    }
  } catch {
    // Missing or unusable entry point.
  }
  return undefined;
}

async function verifyWebPackageEntrypoint(canonical: string): Promise<boolean> {
  for (let directory = dirname(canonical);;) {
    try {
      const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as {
        name?: unknown;
        version?: unknown;
        pi?: { extensions?: unknown };
      };
      if (
        manifest.name !== "pi-web-access"
        || !meetsWebMinimumVersion(manifest.version)
        || !Array.isArray(manifest.pi?.extensions)
      ) return false;
      const packageRoot = await realpath(directory);
      for (const entry of manifest.pi.extensions) {
        if (typeof entry !== "string") continue;
        const declared = await webEntryFile(resolve(directory, entry));
        if (!declared) continue;
        if (declared === canonical && isWithin(packageRoot, declared)) return true;
      }
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    }
    const parent = dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
}

export async function resolveWebExtensionPath(tools: readonly ToolSourceDescriptor[]): Promise<string> {
  const selected = ALLOWED_WEB_TOOLS.map((name) => tools.find((tool) => tool.name === name));
  if (selected.some((tool) => !tool)) {
    throw new Error(`Web subagent capability requires enabled tools: ${ALLOWED_WEB_TOOLS.join(", ")}`);
  }
  const sourceKeys = new Set(selected.map((tool) => `${tool!.sourceInfo?.path ?? ""}\n${tool!.sourceInfo?.baseDir ?? ""}`));
  if (sourceKeys.size !== 1) throw new Error("Web subagent tools must come from one trusted extension source");

  const source = selected[0]!.sourceInfo;
  // Pi supplies the loaded extension path (which may be a directory) and its
  // baseDir. A baseDir alone cannot establish which file owns the tools.
  if (source?.path) {
    const canonical = await webEntryFile(source.path);
    if (canonical && await verifyWebPackageEntrypoint(canonical)) return canonical;
  }
  throw new Error(`Web tools must come from the installed pi-web-access >=${MIN_WEB_EXTENSION_VERSION} (stable releases only) package entry point`);
}
