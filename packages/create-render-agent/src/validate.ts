import { HarnessConfigSchema } from "@render-harness/registry/schema";

/**
 * Validates the generated `render-harness.yaml` object against the live
 * schema before it's written to disk. Throws ZodError on failure so the
 * caller can surface a flat list of issues to the user.
 */
export function validateHarnessConfig(raw: unknown): void {
  HarnessConfigSchema.parse(raw);
}
