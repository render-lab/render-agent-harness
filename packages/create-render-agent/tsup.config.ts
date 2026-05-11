import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    bin: "src/bin.ts",
  },
  format: ["esm"],
  dts: { compilerOptions: { ignoreDeprecations: "6.0" } },
  clean: true,
  sourcemap: true,
  target: "node22",
  splitting: false,
  treeshake: true,
});
