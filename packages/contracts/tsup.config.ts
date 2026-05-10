import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  dts: { compilerOptions: { ignoreDeprecations: "6.0" } },
  clean: false,
  sourcemap: true,
  // Browser-safe types-only package — target the lowest common denominator
  // so the bundler-resolved SPA build never trips over Node-only globals.
  target: "es2022",
  splitting: false,
  treeshake: true,
});
