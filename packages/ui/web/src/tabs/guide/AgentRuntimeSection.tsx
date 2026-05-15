import { useEffect, useState } from "react";
import { type AgentSummary, ApiError, listAgents } from "../../api.js";
import { Markdown } from "../../components/Markdown.js";
import { useDeployment, useDeploymentName } from "../../deployment-context.js";
import { CodeBlock, GuideSectionShell, KV, LivePanel } from "./layout.js";

const PROSE_AGENT = `
Every agent in the harness is just a value passed to \`defineAgent()\`. There's no class hierarchy and no implicit registry — what you write is what runs. The example below shows the canonical shape of an agent declaration:
`;

function buildRuntimeProse(name: string, hasWorker: boolean): string {
  const runtimes = [
    "- `@render-harness/web` — multi-tenant HTTP service. Mounts the UI, exposes `/runs`, persists messages, streams via SSE, doesn't call the model itself.",
    hasWorker
      ? "- `@render-harness/runtime-worker` — long-lived process. Pulls jobs from a Postgres queue (pg-boss) and runs the agent loop."
      : "- `@render-harness/runtime-web` — single-process synchronous shape. Runs the agent loop inline in the request handler. Best for sub-30s interactions.",
  ];
  return `
The agent is a value; the runtime is what actually drives it. The harness ships four runtime adapters that share the same loop in \`@render-harness/core\`. **${name}** uses ${
    hasWorker ? "the web + worker pair" : "the single-process web runtime"
  }:

${runtimes.join("\n")}

${
  hasWorker
    ? "Both processes load the **same agent definition** from `render-harness.yaml` via `defineFromConfig()`. One agent, two adapters, separate scaling."
    : "The web service loads the agent definition from `render-harness.yaml` via `defineFromConfig()` and runs the agent loop in-process — no separate worker needed."
}

For other shapes the harness has \`@render-harness/runtime-cron\` (one-shot scheduled runs) and \`@render-harness/runtime-workflows\` (durable, multi-day, human-in-the-loop). Same \`AgentDefinition\` runs unchanged on any of them.
`;
}

const PROSE_CHAT_SHAPE = `
Multi-turn chat is built on \`agent_conversations\`: one row groups many runs together. Each user turn enqueues a fresh run on the same \`conversationId\`; the run loads message history across every prior run in the conversation, completes normally, and the next user turn starts another run. The Chat tab uses \`POST /conversations/:id/messages\` for every turn and subscribes to \`GET /conversations/:id/stream\` (which stays open across run boundaries). Runs always end in a terminal state — \`paused\` is now strictly HITL (\`ask_user\`, approval gates), never "waiting for the next user message."
`;

export function AgentRuntimeSection() {
  const name = useDeploymentName();
  const deployment = useDeployment();
  const hasWorker = (deployment?.agents ?? []).some((a) =>
    a.runtimes.some((r) => r.kind === "worker"),
  );
  const queueName = `${name}-runs`;
  return (
    <GuideSectionShell
      title="agent + runtime — the smallest moving parts"
      lede={
        hasWorker
          ? "One AgentDefinition, two adapters, one shared agent loop."
          : "One AgentDefinition, one runtime adapter, one shared agent loop."
      }
      body={
        <>
          <Markdown text={PROSE_AGENT} />
          <CodeBlock language="src/agent.ts">
            {`import { type AgentDefinition, defineAgent } from "@render-harness/core";

const SYSTEM_PROMPT = \`\\
You are a helpful agent. Read the latest user message in context with
the prior turns and respond in Markdown.

Keep answers short — usually one or two paragraphs.\`;

export function buildAgent(): AgentDefinition {
  return defineAgent({
    name: "${name}",
    version: "0.1.0",
    model: {
      provider: "anthropic",
      model: process.env.LLM_MODEL ?? "claude-sonnet-4-6",
    },
    systemPrompt: SYSTEM_PROMPT,
    sampling: { temperature: 0.4, maxOutputTokens: 1024 },
  });
}`}
          </CodeBlock>

          <Markdown text={buildRuntimeProse(name, hasWorker)} />
          {hasWorker ? (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <CodeBlock language="src/web.ts">
                {`import { serveWeb } from "@render-harness/web";
import { buildAgent } from "./agent.js";

await serveWeb({
  agent: buildAgent(),
  queue: process.env.WORKER_QUEUE ?? "${queueName}",
  ui: true,
});`}
              </CodeBlock>
              <CodeBlock language="src/worker.ts">
                {`import { startWorkerAndWait } from "@render-harness/runtime-worker";
import { buildAgent } from "./agent.js";

await startWorkerAndWait({
  agent: buildAgent(),
  queue: process.env.WORKER_QUEUE ?? "${queueName}",
});`}
              </CodeBlock>
            </div>
          ) : (
            <CodeBlock language="src/web.ts">
              {`import { serveAgent } from "@render-harness/runtime-web";
import { buildAgent } from "./agent.js";

await serveAgent({ agent: buildAgent() });`}
            </CodeBlock>
          )}

          {hasWorker && (
            <>
              <h3 className="label mt-6">why two processes?</h3>
              <p>
                Splitting the public API from the agent loop lets you scale them independently and
                put the worker on the private network in production. The web service stays cheap,
                predictable, and answerable to load balancers; the worker can be CPU-heavy and run
                for hours without breaking the request budget.
              </p>
              <p>
                Locally they share the same image — Compose just runs{" "}
                <code className="bg-code-bg px-1">node dist/web.js</code> for one and{" "}
                <code className="bg-code-bg px-1">node dist/worker.js</code> for the other.
              </p>
            </>
          )}

          <h3 className="label mt-6">how multi-turn chat works</h3>
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
