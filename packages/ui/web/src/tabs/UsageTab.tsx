import { useEffect, useMemo, useState } from "react";
import { ApiError, getUsage, type UsageRow } from "../api.js";
import { AsyncBoundary } from "../components/AsyncBoundary.js";
import { formatTokens, formatUsd } from "../components/format.js";
import { SectionHeader } from "../components/SectionHeader.js";

const RANGES: { id: number; label: string }[] = [
  { id: 7, label: "7d" },
  { id: 30, label: "30d" },
  { id: 90, label: "90d" },
];

export function UsageTab() {
  const [days, setDays] = useState(30);
  const [allUsers, setAllUsers] = useState(false);
  const [rollups, setRollups] = useState<UsageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const to = new Date();
    const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
    getUsage({ from: from.toISOString(), to: to.toISOString(), allUsers })
      .then((res) => {
        if (cancelled) return;
        setRollups(res.rollups);
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
  }, [days, allUsers]);

  const totals = useMemo(() => {
    let runs = 0;
    let cost = 0;
    let inTokens = 0;
    let outTokens = 0;
    for (const r of rollups) {
      runs += r.runs;
      cost += r.costUsd;
      inTokens += r.inputTokens;
      outTokens += r.outputTokens;
    }
    return { runs, cost, inTokens, outTokens };
  }, [rollups]);

  const byAgent = useMemo(() => {
    const map = new Map<string, UsageRow>();
    for (const r of rollups) {
      const existing = map.get(r.agentName);
      if (existing) {
        existing.runs += r.runs;
        existing.costUsd += r.costUsd;
        existing.inputTokens += r.inputTokens;
        existing.outputTokens += r.outputTokens;
      } else {
        map.set(r.agentName, { ...r, day: "" });
      }
    }
    return Array.from(map.values()).sort((a, b) => b.costUsd - a.costUsd);
  }, [rollups]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="label mr-1">RANGE</span>
        {RANGES.map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => setDays(r.id)}
            className={`btn ${days === r.id ? "btn-active" : ""}`}
          >
            {r.label}
          </button>
        ))}
        <label className="ml-2 flex items-center gap-2 text-xs text-muted">
          <input
            type="checkbox"
            checked={allUsers}
            onChange={(e) => setAllUsers(e.target.checked)}
          />
          all users
        </label>
      </div>

      <AsyncBoundary
        loading={loading}
        error={error}
        empty={{
          when: rollups.length === 0,
          message: "// no runs in this window",
        }}
      >
        <SectionHeader title="totals" />
        <div className="grid gap-3 sm:grid-cols-4">
          <SummaryCard label="runs" value={totals.runs.toLocaleString()} />
          <SummaryCard label="cost" value={formatUsd(totals.cost)} />
          <SummaryCard label="input tokens" value={formatTokens(totals.inTokens)} />
          <SummaryCard label="output tokens" value={formatTokens(totals.outTokens)} />
        </div>

        <SectionHeader title="by agent" />
        <Table
          rows={byAgent.map((r) => ({
            key: r.agentName,
            cells: [
              r.agentName,
              r.runs.toLocaleString(),
              formatUsd(r.costUsd),
              formatTokens(r.inputTokens),
              formatTokens(r.outputTokens),
            ],
          }))}
          headers={["AGENT", "RUNS", "COST", "INPUT", "OUTPUT"]}
        />

        <SectionHeader title="by day" />
        <Table
          rows={rollups.map((r) => ({
            key: `${r.day}-${r.agentName}`,
            cells: [
              r.day,
              r.agentName,
              r.runs.toLocaleString(),
              formatUsd(r.costUsd),
              formatTokens(r.inputTokens + r.outputTokens),
            ],
          }))}
          headers={["DAY", "AGENT", "RUNS", "COST", "TOKENS"]}
        />
      </AsyncBoundary>
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="panel p-4">
      <div className="label">{label}</div>
      <div className="mt-1 text-xl tabular-nums">{value}</div>
    </div>
  );
}

interface TableProps {
  headers: string[];
  rows: { key: string; cells: string[] }[];
}

function Table({ headers, rows }: TableProps) {
  return (
    <div className="panel">
      <table className="w-full text-xs">
        <thead className="label">
          <tr>
            {headers.map((h) => (
              <th
                key={h}
                className="border-b border-line px-3 py-2 text-left font-medium"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, idx) => (
            <tr key={r.key} className={idx > 0 ? "border-t border-line" : ""}>
              {r.cells.map((cell, columnIdx) => {
                const headerKey = headers[columnIdx] ?? String(columnIdx);
                return (
                  <td key={`${r.key}-${headerKey}`} className="px-3 py-2 tabular-nums">
                    {cell}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
