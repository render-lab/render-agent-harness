export type ArchitectureKind =
  | "authoring"
  | "registry"
  | "runtime"
  | "core"
  | "primitive"
  | "product";

export interface ArchitectureFileLink {
  label: string;
  path: string;
}

export interface ArchitectureNode {
  id: string;
  label: string;
  kind: ArchitectureKind;
  summary: string;
  owns: string[];
  files: ArchitectureFileLink[];
  talksTo: string[];
  position: { x: number; y: number };
}

export interface ArchitectureEdge {
  id: string;
  source: string;
  target: string;
  label: string;
}

export const architectureNodes: ArchitectureNode[] = [
  {
    id: "gallery",
    label: "Gallery",
    kind: "authoring",
    summary: "Curated templates and bundles users can start from.",
    owns: ["Agent manifests", "Bundle source files", "Template metadata"],
    files: [
      { label: "Gallery index", path: "gallery/index.yaml" },
      {
        label: "Chief of Staff manifest",
        path: "gallery/agents/chief-of-staff/render-harness.yaml",
      },
    ],
    talksTo: ["create-render-agent", "registry"],
    position: { x: -420, y: -120 },
  },
  {
    id: "create-render-agent",
    label: "CLI scaffolder",
    kind: "authoring",
    summary: "Creates new projects from prompts or sealed gallery bundles.",
    owns: ["Project file maps", "Bundle materialization", "Local starter commands"],
    files: [
      { label: "Generator", path: "packages/create-render-agent/src/generate.ts" },
      { label: "Bundle templates", path: "packages/create-render-agent/src/templates/bundle.ts" },
    ],
    talksTo: ["gallery", "registry"],
    position: { x: -160, y: -120 },
  },
  {
    id: "wizard",
    label: "Browser wizard",
    kind: "authoring",
    summary: "Creates managed repos and deploy links from a browser flow.",
    owns: ["Browser onboarding", "GitHub repo creation", "Deploy-to-Render links"],
    files: [
      { label: "Wizard server", path: "packages/wizard/src/main.ts" },
      { label: "Wizard app", path: "packages/wizard/web/src/App.tsx" },
    ],
    talksTo: ["create-render-agent", "registry"],
    position: { x: -160, y: 80 },
  },
  {
    id: "registry",
    label: "Registry",
    kind: "registry",
    summary: "Loads harness config, resolves capability packs, and emits Render infrastructure.",
    owns: [
      "Config schemas",
      "Capability pack loading",
      "Blueprint emission",
      "Deployment planning",
    ],
    files: [
      { label: "Config loader", path: "packages/registry/src/load-config.ts" },
      { label: "Blueprint emitter", path: "packages/registry/src/emitter.ts" },
      { label: "Deploy planner", path: "packages/registry/src/deploy/planner.ts" },
    ],
    talksTo: ["core", "web", "runtime-worker", "runtime-cron", "runtime-workflows"],
    position: { x: 120, y: -20 },
  },
  {
    id: "web",
    label: "Web service",
    kind: "product",
    summary:
      "Public HTTP surface for runs, conversations, streaming, diagnostics, and UI mounting.",
    owns: ["Auth", "Run and conversation routes", "SSE streams", "Optional operator UI mount"],
    files: [
      { label: "Web entrypoint", path: "packages/web/src/index.ts" },
      { label: "Run routes", path: "packages/web/src/routes/runs.ts" },
      { label: "Conversation routes", path: "packages/web/src/routes/conversations.ts" },
    ],
    talksTo: ["runtime-worker", "runtime-workflows", "postgres", "ui"],
    position: { x: 420, y: -180 },
  },
  {
    id: "ui",
    label: "Operator UI",
    kind: "product",
    summary: "React SPA mounted at `/ui` for chat, runs, agents, usage, and guides.",
    owns: ["Chat tab", "Runs tab", "Agents tab", "Usage tab", "Guide tab"],
    files: [
      { label: "SPA root", path: "packages/ui/web/src/App.tsx" },
      { label: "Chat tab", path: "packages/ui/web/src/tabs/ChatTab.tsx" },
      { label: "Guide tab", path: "packages/ui/web/src/tabs/GuideTab.tsx" },
    ],
    talksTo: ["web"],
    position: { x: 700, y: -260 },
  },
  {
    id: "runtime-worker",
    label: "Worker runtime",
    kind: "runtime",
    summary: "Consumes pg-boss jobs and calls the core loop with cooperative cancellation.",
    owns: ["Queue consumption", "Soft checkpoints", "Job result hooks", "Worker shutdown"],
    files: [{ label: "Worker runtime", path: "packages/runtime-worker/src/index.ts" }],
    talksTo: ["core", "postgres", "key-value", "runtime-workflows"],
    position: { x: 700, y: -60 },
  },
  {
    id: "runtime-cron",
    label: "Cron runtime",
    kind: "runtime",
    summary: "Runs scheduled agents directly or acts as a tiny scheduler adapter for Workflows.",
    owns: ["One-shot run creation", "11-hour default budget", "Scheduled workflow triggers"],
    files: [{ label: "Cron runtime", path: "packages/runtime-cron/src/index.ts" }],
    talksTo: ["core", "runtime-workflows", "postgres"],
    position: { x: 420, y: 140 },
  },
  {
    id: "runtime-workflows",
    label: "Workflow runtime",
    kind: "runtime",
    summary: "Runs durable Render Workflow tasks for long or approval-friendly agent work.",
    owns: ["Workflow task triggers", "Agent step execution", "Checkpoint chaining"],
    files: [{ label: "Workflow runtime", path: "packages/runtime-workflows/src/index.ts" }],
    talksTo: ["core", "postgres"],
    position: { x: 700, y: 140 },
  },
  {
    id: "runtime-web",
    label: "Sync web runtime",
    kind: "runtime",
    summary: "Runs a single agent inside an HTTP request for demos and short examples.",
    owns: ["Simple HTTP handler", "In-request agent execution"],
    files: [{ label: "Sync web runtime", path: "packages/runtime-web/src/index.ts" }],
    talksTo: ["core"],
    position: { x: 420, y: 340 },
  },
  {
    id: "core",
    label: "Core loop",
    kind: "core",
    summary: "The shared agent engine used by every runtime.",
    owns: ["Model adapters", "Built-in tools", "MCP", "Prompt assembly", "State writes", "Budgets"],
    files: [
      { label: "Public exports", path: "packages/core/src/index.ts" },
      { label: "Agent loop", path: "packages/core/src/loop.ts" },
      { label: "Built-ins", path: "packages/core/src/builtins/index.ts" },
    ],
    talksTo: ["postgres", "key-value", "capabilities"],
    position: { x: 1000, y: 40 },
  },
  {
    id: "capabilities",
    label: "Capabilities",
    kind: "core",
    summary: "Optional packs that contribute tools, MCP servers, skills, and env requirements.",
    owns: ["Browser pack", "Search packs", "Scrape pack", "Memory pack", "Filesystem pack"],
    files: [
      { label: "Capability contract", path: "packages/registry/src/capability.ts" },
      { label: "Memory pack", path: "packages/capabilities/cap-memory-pg/src/index.ts" },
    ],
    talksTo: ["registry", "core"],
    position: { x: 1000, y: 280 },
  },
  {
    id: "postgres",
    label: "Postgres",
    kind: "primitive",
    summary:
      "Durable source of truth for runs, conversations, messages, results, usage, and queue jobs.",
    owns: [
      "Run state",
      "Message history",
      "Tool results",
      "pg-boss queue",
      "LISTEN/NOTIFY pointers",
    ],
    files: [
      { label: "Schema migration", path: "packages/core/sql/0001_init.sql" },
      { label: "State repo", path: "packages/core/src/state/repo.ts" },
    ],
    talksTo: ["web", "runtime-worker", "runtime-cron", "runtime-workflows", "core"],
    position: { x: 1260, y: -80 },
  },
  {
    id: "key-value",
    label: "Key Value",
    kind: "primitive",
    summary: "Redis-compatible low-latency control plane for cancel flags and locks.",
    owns: ["Cancellation flags", "Runtime locks"],
    files: [
      { label: "Cancel helpers", path: "packages/core/src/cancel.ts" },
      { label: "KV helpers", path: "packages/core/src/kv.ts" },
    ],
    talksTo: ["web", "runtime-worker", "runtime-cron", "core"],
    position: { x: 1260, y: 170 },
  },
];

export const architectureEdges: ArchitectureEdge[] = [
  { id: "gallery-registry", source: "gallery", target: "registry", label: "manifest" },
  { id: "gallery-cli", source: "gallery", target: "create-render-agent", label: "templates" },
  { id: "cli-registry", source: "create-render-agent", target: "registry", label: "validates" },
  { id: "wizard-cli", source: "wizard", target: "create-render-agent", label: "reuses" },
  { id: "registry-web", source: "registry", target: "web", label: "agents map" },
  { id: "registry-worker", source: "registry", target: "runtime-worker", label: "resolver" },
  { id: "registry-cron", source: "registry", target: "runtime-cron", label: "agent id" },
  { id: "registry-workflows", source: "registry", target: "runtime-workflows", label: "tasks" },
  { id: "web-ui", source: "web", target: "ui", label: "mounts" },
  { id: "web-worker", source: "web", target: "runtime-worker", label: "enqueue" },
  { id: "web-workflows", source: "web", target: "runtime-workflows", label: "manual trigger" },
  { id: "worker-core", source: "runtime-worker", target: "core", label: "runAgent" },
  {
    id: "worker-workflows",
    source: "runtime-worker",
    target: "runtime-workflows",
    label: "tool trigger",
  },
  { id: "cron-core", source: "runtime-cron", target: "core", label: "direct run" },
  {
    id: "cron-workflows",
    source: "runtime-cron",
    target: "runtime-workflows",
    label: "scheduled trigger",
  },
  { id: "workflows-core", source: "runtime-workflows", target: "core", label: "runAgentStep" },
  { id: "runtime-web-core", source: "runtime-web", target: "core", label: "in request" },
  { id: "core-capabilities", source: "capabilities", target: "core", label: "tools" },
  { id: "web-postgres", source: "web", target: "postgres", label: "state and queue" },
  { id: "core-postgres", source: "core", target: "postgres", label: "messages" },
  { id: "worker-kv", source: "runtime-worker", target: "key-value", label: "cancel" },
  { id: "core-kv", source: "core", target: "key-value", label: "signals" },
];
