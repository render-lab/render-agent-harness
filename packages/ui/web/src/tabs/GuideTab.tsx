import { useEffect, useRef } from "react";
import { TourSection } from "./guide/TourSection.js";
import { AgentRuntimeSection } from "./guide/AgentRuntimeSection.js";
import { CustomizingSection } from "./guide/CustomizingSection.js";
import { CapabilitiesSection } from "./guide/CapabilitiesSection.js";
import { DeploySection } from "./guide/DeploySection.js";

/**
 * In-product guide for new operators. Linear narrative anchored on the
 * running operator-demo: each section has prose, real code excerpts, and
 * a small "live panel" that pulls data from the running deployment so
 * the docs stay grounded in what the user is actually looking at.
 *
 * Sections are simple React components under `tabs/guide/`. To add a
 * new one, drop it into `SECTIONS` below — order in the array is the
 * order in the sidebar and the only thing that determines layout.
 */

export type GuideSectionId =
  | "tour"
  | "agent"
  | "customizing"
  | "capabilities"
  | "deploy";

interface SectionDef {
  id: GuideSectionId;
  label: string;
  /** Sidebar one-liner. Kept very short — section content does the work. */
  blurb: string;
  Component: React.FC;
}

const SECTIONS: readonly SectionDef[] = [
  {
    id: "tour",
    label: "01. tour",
    blurb: "what's running and how it fits together",
    Component: TourSection,
  },
  {
    id: "agent",
    label: "02. agent + runtime",
    blurb: "defineAgent, serveWeb, startWorker",
    Component: AgentRuntimeSection,
  },
  {
    id: "customizing",
    label: "03. customizing",
    blurb: "prompts, models, MCP servers",
    Component: CustomizingSection,
  },
  {
    id: "capabilities",
    label: "04. capabilities",
    blurb: "first-party + community packs",
    Component: CapabilitiesSection,
  },
  {
    id: "deploy",
    label: "05. deploy",
    blurb: "blueprint to Render",
    Component: DeploySection,
  },
];

const SECTION_IDS = new Set<GuideSectionId>(SECTIONS.map((s) => s.id));

export function isGuideSectionId(value: string): value is GuideSectionId {
  return SECTION_IDS.has(value as GuideSectionId);
}

interface GuideTabProps {
  section: GuideSectionId | null;
  onSectionChange: (id: GuideSectionId) => void;
}

export function GuideTab({ section, onSectionChange }: GuideTabProps) {
  // Default to the first section if none is in the URL yet.
  const active = section ?? SECTIONS[0]?.id ?? "tour";
  const ActiveComponent =
    SECTIONS.find((s) => s.id === active)?.Component ?? TourSection;

  // When the user picks a section, scroll the body back to the top so
  // they don't land mid-section.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0, behavior: "instant" });
  }, [active]);

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[200px_1fr]">
      <Sidebar active={active} onSectionChange={onSectionChange} />
      <div ref={bodyRef} className="min-w-0">
        <ActiveComponent />
      </div>
    </div>
  );
}

interface SidebarProps {
  active: GuideSectionId;
  onSectionChange: (id: GuideSectionId) => void;
}

function Sidebar({ active, onSectionChange }: SidebarProps) {
  return (
    <aside className="lg:sticky lg:top-4 lg:self-start">
      <div className="label mb-3">// guide</div>
      <nav className="space-y-1 text-xs">
        {SECTIONS.map((s) => {
          const isActive = s.id === active;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => onSectionChange(s.id)}
              className={`flex w-full flex-col items-start border-l-2 px-2 py-1.5 text-left transition ${
                isActive
                  ? "border-accent text-accent"
                  : "border-line text-ink hover:border-accent hover:text-accent"
              }`}
            >
              <span className="uppercase tracking-wider">{s.label}</span>
              <span className="text-[10px] normal-case text-muted">{s.blurb}</span>
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
