import { useEffect, useState } from "react";
import { type AgentSummary, ApiError, listAgents } from "../../api.js";
import { Markdown } from "../../components/Markdown.js";
import { useDeployment } from "../../deployment-context.js";
import { CmdBadge, CodeBlock, GuideSectionShell, KV, LivePanel } from "./layout.js";

const PROSE_INTRO = `
**Capability packs** are the harness's extension surface for "give the agent a new ability without me writing tool code." A pack is a small TypeScript module that exposes some combination of:

- one or more MCP servers,
- a skills directory the model can pull into context,
- env-var declarations the harness validates at boot,
- and a pre-validated default config.

First-party packs live in [\`packages/capabilities/\`](https://github.com/render/render-harness/tree/main/packages/capabilities) and on npm with the \`render-harness-cap\` keyword. Community packs follow the same shape.
`;

const PROSE_FIRST_PARTY = `
### What ships in the box

| Pack | What it adds | Env vars |
| --- | --- | --- |
| \`@render-harness/cap-search-exa\` | Exa MCP — high-recall web search | \`EXA_API_KEY\` |
| \`@render-harness/cap-search-tavily\` | Tavily MCP — search + answer engine | \`TAVILY_API_KEY\` |
| \`@render-harness/cap-scrape-firecrawl\` | Firecrawl MCP — page scraping | \`FIRECRAWL_API_KEY\` |
| \`@render-harness/cap-memory-pg\` | Long-term memory in Postgres | (uses \`DATABASE_URL\`) |
| \`@render-harness/cap-browser-browserbase\` | Browserbase MCP — full browser automation | \`BROWSERBASE_API_KEY\` |
`;

const PROSE_WORKED = `
### Worked example: add web search

Three steps. After this, the agent can search the web mid-conversation.
`;

const PROSE_DECLARATIVE = `
### The declarative path

Inside the harness's config registry, capabilities compose declaratively in \`render-harness.yaml\` instead of TypeScript. The same pack works in either path; \`defineFromConfig()\` reads the YAML, the build emits a Render Blueprint, and one click deploys it. See [\`docs/registry-guide.md\`](https://github.com/render/render-harness/blob/main/docs/registry-guide.md) for the full walkthrough.
`;

export function CapabilitiesSection() {
  return (
    <GuideSectionShell
      title="capabilities — extend without rewriting"
      lede="Plug-ins for the agent loop. Search, scrape, memory, browser."
      body={
        <>
          <Markdown text={PROSE_INTRO} />
          <Markdown text={PROSE_FIRST_PARTY} />

          <Markdown text={PROSE_WORKED} />
          <ol className="list-decimal space-y-3 pl-6 text-sm">
            <li>
              <p>Install the pack:</p>
              <CmdBadge cmd="pnpm add @render-harness/cap-search-exa" />
            </li>
            <li>
              <p>
                Reference it in <code className="bg-code-bg px-1">render-harness.yaml</code> under{" "}
                <code className="bg-code-bg px-1">capabilities</code>. The harness materializes the
                pack at boot, wires its MCP servers into each agent, and the live panel below reads
                the pack list to show what's installed:
              </p>
              <CodeBlock language="excerpt — render-harness.yaml">
                {`capabilities:
  - pack: "@render-harness/cap-search-exa"
    config:
      defaultMaxResults: 10`}
              </CodeBlock>
            </li>
            <li>
              <p>
                Add the API key to <code className="bg-code-bg px-1">.env</code>:
              </p>
              <CmdBadge cmd='echo "EXA_API_KEY=..." >> .env' />
            </li>
            <li>
              <p>
                Restart <CmdBadge cmd="pnpm dev" />. Now ask the chat agent to "search the web for…"
                and watch the new tool fire.
              </p>
            </li>
          </ol>

          <Markdown text={PROSE_DECLARATIVE} />
        </>
      }
      livePanel={<CapabilitiesLivePanel />}
    />
  );
}

function CapabilitiesLivePanel() {
  const deployment = useDeployment();
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

  // Bundle-level capability packs are the source of truth (capabilities
  // are bundle-wide singletons). Agent summaries' `capabilityPacks` is
  // kept as a fallback for legacy single-agent shapes that don't surface
  // the manifest list.
  const packs =
    deployment?.capabilityPacks && deployment.capabilityPacks.length > 0
      ? deployment.capabilityPacks
      : (agents?.[0]?.capabilityPacks ?? []);

  return (
    <LivePanel title="installed packs">
      {error ? (
        <div className="text-err">{error.message}</div>
      ) : !agents ? (
        <div className="text-muted">loading…</div>
      ) : (
        <>
          <KV k="capabilityPacks" v={String(packs.length)} />
          {packs.length > 0 ? (
            <ul className="space-y-1 text-[11px]">
              {packs.map((p) => (
                <li key={p} className="border border-line px-2 py-1 font-mono">
                  {p}
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-[11px] text-muted">
              {
                "// none yet. Follow the recipe on the left and the pack name will show up here after restart."
              }
            </div>
          )}
          {agents[0] && (
            <div className="hairline-top mt-3 border-t border-line pt-3 text-[11px] text-muted">
              <div>mcp servers: {agents[0].mcpServers.length}</div>
              <div>local tools: {agents[0].hasLocalTools ? "yes" : "no"}</div>
              <div>skills: {agents[0].hasSkills ? "yes" : "no"}</div>
            </div>
          )}
        </>
      )}
    </LivePanel>
  );
}
