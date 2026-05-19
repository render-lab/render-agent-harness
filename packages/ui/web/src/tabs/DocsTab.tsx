const DOCS_URL = "https://render-agent-harness.onrender.com/";

export function DocsTab() {
  return (
    <div className="h-screen overflow-hidden">
      <iframe
        title="Render Loops documentation"
        src={DOCS_URL}
        className="h-full w-full bg-canvas"
      />
    </div>
  );
}
