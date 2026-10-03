import { existsSync } from "node:fs";
import { registerHooks } from "node:module";

// Test against Pi's bundled extension SDK when the installed version ships one,
// and the regular SDK otherwise. This hook is for offline Node tests only.
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
