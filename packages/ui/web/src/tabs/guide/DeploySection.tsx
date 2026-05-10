import { useEffect, useState } from "react";
import { ApiError, getBlueprint } from "../../api.js";
import { Markdown } from "../../components/Markdown.js";
import { CTA, CmdBadge, CodeBlock, GuideSectionShell, KV, LivePanel } from "./layout.js";

const PROSE_INTRO = `
The local Compose stack you're running has a one-to-one mapping to a Render Blueprint. Every container becomes a Render service: \`postgres\` becomes a Managed Postgres, \`valkey\` becomes Render Key Value, \`operator-demo-web\` becomes a public web service, \`operator-demo-worker\` becomes a private service. The harness uses the same image and same code; only the runtime layout changes.
`;

const PROSE_BLUEPRINT = `
### The Blueprint

A starter \`render.yaml\` that matches your loaded agent is just one HTTP call away — see the live panel on the right. The shape mirrors [\`blueprints/render.private.yaml\`](https://github.com/render/render-harness/blob/main/blueprints/render.private.yaml):

- a managed Postgres for state + queue
- Render Key Value for cancel signals
- a public \`type: web\` for the operator UI / JSON API
- a private \`type: pserv\` for the worker

Why private for the worker? It runs the agent loop, which means it talks to model providers and (sometimes) third-party MCP servers. Putting it on the private network keeps DB and KV traffic off the public internet — the only outbound is to the model and any MCP endpoints.
`;

const PROSE_ENV = `
### Required env vars

Each generated service needs these set in the Render Dashboard before the first deploy:

- **\`WEB_API_KEY\`** — bearer token for the JSON API and the operator UI's login form. Use a strong shared secret.
- **\`UI_COOKIE_SECRET\`** — Render generates this automatically with \`generateValue: true\` in the Blueprint. Don't override.
- **\`ANTHROPIC_API_KEY\`** (or \`OPENAI_API_KEY\`, etc., based on your model adapter) — model provider key.
- Pack-specific keys (e.g. \`EXA_API_KEY\`, \`RENDER_API_KEY\`) — only the ones you've actually wired in.
`;

const PROSE_DEPLOY = `
### Deploy

1. Push the repo (with your edited \`agent.ts\`) to GitHub.
2. In the Render Dashboard, **New → Blueprint**, point it at your repo's \`render.yaml\`.
3. Render reads the file, prompts for the \`sync: false\` env vars, and provisions all four services together.
4. Once the build finishes, your operator UI is at the assigned \`*.onrender.com\` URL plus \`/ui\`.

For zero-downtime rolling deploys, keep the agent's \`shape: "chat"\` runs idempotent (each turn is independent state-wise) and let Render's rolling deploy handle the rest. Worker jobs in flight finish before the old container exits — the worker has a SIGTERM handler that waits up to 30s for in-flight runs.
`;

const PROSE_OTHER_RUNTIMES = `
### Other runtimes

Operator-demo focuses on \`runtime-web\` + \`runtime-worker\`. The harness has two more:

- [\`runtime-cron\`](https://github.com/render/render-harness/tree/main/packages/runtime-cron) — one-shot scheduled runs, max 12 hours each. See the [\`citations-monitor\`](https://github.com/render/render-harness/tree/main/examples/citations-monitor) example.
- [\`runtime-workflows\`](https://github.com/render/render-harness/tree/main/packages/runtime-workflows) — durable, multi-day, human-in-the-loop. See the [\`deploy-agent\`](https://github.com/render/render-harness/tree/main/examples/deploy-agent) example.

Same \`AgentDefinition\`. Same skills. Same MCP wiring. Different deploy shape.
`;

export function DeploySection() {
  return (
    <GuideSectionShell
      title="deploy — go to render"
      lede="Local Compose stack → render.yaml. One file, four services."
      body={
        <>
          <Markdown text={PROSE_INTRO} />
          <Markdown text={PROSE_BLUEPRINT} />

          <p className="text-xs text-muted">
            Want to see the generated yaml inline? The live panel on the right has a "fetch
            blueprint" button — it returns a starter file based on the agent and queue this
            instance is configured with.
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
              <CmdBadge cmd="render logs --tail --service <service>" />
            </div>
          </div>

          <Markdown text={PROSE_OTHER_RUNTIMES} />
        </>
      }
      livePanel={<DeployLivePanel />}
    />
  );
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
