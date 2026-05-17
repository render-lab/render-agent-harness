import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    schema: "src/schema.ts",
    capability: "src/capability.ts",
    "capability-index": "src/capability-index.ts",
    "capability-validate": "src/capability-validate.ts",
    emitter: "src/emitter.ts",
    gallery: "src/gallery.ts",
    "builtin-chat": "src/builtin-chat.ts",
    "deploy/index": "src/deploy/index.ts",
    "bin/build": "src/bin/build.ts",
    "bin/deploy": "src/bin/deploy.ts",
  },
  format: ["esm"],
  dts: { compilerOptions: { ignoreDeprecations: "6.0" } },
  clean: true,
  sourcemap: true,
  target: "node22",
  splitting: false,
  treeshake: true,
});
