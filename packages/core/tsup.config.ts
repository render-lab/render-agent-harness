import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  dts: { compilerOptions: { ignoreDeprecations: "6.0" } },
  // clean: false on purpose. Tsup overwrites the three emitted files
  // (index.js / .js.map / .d.ts) in place; skipping the rmdir avoids the
  // brief window where the dist directory is empty, which causes consumer
  // IDE TypeScript Servers to cache a "module not found" result and require
  // a manual restart to clear. Single-entry build means there are no
  // legacy chunks to leave behind.
  clean: false,
  sourcemap: true,
  target: "node22",
  splitting: false,
  treeshake: true,
});
