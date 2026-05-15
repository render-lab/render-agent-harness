import mermaid from "mermaid";
import { useEffect, useId, useState } from "react";

mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  theme: "base",
  themeVariables: {
    background: "transparent",
    mainBkg: "#050505",
    primaryColor: "#050505",
    primaryBorderColor: "#2a2a2a",
    primaryTextColor: "#ffffff",
    lineColor: "#c084fc",
    secondaryColor: "#101010",
    tertiaryColor: "#000000",
    fontFamily: "JetBrains Mono Variable, ui-monospace, monospace",
  },
});

interface MermaidDiagramProps {
  chart: string;
}

export function MermaidDiagram({ chart }: MermaidDiagramProps) {
  const id = useId().replaceAll(":", "");
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setError(null);
    mermaid
      .render(`mermaid-${id}`, chart)
      .then(({ svg }) => {
        if (!cancelled) setSvg(svg);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [chart, id]);

  if (error) {
    return (
      <pre className="my-2 overflow-auto border border-err p-3 text-[11px] text-err">{error}</pre>
    );
  }

  if (!svg) {
    return <div className="panel my-2 p-3 text-xs text-muted">rendering diagram…</div>;
  }

  return (
    <div
      className="mermaid-host panel my-3 overflow-auto p-3"
      // Mermaid renders trusted guide-authored diagrams.
      // biome-ignore lint/security/noDangerouslySetInnerHtml: Mermaid emits SVG from checked-in guide content.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
