import { useState } from "react";
import type { GalleryAgent } from "../lib/types.js";

/**
 * Bundle review screen. Shown after the user picks a sealed-bundle
 * template — no per-agent prompts. The user just confirms a name +
 * description and submits.
 */
export function BundleReview({
  bundle,
  onSubmit,
  onPrev,
}: {
  bundle: GalleryAgent;
  onSubmit: (args: { agentName: string; description: string }) => void;
  onPrev: () => void;
}) {
  const [agentName, setAgentName] = useState(bundle.slug);
  const [description, setDescription] = useState(bundle.description);
  const valid = /^[a-z0-9][a-z0-9-]*$/.test(agentName) && description.length > 0;

  return (
    <div className="space-y-5">
      <div>
        <div className="hr-section">
          <span>// SEALED BUNDLE</span>
        </div>
        <p className="mt-3 text-sm text-muted">
          This template ships {bundle.manifest.agents.length} agents that share one harness
          deployment. The wizard writes the files as-is — customize after.
        </p>
      </div>

      <section className="border border-line bg-canvas p-4">
        <div className="label mb-2">{`// ${bundle.name.toUpperCase()}`}</div>
        <p className="text-sm">{bundle.description}</p>
        <ul className="mt-3 space-y-1 text-xs">
          {bundle.manifest.agents.map((a) => (
            <li key={a.id} className="flex items-baseline gap-2">
              <span className="badge">{a.id}</span>
              <span className="text-muted">{a.description ?? a.agent.kind}</span>
            </li>
          ))}
        </ul>
      </section>

      <div className="space-y-3">
        <label className="block">
          <span className="label">// PROJECT NAME</span>
          <input
            type="text"
            value={agentName}
            onChange={(e) => setAgentName(e.target.value)}
            pattern="^[a-z0-9][a-z0-9-]*$"
            className="mt-1 block w-full border border-line bg-canvas p-2 text-sm"
          />
          <p className="mt-1 text-[11px] text-muted">
            Lowercase letters, digits, and dashes. Used for the managed repo and Render service
            names.
          </p>
        </label>

        <label className="block">
          <span className="label">// DESCRIPTION</span>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="mt-1 block w-full border border-line bg-canvas p-2 text-sm"
          />
        </label>
      </div>

      <div className="flex items-center justify-between">
        <button type="button" onClick={onPrev} className="btn">
          Back
        </button>
        <button
          type="button"
          disabled={!valid}
          onClick={() => onSubmit({ agentName, description })}
          className="btn btn-accent"
        >
          Create bundle
        </button>
      </div>
    </div>
  );
}
