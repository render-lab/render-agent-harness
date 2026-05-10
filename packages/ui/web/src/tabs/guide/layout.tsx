import type { ReactNode } from "react";
import { ShikiBlock } from "../../components/ShikiBlock.js";

/**
 * Common shell every Guide section uses: header, prose body, and a
 * sticky "live panel" on the right that pulls data from the running
 * deployment. Sections compose this shell so the visual rhythm stays
 * consistent across the whole guide.
 */

interface GuideSectionShellProps {
  title: string;
  /** One-line summary under the title. */
  lede: string;
  /** Main prose + code, the bulk of the section. */
  body: ReactNode;
  /** Right-side live panel. Optional; when omitted the body fills the row. */
  livePanel?: ReactNode;
}

export function GuideSectionShell({
  title,
  lede,
  body,
  livePanel,
}: GuideSectionShellProps) {
  return (
    <article className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-base font-bold uppercase tracking-wider">// {title}</h1>
        <p className="text-xs text-muted">{lede}</p>
      </header>
      <div
        className={
          livePanel
            ? "grid grid-cols-1 gap-6 lg:grid-cols-[1fr_280px]"
            : "max-w-3xl"
        }
      >
        <div className="min-w-0 space-y-4 text-sm leading-relaxed">{body}</div>
        {livePanel && (
          <aside className="lg:sticky lg:top-4 lg:self-start">{livePanel}</aside>
        )}
      </div>
    </article>
  );
}

/**
 * Brutalist code block. Routed through the shared `ShikiBlock` so the
 * Guide's hand-authored snippets get the same syntax highlighting that
 * the chat tab applies to agent-rendered markdown. The `language` prop
 * doubles as the panel label — pass something like `"src/web.ts"` or
 * `"yaml"` to title the block.
 */
export function CodeBlock({
  children,
  language,
}: {
  children: string;
  language?: string;
}) {
  // Strip arbitrary file-path prefixes from the language hint when
  // mapping to a shiki language. e.g. "src/web.ts" -> "ts".
  const shikiLang = language ? extractLangFromHint(language) : undefined;
  return (
    <ShikiBlock
      code={children}
      {...(shikiLang ? { language: shikiLang } : {})}
      {...(language ? { label: language } : {})}
    />
  );
}

function extractLangFromHint(hint: string): string {
  // If the hint already looks like a bare language, use it as-is.
  if (!hint.includes(".") && !hint.includes("/") && !hint.includes(" ")) return hint;
  // Otherwise try to derive a language from a path-like extension.
  const m = /\.([\w]+)$/.exec(hint);
  return m?.[1] ?? "text";
}

/** Inline shell-command badge that copies on click. */
export function CmdBadge({ cmd }: { cmd: string }) {
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(cmd);
      }}
      title="Copy command to clipboard"
      className="bg-code-bg cursor-pointer px-1 text-[0.85em] hover:text-accent"
    >
      {cmd}
    </button>
  );
}

/** Live-panel container with consistent header styling. */
export function LivePanel({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="border border-line p-3">
      <div className="label mb-3">// live · {title}</div>
      <div className="space-y-2 text-xs">{children}</div>
    </div>
  );
}

/** Simple key/value row for live panels. */
export function KV({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-muted">{k}</span>
      <span className="text-right break-all">{v}</span>
    </div>
  );
}

/** Visual "next-step" arrow CTA. */
export function CTA({
  label,
  hint,
  onClick,
  href,
}: {
  label: string;
  hint?: string;
  onClick?: () => void;
  href?: string;
}) {
  const content = (
    <span className="flex items-center gap-2">
      <span className="text-accent">→</span>
      <span>{label}</span>
      {hint && <span className="text-muted">{hint}</span>}
    </span>
  );
  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        className="block w-full border border-line px-3 py-2 text-xs hover:border-accent hover:text-accent"
      >
        {content}
      </a>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className="block w-full border border-line px-3 py-2 text-left text-xs hover:border-accent hover:text-accent"
    >
      {content}
    </button>
  );
}
