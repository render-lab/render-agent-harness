import type {
  ContentBlock,
  Message,
  ModelSpec,
  SamplingParams,
  TokenUsage,
  ToolDefinition,
} from "../types.js";

/**
 * Provider-agnostic LLM client interface.
 *
 * Two implementations ship in v1: AnthropicAdapter (native, with cache_control
 * and extended thinking) and OpenAICompatAdapter (any OpenAI-format endpoint
 * including OpenRouter, Bedrock-via-LiteLLM, Vertex-via-LiteLLM, Groq, vLLM,
 * Ollama). Adding Bedrock or Vertex natively is a matter of writing a third
 * adapter against this interface.
 */
export interface LLMClient {
  readonly providerName: string;

  /**
   * Single (non-streaming) completion. Returns one assistant message and the
   * token usage for the turn.
   *
   * The adapter is responsible for:
   * - Translating our internal Message[] / ToolDefinition[] into the provider's
   *   wire format and back.
   * - Inserting cache_control breakpoints for prompt prefixes (system + tools).
   * - Surfacing token usage including cache reads/writes when the provider
   *   reports them.
   * - Honoring the AbortSignal for in-flight requests.
   */
  complete(opts: CompleteOpts): Promise<CompleteResult>;
}

export interface CompleteOpts {
  model: ModelSpec;
  /** Single system prompt block, cache-pinned. */
  system: string;
  /** Tool definitions in MCP-shaped form; adapter translates to provider shape. */
  tools: ToolDefinition[];
  /** The conversation so far. The adapter strips internal-only blocks if needed. */
  messages: Message[];
  sampling?: SamplingParams;
  signal: AbortSignal;
}

export interface CompleteResult {
  /** Single assistant message containing one or more content blocks. */
  message: { role: "assistant"; content: ContentBlock[] };
  usage: TokenUsage;
  /** Provider-reported stop reason: "end_turn" | "tool_use" | "max_tokens" | etc. */
  stopReason: string;
}
