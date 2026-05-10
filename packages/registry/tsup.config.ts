import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    schema: "src/schema.ts",
    capability: "src/capability.ts",
    emitter: "src/emitter.ts",
    "builtin-chat": "src/builtin-chat.ts",
    "bin/build": "src/bin/build.ts",
  },
  format: ["esm"],
  dts: { compilerOptions: { ignoreDeprecations: "6.0" } },
  clean: true,
  sourcemap: true,
  target: "node22",
  splitting: false,
  treeshake: true,
});
