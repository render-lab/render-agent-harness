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

const graphClassDefs = `
  classDef external fill:#050505,stroke:#8a8a8a,color:#d0d0d0,stroke-dasharray:4 3
  classDef surface fill:#101010,stroke:#a855f7,stroke-width:2px,color:#ffffff
  classDef runtime fill:#111827,stroke:#a78bfa,color:#ffffff
  classDef central fill:#1f0b35,stroke:#c084fc,stroke-width:3px,color:#ffffff
  classDef data fill:#050505,stroke:#f59e0b,color:#ffffff
  classDef config fill:#050505,stroke:#60a5fa,color:#ffffff
  classDef capability fill:#111827,stroke:#22c55e,stroke-width:2px,color:#ffffff
`;

const graphViews: GraphView[] = [
  {
    id: "request",
    label: "How does a request start work?",
    description:
      "An external app or user hits the public web service. The web service authenticates, creates state, and either runs short work or hands off to another runtime.",
    defaultNode: "web",
    diagram: `
flowchart LR
  client["User, app, or webhook"]
  web[["Web service"]]
  runtimeWeb[["Sync web runtime"]]
  core{{"Core loop"}}
  postgres[("Postgres")]
  client -->|"HTTP request"| web
  web -->|"short demo path"| runtimeWeb
  runtimeWeb -->|"runAgent"| core
  core -->|"run state"| postgres
  class client external
  class web surface
  class runtimeWeb runtime
  class core central
  class postgres data
  ${graphClassDefs}
  click web selectArchitectureNode
  click runtimeWeb selectArchitectureNode
  click core selectArchitectureNode
  click postgres selectArchitectureNode
`,
  },
  {
    id: "queued",
    label: "How does production chat run?",
    description:
      "The web service returns quickly after enqueueing work. The worker owns execution, streams state through Postgres, and checks Key Value for cancellation.",
    defaultNode: "runtime-worker",
    diagram: `
flowchart LR
  web[["Web service"]]
  worker[["Worker runtime"]]
  core{{"Core loop"}}
  postgres[("Postgres")]
  kv[("Key Value")]
  web -->|"enqueue job"| worker
  worker -->|"runAgent"| core
  core -->|"messages, results"| postgres
  worker -.->|"cancel checks"| kv
  class web surface
  class worker runtime
  class core central
  class postgres,kv data
  ${graphClassDefs}
  click web selectArchitectureNode
  click worker selectArchitectureNode
  click core selectArchitectureNode
  click postgres selectArchitectureNode
  click kv selectArchitectureNode
`,
  },
  {
    id: "scheduled",
    label: "How does scheduled work run?",
    description:
      "Cron can run an agent inline for short work, or act as a small scheduler that starts a durable Workflow task.",
    defaultNode: "runtime-cron",
    diagram: `
flowchart LR
  cron[["Cron runtime"]]
  core{{"Core loop"}}
  workflows[["Workflow runtime"]]
  postgres[("Postgres")]
  cron -->|"inline schedule"| core
  cron -->|"durable schedule"| workflows
  workflows -->|"runAgentStep"| core
  core -->|"messages, results"| postgres
  class cron,workflows runtime
  class core central
  class postgres data
  ${graphClassDefs}
  click cron selectArchitectureNode
  click workflows selectArchitectureNode
  click core selectArchitectureNode
  click postgres selectArchitectureNode
`,
  },
  {
    id: "durable",
    label: "How does durable work run?",
    description:
      "Web, worker, and cron can all start Workflow tasks. The Workflow runtime executes checkpointed agent steps through the same core.",
    defaultNode: "runtime-workflows",
    diagram: `
flowchart LR
  web[["Web service"]]
  worker[["Worker runtime"]]
  cron[["Cron runtime"]]
  workflows[["Workflow runtime"]]
  core{{"Core loop"}}
  postgres[("Postgres")]
  web -->|"manual trigger"| workflows
  worker -->|"model delegates"| workflows
  cron -->|"schedule triggers"| workflows
  workflows -->|"runAgentStep"| core
  core -->|"checkpoint state"| postgres
  class web surface
  class worker,cron,workflows runtime
  class core central
  class postgres data
  ${graphClassDefs}
  click web selectArchitectureNode
  click worker selectArchitectureNode
  click cron selectArchitectureNode
  click workflows selectArchitectureNode
  click core selectArchitectureNode
  click postgres selectArchitectureNode
`,
  },
  {
    id: "authoring",
    label: "How does authoring become a deployment?",
    description:
      "Templates and scaffolding produce a manifest. The registry loads that manifest into agents and emits the Render deployment shape.",
    defaultNode: "registry",
    diagram: `
flowchart LR
  gallery[/"Gallery"/]
  wizard[["Browser wizard"]]
  scaffolder[["CLI scaffolder"]]
  registry{{"Registry"}}
  core{{"Core loop"}}
  web[["Web service"]]
  worker[["Worker runtime"]]
  gallery -->|"template"| scaffolder
  wizard -->|"managed repo"| scaffolder
  scaffolder -->|"render-harness.yaml"| registry
  registry -->|"AgentDefinition map"| core
  registry -->|"Render services"| web
  registry -->|"worker resolver"| worker
  class gallery config
  class wizard,scaffolder,web surface
  class registry,core central
  class worker runtime
  ${graphClassDefs}
  click gallery selectArchitectureNode
  click wizard selectArchitectureNode
  click scaffolder selectArchitectureNode
  click registry selectArchitectureNode
  click core selectArchitectureNode
  click web selectArchitectureNode
  click worker selectArchitectureNode
`,
  },
  {
    id: "extensions",
    label: "How do capabilities attach?",
    description:
      "Capability packs are loaded by the registry, then contribute tools, MCP servers, skills, and env requirements to agent definitions.",
    defaultNode: "capabilities",
    diagram: `
flowchart LR
  capabilities{{"Capabilities"}}
  registry{{"Registry"}}
  agents[/"Agent definitions"/]
  core{{"Core loop"}}
  capabilities -->|"pack contract"| registry
  registry -->|"tools, MCP, skills"| agents
  agents -->|"runtime tool surface"| core
  class capabilities capability
  class registry,core central
  class agents config
  ${graphClassDefs}
  click capabilities selectArchitectureNode
  click registry selectArchitectureNode
  click core selectArchitectureNode
`,
  },
];

const viewsById = new Map(graphViews.map((view) => [view.id, view]));

function selectedNodeFor(id: string): ArchitectureNodeRecord {
  return architectureNodes.find((node) => node.id === id) ?? architectureNodes[0];
}

function architectureNodeIdFor(viewId: string, mermaidNodeId: string): string {
  const map: Record<string, Record<string, string>> = {
    request: {
      runtimeWeb: "runtime-web",
    },
    queued: {
      worker: "runtime-worker",
      kv: "key-value",
    },
    scheduled: {
      cron: "runtime-cron",
      workflows: "runtime-workflows",
    },
    durable: {
      worker: "runtime-worker",
      cron: "runtime-cron",
      workflows: "runtime-workflows",
    },
    authoring: {
      scaffolder: "create-render-agent",
      worker: "runtime-worker",
    },
    extensions: {
      agents: "registry",
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
        theme: "base",
        flowchart: {
          curve: "linear",
          htmlLabels: false,
          nodeSpacing: 48,
          padding: 32,
          rankSpacing: 58,
          wrappingWidth: 220,
        },
        themeVariables: {
          background: "#000000",
          clusterBkg: "#050505",
          clusterBorder: "#4c1d95",
          edgeLabelBackground: "#000000",
          fontFamily: "Arial, Helvetica, sans-serif",
          fontSize: "16px",
          lineColor: "#a78bfa",
          primaryColor: "#101010",
          primaryBorderColor: "#9cc3ff",
          primaryTextColor: "#ffffff",
          mainBkg: "#101010",
          nodeBorder: "#a855f7",
          secondaryBorderColor: "#7c3aed",
          secondaryColor: "#111827",
          secondaryTextColor: "#ffffff",
          tertiaryBorderColor: "#4a4a4a",
          tertiaryColor: "#050505",
          tertiaryTextColor: "#d0d0d0",
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
          <legend>Choose a question</legend>
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
