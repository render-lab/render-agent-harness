import { stringify } from "yaml";
import type { Answers, RuntimeSelection } from "../types.js";

/**
 * Build the `render-harness.yaml` content for a scaffolded project. The
 * returned object is validated against `HarnessConfigSchema` by
 * `validate.ts` before it's written to disk.
 */
export function buildHarnessConfig(answers: Answers): Record<string, unknown> {
  // Start from the template manifest when one was picked. This preserves
  // template-declared fields the wizard does not collect (mcpServers,
  // permissions, budget, envSchema, capability `config` blocks).
  const base: Record<string, unknown> = answers.templateManifest
    ? structuredClone(answers.templateManifest)
    : {};

  const cfg: Record<string, unknown> = {
    ...base,
    schemaVersion: 1,
    name: answers.agentName,
    description: answers.description,
    harnessVersion: "^0.1",
    license: "MIT",
  };

  cfg.agent = {
    kind: "builtin",
    ref: "chat",
    systemPrompt: answers.systemPrompt,
  };

  cfg.runtimes = answers.runtimes.map(runtimeToYaml);

  cfg.model = {
    provider: "anthropic",
    model: answers.model,
  };

  if (answers.capabilities.length > 0) {
    // Preserve any per-capability `config` declared by the template;
    // if a wizard pick wasn't in the template, emit it without config.
    const templateCaps = readTemplateCapabilities(answers.templateManifest);
    cfg.capabilities = answers.capabilities.map((c) => {
      const fromTemplate = templateCaps.get(c.pack);
      return fromTemplate ?? { pack: c.pack };
    });
  } else {
    // User unchecked everything — drop any inherited capabilities.
    delete cfg.capabilities;
  }

  return cfg;
}

function readTemplateCapabilities(
  manifest: Record<string, unknown> | null,
): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  if (!manifest) return map;
  const caps = manifest.capabilities;
  if (!Array.isArray(caps)) return map;
  for (const c of caps) {
    if (c && typeof c === "object" && "pack" in c && typeof c.pack === "string") {
      map.set(c.pack, c as Record<string, unknown>);
    }
  }
  return map;
}

function runtimeToYaml(r: RuntimeSelection): Record<string, unknown> {
  switch (r.kind) {
    case "web":
      return { kind: "web", plan: "starter" };
    case "cron":
      return { kind: "cron", plan: "starter", schedule: r.schedule };
    case "worker":
      return { kind: "worker", plan: "starter", queue: r.queue };
  }
}

export function renderHarnessYaml(answers: Answers): string {
  const cfg = buildHarnessConfig(answers);
  return stringify(cfg, { lineWidth: 0 });
}
