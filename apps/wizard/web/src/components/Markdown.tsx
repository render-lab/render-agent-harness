import type { JSX } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Renders a string of CommonMark / GFM markdown with styling that
 * fits the wizard's brutalist black-and-white theme. Lives next to
 * `Select` / `Footer` because it's the third presentational
 * component shared across browse and detail surfaces.
 *
 * `react-markdown` is safe by default — it converts the AST to JSX
 * rather than using `dangerouslySetInnerHTML`, so even hostile
 * community READMEs can't smuggle in `<script>` tags. We deliberately
 * don't enable `rehype-raw` for the same reason.
 */
export function Markdown({ children }: { children: string }): JSX.Element {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}
