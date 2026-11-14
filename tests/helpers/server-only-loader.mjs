// Test process only: retain real React hooks while importing server modules.
import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, nextResolve) {
  return specifier === "server-only" ? { url: "data:text/javascript,export{}", shortCircuit: true } : nextResolve(specifier, context);
} });
