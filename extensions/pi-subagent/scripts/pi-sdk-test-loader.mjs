import { existsSync } from "node:fs";
import { registerHooks } from "node:module";

// Match Pi's bundled extension SDK when shipped. Pi 0.85.0's unbundled root
// historically imported an undeclared pi-server dependency. Retain the regular
// SDK when no bundle exists. This hook is for offline Node tests only.
const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
const bundled = new URL("./bundle/index.js", entry);
if (existsSync(bundled)) {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      return specifier === "@earendil-works/pi-coding-agent"
        ? { url: bundled.href, shortCircuit: true }
        : nextResolve(specifier, context);
    },
  });
}
