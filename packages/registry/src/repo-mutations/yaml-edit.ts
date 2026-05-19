/**
 * Surgical edits to a `render-harness.yaml` source string. Uses the
 * `yaml` package's `Document` AST so comments, key order, and
 * unrelated fields are preserved across the round-trip.
 *
 * Today: setting an agent's `model:` block. The PATCH endpoint at
 * `/api/agents/:slug/model` calls {@link mutateAgentModel}, commits the
 * result, and Render auto-deploys on push.
 *
 * Always writes a *per-agent* override under `agents[i].model`, even
 * when `shared.model` already covers the picked spec. This is
 * deterministic — one code path regardless of how the YAML happens to
 * be structured — and matches `effectiveAgentDefaults()` precedence in
 * `@render-harness/registry/load-config.ts`.
 */

import { isMap, isSeq, parseDocument, type YAMLMap, type YAMLSeq } from "yaml";
import type { ModelSpecInput } from "../schema.js";

export interface MutateAgentModelOpts {
  yamlText: string;
  agentId: string;
  spec: ModelSpecInput;
}

export class AgentNotFoundError extends Error {
  constructor(agentId: string) {
    super(`agent "${agentId}" not found under agents[]`);
    this.name = "AgentNotFoundError";
  }
}

export class InvalidManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidManifestError";
  }
}

/**
 * Return a new YAML string with `agents[*].model` replaced for the
 * matching `agentId`. Throws if the document doesn't have an `agents:`
 * sequence or the agent id can't be found.
 */
export function mutateAgentModel(opts: MutateAgentModelOpts): string {
  const doc = parseDocument(opts.yamlText);
  if (doc.errors.length > 0) {
    throw new InvalidManifestError(
      `render-harness.yaml has parse errors: ${doc.errors.map((e) => e.message).join("; ")}`,
    );
  }

  const agents = doc.get("agents", true);
  if (!isSeq(agents)) {
    throw new InvalidManifestError("manifest must have an `agents:` sequence");
  }

  const index = findAgentIndex(agents, opts.agentId);
  if (index === -1) throw new AgentNotFoundError(opts.agentId);

  // Build the new model node from the canonical spec. Building from a
  // plain object lets us preserve only the fields the spec actually
  // sets — going from openai-compat back to anthropic removes the old
  // baseURL/apiKeyEnv keys without us having to delete them by hand.
  const modelNode = doc.createNode(specToPlainObject(opts.spec));
  doc.setIn(["agents", index, "model"], modelNode);

  return doc.toString();
}

function findAgentIndex(seq: YAMLSeq, agentId: string): number {
  const items = seq.items;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!isMap<unknown, unknown>(item)) continue;
    const id = readScalar((item as YAMLMap).get("id"));
    if (id === agentId) return i;
  }
  return -1;
}

function readScalar(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "value" in value) {
    const inner = (value as { value: unknown }).value;
    return typeof inner === "string" ? inner : null;
  }
  return null;
}

/**
 * Strip undefined / empty optional fields. `yaml.createNode` emits
 * keys verbatim from the input object, so we filter at this layer to
 * keep the on-disk YAML tidy.
 */
function specToPlainObject(spec: ModelSpecInput): Record<string, unknown> {
  const out: Record<string, unknown> = { provider: spec.provider, model: spec.model };
  if (spec.baseURL) out.baseURL = spec.baseURL;
  if (spec.apiKeyEnv) out.apiKeyEnv = spec.apiKeyEnv;
  if (spec.thinking) out.thinking = { ...spec.thinking };
  return out;
}
