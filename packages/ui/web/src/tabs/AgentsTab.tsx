import { useEffect, useState } from "react";
import {
  type AgentModelSummary,
  type AgentSummary,
  ApiError,
  type CapabilitySummary,
  type ConnectorSummary,
  listAgents,
  listCapabilities,
  listConnectors,
} from "../api.js";
import { AsyncBoundary } from "../components/AsyncBoundary.js";
import { EditModelModal } from "./EditModelModal.js";
import { InstallCapabilityModal } from "./InstallCapabilityModal.js";

export function AgentsTab() {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [capabilities, setCapabilities] = useState<CapabilitySummary[]>([]);
  const [connectors, setConnectors] = useState<ConnectorSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [installingCapability, setInstallingCapability] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listAgents()
      .then((res) => {
        if (cancelled) return;
        setAgents(res.agents);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) return;
        setError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    Promise.all([listCapabilities(), listConnectors()])
      .then(([capRes, connRes]) => {
        if (cancelled) return;
        setCapabilities(capRes.capabilities);
        setConnectors(connRes.connectors);
      })
      .catch(() => {
        // Older servers may not expose these routes yet; keep the Agents tab usable.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <AsyncBoundary
      loading={loading}
      error={error}
      empty={{
        when: agents.length === 0,
        message: "// no agents loaded — pass via serveWeb({ agent }) or serveWeb({ agents })",
      }}
    >
      <div className="space-y-6">
        {notice ? <p className="border border-line p-2 text-xs text-muted">{notice}</p> : null}
        <CapabilityOverview
          capabilities={capabilities}
          connectors={connectors}
          onAdd={() => setInstallingCapability(true)}
        />
        <div className="grid gap-4 md:grid-cols-2">
          {agents.map((agent) => (
            <AgentCard
              key={agent.name}
              agent={agent}
              onModelUpdated={(spec) =>
                setAgents((curr) =>
                  curr.map((a) => (a.name === agent.name ? { ...a, model: spec } : a)),
                )
              }
            />
          ))}
        </div>
      </div>
      {installingCapability ? (
        <InstallCapabilityModal
          agents={agents}
          onClose={() => setInstallingCapability(false)}
          onInstalled={setNotice}
        />
      ) : null}
    </AsyncBoundary>
  );
}

function CapabilityOverview({
  capabilities,
  connectors,
  onAdd,
}: {
  capabilities: CapabilitySummary[];
  connectors: ConnectorSummary[];
  onAdd: () => void;
}) {
  return (
    <div className="panel grid gap-4 p-4 text-xs md:grid-cols-2">
      <Section title="capabilities">
        <button type="button" className="btn mb-3" onClick={onAdd}>
          Add capability
        </button>
        {capabilities.length === 0 ? (
          <p className="text-muted">{"// none installed"}</p>
        ) : (
          <ul className="space-y-1">
            {capabilities.map((cap) => (
              <li key={cap.pack} className="border border-line px-2 py-1">
                <div className="font-mono">{cap.pack}</div>
                <div className="mt-1 text-[11px] text-muted">
                  tools: {cap.localToolCount} · mcp: {cap.mcpServerCount} · env:{" "}
                  {cap.envVars.length}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="connectors">
        {connectors.length === 0 ? (
          <p className="text-muted">{"// none mounted"}</p>
        ) : (
          <ul className="space-y-1">
            {connectors.map((connector) => (
              <li key={connector.key} className="border border-line px-2 py-1">
                <div className="font-mono">{connector.url}</div>
                <div className="mt-1 text-[11px] text-muted">{connector.pack}</div>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function AgentCard({
  agent,
  onModelUpdated,
}: {
  agent: AgentSummary;
  onModelUpdated: (spec: AgentModelSummary) => void;
}) {
  const [editing, setEditing] = useState(false);

  return (
    <div className="panel space-y-4 p-4 text-xs">
      <header>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold uppercase tracking-wide">{agent.name}</h2>
          <span className="badge">v{agent.version}</span>
        </div>
        <div className="mt-1 flex items-center gap-2 text-muted">
          <span>
            {agent.model.provider}/{agent.model.model}
          </span>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="border border-line px-1.5 py-0.5 text-[10px] text-accent hover:bg-accent hover:text-bg"
            aria-label={`Edit model for ${agent.name}`}
          >
            edit
          </button>
        </div>
      </header>

      {editing ? (
        <EditModelModal agent={agent} onClose={() => setEditing(false)} onSaved={onModelUpdated} />
      ) : null}

      <Section title="system prompt">
        <details className="border border-line p-2">
          <summary className="cursor-pointer text-[11px] text-muted">
            {agent.systemPromptLength.toLocaleString()} chars · click to expand preview
          </summary>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-[11px]">
            {agent.systemPromptPreview}
          </pre>
        </details>
      </Section>

      <Section title="mcp servers">
        {agent.mcpServers.length === 0 ? (
          <p className="text-muted">{"// none configured"}</p>
        ) : (
          <ul className="space-y-1">
            {agent.mcpServers.map((s) => (
              <li
                key={s.name}
                className="flex items-center justify-between border border-line px-2 py-1"
              >
                <span>{s.name}</span>
                <span className="label">{s.transport}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="permissions">
        <div className="space-y-2">
          <PermList label="allowed" items={agent.permissions.allowedTools ?? []} />
          <PermList label="denied" items={agent.permissions.deniedTools ?? []} />
          <PermList label="requires approval" items={agent.permissions.requireApproval ?? []} />
        </div>
      </Section>

      <Section title="tools / skills">
        <div className="text-muted">
          local tools: {agent.hasLocalTools ? "yes" : "no"} · skills:{" "}
          {agent.hasSkills ? "yes" : "no"}
        </div>
      </Section>

      {(agent.budget || agent.sampling) && (
        <Section title="budget / sampling">
          <pre className="overflow-auto border border-line p-2 text-[11px]">
            {JSON.stringify({ budget: agent.budget, sampling: agent.sampling }, null, 2)}
          </pre>
        </Section>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="label mb-1">{title}</div>
      {children}
    </div>
  );
}

function PermList({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) {
    return (
      <div className="text-muted">
        <span className="label">{label}:</span> —
      </div>
    );
  }
  return (
    <div>
      <div className="label">{label}</div>
      <ul className="mt-1 flex flex-wrap gap-1">
        {items.map((t) => (
          <li key={t} className="border border-line px-1.5 py-0.5 text-[11px]">
            {t}
          </li>
        ))}
      </ul>
    </div>
  );
}
