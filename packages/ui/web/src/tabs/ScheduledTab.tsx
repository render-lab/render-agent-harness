import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  type InboxItem,
  listInbox,
  listSchedules,
  type ScheduleSummary,
} from "../api.js";
import { AsyncBoundary } from "../components/AsyncBoundary.js";
import { formatDateTime, formatRelative } from "../components/format.js";

export function ScheduledTab() {
  const [schedules, setSchedules] = useState<ScheduleSummary[]>([]);
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [scheduleResp, inboxResp] = await Promise.all([listSchedules(), listInbox()]);
      setSchedules(scheduleResp.schedules);
      setInbox(inboxResp.items);
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 401) {
        setError(err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm uppercase tracking-widest">Scheduled tasks</h2>
          <p className="mt-1 text-xs text-muted">
            Create or change schedules from chat. This tab shows what is active and what delivered.
          </p>
        </div>
        <button type="button" className="btn" onClick={() => void load()}>
          Refresh
        </button>
      </div>

      <AsyncBoundary
        loading={loading}
        error={error}
        empty={{
          when: schedules.length === 0 && inbox.length === 0,
          message: "// no schedules or scheduled outputs yet",
        }}
      >
        <section className="space-y-3">
          <div className="hr-section">Schedules</div>
          <div className="panel overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="label">
                <tr>
                  <Th>STATE</Th>
                  <Th>AGENT</Th>
                  <Th>CRON</Th>
                  <Th>NEXT</Th>
                  <Th>LAST</Th>
                  <Th>NOTIFY</Th>
                </tr>
              </thead>
              <tbody>
                {schedules.map((s, idx) => (
                  <tr key={s.id} className={idx > 0 ? "border-t border-line" : ""}>
                    <Td>
                      <span className={`badge ${s.enabled ? "text-accent" : ""}`}>
                        {s.enabled ? "enabled" : "disabled"}
                      </span>
                      <div className="mt-1 text-[10px] text-muted">{s.id.slice(0, 12)}…</div>
                    </Td>
                    <Td>{s.agentName}</Td>
                    <Td>
                      <code>{s.cronExpr}</code>
                      <div className="text-[10px] text-muted">{s.timezone}</div>
                    </Td>
                    <Td>{formatDateTime(s.nextFireAt)}</Td>
                    <Td>{formatDateTime(s.lastFiredAt)}</Td>
                    <Td>{s.notifications.map((n) => n.kind).join(", ") || "—"}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="space-y-3">
          <div className="hr-section">Inbox</div>
          <div className="space-y-2">
            {inbox.map((item) => (
              <article key={item.id} className="panel p-3 text-xs">
                <div className="mb-2 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-wider text-muted">
                  <span>{formatRelative(item.createdAt)}</span>
                  <span>run {item.runId.slice(0, 12)}…</span>
                  {item.scheduleId && <span>schedule {item.scheduleId.slice(0, 12)}…</span>}
                  <span>{item.status}</span>
                </div>
                <p className="whitespace-pre-wrap">{item.summary}</p>
              </article>
            ))}
          </div>
        </section>
      </AsyncBoundary>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="border-b border-line px-3 py-2 text-left font-medium">{children}</th>;
}

function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-3 py-2 align-top">{children}</td>;
}
