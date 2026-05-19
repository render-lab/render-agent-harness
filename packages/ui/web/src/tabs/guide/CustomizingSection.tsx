import { formatDistanceToNowStrict, parseISO } from "date-fns";
import { useEffect, useState } from "react";
import { type AgentSummary, ApiError, getHealth, type HealthInfo, listAgents } from "../../api.js";
import { Markdown } from "../../components/Markdown.js";
import { useDeploymentName } from "../../deployment-context.js";
import { CmdBadge, CodeBlock, GuideSectionShell, KV, LivePanel } from "./layout.js";

const PROSE_INTRO = `
Three changes you'll likely make first. Each is a one or two-line edit in \`render-harness.yaml\` (or the agent's TS source). Restart the dev process — \`tsx\` watches for changes and reboots the runtimes in a couple of seconds. No image rebuild, no reinstall, no Docker layer cache fights.
`;

const RELOAD_CMD = "pnpm dev";

const PROSE_PROMPT = `
### 1. Change the system prompt

It's a string. Replace it with whatever shape you want the agent to take — a customer-support persona, a coding assistant, a bedtime-story writer.
`;

const PROSE_MODEL = `
### 2. Swap the model

Render Loops has two model adapters: \`anthropic\` (direct Anthropic SDK) and \`openai-compat\` (any OpenAI-compatible gateway, including OpenRouter, Bedrock-via-LiteLLM, vLLM, Ollama, etc.). Switching providers is one config block.
`;

const PROSE_MCP = `
### 3. Add an MCP server

MCP gives the agent tools without you writing tool code. Drop a server into \`mcpServers\` and Render Loops connects, lists the tools, and exposes them to the model. Render's own MCP works as a read-only example: the agent can list services, fetch deploy logs, and inspect Postgres / Key Value resources.
`;

const PROSE_CLOSE = `
### Putting it together

Each of these is a small edit. The reload loop is fast enough that you can iterate on prompts and tool wiring with the chat tab open in the next monitor — change a line, hit reload, send a message, see the new behavior immediately.
`;

export function CustomizingSection() {
  const name = useDeploymentName();
  return (
    <GuideSectionShell
      title="customizing — make it yours"
      lede="Three concrete recipes; each ~5 lines and a 5-second reload."
      body={
        <>
          <Markdown text={PROSE_INTRO} />
          <div className="border border-line p-3 text-xs">
            <div className="label mb-2">{"// the reload loop"}</div>
            <div className="space-y-1">
              <div>
                1. edit <code className="bg-code-bg px-1">render-harness.yaml</code> (or the agent's{" "}
                <code className="bg-code-bg px-1">src/*.ts</code>)
              </div>
              <div>
                2. restart <CmdBadge cmd={RELOAD_CMD} /> (or let{" "}
                <code className="bg-code-bg px-1">tsx</code> reload it for you)
              </div>
              <div>3. refresh the chat tab; the new behavior is live</div>
            </div>
          </div>

          <Markdown text={PROSE_PROMPT} />
          <CodeBlock language="excerpt — render-harness.yaml">
            {`agents:
  - id: ${name}
    agent:
      kind: builtin
      ref: chat
      systemPrompt: |
        You are a customer-support agent for Acme Co. Be empathetic and
        concrete. Always end with: "Anything else I can help with?"
    runtimes:
      - kind: web`}
          </CodeBlock>

          <Markdown text={PROSE_MODEL} />
          <CodeBlock language="excerpt — render-harness.yaml">
            {`shared:
  model:
    provider: openai-compat
    model: anthropic/claude-sonnet-4
    baseURL: https://openrouter.ai/api/v1
    apiKeyEnv: OPENROUTER_API_KEY`}
          </CodeBlock>
          <p className="text-xs text-muted">
            Then add <code className="bg-code-bg px-1">OPENROUTER_API_KEY=sk-...</code> to your
            <code className="bg-code-bg px-1">.env</code> and restart.
          </p>

          <Markdown text={PROSE_MCP} />
          <CodeBlock language="excerpt — render-harness.yaml">
            {`agents:
  - id: ${name}
    mcpServers:
      - name: render
        transport: http
        url: https://mcp.render.com/mcp
        headers:
          Authorization: "Bearer \${RENDER_API_KEY}"
    permissions:
      deniedTools:
        - render__delete_service
        - render__delete_postgres
        - render__delete_keyvalue`}
          </CodeBlock>
          <p className="text-xs text-muted">
            Set <code className="bg-code-bg px-1">RENDER_API_KEY</code> in{" "}
            <code className="bg-code-bg px-1">.env</code> (read-only is the default behavior; the
            explicit deny list above hardens it).
          </p>

          <Markdown text={PROSE_CLOSE} />
        </>
      }
      livePanel={<CustomizingLivePanel />}
    />
  );
}

function CustomizingLivePanel() {
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [error, setError] = useState<Error | null>(null);
  // Tick so "5m ago" stays current without a manual refresh.
  const [, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      Promise.all([getHealth(), listAgents()])
        .then(([h, a]) => {
          if (cancelled) return;
          setHealth(h);
          setAgents(a.agents);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          if (err instanceof ApiError && err.status === 401) return;
          setError(err instanceof Error ? err : new Error(String(err)));
        });
    };
    load();
    const refresh = setInterval(load, 5_000);
    const tick = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => {
      cancelled = true;
      clearInterval(refresh);
      clearInterval(tick);
    };
  }, []);

  return (
    <LivePanel title="reload state">
      {error ? (
        <div className="text-err">{error.message}</div>
      ) : !health || !agents ? (
        <div className="text-muted">loading…</div>
      ) : (
        <>
          <KV
            k="last reload"
            v={formatDistanceToNowStrict(parseISO(health.bootedAt), { addSuffix: true })}
          />
          <KV k="version" v={agents[0]?.version ?? "—"} />
          <KV
            k="model"
            v={agents[0] ? `${agents[0].model.provider}/${agents[0].model.model}` : "—"}
          />
          <KV k="mcp servers" v={String(agents[0]?.mcpServers.length ?? 0)} />
          <div className="hairline-top mt-3 border-t border-line pt-3 text-[11px] text-muted">
            Edit <code className="bg-code-bg px-1">agent.ts</code>, run{" "}
            <CmdBadge cmd={RELOAD_CMD} />, watch this number go to "just now".
          </div>
        </>
      )}
    </LivePanel>
  );
}
