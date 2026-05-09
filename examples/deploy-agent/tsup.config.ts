import { defineConfig } from "tsup";

export default defineConfig({
  entry: { main: "src/main.ts", trigger: "src/trigger.ts" },
  format: ["esm"],
  dts: false,
  clean: true,
  sourcemap: true,
  target: "node22",
  splitting: false,
  treeshake: true,
});
