import { useEffect, useState } from "react";
import {
  type AgentSummary,
  ApiError,
  type DiagnosticCheck,
  getDiagnostics,
  listAgents,
} from "../../api.js";
import { Markdown } from "../../components/Markdown.js";
import { CmdBadge, CTA, GuideSectionShell, KV, LivePanel } from "./layout.js";

const PROSE = `
You're looking at the **operator-demo** stack — the smallest end-to-end shape of the Render agent harness. Everything you see in the UI is powered by four cooperating containers running locally via Docker Compose:

- \`operator-demo-web\` — the public web service. It serves this UI, exposes the JSON+SSE API (\`/runs\`, \`/agents\`, \`/usage\`, \`/diagnostics\`), and enqueues new run jobs onto a Postgres-backed queue.
- \`operator-demo-worker\` — a separate process that pulls jobs off the queue and actually drives the agent loop. Same image as the web service, just a different command.
- \`postgres\` — durable state. Runs, messages, tool calls, and the queue itself all live here.
- \`valkey\` — Redis-compatible. Holds short-lived signals like cancel flags. Cancellation only works because we have it.

When you send a chat message:

1. Your browser POSTs to \`/runs\` (or \`/runs/:id/input\` on a follow-up turn).
2. The web service persists the message and pushes a job onto the queue in Postgres.
3. The worker pulls the job, calls Anthropic, writes assistant messages back to Postgres, and emits Postgres \`NOTIFY\` events.
4. The web service tails \`NOTIFY\` and forwards everything to your browser as Server-Sent Events on \`/runs/:id/stream\`.

That separation is deliberate: the public web service stays cheap and stateless, the worker can be put on the private network in production. The same code shape works for Slack agents, scheduled jobs, and durable Workflows tasks — only the runtime adapter changes.
`;

export function TourSection() {
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
          <Markdown text={PROSE} />
          <Diagram />
          <h3 className="label mt-6">peek at the wiring</h3>
          <p>
            From your shell, watch what each container is doing right now:
          </p>
          <div className="space-y-2">
            <div>
              <CmdBadge cmd="docker compose logs -f operator-demo-worker" /> — agent
              loop, model calls, tool use.
            </div>
            <div>
              <CmdBadge cmd="docker compose logs -f operator-demo-web" /> — HTTP
              requests, SSE streams.
            </div>
            <div>
              <CmdBadge cmd="docker compose exec postgres psql -U harness -d harness" />{" "}
              — runs and messages live in <code className="bg-code-bg px-1">agent_runs</code>
              {" "}and <code className="bg-code-bg px-1">agent_messages</code>.
            </div>
            <div>
              <CmdBadge cmd="docker compose exec valkey valkey-cli" /> — try{" "}
              <code className="bg-code-bg px-1">KEYS cancel:*</code> after you click cancel
              on an active run.
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
              <KV
                k="warnings"
                v={String(checks.filter((c) => c.level === "warn").length)}
              />
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

/** ASCII container diagram — rendered as a <pre> for monospace alignment. */
function Diagram() {
  return (
    <pre className="my-3 overflow-x-auto border border-line p-3 text-[11px] leading-relaxed">
{`                              ┌──────────────────────────┐
   browser  ──── HTTP ───►     │   operator-demo-web      │  serves /ui, /runs, SSE
                              │   serveWeb({ ui: true }) │
                              └────────────┬─────────────┘
                                           │
                                           │ enqueue job  (pg-boss)
                                           ▼
                              ┌──────────────────────────┐
                              │   postgres               │  agent_runs, agent_messages,
                              │   queue + state          │  agent_tool_calls, pgboss.job
                              └────────────┬─────────────┘
                                           │
                                           │ pull job  (LISTEN/NOTIFY)
                                           ▼
                              ┌──────────────────────────┐
                              │   operator-demo-worker   │  startWorkerAndWait
                              │   runs the agent loop    │  → Anthropic / MCP servers
                              └────────────┬─────────────┘
                                           │
                                           │ cancel signal (TTL)
                                           ▼
                              ┌──────────────────────────┐
                              │   valkey  (KV)           │  cancel:<runId>
                              └──────────────────────────┘`}
    </pre>
  );
}
