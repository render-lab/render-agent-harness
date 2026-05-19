import { useState } from "react";
import { ApiError, getBlueprint } from "../../api.js";
import { Markdown } from "../../components/Markdown.js";
import { useDeployment, useDeploymentName } from "../../deployment-context.js";
import { CmdBadge, CodeBlock, CTA, GuideSectionShell, KV, LivePanel } from "./layout.js";

function buildIntro(name: string): string {
  return `
The local Compose stack you're running has a one-to-one mapping to a Render Blueprint. Every container becomes a Render resource: \`postgres\` becomes a Managed Postgres, \`valkey\` becomes Render Key Value, \`${name}-web\` becomes a public web service, and \`${name}-worker\` becomes a background worker. Render Loops uses the same image and same code; only the runtime layout changes.
`;
}

const PROSE_BLUEPRINT = `
### The Blueprint

A starter \`render.yaml\` that matches your loaded agent is just one HTTP call away — see the live panel on the right. The shape mirrors [\`blueprints/render.private.yaml\`](https://github.com/render/render-harness/blob/main/blueprints/render.private.yaml):

- a managed Postgres for state + queue
- Render Key Value for cancel signals
- a public \`type: web\` for the agent console / JSON API
- a background \`type: worker\` for the queue consumer

Why a background worker? It runs the agent loop, drains jobs from the queue, and doesn't accept inbound HTTP traffic.
`;

const PROSE_ENV = `
### Required env vars

Each generated service needs these set in the Render Dashboard before the first deploy:

- **\`WEB_API_KEY\`** — bearer token for the JSON API and the agent console's login form. Use a strong shared secret.
- **\`UI_COOKIE_SECRET\`** — Render generates this automatically with \`generateValue: true\` in the Blueprint. Don't override.
- **\`ANTHROPIC_API_KEY\`** (or \`OPENAI_API_KEY\`, etc., based on your model adapter) — model provider key.
- Pack-specific keys (e.g. \`EXA_API_KEY\`, \`RENDER_API_KEY\`) — only the ones you've actually wired in.
`;

const PROSE_DEPLOY = `
### Deploy

1. Push the repo (with your edited \`agent.ts\`) to GitHub.
2. In the Render Dashboard, **New → Blueprint**, point it at your repo's \`render.yaml\`.
3. Render reads the file, prompts for the \`sync: false\` env vars, and provisions all four services together.
4. Once the build finishes, the agent console is at the assigned \`*.onrender.com\` URL.

For zero-downtime rolling deploys, keep each conversation turn idempotent (state lives in \`agent_conversations\` + \`agent_runs\`, not in process memory) and let Render's rolling deploy handle the rest. Worker jobs in flight finish before the old container exits — the worker has a SIGTERM handler that waits up to 30s for in-flight runs.
`;

function buildOtherRuntimes(used: Set<string>): string {
  const usedList = [...used].map((k) => `\`runtime-${k}\``).join(" + ");
  const cronUsed = used.has("cron");
  const wfUsed = used.has("workflows");
  const remaining: string[] = [];
  if (!used.has("web")) {
    remaining.push(
      "- [`runtime-web`](https://github.com/render/render-harness/tree/main/packages/runtime-web) — synchronous HTTP shape (sub-30s). The bundled `runtime-worker` pair (above) is the multi-tenant production default.",
    );
  }
  if (!cronUsed) {
    remaining.push(
      "- [`runtime-cron`](https://github.com/render/render-harness/tree/main/packages/runtime-cron) — one-shot scheduled runs, max 12 hours each. See the [`citations-monitor`](https://github.com/render/render-harness/tree/main/examples/citations-monitor) example.",
    );
  }
  if (!wfUsed) {
    remaining.push(
      "- [`runtime-workflows`](https://github.com/render/render-harness/tree/main/packages/runtime-workflows) — durable, multi-day, human-in-the-loop. See the [`deploy-agent`](https://github.com/render/render-harness/tree/main/examples/deploy-agent) example.",
    );
  }
  if (remaining.length === 0) {
    return `\n### Other runtimes\n\nThis bundle already uses every runtime adapter Render Loops ships (${usedList}). Same \`AgentDefinition\` would run unchanged on any of them. Different deploy shape, same code.\n`;
  }
  return `\n### Other runtimes\n\nThis bundle uses ${usedList}. Render Loops also ships:\n\n${remaining.join("\n")}\n\nSame \`AgentDefinition\`. Same skills. Same MCP wiring. Different deploy shape.\n`;
}

export function DeploySection() {
  const name = useDeploymentName();
  const deployment = useDeployment();
  const services = deriveServiceList(name, deployment);
  const usedRuntimes = new Set<string>();
  for (const a of deployment?.agents ?? []) {
    for (const rt of a.runtimes) usedRuntimes.add(rt.kind);
    if (a.workflowTask) usedRuntimes.add("workflows");
  }
  return (
    <GuideSectionShell
      title="deploy — go to render"
      lede="Local Compose stack → render.yaml. One file, every service."
      body={
        <>
          <Markdown text={buildIntro(name)} />
          {services.length > 0 && (
            <div className="border border-line p-3 text-xs">
              <div className="label mb-2">{"// services this bundle deploys"}</div>
              <ul className="space-y-1 font-mono">
                {services.map((s) => (
                  <li key={s.label}>
                    <code className="bg-code-bg px-1">{s.label}</code> — {s.role}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <Markdown text={PROSE_BLUEPRINT} />

          <p className="text-xs text-muted">
            Want to see the generated yaml inline? The live panel on the right has a "fetch
            blueprint" button — it returns a starter file based on the agent and queue this instance
            is configured with.
          </p>

          <Markdown text={PROSE_ENV} />
          <Markdown text={PROSE_DEPLOY} />

          <h3 className="label mt-6">handy commands</h3>
          <div className="space-y-2 text-xs">
            <div>
              Validate your Blueprint locally before pushing:{" "}
              <CmdBadge cmd="render blueprints validate render.yaml" />
            </div>
            <div>
              Tail logs in production:{" "}
              <CmdBadge cmd={`render logs --tail --service ${name}-worker`} />
            </div>
          </div>

          <Markdown text={buildOtherRuntimes(usedRuntimes)} />
        </>
      }
      livePanel={<DeployLivePanel />}
    />
  );
}

/**
 * Build the per-service preview list shown above the Blueprint prose.
 * Mirrors how the emitter coalesces runtimes: one web + one worker
 * service total (shared across agents), one cron-job per cron runtime
 * fanned out per-agent, plus the dashboard-provisioned Workflow service
 * when any agent is a workflow task.
 */
interface ServiceRow {
  label: string;
  role: string;
}
function deriveServiceList(
  bundleName: string,
  deployment: ReturnType<typeof useDeployment>,
): ServiceRow[] {
  if (!deployment) return [];
  const rows: ServiceRow[] = [];
  const kinds = new Set<string>();
  let hasWorkflowTask = false;
  for (const a of deployment.agents) {
    if (a.workflowTask) hasWorkflowTask = true;
    for (const rt of a.runtimes) {
      kinds.add(rt.kind);
      if (rt.kind === "cron") {
        rows.push({
          label:
            rt.via === "workflow"
              ? `${bundleName}-cron-trigger-${a.id}`
              : `${bundleName}-cron-${a.id}`,
          role:
            rt.via === "workflow"
              ? `triggers ${a.id} as a workflow task on \`${rt.schedule}\``
              : `runs ${a.id} inline on \`${rt.schedule}\``,
        });
      }
    }
  }
  if (kinds.has("web")) {
    rows.unshift({
      label: `${bundleName}-web`,
      role: "public HTTP / SSE + agent console",
    });
  }
  if (kinds.has("worker")) {
    const webIdx = rows.findIndex((r) => r.label === `${bundleName}-web`);
    rows.splice(webIdx + 1, 0, {
      label: `${bundleName}-worker`,
      role: "background worker — pulls jobs from the pg-boss queue",
    });
  }
  if (hasWorkflowTask) {
    rows.push({
      label: `${bundleName}-workflows`,
      role: "Render Workflows service (Dashboard-provisioned)",
    });
  }
  return rows;
}

function DeployLivePanel() {
  const [yaml, setYaml] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [copied, setCopied] = useState(false);

  const fetchYaml = () => {
    setLoading(true);
    setError(null);
    setCopied(false);
    getBlueprint()
      .then((y) => setYaml(y))
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) return;
        setError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => setLoading(false));
  };

  const copyYaml = () => {
    if (!yaml) return;
    void navigator.clipboard.writeText(yaml);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <LivePanel title="blueprint">
      <KV
        k="endpoint"
        v={
          <a
            href="/blueprint"
            target="_blank"
            rel="noreferrer noopener"
            className="text-accent hover:underline"
          >
            GET /blueprint
          </a>
        }
      />
      {!yaml && (
        <CTA
          label={loading ? "fetching…" : "generate blueprint"}
          hint="render.yaml"
          onClick={fetchYaml}
        />
      )}
      {error && <div className="text-err">{error.message}</div>}
      {yaml && (
        <div className="mt-2 space-y-2">
          <div className="flex items-center justify-between">
            <span className="label">render.yaml ({yaml.length.toLocaleString()} chars)</span>
            <button
              type="button"
              onClick={copyYaml}
              className="border border-line px-2 py-0.5 text-[10px] uppercase tracking-wider hover:border-accent hover:text-accent"
            >
              {copied ? "copied!" : "copy"}
            </button>
          </div>
          <CodeBlock language="render.yaml">{yaml}</CodeBlock>
          <CTA
            label="open Render dashboard"
            hint="new blueprint"
            href="https://dashboard.render.com/blueprints"
          />
        </div>
      )}
    </LivePanel>
  );
}
