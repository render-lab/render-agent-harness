/**
 * Tool result truncation.
 *
 * Default policy: inject the first ~2000 tokens (≈8000 characters) of a tool
 * result into the model's context. Store the full payload in
 * `agent_tool_results` keyed by tool_call_id. The agent calls
 * `fetch_full_result(tool_call_id)` when it needs more.
 *
 * "Tokens" here is a rough char/4 approximation. We don't ship a tokenizer
 * with the core to keep dependencies minimal. Apps that need accurate counts
 * should plug in their own tokenizer via the runtime hooks.
 */

export const DEFAULT_MAX_RESULT_TOKENS = 2000;
export const CHARS_PER_TOKEN_APPROX = 4;

export function approximateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_APPROX);
}

export interface TruncationResult {
  truncated: string;
  fullTokens: number;
  truncatedTokens: number;
  wasTruncated: boolean;
}

export function truncateResult(
  full: string,
  toolCallId: string,
  maxTokens = DEFAULT_MAX_RESULT_TOKENS,
): TruncationResult {
  const fullTokens = approximateTokens(full);
  if (fullTokens <= maxTokens) {
    return {
      truncated: full,
      fullTokens,
      truncatedTokens: fullTokens,
      wasTruncated: false,
    };
  }
  const sliceChars = maxTokens * CHARS_PER_TOKEN_APPROX;
  const head = full.slice(0, sliceChars);
  const footer = `\n\n…[truncated; ${fullTokens - maxTokens} more tokens. Call fetch_full_result("${toolCallId}") to read the full payload.]`;
  const truncated = head + footer;
  return {
    truncated,
    fullTokens,
    truncatedTokens: approximateTokens(truncated),
    wasTruncated: true,
  };
}
