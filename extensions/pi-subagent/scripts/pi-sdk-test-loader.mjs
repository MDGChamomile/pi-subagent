import { existsSync } from "node:fs";
import { registerHooks } from "node:module";

// Match Pi's bundled extension SDK on 0.85.x. Its unbundled root imports an
// undeclared pi-server dependency. On 0.84.2 retain the regular public SDK.
// This hook is for offline Node tests only, never packaged or installed.
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
