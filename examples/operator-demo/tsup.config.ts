import { defineConfig } from "tsup";

export default defineConfig({
  entry: { web: "src/web.ts", worker: "src/worker.ts" },
  format: ["esm"],
  dts: false,
  clean: true,
  sourcemap: true,
  target: "node22",
  splitting: false,
  treeshake: true,
});
