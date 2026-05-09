import OpenAI from "openai";
import type { ContentBlock, Message, TextBlock, ToolDefinition, ToolUseBlock } from "../types.js";
import type { CompleteOpts, CompleteResult, LLMClient } from "./client.js";

/**
 * OpenAI-compatible adapter.
 *
 * Works with any provider that exposes an OpenAI Chat Completions endpoint:
 * OpenAI itself, OpenRouter, Groq, DeepSeek, Together, vLLM, Ollama, and
 * anything fronted by LiteLLM Proxy or a custom gateway. Set `baseURL` and
 * `apiKeyEnv` on the {@link ModelSpec} to route requests.
 *
 * Cache control: providers that support OpenAI's prompt caching opt-in
 * automatically once the prefix is large enough; we don't have a portable
 * cache_control breakpoint here.
 */
export class OpenAICompatAdapter implements LLMClient {
  readonly providerName = "openai-compat";

  #client: OpenAI;

  constructor(opts?: { apiKey?: string; baseURL?: string }) {
    this.#client = new OpenAI({
      apiKey: opts?.apiKey ?? process.env.OPENAI_API_KEY ?? "missing",
      ...(opts?.baseURL ? { baseURL: opts.baseURL } : {}),
    });
  }

  async complete(opts: CompleteOpts): Promise<CompleteResult> {
    const { model, system, tools, messages, sampling, signal } = opts;

    const apiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: system },
      ...messages.flatMap(toApiMessages),
    ];

    const apiTools = tools.map(toApiTool);

    const response = await this.#client.chat.completions.create(
      {
        model: model.model,
        messages: apiMessages,
        ...(apiTools.length > 0 ? { tools: apiTools } : {}),
        ...(sampling?.temperature !== undefined ? { temperature: sampling.temperature } : {}),
        ...(sampling?.topP !== undefined ? { top_p: sampling.topP } : {}),
        ...(sampling?.maxOutputTokens !== undefined
          ? { max_tokens: sampling.maxOutputTokens }
          : {}),
      },
      { signal },
    );

    const choice = response.choices[0];
    if (!choice) {
      throw new Error("openai-compat adapter: empty choices array");
    }

    const content: ContentBlock[] = [];
    const text = choice.message.content;
    if (text) {
      content.push({ type: "text", text } satisfies TextBlock);
    }
    for (const tc of choice.message.tool_calls ?? []) {
      if (tc.type !== "function") continue;
      let parsedInput: unknown = {};
      try {
        parsedInput = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch {
        parsedInput = { _raw: tc.function.arguments };
      }
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input: parsedInput,
      } satisfies ToolUseBlock);
    }

    return {
      message: { role: "assistant", content },
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
      stopReason: choice.finish_reason ?? "stop",
    };
  }
}

// --------------------------------------------------------------------
// Translation helpers
// --------------------------------------------------------------------

function toApiMessages(msg: Message): OpenAI.Chat.ChatCompletionMessageParam[] {
  if (msg.role === "user") {
    return [{ role: "user", content: collectText(msg.content) }];
  }
  if (msg.role === "assistant") {
    const text = collectText(msg.content);
    const toolCalls = msg.content
      .filter((b): b is ToolUseBlock => b.type === "tool_use")
      .map<OpenAI.Chat.ChatCompletionMessageToolCall>((b) => ({
        id: b.id,
        type: "function",
        function: {
          name: b.name,
          arguments: JSON.stringify(b.input ?? {}),
        },
      }));
    const assistant: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
      role: "assistant",
      ...(text ? { content: text } : { content: null }),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };
    return [assistant];
  }
  if (msg.role === "tool") {
    return msg.content
      .filter((b) => b.type === "tool_result")
      .map((b) => {
        const tr = b as Extract<ContentBlock, { type: "tool_result" }>;
        return {
          role: "tool",
          tool_call_id: tr.tool_use_id,
          content: tr.content,
        } satisfies OpenAI.Chat.ChatCompletionToolMessageParam;
      });
  }
  return [];
}

function collectText(content: ContentBlock[]): string {
  return content
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function toApiTool(tool: ToolDefinition): OpenAI.Chat.ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}
