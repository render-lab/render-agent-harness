import { useEffect, useState } from "react";
import { type AgentModelSummary, type AgentSummary, ApiError, listAgents } from "../api.js";
import { AsyncBoundary } from "../components/AsyncBoundary.js";
import { EditModelModal } from "./EditModelModal.js";

export function AgentsTab() {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

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
    </AsyncBoundary>
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
          <p className="text-muted">// none configured</p>
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
