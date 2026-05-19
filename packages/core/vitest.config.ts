import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    globals: false,
    pool: "threads",
    // Integration tests hit the same shared Postgres via the local
    // Compose stack. Vitest's default file-parallel threads race each
    // other on table creation / advisory locks / row counts; the
    // failures look like 1s timeouts on `pg_advisory_lock` waits.
    // Run files sequentially in core so only one suite is touching the
    // DB at a time. Unit tests inside each file still parallelize.
    fileParallelism: false,
    coverage: {
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/index.ts"],
    },
  },
});
