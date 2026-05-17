import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlock,
  Message,
  TextBlock,
  ThinkingBlock,
  ToolDefinition,
  ToolResultBlock,
  ToolUseBlock,
} from "../types.js";
import type { CompleteOpts, CompleteResult, LLMClient } from "./client.js";

/**
 * Native Anthropic adapter.
 *
 * - Cache-pins the system prompt and tool definitions so prompt caching kicks
 *   in transparently across turns.
 * - Supports extended thinking when {@link ModelSpec.thinking} is set.
 * - Translates internal blocks to/from the Messages API wire shape.
 */
export class AnthropicAdapter implements LLMClient {
  readonly providerName = "anthropic";

  #client: Anthropic;

  constructor(opts?: { apiKey?: string; baseURL?: string }) {
    this.#client = new Anthropic({
      ...(opts?.apiKey ? { apiKey: opts.apiKey } : {}),
      ...(opts?.baseURL ? { baseURL: opts.baseURL } : {}),
    });
  }

  async complete(opts: CompleteOpts): Promise<CompleteResult> {
    const { model, system, tools, messages, sampling, signal } = opts;

    const apiMessages = messages
      .filter((m) => m.role === "user" || m.role === "assistant" || m.role === "tool")
      .map(toApiMessage);

    const apiTools = tools.map(toApiTool);

    const systemBlock: Anthropic.TextBlockParam[] = [
      {
        type: "text",
        text: system,
        cache_control: { type: "ephemeral" },
      },
    ];

    const thinkingParam = model.thinking?.enabled
      ? {
          thinking: {
            type: "enabled" as const,
            budget_tokens: model.thinking.budgetTokens,
          },
        }
      : {};

    const response = await this.#client.messages.create(
      {
        model: model.model,
        max_tokens: sampling?.maxOutputTokens ?? 8192,
        system: systemBlock,
        tools: apiTools,
        messages: apiMessages,
        ...(sampling?.temperature !== undefined ? { temperature: sampling.temperature } : {}),
        ...(sampling?.topP !== undefined ? { top_p: sampling.topP } : {}),
        ...thinkingParam,
      },
      { signal },
    );

    const content: ContentBlock[] = response.content.map(fromApiBlock);

    return {
      message: { role: "assistant", content },
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        ...(response.usage.cache_read_input_tokens !== null &&
        response.usage.cache_read_input_tokens !== undefined
          ? { cacheReadTokens: response.usage.cache_read_input_tokens }
          : {}),
        ...(response.usage.cache_creation_input_tokens !== null &&
        response.usage.cache_creation_input_tokens !== undefined
          ? { cacheWriteTokens: response.usage.cache_creation_input_tokens }
          : {}),
      },
      stopReason: response.stop_reason ?? "end_turn",
    };
  }
}

// --------------------------------------------------------------------
// Translation helpers
// --------------------------------------------------------------------

function toApiMessage(msg: Message): Anthropic.MessageParam {
  if (msg.role === "tool") {
    // Internal "tool" role messages collapse into user messages with
    // tool_result blocks per the Messages API.
    return {
      role: "user",
      content: msg.content.map(toApiContentBlock),
    };
  }
  return {
    role: msg.role === "assistant" ? "assistant" : "user",
    content: msg.content.map(toApiContentBlock),
  };
}

function toApiContentBlock(block: ContentBlock): Anthropic.ContentBlockParam {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "tool_use":
      return {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: (block.input ?? {}) as Record<string, unknown>,
      };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: block.tool_use_id,
        content: block.content,
        ...(block.is_error ? { is_error: true } : {}),
      };
    case "thinking":
      return {
        type: "thinking",
        thinking: block.thinking,
        signature: block.signature ?? "",
      };
    default:
      return assertNever(block);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported content block: ${JSON.stringify(value)}`);
}

function fromApiBlock(block: Anthropic.ContentBlock): ContentBlock {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text } satisfies TextBlock;
    case "tool_use":
      return {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input,
      } satisfies ToolUseBlock;
    case "thinking":
      return {
        type: "thinking",
        thinking: block.thinking,
        signature: block.signature,
      } satisfies ThinkingBlock;
    default:
      // Forward-compat for unknown block kinds (e.g. server_tool_use, redacted_thinking):
      // surface as text so the loop can still progress.
      return {
        type: "text",
        text: `[unsupported block: ${block.type}]`,
      } satisfies TextBlock;
  }
}

function toApiTool(tool: ToolDefinition): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Tool["input_schema"],
  };
}

// Re-export for symmetry with openai adapter signature
export type { ToolResultBlock };
