/**
 * Shiki singleton — one async init, then synchronous highlights forever.
 *
 * Shiki ships its themes/langs as separate dynamic imports so a default
 * `createHighlighter()` call would try to fetch them at use time. We
 * pre-bundle a small set we actually need (covers JSON / yaml / shell
 * and the TS/JS we use in the Guide section snippets) to keep things
 * snappy and offline-capable.
 *
 * Dual themes: tokens get inline CSS variables for both `light` and
 * `dark`. The chunk of CSS in `index.css` flips them on
 * `prefers-color-scheme`, so highlighted code adapts to OS theme like
 * the rest of the UI.
 */

import { createHighlighter, type HighlighterGeneric } from "shiki";

/**
 * Languages bundled into the SPA. We deliberately include the long tail
 * of "stuff agents tend to emit in code blocks" so chat replies render
 * with colour even when the model picks an unusual language hint. Each
 * grammar is a few KB; shiki tree-shakes the unused ones at build time.
 *
 * If an agent reply uses a language not in this list, the block still
 * renders cleanly via the `text` fallback in `resolveLang()` — just
 * without per-token colour. Add it here when that's worth fixing.
 */
const LANGS = [
  // TypeScript / JavaScript family
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  // Data / config formats
  "json",
  "yaml",
  "toml",
  "xml",
  // Shell & scripting
  "bash",
  "shell",
  "powershell",
  // Languages we expect agents to write in chat replies
  "python",
  "rust",
  "go",
  "java",
  "kotlin",
  "swift",
  "ruby",
  "php",
  "csharp",
  "c",
  "cpp",
  "sql",
  // Web
  "html",
  "css",
  "scss",
  // Docs / diff
  "markdown",
  "diff",
  "dockerfile",
] as const;

const THEMES = ["github-light", "github-dark"] as const;

type Highlighter = HighlighterGeneric<(typeof LANGS)[number], (typeof THEMES)[number]>;

let highlighterPromise: Promise<Highlighter> | null = null;

export function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [...THEMES],
      langs: [...LANGS],
    }) as Promise<Highlighter>;
  }
  return highlighterPromise;
}

const LANG_ALIASES: Record<string, (typeof LANGS)[number]> = {
  ts: "typescript",
  js: "javascript",
  yml: "yaml",
  sh: "bash",
  zsh: "bash",
  py: "python",
  rs: "rust",
  golang: "go",
  rb: "ruby",
  cs: "csharp",
  "c++": "cpp",
  cxx: "cpp",
  "c#": "csharp",
  ps1: "powershell",
  pwsh: "powershell",
  text: "markdown",
  txt: "markdown",
};

/**
 * Resolve user-supplied language hints to a language we actually loaded.
 * Falls back to "text" — shiki will then render plain text without
 * tokenising, but with our themes still applied to the wrapper.
 */
export function resolveLang(raw: string | undefined): (typeof LANGS)[number] | "text" {
  if (!raw) return "text";
  const lower = raw.toLowerCase();
  if ((LANGS as readonly string[]).includes(lower)) {
    return lower as (typeof LANGS)[number];
  }
  if (lower in LANG_ALIASES) {
    return LANG_ALIASES[lower] ?? "text";
  }
  return "text";
}
