import { useCallback, useEffect, useState } from "react";
import { ApiError, listRuns, type RunStatus, type RunSummary } from "../api.js";
import { AsyncBoundary } from "../components/AsyncBoundary.js";
import { formatRelative, formatTokens, formatUsd } from "../components/format.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { RunDetail } from "./RunDetail.js";

const STATUSES: RunStatus[] = ["pending", "running", "paused", "completed", "failed", "cancelled"];

interface RunsTabProps {
  runId: string | null;
  onSelectRun: (id: string) => void;
  onBackToList: () => void;
  /** Jump to the chat tab and hydrate the conversation this run belongs to. */
  onOpenInChat: (conversationId: string) => void;
}

export function RunsTab({ runId, onSelectRun, onBackToList, onOpenInChat }: RunsTabProps) {
  if (runId) {
    return <RunDetail runId={runId} onBack={onBackToList} onOpenInChat={onOpenInChat} />;
  }
  return <RunList onSelect={onSelectRun} />;
}

function RunList({ onSelect }: { onSelect: (id: string) => void }) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [statusFilter, setStatusFilter] = useState<Set<RunStatus>>(new Set());
  const [agentFilter, setAgentFilter] = useState("");
  const [allUsers, setAllUsers] = useState(false);

  const load = useCallback(
    async (opts?: { append?: boolean; cursor?: string }) => {
      setError(null);
      if (!opts?.append) setLoading(true);
      try {
        const params: Parameters<typeof listRuns>[0] = {
          status: Array.from(statusFilter),
          ...(agentFilter.trim() ? { agent: [agentFilter.trim()] } : {}),
          ...(opts?.cursor ? { cursor: opts.cursor } : {}),
          ...(allUsers ? { allUsers: true } : {}),
        };
        const page = await listRuns(params);
        setRuns((prev) => (opts?.append ? [...prev, ...page.runs] : page.runs));
        setNextCursor(page.nextCursor);
      } catch (err) {
        if (!(err instanceof ApiError) || err.status !== 401) {
          setError(err instanceof Error ? err : new Error(String(err)));
        }
      } finally {
        setLoading(false);
      }
    },
    [statusFilter, agentFilter, allUsers],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const toggleStatus = (s: RunStatus) => {
    setStatusFilter((prev) => {
      const next = new Set(prev);
      if (next.has(s)) {
        next.delete(s);
      } else {
        next.add(s);
      }
      return next;
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="label mr-1">FILTER</span>
        {STATUSES.map((s) => {
          const active = statusFilter.has(s);
          return (
            <button
              key={s}
              type="button"
              onClick={() => toggleStatus(s)}
              className={`btn ${active ? "btn-active" : ""}`}
            >
              {s}
            </button>
          );
        })}
        <input
          type="text"
          placeholder="agent name"
          value={agentFilter}
          onChange={(e) => setAgentFilter(e.target.value)}
          className="min-w-[10rem] text-xs"
        />
        <label className="flex items-center gap-2 text-xs text-muted">
          <input
            type="checkbox"
            checked={allUsers}
            onChange={(e) => setAllUsers(e.target.checked)}
          />
          all users
        </label>
        <button type="button" onClick={() => void load()} className="btn ml-auto">
          Refresh
        </button>
      </div>

      <AsyncBoundary
        loading={loading}
        error={error}
        empty={{ when: runs.length === 0, message: "// no runs match the current filters" }}
      >
        <div className="panel">
          <table className="w-full text-xs">
            <thead className="label">
              <tr>
                <Th>STATUS</Th>
                <Th>RUN</Th>
                <Th>AGENT</Th>
                <Th>USER</Th>
                <Th>TOKENS</Th>
                <Th>COST</Th>
                <Th>CREATED</Th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r, idx) => {
                const tokens =
                  (r.cursor.usage?.inputTokens ?? 0) + (r.cursor.usage?.outputTokens ?? 0);
                return (
                  <tr
                    key={r.id}
                    className={`cursor-pointer hover:text-accent ${idx > 0 ? "border-t border-line" : ""}`}
                    onClick={() => onSelect(r.id)}
                  >
                    <Td>
                      <div className="flex items-center gap-1">
                        <StatusBadge status={r.status} />
                        {r.conversationId && (
                          <span className="badge" title="Part of a conversation">
                            chat
                          </span>
                        )}
                      </div>
                    </Td>
                    <Td>{r.id.slice(0, 12)}…</Td>
                    <Td>
                      <div>{r.agentName}</div>
                      <div className="text-[10px] text-muted">v{r.agentVersion}</div>
                    </Td>
                    <Td>{r.userId ?? "—"}</Td>
                    <Td className="tabular-nums">{formatTokens(tokens)}</Td>
                    <Td className="tabular-nums">{formatUsd(r.totalCostUsd)}</Td>
                    <Td>{formatRelative(r.createdAt)}</Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {nextCursor && (
          <div className="flex justify-center pt-2">
            <button
              type="button"
              onClick={() => void load({ append: true, cursor: nextCursor })}
              className="btn"
            >
              Load more
            </button>
          </div>
        )}
      </AsyncBoundary>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="border-b border-line px-3 py-2 text-left font-medium">{children}</th>;
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-2 align-top ${className ?? ""}`}>{children}</td>;
}
