/**
 * Embedding-provider chain for cap-memory-pg pgvector mode.
 *
 * Mirrors the env-gated provider-chain pattern of core's `web_search`
 * builtin: at boot we look for known API keys in order
 * (OPENAI_API_KEY → VOYAGE_API_KEY → COHERE_API_KEY), pick the first
 * one set, and use that provider for both `memory.ingest` (write-side)
 * and `memory.search` (read-side) embedding calls. Operators override
 * the auto-pick with `HARNESS_EMBEDDING_PROVIDER=openai|voyage|cohere`.
 *
 * Each provider returns a vector of fixed length per model; the pack's
 * `embeddingDim` config locks that length at migration time. Swapping
 * provider/model after ingestion requires re-ingestion because pgvector
 * column dims are immutable.
 */

export type EmbeddingProviderId = "openai" | "voyage" | "cohere";

export interface EmbeddingProvider {
  id: EmbeddingProviderId;
  model: string;
  dim: number;
  embed(texts: string[]): Promise<number[][]>;
}

export const DEFAULT_MODELS: Record<EmbeddingProviderId, { model: string; dim: number }> = {
  openai: { model: "text-embedding-3-small", dim: 1536 },
  voyage: { model: "voyage-3-lite", dim: 1024 },
  cohere: { model: "embed-v3", dim: 1024 },
};

export interface SelectEmbeddingProviderOpts {
  env: (name: string) => string | undefined;
  /** Override the env-auto-pick. */
  preferred?: EmbeddingProviderId;
  /** Override the default model for the resolved provider. */
  model?: string;
}

/**
 * Pick an embedding provider from env. Returns `null` when no
 * provider's key is set — callers (the pack's `mcpServers` /
 * `localTools` factories) should `console.warn` and return empty
 * contributions in that case, matching the safe-default pattern of
 * `cap-search-exa`.
 */
export function selectEmbeddingProvider(
  opts: SelectEmbeddingProviderOpts,
): EmbeddingProvider | null {
  const fromOverride = opts.env("HARNESS_EMBEDDING_PROVIDER")?.toLowerCase().trim() as
    | EmbeddingProviderId
    | "";
  const order: EmbeddingProviderId[] = ["openai", "voyage", "cohere"];
  const tryOrder: EmbeddingProviderId[] = (() => {
    const explicit =
      opts.preferred ??
      (fromOverride && order.includes(fromOverride as EmbeddingProviderId)
        ? (fromOverride as EmbeddingProviderId)
        : undefined);
    if (!explicit) return order;
    return [explicit, ...order.filter((p) => p !== explicit)];
  })();
  for (const id of tryOrder) {
    const key = providerKeyEnv(id);
    const apiKey = opts.env(key);
    if (apiKey) {
      const defaults = DEFAULT_MODELS[id];
      const model = opts.model ?? defaults.model;
      return buildProvider(id, model, defaults.dim, apiKey);
    }
  }
  return null;
}

export function providerKeyEnv(id: EmbeddingProviderId): string {
  switch (id) {
    case "openai":
      return "OPENAI_API_KEY";
    case "voyage":
      return "VOYAGE_API_KEY";
    case "cohere":
      return "COHERE_API_KEY";
  }
}

function buildProvider(
  id: EmbeddingProviderId,
  model: string,
  dim: number,
  apiKey: string,
): EmbeddingProvider {
  switch (id) {
    case "openai":
      return {
        id,
        model,
        dim,
        embed: (texts) => embedOpenAI({ apiKey, model, texts }),
      };
    case "voyage":
      return {
        id,
        model,
        dim,
        embed: (texts) => embedVoyage({ apiKey, model, texts }),
      };
    case "cohere":
      return {
        id,
        model,
        dim,
        embed: (texts) => embedCohere({ apiKey, model, texts }),
      };
  }
}

// --------------------------------------------------------------------
// Provider wire calls
//
// Thin typed wrappers per the connectors-plan rule: SDK if good,
// else direct HTTP. None of these providers ships a TS SDK we need;
// the surface is one POST endpoint each, returning a vector array.
// --------------------------------------------------------------------

interface ProviderArgs {
  apiKey: string;
  model: string;
  texts: string[];
}

async function embedOpenAI({ apiKey, model, texts }: ProviderArgs): Promise<number[][]> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model, input: texts }),
  });
  if (!res.ok) {
    throw new Error(`OpenAI embeddings failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
  const out = body.data?.map((d) => d.embedding ?? []) ?? [];
  if (out.length !== texts.length) {
    throw new Error(`OpenAI embeddings: expected ${texts.length} vectors, got ${out.length}`);
  }
  return out;
}

async function embedVoyage({ apiKey, model, texts }: ProviderArgs): Promise<number[][]> {
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model, input: texts }),
  });
  if (!res.ok) {
    throw new Error(`Voyage embeddings failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
  const out = body.data?.map((d) => d.embedding ?? []) ?? [];
  if (out.length !== texts.length) {
    throw new Error(`Voyage embeddings: expected ${texts.length} vectors, got ${out.length}`);
  }
  return out;
}

async function embedCohere({ apiKey, model, texts }: ProviderArgs): Promise<number[][]> {
  const res = await fetch("https://api.cohere.com/v2/embed", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      texts,
      input_type: "search_document",
      embedding_types: ["float"],
    }),
  });
  if (!res.ok) {
    throw new Error(`Cohere embed failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { embeddings?: { float?: number[][] } | number[][] };
  const out = Array.isArray(body.embeddings) ? body.embeddings : (body.embeddings?.float ?? []);
  if (out.length !== texts.length) {
    throw new Error(`Cohere embed: expected ${texts.length} vectors, got ${out.length}`);
  }
  return out;
}

// --------------------------------------------------------------------
// Chunking
//
// Recursive-character splitter — char-based not token-based to keep
// the runtime dep surface zero. Roughly 4 chars per token in English;
// users tuning for cost vs recall should think in chars accordingly.
// --------------------------------------------------------------------

export interface ChunkOpts {
  size: number;
  overlap: number;
}

export function chunkText(text: string, opts: ChunkOpts): string[] {
  const { size, overlap } = opts;
  if (size <= 0) throw new Error("chunkText: size must be > 0");
  if (overlap < 0 || overlap >= size) {
    throw new Error("chunkText: overlap must be >= 0 and < size");
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.length <= size) return [trimmed];

  // Try to split on paragraph boundaries first, then fall back to
  // sentence boundaries, then character boundaries. Within each chunk
  // we don't slice in the middle of a word if a natural boundary
  // exists nearby.
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < trimmed.length) {
    const end = Math.min(cursor + size, trimmed.length);
    let cut = end;
    if (end < trimmed.length) {
      // Look backwards from `end` for a paragraph break, then a sentence
      // break, then whitespace. Prefer the latest natural boundary at
      // or after the midpoint of the chunk.
      const minCut = cursor + Math.floor(size / 2);
      const slice = trimmed.slice(cursor, end);
      const paraIdx = slice.lastIndexOf("\n\n");
      const sentenceIdx = Math.max(
        slice.lastIndexOf(". "),
        slice.lastIndexOf(".\n"),
        slice.lastIndexOf("? "),
        slice.lastIndexOf("! "),
      );
      const wsIdx = slice.lastIndexOf(" ");
      let chosen = -1;
      if (paraIdx >= 0 && cursor + paraIdx >= minCut) chosen = cursor + paraIdx + 2;
      else if (sentenceIdx >= 0 && cursor + sentenceIdx >= minCut)
        chosen = cursor + sentenceIdx + 2;
      else if (wsIdx >= 0 && cursor + wsIdx >= minCut) chosen = cursor + wsIdx + 1;
      if (chosen > cursor) cut = chosen;
    }
    chunks.push(trimmed.slice(cursor, cut).trim());
    if (cut >= trimmed.length) break;
    cursor = Math.max(cut - overlap, cursor + 1);
  }
  return chunks.filter((c) => c.length > 0);
}
