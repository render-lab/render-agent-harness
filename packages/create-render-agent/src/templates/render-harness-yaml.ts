import { stringify } from "yaml";
import type { Answers, RuntimeSelection } from "../types.js";
import { DEFAULT_HARNESS_VERSION_RANGE } from "../version-ranges.js";

/**
 * Build the `render-harness.yaml` content for a scaffolded project. The
 * returned object is validated against `HarnessConfigSchema` by
 * `validate.ts` before it's written to disk.
 *
 * Emits the canonical (multi-agent) shape with a single agent for
 * wizard-driven scaffolds. Template-declared fields the wizard doesn't
 * collect (mcpServers, permissions, budget, envSchema, capability
 * `config` blocks) are preserved from `templateManifest` when present.
 */
export function buildHarnessConfig(answers: Answers): Record<string, unknown> {
  // Pull anything the template provided that we want to thread through:
  // bundle-wide envSchema, shared.permissions / budget / sampling,
  // per-agent mcpServers. Don't carry forward template `agents[]` — the
  // wizard owns the single-agent shape for the wizard flow.
  const base: Record<string, unknown> = answers.templateManifest
    ? extractCarryForward(answers.templateManifest)
    : {};

  // shared.* — start from template defaults (so permissions / budget /
  // sampling from a gallery entry land in the scaffolded manifest), then
  // override model with the user's wizard pick. UI toggle is wizard-side.
  const templateShared =
    base.shared && typeof base.shared === "object" ? (base.shared as Record<string, unknown>) : {};
  const shared: Record<string, unknown> = {
    ...templateShared,
    model: { ...answers.model },
    ...(answers.ui ? { ui: true } : {}),
  };

  const agent: Record<string, unknown> = {
    id: answers.agentName,
    agent: {
      kind: "builtin",
      ref: "chat",
      systemPrompt: answers.systemPrompt,
    },
    runtimes: answers.runtimes.map(runtimeToYaml),
  };

  const templateAgentMcp = extractTemplateAgentMcpServers(answers.templateManifest);
  if (templateAgentMcp) agent.mcpServers = templateAgentMcp;

  const cfg: Record<string, unknown> = {
    schemaVersion: 1,
    name: answers.agentName,
    description: answers.description,
    harnessVersion: DEFAULT_HARNESS_VERSION_RANGE,
    license: "MIT",
    shared,
  };

  if (answers.capabilities.length > 0) {
    const templateCaps = readTemplateCapabilities(answers.templateManifest);
    cfg.capabilities = answers.capabilities.map((c) => {
      const fromTemplate = templateCaps.get(c.pack);
      const base = fromTemplate ?? { pack: c.pack };
      return retargetCapabilityConfig(base, answers.agentName);
    });
  }

  if (base.envSchema) cfg.envSchema = base.envSchema;
  if (base.categories) cfg.categories = base.categories;

  cfg.agents = [agent];
  return cfg;
}

/**
 * Pulls forward fields from a template manifest that should land
 * unchanged in the scaffolded manifest — top-level bundle metadata +
 * per-agent extras we'd otherwise lose.
 */
function extractCarryForward(manifest: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ["shared", "envSchema", "categories"]) {
    if (manifest[key] !== undefined) out[key] = manifest[key];
  }
  return out;
}

function extractTemplateAgentMcpServers(
  manifest: Record<string, unknown> | null,
): unknown[] | undefined {
  if (!manifest) return undefined;
  const agents = manifest.agents;
  if (!Array.isArray(agents) || agents.length === 0) return undefined;
  const first = agents[0];
  if (!first || typeof first !== "object") return undefined;
  const mcp = (first as Record<string, unknown>).mcpServers;
  return Array.isArray(mcp) ? mcp : undefined;
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

/**
 * Capability packs carried over from a gallery template often pin the
 * connector to the template's own agent id (e.g. `agent: support-bot`).
 * The wizard is single-agent, so the scaffolded project has exactly one
 * agent whose id is `answers.agentName`. Rewrite any `config.agent` value
 * to point at that agent so the connector dispatches to the right place
 * out-of-the-box.
 */
function retargetCapabilityConfig(
  cap: Record<string, unknown>,
  agentName: string,
): Record<string, unknown> {
  const config = cap.config;
  if (!config || typeof config !== "object") return cap;
  const original = config as Record<string, unknown>;
  if (!("agent" in original)) return cap;
  return { ...cap, config: { ...original, agent: agentName } };
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
