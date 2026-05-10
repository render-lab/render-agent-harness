import { useEffect, useState } from "react";
import { type AgentSummary, ApiError, listAgents } from "../../api.js";
import { Markdown } from "../../components/Markdown.js";
import { CodeBlock, GuideSectionShell, KV, LivePanel } from "./layout.js";

const PROSE_AGENT = `
Every agent in the harness is just a value passed to \`defineAgent()\`. There's no class hierarchy and no implicit registry — what you write is what runs. This is the entire definition of the demo agent you're chatting with right now:
`;

const PROSE_RUNTIME = `
The agent is a value; the runtime is what actually drives it. The harness ships four runtime adapters that share the same loop in \`@render-harness/core\`. Operator-demo uses two of them:

- \`@render-harness/web\` — multi-tenant HTTP service. Mounts the UI, exposes \`/runs\`, persists messages, streams via SSE, doesn't call the model itself.
- \`@render-harness/runtime-worker\` — long-lived process. Pulls jobs from a Postgres queue (pg-boss) and runs the agent loop.

Both processes load the **same agent definition** by importing \`buildDemoAgent()\`. That's the whole story — one agent, two adapters, separate scaling.

For other shapes the harness has \`@render-harness/runtime-cron\` (one-shot scheduled runs) and \`@render-harness/runtime-workflows\` (durable, multi-day, human-in-the-loop). Same \`AgentDefinition\` runs unchanged on any of them.
`;

const PROSE_CHAT_SHAPE = `
\`shape: "chat"\` is what makes the conversation feel like a chat. After each model response with no tool calls, the run transitions to \`paused\` instead of \`completed\`. The Chat tab uses \`POST /runs/:id/input\` to append the next user message and re-enqueues the same run. The whole conversation lives on one persistent \`agent_runs\` row, with metadata like \`pauseReason: "chat_turn_end"\` so the operator can tell chat-shape runs apart from one-shots.
`;

export function AgentRuntimeSection() {
  return (
    <GuideSectionShell
      title="agent + runtime — the smallest moving parts"
      lede="One AgentDefinition, two adapters, one shared agent loop."
      body={
        <>
          <Markdown text={PROSE_AGENT} />
          <CodeBlock language="examples/operator-demo/src/agent.ts">
{`import { type AgentDefinition, defineAgent } from "@render-harness/core";

const SYSTEM_PROMPT = \`\\
You are a friendly demo agent running behind the Render harness
operator UI. Read the latest user message in context with the prior
turns and respond in Markdown.

Keep answers short — usually one or two paragraphs.\`;

export function buildDemoAgent(): AgentDefinition {
  return defineAgent({
    name: "operator-demo",
    version: "0.2.0",
    model: {
      provider: "anthropic",
      model: process.env.LLM_MODEL ?? "claude-sonnet-4-6",
    },
    systemPrompt: SYSTEM_PROMPT,
    sampling: { temperature: 0.4, maxOutputTokens: 1024 },
    shape: "chat",
  });
}`}
          </CodeBlock>

          <Markdown text={PROSE_RUNTIME} />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <CodeBlock language="src/web.ts">
{`import { serveWeb } from "@render-harness/web";
import { buildDemoAgent } from "./agent.js";

await serveWeb({
  agent: buildDemoAgent(),
  queue: process.env.WORKER_QUEUE ?? "operator-demo-runs",
  ui: true,
});`}
            </CodeBlock>
            <CodeBlock language="src/worker.ts">
{`import { startWorkerAndWait } from "@render-harness/runtime-worker";
import { buildDemoAgent } from "./agent.js";

await startWorkerAndWait({
  agent: buildDemoAgent(),
  queue: process.env.WORKER_QUEUE ?? "operator-demo-runs",
});`}
            </CodeBlock>
          </div>

          <h3 className="label mt-6">why two processes?</h3>
          <p>
            Splitting the public API from the agent loop lets you scale them independently and put the worker on the private network in production. The web service stays cheap, predictable, and answerable to load balancers; the worker can be CPU-heavy and run for hours without breaking the request budget.
          </p>
          <p>
            Locally they share the same image — Compose just runs <code className="bg-code-bg px-1">node dist/web.js</code> for one and <code className="bg-code-bg px-1">node dist/worker.js</code> for the other.
          </p>

          <h3 className="label mt-6">why "chat" shape?</h3>
          <Markdown text={PROSE_CHAT_SHAPE} />
        </>
      }
      livePanel={<AgentLivePanel />}
    />
  );
}

function AgentLivePanel() {
  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    listAgents()
      .then((res) => {
        if (cancelled) return;
        setAgents(res.agents);
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
    <LivePanel title="loaded agent">
      {error ? (
        <div className="text-err">{error.message}</div>
      ) : !agents ? (
        <div className="text-muted">loading…</div>
      ) : agents[0] ? (
        <>
          <KV k="name" v={agents[0].name} />
          <KV k="version" v={agents[0].version} />
          <KV k="model" v={`${agents[0].model.provider}/${agents[0].model.model}`} />
          <KV k="prompt" v={`${agents[0].systemPromptLength.toLocaleString()} chars`} />
          <KV k="mcp servers" v={String(agents[0].mcpServers.length)} />
          <KV k="local tools" v={agents[0].hasLocalTools ? "yes" : "no"} />
          <KV k="skills" v={agents[0].hasSkills ? "yes" : "no"} />
        </>
      ) : (
        <div className="text-muted">no agents loaded</div>
      )}
    </LivePanel>
  );
}
