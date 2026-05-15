import { describe, expect, it } from "vitest";
import {
  BASE_URL_ALLOWLIST,
  DEFAULT_MODEL_PRESET_ID,
  findPreset,
  MODEL_PRESETS,
  matchPreset,
} from "./model-presets.js";
import { ModelSpecSchema } from "./schema.js";

describe("MODEL_PRESETS", () => {
  it("every non-custom preset round-trips through ModelSpecSchema", () => {
    for (const preset of MODEL_PRESETS) {
      if (!preset.spec) continue;
      const parsed = ModelSpecSchema.parse(preset.spec);
      expect(parsed).toEqual(preset.spec);
    }
  });

  it("contains exactly one synthetic custom entry", () => {
    const custom = MODEL_PRESETS.filter((p) => p.spec === null);
    expect(custom).toHaveLength(1);
    expect(custom[0]?.id).toBe("custom");
  });

  it("preset ids are unique", () => {
    const ids = MODEL_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("openai-compat presets either omit baseURL or use an allowlisted host", () => {
    for (const preset of MODEL_PRESETS) {
      if (preset.spec?.provider !== "openai-compat") continue;
      if (!preset.spec.baseURL) continue;
      const host = new URL(preset.spec.baseURL).host;
      expect(BASE_URL_ALLOWLIST).toContain(host);
    }
  });

  it("DEFAULT_MODEL_PRESET_ID resolves to a real preset with a spec", () => {
    const preset = findPreset(DEFAULT_MODEL_PRESET_ID);
    expect(preset.id).toBe(DEFAULT_MODEL_PRESET_ID);
    expect(preset.spec).not.toBeNull();
  });
});

describe("findPreset", () => {
  it("returns the matching preset for a known id", () => {
    expect(findPreset("gpt-5-1").id).toBe("gpt-5-1");
  });

  it("falls back to custom for an unknown id", () => {
    expect(findPreset("does-not-exist").id).toBe("custom");
  });
});

describe("matchPreset", () => {
  it("matches anthropic specs by model id", () => {
    expect(matchPreset({ provider: "anthropic", model: "claude-sonnet-4-6" }).id).toBe(
      "claude-sonnet-4-6",
    );
  });

  it("matches openai-compat presets including baseURL and apiKeyEnv", () => {
    expect(
      matchPreset({
        provider: "openai-compat",
        model: "gemini-2.5-pro",
        baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
        apiKeyEnv: "GEMINI_API_KEY",
      }).id,
    ).toBe("gemini-2-5-pro");
  });

  it("falls back to custom for a non-matching spec", () => {
    expect(
      matchPreset({
        provider: "openai-compat",
        model: "mistral-large",
        baseURL: "https://api.mistral.ai/v1",
        apiKeyEnv: "MISTRAL_API_KEY",
      }).id,
    ).toBe("custom");
  });
});
