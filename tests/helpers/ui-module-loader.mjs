// Test only: compile actual JSX with the installed Next SWC; no application dependencies added.
import "./server-only-loader.mjs";
import { registerHooks } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const swc = require("next/dist/build/swc"); await swc.loadBindings();
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith(".css")) return { url: "data:text/javascript,export{}", shortCircuit: true };
    if (specifier.startsWith(".") && context.parentURL?.includes("/src/")) {
      const candidate = new URL(`${specifier}.js`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith("file:") && /\/src\/(app|components)\/.*\.js$/.test(url)) {
      const filename = fileURLToPath(url);
      return { format: "module", shortCircuit: true, source: swc.transformSync(readFileSync(filename, "utf8"), { filename, jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" }, module: { type: "es6" } }).code };
    }
    return next(url, context);
  },
});
