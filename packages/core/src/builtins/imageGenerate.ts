import OpenAI from "openai";
import type { LocalToolHandler } from "../types.js";
import type { BuiltinFactory } from "./types.js";

/**
 * `image_generate({ prompt, size?, n? })` — text-to-image.
 *
 * Provider chain (first match wins):
 *   1. OpenAI (`OPENAI_API_KEY`) — gpt-image-1 by default.
 *   2. FAL (`FAL_KEY`) — FLUX-class model.
 *
 * Override with `HARNESS_IMAGE_PROVIDER=openai|fal`.
 *
 * Returns one or more URLs (or base64 data URIs when the provider only
 * returns inline bytes).
 */
export const imageGenerateFactory: BuiltinFactory = (ctx) => {
  const provider = pickProvider(ctx.env);
  if (!provider) {
    return {
      registered: false,
      name: "image_generate",
      reason: "no image provider configured (set OPENAI_API_KEY or FAL_KEY)",
    };
  }
  return {
    registered: true,
    handler: buildHandler(provider, ctx.env),
  };
};

type Provider = { kind: "openai"; apiKey: string } | { kind: "fal"; apiKey: string };

function pickProvider(env: NodeJS.ProcessEnv): Provider | null {
  const forced = (env.HARNESS_IMAGE_PROVIDER ?? "").toLowerCase().trim();
  if (forced === "openai" && env.OPENAI_API_KEY)
    return { kind: "openai", apiKey: env.OPENAI_API_KEY };
  if (forced === "fal" && env.FAL_KEY) return { kind: "fal", apiKey: env.FAL_KEY };
  if (forced) return null;
  if (env.OPENAI_API_KEY) return { kind: "openai", apiKey: env.OPENAI_API_KEY };
  if (env.FAL_KEY) return { kind: "fal", apiKey: env.FAL_KEY };
  return null;
}

interface Input {
  prompt?: string;
  size?: string;
  n?: number;
}

const SIZES = new Set(["1024x1024", "1536x1024", "1024x1536", "auto"]);

function buildHandler(provider: Provider, env: NodeJS.ProcessEnv): LocalToolHandler {
  return {
    definition: {
      name: "image_generate",
      description: `Generate one or more images from a text prompt using ${provider.kind}. Returns URLs (or data URIs) for the generated images.`,
      source: "builtin",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          prompt: {
            type: "string",
            description: "Description of the desired image.",
            minLength: 1,
          },
          size: {
            type: "string",
            description: "Image size. Defaults to 1024x1024.",
            enum: ["1024x1024", "1536x1024", "1024x1536", "auto"],
          },
          n: {
            type: "integer",
            description: "Number of images (1-4). Defaults to 1.",
            minimum: 1,
            maximum: 4,
          },
        },
        required: ["prompt"],
      },
    },
    handler: async ({ input, signal }) => {
      const args = (input ?? {}) as Input;
      const prompt = (args.prompt ?? "").trim();
      if (!prompt) return { content: "image_generate: missing `prompt`", isError: true };
      const size = args.size && SIZES.has(args.size) ? args.size : "1024x1024";
      const n = Math.max(1, Math.min(4, Math.floor(args.n ?? 1)));

      try {
        const urls = await runProvider(provider, prompt, size, n, signal, env);
        if (urls.length === 0)
          return { content: "image_generate: provider returned no images", isError: true };
        return { content: urls.map((u, i) => `${i + 1}. ${u}`).join("\n") };
      } catch (err) {
        return {
          content: `image_generate (${provider.kind}): ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  };
}

async function runProvider(
  provider: Provider,
  prompt: string,
  size: string,
  n: number,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  switch (provider.kind) {
    case "openai":
      return await generateOpenAI(provider.apiKey, prompt, size, n, signal, env);
    case "fal":
      return await generateFal(provider.apiKey, prompt, size, n, signal, env);
  }
}

async function generateOpenAI(
  apiKey: string,
  prompt: string,
  size: string,
  n: number,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  // The openai SDK is already a core dependency for the LLMClient adapters,
  // so reuse it instead of hand-rolling the REST call. Maps the SDK's
  // `size: "auto" | "1024x1024" | "1536x1024" | "1024x1536"` parameter
  // through unchanged.
  const model = env.HARNESS_OPENAI_IMAGE_MODEL ?? "gpt-image-1";
  const client = new OpenAI({ apiKey });
  const res = await client.images.generate(
    {
      model,
      prompt,
      n,
      size: size as "auto" | "1024x1024" | "1536x1024" | "1024x1536",
    },
    { signal },
  );
  return (res.data ?? [])
    .map((d) => {
      if (d.url) return d.url;
      if (d.b64_json) return `data:image/png;base64,${d.b64_json}`;
      return "";
    })
    .filter(Boolean);
}

async function generateFal(
  apiKey: string,
  prompt: string,
  size: string,
  n: number,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const model = env.HARNESS_FAL_IMAGE_MODEL ?? "fal-ai/flux/schnell";
  const [w, h] = size === "auto" ? [1024, 1024] : size.split("x").map(Number);
  const res = await fetch(`https://fal.run/${model}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Key ${apiKey}`,
    },
    body: JSON.stringify({
      prompt,
      num_images: n,
      image_size: { width: w, height: h },
    }),
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const data = (await res.json()) as {
    images?: Array<{ url?: string }>;
  };
  return (data.images ?? []).map((i) => i.url ?? "").filter(Boolean);
}
