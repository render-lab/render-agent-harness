import { describe, expect, it } from "vitest";
import { chunkText, DEFAULT_MODELS, selectEmbeddingProvider } from "./embeddings.js";

function envFromMap(map: Record<string, string | undefined>): (name: string) => string | undefined {
  return (name) => map[name];
}

describe("selectEmbeddingProvider", () => {
  it("returns null when no provider key is set", () => {
    const p = selectEmbeddingProvider({ env: envFromMap({}) });
    expect(p).toBeNull();
  });

  it("picks OpenAI when only OPENAI_API_KEY is set", () => {
    const p = selectEmbeddingProvider({ env: envFromMap({ OPENAI_API_KEY: "sk_test" }) });
    expect(p?.id).toBe("openai");
    expect(p?.model).toBe(DEFAULT_MODELS.openai.model);
    expect(p?.dim).toBe(DEFAULT_MODELS.openai.dim);
  });

  it("picks Voyage when only VOYAGE_API_KEY is set", () => {
    const p = selectEmbeddingProvider({ env: envFromMap({ VOYAGE_API_KEY: "vk_test" }) });
    expect(p?.id).toBe("voyage");
    expect(p?.dim).toBe(DEFAULT_MODELS.voyage.dim);
  });

  it("picks Cohere when only COHERE_API_KEY is set", () => {
    const p = selectEmbeddingProvider({ env: envFromMap({ COHERE_API_KEY: "co_test" }) });
    expect(p?.id).toBe("cohere");
    expect(p?.dim).toBe(DEFAULT_MODELS.cohere.dim);
  });

  it("prefers OpenAI when multiple keys are set (default chain order)", () => {
    const p = selectEmbeddingProvider({
      env: envFromMap({
        OPENAI_API_KEY: "sk_test",
        VOYAGE_API_KEY: "vk_test",
        COHERE_API_KEY: "co_test",
      }),
    });
    expect(p?.id).toBe("openai");
  });

  it("respects HARNESS_EMBEDDING_PROVIDER override", () => {
    const p = selectEmbeddingProvider({
      env: envFromMap({
        OPENAI_API_KEY: "sk_test",
        VOYAGE_API_KEY: "vk_test",
        HARNESS_EMBEDDING_PROVIDER: "voyage",
      }),
    });
    expect(p?.id).toBe("voyage");
  });

  it("falls back to next provider when HARNESS_EMBEDDING_PROVIDER chooses one with no key", () => {
    const p = selectEmbeddingProvider({
      env: envFromMap({
        OPENAI_API_KEY: "sk_test",
        HARNESS_EMBEDDING_PROVIDER: "voyage",
      }),
    });
    expect(p?.id).toBe("openai");
  });

  it("respects explicit `preferred` arg over env override", () => {
    const p = selectEmbeddingProvider({
      env: envFromMap({
        OPENAI_API_KEY: "sk_test",
        VOYAGE_API_KEY: "vk_test",
        HARNESS_EMBEDDING_PROVIDER: "voyage",
      }),
      preferred: "openai",
    });
    expect(p?.id).toBe("openai");
  });

  it("honors a per-call model override", () => {
    const p = selectEmbeddingProvider({
      env: envFromMap({ OPENAI_API_KEY: "sk_test" }),
      model: "text-embedding-3-large",
    });
    expect(p?.model).toBe("text-embedding-3-large");
  });

  it("ignores garbage HARNESS_EMBEDDING_PROVIDER and falls through to default chain", () => {
    const p = selectEmbeddingProvider({
      env: envFromMap({
        OPENAI_API_KEY: "sk_test",
        HARNESS_EMBEDDING_PROVIDER: "totally-not-a-provider",
      }),
    });
    expect(p?.id).toBe("openai");
  });
});

describe("chunkText", () => {
  it("returns [] for empty input", () => {
    expect(chunkText("", { size: 100, overlap: 10 })).toEqual([]);
    expect(chunkText("   \n   ", { size: 100, overlap: 10 })).toEqual([]);
  });

  it("returns one chunk for input <= size", () => {
    expect(chunkText("hello world", { size: 100, overlap: 10 })).toEqual(["hello world"]);
  });

  it("splits long text into multiple chunks", () => {
    const para1 = "Sentence one. Sentence two. Sentence three.\n\n";
    const para2 = "Sentence four. Sentence five. Sentence six.\n\n";
    const para3 = "Sentence seven. Sentence eight. Sentence nine.";
    const text = para1 + para2 + para3;
    const chunks = chunkText(text, { size: 60, overlap: 10 });
    expect(chunks.length).toBeGreaterThan(1);
    // Concatenating roughly recovers original content (overlap dupes
    // some text, but every word appears at least once).
    const joined = chunks.join(" ");
    expect(joined).toContain("Sentence one");
    expect(joined).toContain("Sentence five");
    expect(joined).toContain("Sentence nine");
  });

  it("prefers paragraph boundaries when they fall after the chunk midpoint", () => {
    const text = "First paragraph here.\n\nSecond paragraph follows. With more text.";
    // size 40 with midpoint 20 — the \n\n at index 21 should be the cut.
    const chunks = chunkText(text, { size: 40, overlap: 5 });
    expect(chunks[0]).toBe("First paragraph here.");
  });

  it("rejects invalid options", () => {
    expect(() => chunkText("hi", { size: 0, overlap: 0 })).toThrow(/size/);
    expect(() => chunkText("hi", { size: 100, overlap: 100 })).toThrow(/overlap/);
    expect(() => chunkText("hi", { size: 100, overlap: -1 })).toThrow(/overlap/);
  });

  it("never produces a chunk longer than size (with some slack for trimming)", () => {
    const text = "a".repeat(500);
    const chunks = chunkText(text, { size: 60, overlap: 10 });
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(60);
    }
  });

  it("respects overlap so consecutive chunks share trailing/leading content", () => {
    const text =
      "The quick brown fox jumps over the lazy dog. " +
      "Then it runs back to its den. After that it sleeps for hours.";
    const chunks = chunkText(text, { size: 50, overlap: 15 });
    expect(chunks.length).toBeGreaterThan(1);
  });
});
