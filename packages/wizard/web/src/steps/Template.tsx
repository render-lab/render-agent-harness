import type { Gallery, GalleryAgent, WizardState } from "../lib/types.js";

/**
 * First step: pick a gallery template or start blank. Distinct from the
 * other steps — no Back button, and the choice itself advances the wizard.
 */
export function Template({
  gallery,
  state,
  onPick,
}: {
  gallery: Gallery;
  state: WizardState;
  onPick: (template: GalleryAgent | null) => void;
}) {
  void state;
  return (
    <div className="space-y-5">
      <div>
        <div className="hr-section">
          <span>// PICK A STARTING POINT</span>
        </div>
        <p className="mt-3 text-sm text-muted">
          Templates pre-fill the wizard with sensible defaults. Override any value in the next
          steps.
        </p>
      </div>

      <div className="space-y-2">
        <button
          type="button"
          onClick={() => onPick(null)}
          className="block w-full border border-line bg-canvas p-4 text-left hover:border-accent hover:text-accent"
        >
          <div className="label">// BLANK</div>
          <div className="mt-1 text-sm">Fill everything in yourself.</div>
        </button>
        {gallery.agents.map((t) => (
          <button
            key={t.slug}
            type="button"
            onClick={() => onPick(t)}
            className="block w-full border border-line bg-canvas p-4 text-left hover:border-accent hover:text-accent"
          >
            <div className="flex items-center justify-between">
              <span className="label">{`// ${t.slug.toUpperCase()}`}</span>
              <div className="flex items-center gap-2">
                {t.kind === "bundle" && (
                  <span className="badge border-accent text-accent">BUNDLE</span>
                )}
                <span className="badge">{t.runtimeKinds.join(" + ")}</span>
              </div>
            </div>
            <div className="mt-1 text-sm">{t.name}</div>
            <div className="mt-1 text-xs text-muted">{t.description}</div>
            {t.kind === "bundle" && (
              <div className="mt-2 text-[11px] text-muted">
                Sealed multi-agent template — {t.manifest.agents.length} agents in one deployment.
              </div>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
