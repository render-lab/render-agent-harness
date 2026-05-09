import type { ModelSpec } from "../types.js";
import { AnthropicAdapter } from "./anthropic.js";
import type { LLMClient } from "./client.js";
import { OpenAICompatAdapter } from "./openai-compat.js";

export { AnthropicAdapter } from "./anthropic.js";
export type { CompleteOpts, CompleteResult, LLMClient } from "./client.js";
export { OpenAICompatAdapter } from "./openai-compat.js";

/**
 * Resolve an {@link LLMClient} for the given {@link ModelSpec}. Looks up the
 * provider's API key from the env var named on the spec (or a sensible
 * default) and returns a fresh adapter instance.
 *
 * Adapters are cheap to construct; callers typically create one per agent run.
 */
export function resolveClient(model: ModelSpec): LLMClient {
  switch (model.provider) {
    case "anthropic": {
      const envName = model.apiKeyEnv ?? "ANTHROPIC_API_KEY";
      const apiKey = process.env[envName];
      if (!apiKey) {
        throw new Error(`AnthropicAdapter: missing ${envName} environment variable`);
      }
      return new AnthropicAdapter({
        apiKey,
        ...(model.baseURL ? { baseURL: model.baseURL } : {}),
      });
    }
    case "openai-compat": {
      const envName = model.apiKeyEnv ?? "OPENAI_API_KEY";
      const apiKey = process.env[envName];
      if (!apiKey) {
        throw new Error(`OpenAICompatAdapter: missing ${envName} environment variable`);
      }
      return new OpenAICompatAdapter({
        apiKey,
        ...(model.baseURL ? { baseURL: model.baseURL } : {}),
      });
    }
  }
}
