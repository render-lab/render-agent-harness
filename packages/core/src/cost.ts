import type { CostEstimate, ModelSpec, TokenUsage } from "./types.js";

/**
 * Per-model pricing per 1M tokens, in USD. Conservative defaults used when a
 * model isn't in the table — cost tracking is a budget gate, not an invoice
 * line item, so over-estimating is safer than under-estimating.
 *
 * Prices update; treat this table as a soft default. Apps that need precise
 * accounting should pass their own pricing via {@link estimateCost}'s
 * overrides argument.
 */
interface ModelPricing {
  in: number;
  out: number;
  cacheRead?: number;
  cacheWrite?: number;
}

const FALLBACK_PRICING: ModelPricing = { in: 5, out: 20 };

const PRICING: Record<string, ModelPricing> = {
  // Anthropic
  "claude-sonnet-4-7": { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-sonnet-4-6": { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-opus-4-7": { in: 15, out: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-opus-4-6": { in: 15, out: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-haiku-4-5": { in: 1, out: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  // OpenAI
  "gpt-4o": { in: 2.5, out: 10 },
  "gpt-4o-mini": { in: 0.15, out: 0.6 },
  "gpt-5": { in: 5, out: 20 },
  "gpt-5-mini": { in: 0.5, out: 2 },
};

export interface PricingOverride {
  in: number;
  out: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export function estimateCost(
  model: ModelSpec,
  usage: TokenUsage,
  override?: PricingOverride,
): CostEstimate {
  const p = override ?? PRICING[model.model] ?? FALLBACK_PRICING;
  const per = 1_000_000;
  const inputUsd = (usage.inputTokens / per) * p.in;
  const outputUsd = (usage.outputTokens / per) * p.out;
  const cacheRead = ((usage.cacheReadTokens ?? 0) / per) * (p.cacheRead ?? 0);
  const cacheWrite = ((usage.cacheWriteTokens ?? 0) / per) * (p.cacheWrite ?? p.in);
  const cacheUsd = cacheRead + cacheWrite;
  return {
    inputUsd,
    outputUsd,
    cacheUsd,
    totalUsd: inputUsd + outputUsd + cacheUsd,
  };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(a.cacheReadTokens !== undefined || b.cacheReadTokens !== undefined
      ? {
          cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0),
        }
      : {}),
    ...(a.cacheWriteTokens !== undefined || b.cacheWriteTokens !== undefined
      ? {
          cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0),
        }
      : {}),
  };
}
