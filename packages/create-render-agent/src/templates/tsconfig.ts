/**
 * `tsconfig.json` for the scaffolded project. Mirrors the existing template
 * at `templates/render-harness-entry/tsconfig.json` so all the harness's
 * compiler flags are in force (`verbatimModuleSyntax`,
 * `exactOptionalPropertyTypes`, etc.).
 */
export function tsconfig(): string {
  const cfg = {
    compilerOptions: {
      target: "ESNext",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      lib: ["ESNext"],
      types: ["node"],
      strict: true,
      noUncheckedIndexedAccess: true,
      noImplicitOverride: true,
      exactOptionalPropertyTypes: true,
      esModuleInterop: true,
      isolatedModules: true,
      verbatimModuleSyntax: true,
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true,
      declaration: false,
      sourceMap: true,
      resolveJsonModule: true,
      outDir: "./dist",
    },
    include: ["src/**/*.ts", "agent/**/*.ts"],
    exclude: ["node_modules", "dist"],
  };
  return `${JSON.stringify(cfg, null, 2)}\n`;
}
