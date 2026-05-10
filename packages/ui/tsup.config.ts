import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  dts: { compilerOptions: { ignoreDeprecations: "6.0" } },
  // tsup runs first in `pnpm build`. Vite then writes the SPA bundle to
  // dist/static/, which tsup's clean step would otherwise wipe on rebuild.
  clean: true,
  sourcemap: true,
  target: "node22",
  splitting: false,
  treeshake: true,
});
