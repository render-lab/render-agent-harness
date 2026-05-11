import { type Answers, isMultiRuntime } from "../types.js";

/**
 * tsup config for the scaffolded project. Single-runtime layouts emit
 * `{ main: "src/main.ts" }`. Multi-runtime layouts emit one entry per
 * runtime kind (`{ web: "src/web.ts", worker: "src/worker.ts" }`),
 * mirroring `examples/support-agent/tsup.config.ts`.
 */
export function tsupConfig(answers: Answers): string {
  const multi = isMultiRuntime(answers);

  let entryLiteral: string;
  if (multi) {
    const pairs = answers.runtimes.map((r) => `    ${r.kind}: "src/${r.kind}.ts"`).join(",\n");
    entryLiteral = `{\n${pairs},\n  }`;
  } else {
    entryLiteral = `{ main: "src/main.ts" }`;
  }

  return `import { defineConfig } from "tsup";

export default defineConfig({
  entry: ${entryLiteral},
  format: ["esm"],
  clean: true,
  sourcemap: true,
  target: "node22",
  splitting: false,
  treeshake: true,
});
`;
}
