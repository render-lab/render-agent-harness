import { useEffect, useState } from "react";
import { getHighlighter, resolveLang } from "../lib/shiki.js";

/**
 * Fenced code block highlighted by shiki.
 *
 * Used in two places:
 *   - `Markdown.tsx` for code blocks inside agent / chat markdown content.
 *   - `tabs/guide/layout.tsx` for hand-authored code samples in the Guide.
 *
 * Shiki returns a complete `<pre><code>...</code></pre>` HTML string with
 * inline tokens already coloured for both light and dark themes (via the
 * dual-theme CSS-variable mechanism set up in `index.css`). Until shiki
 * finishes its async init we render a plain monospace fallback. After
 * the highlighter is cached, every subsequent block highlights
 * synchronously inside the effect.
 */
interface ShikiBlockProps {
  code: string;
  /** Language hint (e.g. "typescript", "yaml"). Falls back to plain text. */
  language?: string;
  /** Optional label shown above the code (defaults to `language`). */
  label?: string;
  /** Override max-height. Defaults to a reasonable cap so the code panel never dominates the page. */
  maxHeight?: string;
}

export function ShikiBlock({ code, language, label, maxHeight }: ShikiBlockProps) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const lang = resolveLang(language);
    getHighlighter()
      .then((h) => {
        if (cancelled) return;
        const out = h.codeToHtml(code, {
          lang,
          themes: { light: "github-light", dark: "github-dark" },
          defaultColor: false,
          cssVariablePrefix: "--shiki-",
        });
        setHtml(out);
      })
      .catch(() => {
        // Highlighter failed to initialise; keep showing the plain fallback.
      });
    return () => {
      cancelled = true;
    };
  }, [code, language]);

  const heading = label ?? language;
  const heightClass = maxHeight ?? "max-h-96";

  return (
    <div className="my-2 overflow-hidden border border-line text-[12px] first:mt-0 last:mb-0">
      {heading && <div className="label border-b border-line px-3 py-1">{heading}</div>}
      {html ? (
        <div
          className={`shiki-host ${heightClass} overflow-auto`}
          // shiki output is server-side-rendered escaped HTML we trust by
          // construction (the input is the literal markdown / source content).
          // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki emits trusted HTML.
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className={`${heightClass} overflow-auto p-3`}>
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}
