import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { MermaidDiagram } from "./MermaidDiagram.js";
import { ShikiBlock } from "./ShikiBlock.js";

/**
 * Brutalist markdown renderer. We let `react-markdown` + `remark-gfm`
 * do all the parsing and structural rendering — this file only adds
 * Tailwind class names for the brutalist look. No manual prefixes, no
 * hand-rolled bullets; the library renders the AST and CSS styles it.
 */
const components: Components = {
  // Block elements: visual styling only. The library produces the right
  // DOM tags; we just dial in spacing and weight.
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
  h1: ({ children }) => (
    <h1 className="mt-5 mb-2 text-base font-bold tracking-tight first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-4 mb-2 text-base font-bold tracking-tight first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-4 mb-1.5 text-sm font-bold tracking-tight first:mt-0">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="mt-3 mb-1 text-sm font-bold tracking-tight first:mt-0">{children}</h4>
  ),
  ul: ({ children }) => (
    <ul className="my-2 ml-5 list-disc space-y-0.5 first:mt-0 last:mb-0 marker:text-muted">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="my-2 ml-5 list-decimal space-y-0.5 first:mt-0 last:mb-0 marker:text-muted">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="pl-1">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-muted pl-3 text-muted first:mt-0 last:mb-0">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-3 border-line" />,
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="text-accent underline underline-offset-2 hover:opacity-80"
    >
      {children}
    </a>
  ),
  strong: ({ children }) => <strong className="font-bold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  del: ({ children }) => <del className="text-muted line-through">{children}</del>,

  // Inline `code` gets a subtle dark-gray fill. Fenced blocks (the ones
  // react-markdown gives us with a `language-*` class) get
  // syntax-highlighted via `ShikiBlock`.
  code: ({ className, children, ...props }) => {
    const isInline = !className;
    if (isInline) {
      return (
        <code className="bg-code-bg px-1 text-[0.85em]" {...props}>
          {children}
        </code>
      );
    }
    const match = /language-([\w-]+)/.exec(className ?? "");
    const code = String(children).replace(/\n$/, "");
    if (match?.[1] === "mermaid") return <MermaidDiagram chart={code} />;
    return match?.[1] ? <ShikiBlock code={code} language={match[1]} /> : <ShikiBlock code={code} />;
  },
  // Disable the default <pre> wrapper around fenced code — ShikiBlock
  // emits its own <pre>, and double-wrapping breaks the layout.
  pre: ({ children }) => <>{children}</>,

  // Tables get hairline borders consistent with the rest of the UI.
  table: ({ children }) => (
    <div className="my-2 overflow-auto first:mt-0 last:mb-0">
      <table className="w-full border-collapse border border-line text-xs">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="border-b border-line">{children}</thead>,
  th: ({ children }) => (
    <th className="border-r border-line px-2 py-1 text-left text-xs font-bold uppercase tracking-wider last:border-r-0">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-t border-r border-line px-2 py-1 last:border-r-0">{children}</td>
  ),
};

interface MarkdownProps {
  text: string;
}

/**
 * Render markdown text with brutalist styling. Memoized because the
 * chat re-renders the message list on every SSE message — re-parsing
 * markdown for every prior message on each tick would be wasteful.
 */
export const Markdown = memo(function Markdown({ text }: MarkdownProps) {
  return (
    <div className="leading-relaxed">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
