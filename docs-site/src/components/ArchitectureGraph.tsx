import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  type ArchitectureNode as ArchitectureNodeRecord,
  architectureNodes,
} from "../data/architecture";
import "../styles/architecture.css";

declare global {
  interface Window {
    selectArchitectureNode?: (nodeId: string) => void;
  }
}

interface GraphView {
  id: string;
  label: string;
  description: string;
  defaultNode: string;
  diagram: string;
}

const graphViews: GraphView[] = [
  {
    id: "manual",
    label: "Manual workflow",
    description: "An explicit user or API action starts a durable Workflow task directly.",
    defaultNode: "web",
    diagram: `
flowchart LR
  web["Web service"]
  workflows["Workflow runtime"]
  core["Core loop"]
  postgres["Postgres"]
  web -->|"manual trigger"| workflows
  workflows -->|"runAgentStep"| core
  core -->|"messages, results"| postgres
  click web selectArchitectureNode
  click workflows selectArchitectureNode
  click core selectArchitectureNode
  click postgres selectArchitectureNode
`,
  },
  {
    id: "delegated",
    label: "Model delegated",
    description: "A chat turn runs in the worker, then the model calls `trigger_workflow`.",
    defaultNode: "runtime-worker",
    diagram: `
flowchart LR
  web["Web service"]
  worker["Worker runtime"]
  workflows["Workflow runtime"]
  core["Core loop"]
  postgres["Postgres"]
  kv["Key Value"]
  web -->|"enqueue run"| worker
  worker -->|"trigger_workflow"| workflows
  workflows -->|"runAgentStep"| core
  core -->|"messages, results"| postgres
  worker -.->|"cancel checks"| kv
  click web selectArchitectureNode
  click worker selectArchitectureNode
  click workflows selectArchitectureNode
  click core selectArchitectureNode
  click postgres selectArchitectureNode
  click kv selectArchitectureNode
`,
  },
  {
    id: "scheduled",
    label: "Scheduled workflow",
    description: "A Render Cron service is a scheduler adapter that starts a Workflow task.",
    defaultNode: "runtime-cron",
    diagram: `
flowchart LR
  cron["Cron runtime"]
  workflows["Workflow runtime"]
  core["Core loop"]
  postgres["Postgres"]
  cron -->|"scheduled trigger"| workflows
  workflows -->|"runAgentStep"| core
  core -->|"messages, results"| postgres
  click cron selectArchitectureNode
  click workflows selectArchitectureNode
  click core selectArchitectureNode
  click postgres selectArchitectureNode
`,
  },
  {
    id: "sync",
    label: "Sync demo",
    description: "The simple web runtime executes the agent inside one HTTP request.",
    defaultNode: "runtime-web",
    diagram: `
flowchart LR
  runtimeWeb["Sync web runtime"]
  core["Core loop"]
  postgres["Postgres"]
  runtimeWeb -->|"in request"| core
  core -->|"state writes"| postgres
  click runtimeWeb selectArchitectureNode
  click core selectArchitectureNode
  click postgres selectArchitectureNode
`,
  },
  {
    id: "authoring",
    label: "Authoring to deploy",
    description: "Gallery and wizard inputs become a registry-loaded deployment.",
    defaultNode: "registry",
    diagram: `
flowchart LR
  gallery["Gallery"]
  wizard["Browser wizard"]
  scaffolder["CLI scaffolder"]
  registry["Registry"]
  web["Web service"]
  worker["Worker runtime"]
  gallery -->|"template"| scaffolder
  wizard -->|"managed repo"| scaffolder
  scaffolder -->|"render-harness.yaml"| registry
  registry -->|"agents map"| web
  registry -->|"resolver"| worker
  click gallery selectArchitectureNode
  click wizard selectArchitectureNode
  click scaffolder selectArchitectureNode
  click registry selectArchitectureNode
  click web selectArchitectureNode
  click worker selectArchitectureNode
`,
  },
  {
    id: "core",
    label: "Core and extensions",
    description:
      "Capabilities extend the shared core loop, which writes state and observes signals.",
    defaultNode: "core",
    diagram: `
flowchart LR
  capabilities["Capabilities"]
  core["Core loop"]
  postgres["Postgres"]
  kv["Key Value"]
  capabilities -->|"tools, MCP, skills"| core
  core -->|"durable state"| postgres
  core -.->|"signals"| kv
  click capabilities selectArchitectureNode
  click core selectArchitectureNode
  click postgres selectArchitectureNode
  click kv selectArchitectureNode
`,
  },
];

const viewsById = new Map(graphViews.map((view) => [view.id, view]));

function selectedNodeFor(id: string): ArchitectureNodeRecord {
  return architectureNodes.find((node) => node.id === id) ?? architectureNodes[0];
}

function architectureNodeIdFor(viewId: string, mermaidNodeId: string): string {
  const map: Record<string, Record<string, string>> = {
    manual: {
      workflows: "runtime-workflows",
    },
    delegated: {
      worker: "runtime-worker",
      workflows: "runtime-workflows",
      kv: "key-value",
    },
    scheduled: {
      cron: "runtime-cron",
      workflows: "runtime-workflows",
    },
    sync: {
      runtimeWeb: "runtime-web",
    },
    authoring: {
      scaffolder: "create-render-agent",
      worker: "runtime-worker",
    },
    core: {
      kv: "key-value",
    },
  };
  return map[viewId]?.[mermaidNodeId] ?? mermaidNodeId;
}

export default function ArchitectureGraph() {
  const containerRef = useRef<HTMLElement>(null);
  const reactId = useId();
  const [viewId, setViewId] = useState("manual");
  const [selectedId, setSelectedId] = useState("web");
  const view = viewsById.get(viewId) ?? graphViews[0];
  const selected = selectedNodeFor(selectedId);
  const diagramId = useMemo(
    () => `architecture-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`,
    [reactId],
  );

  useEffect(() => {
    let cancelled = false;
    window.selectArchitectureNode = (nodeId: string) => {
      setSelectedId(architectureNodeIdFor(view.id, nodeId));
    };

    async function renderDiagram() {
      const mermaid = (await import("mermaid")).default;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "loose",
        theme: "dark",
        flowchart: {
          curve: "linear",
          htmlLabels: false,
          nodeSpacing: 55,
          rankSpacing: 70,
        },
        themeVariables: {
          background: "#000000",
          mainBkg: "#101010",
          primaryColor: "#101010",
          primaryTextColor: "#ffffff",
          primaryBorderColor: "#9cc3ff",
          lineColor: "#9cc3ff",
          secondaryColor: "#050505",
          tertiaryColor: "#000000",
          fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
        },
      });

      const { svg, bindFunctions } = await mermaid.render(`${diagramId}-${view.id}`, view.diagram);
      if (!cancelled && containerRef.current) {
        containerRef.current.innerHTML = svg;
        bindFunctions?.(containerRef.current);
      }
    }

    renderDiagram().catch((err: unknown) => {
      if (containerRef.current) {
        containerRef.current.textContent = err instanceof Error ? err.message : String(err);
      }
    });

    return () => {
      cancelled = true;
      window.selectArchitectureNode = undefined;
    };
  }, [diagramId, view]);

  const selectView = (nextView: GraphView) => {
    setViewId(nextView.id);
    setSelectedId(nextView.defaultNode);
  };

  return (
    <div className="architecture-shell">
      <div className="architecture-main">
        <fieldset className="architecture-viewbar">
          <legend>Graph views</legend>
          {graphViews.map((item) => (
            <button
              key={item.id}
              type="button"
              className={item.id === view.id ? "is-active" : ""}
              onClick={() => selectView(item)}
            >
              {item.label}
            </button>
          ))}
        </fieldset>
        <p className="architecture-view-description">{view.description}</p>
        <section
          className="architecture-flow"
          aria-label={`${view.label} architecture diagram`}
          ref={containerRef}
        />
      </div>

      <aside className="architecture-detail" aria-live="polite">
        <section>
          <p className="architecture-kicker">{selected.kind}</p>
          <h2>{selected.label}</h2>
          <p>{selected.summary}</p>
        </section>

        <section>
          <h3>Owns</h3>
          <ul>
            {selected.owns.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>

          <h3>Talks to</h3>
          <ul>
            {selected.talksTo.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>

        <section>
          <h3>Files to inspect</h3>
          <ul className="architecture-files">
            {selected.files.map((file) => (
              <li key={file.path}>
                <span>{file.label}</span>
                <code>{file.path}</code>
              </li>
            ))}
          </ul>
        </section>
      </aside>
    </div>
  );
}
