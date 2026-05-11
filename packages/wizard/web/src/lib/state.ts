import type { GalleryAgent, RuntimeKind, RuntimeSelection, WizardState } from "./types.js";

export const KNOWN_MODELS = [
  { value: "claude-sonnet-4-6", label: "claude-sonnet-4-6", hint: "default — best balance" },
  { value: "claude-opus-4-7", label: "claude-opus-4-7", hint: "most capable" },
  { value: "claude-haiku-4-5", label: "claude-haiku-4-5", hint: "fastest / cheapest" },
] as const;

export const DEFAULT_STATE: WizardState = {
  templateSlug: null,
  agentName: "my-agent",
  description: "An agent built with the Render harness.",
  systemPrompt: "You are a helpful assistant deployed on Render via the agent harness.",
  model: "claude-sonnet-4-6",
  runtimes: [{ kind: "web" }],
  ui: true,
  capabilities: [],
};

/**
 * Seed wizard state from a gallery template. Only sets fields the
 * template provides; the user can still override every value before
 * submitting.
 */
export function seedFromTemplate(t: GalleryAgent): WizardState {
  const systemPrompt =
    t.manifest.agent.kind === "builtin"
      ? t.manifest.agent.systemPrompt
      : DEFAULT_STATE.systemPrompt;
  // Filter to v1-supported kinds (drop "workflows" since render.yaml
  // Blueprints don't support workflow services yet).
  const supportedKinds: RuntimeKind[] = (t.runtimeKinds as readonly string[]).filter(
    (k): k is RuntimeKind => k === "web" || k === "worker" || k === "cron",
  );
  const runtimes: RuntimeSelection[] = supportedKinds.map((kind) => {
    if (kind === "cron") return { kind, schedule: "0 13 * * *" };
    if (kind === "worker") return { kind, queue: `${t.slug}-runs` };
    return { kind: "web" };
  });
  return {
    templateSlug: t.slug,
    agentName: t.slug,
    description: t.description,
    systemPrompt,
    model: t.manifest.model.model,
    runtimes: runtimes.length > 0 ? runtimes : [{ kind: "web" }],
    ui: true,
    capabilities: t.capabilities.map((pack) => ({ pack })),
  };
}

/** Toggle a runtime kind, applying sensible defaults for cron/worker fields. */
export function toggleRuntime(
  current: RuntimeSelection[],
  kind: RuntimeKind,
  agentName: string,
): RuntimeSelection[] {
  const exists = current.find((r) => r.kind === kind);
  if (exists) return current.filter((r) => r.kind !== kind);
  if (kind === "web") return [...current, { kind: "web" }];
  if (kind === "cron") return [...current, { kind: "cron", schedule: "0 13 * * *" }];
  return [...current, { kind: "worker", queue: `${agentName}-runs` }];
}

/** When the UI toggle flips on and there's no worker, add one. */
export function ensureWorkerForUi(
  runtimes: RuntimeSelection[],
  ui: boolean,
  agentName: string,
): RuntimeSelection[] {
  if (!ui) return runtimes;
  if (runtimes.some((r) => r.kind === "worker")) return runtimes;
  if (!runtimes.some((r) => r.kind === "web")) return runtimes; // UI requires web; user hasn't enabled it yet
  return [...runtimes, { kind: "worker", queue: `${agentName}-runs` }];
}
