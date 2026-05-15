import { useEffect, useState } from "react";
import {
  type AgentSummary,
  ApiError,
  type DeploymentAgentInfo,
  type DeploymentInfo,
  type DiagnosticCheck,
  getDiagnostics,
  listAgents,
} from "../../api.js";
import { Markdown } from "../../components/Markdown.js";
import { useDeployment, useDeploymentName } from "../../deployment-context.js";
import { CmdBadge, CTA, GuideSectionShell, KV, LivePanel } from "./layout.js";

function buildProse(name: string): string {
  return `
You're looking at the **${name}** stack — an end-to-end agent deployment built on the Render agent harness. Everything you see in the UI is powered by four cooperating containers running locally via Docker Compose:

- \`${name}-web\` — the public web service. It serves this UI, exposes the JSON+SSE API (\`/runs\`, \`/agents\`, \`/usage\`, \`/diagnostics\`), and enqueues new run jobs onto a Postgres-backed queue.
- \`${name}-worker\` — a separate process that pulls jobs off the queue and actually drives the agent loop. Same image as the web service, just a different command.
- \`postgres\` — durable state. Runs, messages, tool calls, and the queue itself all live here.
- \`valkey\` — Redis-compatible. Holds short-lived signals like cancel flags. Cancellation only works because we have it.

When you send a chat message:

1. Your browser POSTs to \`/runs\` (or \`/runs/:id/input\` on a follow-up turn).
2. The web service persists the message and pushes a job onto the queue in Postgres.
3. The worker pulls the job, calls Anthropic, writes assistant messages back to Postgres, and emits Postgres \`NOTIFY\` events.
4. The web service tails \`NOTIFY\` and forwards everything to your browser as Server-Sent Events on \`/runs/:id/stream\`.

That separation is deliberate: the public web service stays cheap and stateless, the worker can be put on the private network in production. The same code shape works for Slack agents, scheduled jobs, and durable Workflows tasks — only the runtime adapter changes.
`;
}

export function TourSection() {
  const name = useDeploymentName();
  const deployment = useDeployment();
  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [checks, setChecks] = useState<DiagnosticCheck[] | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([listAgents(), getDiagnostics()])
      .then(([a, d]) => {
        if (cancelled) return;
        setAgents(a.agents);
        setChecks(d.checks);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) return;
        setError(err instanceof Error ? err : new Error(String(err)));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <GuideSectionShell
      title="tour — what's running"
      lede="Five minutes from cold-start to grokking the moving parts."
      body={
        <>
          <Markdown text={buildProse(name)} />
          <Diagram name={name} deployment={deployment} />
          <h3 className="label mt-6">peek at the wiring</h3>
          <p>From your shell, watch what each container is doing right now:</p>
          <div className="space-y-2">
            <div>
              <CmdBadge cmd={`docker compose logs -f ${name}-worker`} /> — agent loop, model calls,
              tool use.
            </div>
            <div>
              <CmdBadge cmd={`docker compose logs -f ${name}-web`} /> — HTTP requests, SSE streams.
            </div>
            <div>
              <CmdBadge cmd="docker compose exec postgres psql -U harness -d harness" /> — runs and
              messages live in <code className="bg-code-bg px-1">agent_runs</code> and{" "}
              <code className="bg-code-bg px-1">agent_messages</code>.
            </div>
            <div>
              <CmdBadge cmd="docker compose exec valkey valkey-cli" /> — try{" "}
              <code className="bg-code-bg px-1">KEYS cancel:*</code> after you click cancel on an
              active run.
            </div>
          </div>
        </>
      }
      livePanel={
        <LivePanel title="this deployment">
          {error ? (
            <div className="text-err">{error.message}</div>
          ) : !agents || !checks ? (
            <div className="text-muted">loading…</div>
          ) : (
            <>
              <KV
                k="agents loaded"
                v={
                  agents.length === 0
                    ? "0"
                    : `${agents.length} (${agents.map((a) => a.name).join(", ")})`
                }
              />
              <KV k="health" v={summariseChecks(checks)} />
              <KV k="errors" v={String(checks.filter((c) => c.level === "error").length)} />
              <KV k="warnings" v={String(checks.filter((c) => c.level === "warn").length)} />
              <div className="hairline-top mt-3 border-t border-line pt-3">
                <CTA
                  label="see all checks"
                  hint="diagnostics"
                  onClick={() => {
                    window.location.hash = "#/usage"; // diagnostics doesn't have its own tab; banner shows everything
                  }}
                />
              </div>
            </>
          )}
        </LivePanel>
      }
    />
  );
}

function summariseChecks(checks: DiagnosticCheck[]): string {
  const errors = checks.filter((c) => c.level === "error").length;
  const warns = checks.filter((c) => c.level === "warn").length;
  if (errors > 0) return "needs attention";
  if (warns > 0) return "ok with warnings";
  return "all good";
}

/**
 * Topology diagram — rendered as a <pre> for monospace alignment.
 * Reads the deployment info to draw the actual service set: web/worker
 * if present, one row per inline cron, one row per cron-trigger, and a
 * Workflows row when the bundle has workflow-task agents.
 *
 * If deployment info isn't loaded yet, falls back to the canonical
 * web+worker layout — better than a blank box while the fetch resolves.
 */
function Diagram({ name, deployment }: { name: string; deployment: DeploymentInfo | null }) {
  const lines = deployment
    ? buildTopologyLines(name, deployment)
    : buildTopologyLines(name, fallbackDeployment(name));
  return (
    <pre className="my-3 overflow-x-auto border border-line p-3 text-[11px] leading-relaxed">
      {lines.join("\n")}
    </pre>
  );
}

function fallbackDeployment(name: string): DeploymentInfo {
  return {
    name,
    agents: [
      {
        id: name,
        name,
        runtimes: [{ kind: "web" }, { kind: "worker" }],
        workflowTask: false,
      },
    ],
  };
}

const BOX_WIDTH = 28;

function buildTopologyLines(name: string, deployment: DeploymentInfo): string[] {
  const kinds = new Set<string>();
  const inlineCrons: DeploymentAgentInfo[] = [];
  const cronTriggers: DeploymentAgentInfo[] = [];
  const workflowTasks: DeploymentAgentInfo[] = [];
  for (const agent of deployment.agents) {
    if (agent.workflowTask) workflowTasks.push(agent);
    for (const rt of agent.runtimes) {
      kinds.add(rt.kind);
      if (rt.kind === "cron") {
        if (rt.via === "workflow") cronTriggers.push(agent);
        else inlineCrons.push(agent);
      }
    }
  }
  const hasWeb = kinds.has("web");
  const hasWorker = kinds.has("worker");
  const hasWorkflows = workflowTasks.length > 0;

  const out: string[] = [];
  if (hasWeb) {
    out.push(...drawBox(`${name}-web`, "serves /ui, /runs, SSE"));
    if (hasWorker) out.push(...arrow("enqueue job  (pg-boss)"));
  }
  out.push(...drawBox("postgres", "agent_runs · agent_messages · pgboss.job"));
  if (hasWorker) {
    out.push(...arrow("pull job  (LISTEN/NOTIFY)"));
    out.push(...drawBox(`${name}-worker`, "startWorkerAndWait → model / MCP"));
  }
  out.push(...arrow("cancel signal (TTL)"));
  out.push(...drawBox("valkey (KV)", "cancel:<runId>"));

  for (const agent of inlineCrons) {
    out.push("");
    out.push(...drawBox(`${name}-cron-${agent.id}`, "inline agent loop"));
    out.push(`     ${gutter()}── runs ${agent.id} on its schedule`);
  }
  for (const agent of cronTriggers) {
    out.push("");
    out.push(...drawBox(`${name}-cron-trigger-${agent.id}`, "calls render.workflows.runTask"));
    out.push(`     ${gutter()}── starts ${agent.id} workflow task`);
  }
  if (hasWorkflows) {
    out.push("");
    out.push(
      ...drawBox(
        `${name}-workflows`,
        `Render Workflows · ${workflowTasks.length} task${workflowTasks.length === 1 ? "" : "s"}`,
      ),
    );
    out.push(`     ${gutter()}── tasks: ${workflowTasks.map((a) => a.id).join(", ")}`);
  }
  return out;
}

function drawBox(title: string, sub: string): string[] {
  const top = `     ┌${"─".repeat(BOX_WIDTH)}┐`;
  const titleLine = `     │ ${pad(title, BOX_WIDTH - 2)} │  ${sub}`;
  const bottom = `     └${"─".repeat(BOX_WIDTH)}┘`;
  return [top, titleLine, bottom];
}

function arrow(label: string): string[] {
  return [`     ${gutter()}`, `     ${gutter()}  ${label}`, `     ${gutter()}`];
}

function gutter(): string {
  return `${" ".repeat(Math.floor(BOX_WIDTH / 2))}│`;
}

function pad(s: string, width: number): string {
  if (s.length >= width) return `${s.slice(0, width - 1)}…`;
  return s.padEnd(width, " ");
}
