import { useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  ApiError,
  getVitals,
  listVitalsLogs,
  type VitalsInstance,
  type VitalsLogEntry,
  type VitalsMetricSeries,
} from "../api.js";
import { AsyncBoundary } from "../components/AsyncBoundary.js";
import { formatDateTime, formatRelative } from "../components/format.js";
import { SectionHeader } from "../components/SectionHeader.js";

const RANGES: { id: number; label: string; resolutionSeconds: number }[] = [
  { id: 30, label: "30m", resolutionSeconds: 30 },
  { id: 60, label: "1h", resolutionSeconds: 60 },
  { id: 360, label: "6h", resolutionSeconds: 300 },
  { id: 1440, label: "24h", resolutionSeconds: 900 },
];

type LogLevel = "all" | "error" | "warn" | "info";

export function VitalsTab() {
  const [rangeMinutes, setRangeMinutes] = useState(60);
  const [vitals, setVitals] = useState<{
    serviceId: string;
    instances: VitalsInstance[];
    metrics: VitalsMetricSeries[];
  } | null>(null);
  const [logs, setLogs] = useState<VitalsLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [logsLoading, setLogsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [logsError, setLogsError] = useState<Error | null>(null);
  const [logLevel, setLogLevel] = useState<LogLevel>("all");
  const [logText, setLogText] = useState("");
  const [logQuery, setLogQuery] = useState({ level: "all" as LogLevel, text: "" });

  const selectedRange = RANGES.find((r) => r.id === rangeMinutes) ?? RANGES[1];

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getVitals({
      rangeMinutes,
      resolutionSeconds: selectedRange?.resolutionSeconds ?? 60,
    })
      .then((res) => {
        if (cancelled) return;
        setVitals({
          serviceId: res.serviceId,
          instances: res.instances,
          metrics: res.metrics,
        });
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
  }, [rangeMinutes, selectedRange]);

  useEffect(() => {
    let cancelled = false;
    setLogsLoading(true);
    setLogsError(null);
    const text = logQuery.text.trim();
    listVitalsLogs({
      limit: 100,
      level: logQuery.level === "all" ? [] : [logQuery.level],
      ...(text ? { text } : {}),
    })
      .then((res) => {
        if (!cancelled) setLogs(res.logs);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) return;
        setLogsError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        if (!cancelled) setLogsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [logQuery]);

  const latest = useMemo(() => {
    const map = new Map<string, string>();
    for (const series of vitals?.metrics ?? []) {
      const point = series.points.at(-1);
      map.set(series.kind, point ? formatMetricValue(point.value, series.unit) : "—");
    }
    return map;
  }, [vitals]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="label mr-1">RANGE</span>
        {RANGES.map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => setRangeMinutes(r.id)}
            className={`btn ${rangeMinutes === r.id ? "btn-active" : ""}`}
          >
            {r.label}
          </button>
        ))}
      </div>

      <AsyncBoundary
        loading={loading}
        error={error}
        empty={{
          when: !vitals,
          message: "// no vitals available",
        }}
      >
        {vitals && (
          <>
            <SectionHeader title="service" />
            <div className="grid gap-3 sm:grid-cols-4">
              <SummaryCard label="service id" value={vitals.serviceId} />
              <SummaryCard label="instances" value={vitals.instances.length.toLocaleString()} />
              <SummaryCard label="cpu" value={latest.get("cpu") ?? "—"} />
              <SummaryCard label="memory" value={latest.get("memory") ?? "—"} />
            </div>

            <SectionHeader title="metrics" />
            <div className="grid gap-4 lg:grid-cols-3">
              {vitals.metrics.map((series) => (
                <MetricPanel key={series.kind} series={series} />
              ))}
            </div>

            <SectionHeader title="instances" />
            <InstancesTable instances={vitals.instances} />
          </>
        )}
      </AsyncBoundary>

      <SectionHeader title="logs" />
      <form
        className="panel flex flex-wrap items-end gap-3 p-3"
        onSubmit={(event) => {
          event.preventDefault();
          setLogQuery({ level: logLevel, text: logText });
        }}
      >
        <label className="grid gap-1">
          <span className="label">level</span>
          <select
            value={logLevel}
            onChange={(event) => setLogLevel(event.target.value as LogLevel)}
          >
            <option value="all">all</option>
            <option value="error">error</option>
            <option value="warn">warn</option>
            <option value="info">info</option>
          </select>
        </label>
        <label className="grid min-w-56 flex-1 gap-1">
          <span className="label">text</span>
          <input
            value={logText}
            onChange={(event) => setLogText(event.target.value)}
            placeholder="timeout, 500, tool name..."
          />
        </label>
        <button type="submit" className="btn">
          Refresh
        </button>
      </form>
      <AsyncBoundary
        loading={logsLoading}
        error={logsError}
        empty={{
          when: logs.length === 0,
          message: "// no logs in this window",
        }}
      >
        <LogsTable logs={logs} />
      </AsyncBoundary>
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="panel min-w-0 p-4">
      <div className="label">{label}</div>
      <div className="mt-1 truncate text-xl tabular-nums" title={value}>
        {value}
      </div>
    </div>
  );
}

function MetricPanel({ series }: { series: VitalsMetricSeries }) {
  const data = series.points.map((point) => ({
    time: formatChartTime(point.timestamp),
    rawTime: point.timestamp,
    value: point.value,
    label: formatMetricValue(point.value, series.unit),
  }));
  const latest = series.points.at(-1);

  return (
    <div className="panel p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="label">{series.label}</div>
          <div className="mt-1 text-xl tabular-nums">
            {latest ? formatMetricValue(latest.value, series.unit) : "—"}
          </div>
        </div>
        <div className="text-right text-[10px] text-muted uppercase tracking-wider">
          {latest ? formatRelative(latest.timestamp) : "no data"}
        </div>
      </div>
      <div className="mt-4 h-48">
        {data.length === 0 ? (
          <div className="flex h-full items-center justify-center border border-line text-muted text-xs">
            no samples
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            {series.kind === "httpLatencyP95" ? (
              <LineChart data={data}>
                <CartesianGrid stroke="var(--color-line)" strokeDasharray="3 3" />
                <XAxis dataKey="time" tick={{ fill: "var(--color-muted)", fontSize: 10 }} />
                <YAxis
                  tick={{ fill: "var(--color-muted)", fontSize: 10 }}
                  tickFormatter={(value) => formatMetricValue(Number(value), series.unit)}
                />
                <Tooltip
                  labelFormatter={(_, payload) => payload?.[0]?.payload?.rawTime ?? ""}
                  formatter={(_, __, item) => item.payload.label}
                />
                <Line
                  type="monotone"
                  dataKey="value"
                  dot={false}
                  stroke="var(--color-accent)"
                  strokeWidth={2}
                />
              </LineChart>
            ) : (
              <AreaChart data={data}>
                <CartesianGrid stroke="var(--color-line)" strokeDasharray="3 3" />
                <XAxis dataKey="time" tick={{ fill: "var(--color-muted)", fontSize: 10 }} />
                <YAxis
                  tick={{ fill: "var(--color-muted)", fontSize: 10 }}
                  tickFormatter={(value) => formatMetricValue(Number(value), series.unit)}
                />
                <Tooltip
                  labelFormatter={(_, payload) => payload?.[0]?.payload?.rawTime ?? ""}
                  formatter={(_, __, item) => item.payload.label}
                />
                <Area
                  type="monotone"
                  dataKey="value"
                  fill="var(--color-accent)"
                  fillOpacity={0.16}
                  stroke="var(--color-accent)"
                  strokeWidth={2}
                />
              </AreaChart>
            )}
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

function InstancesTable({ instances }: { instances: VitalsInstance[] }) {
  if (instances.length === 0) {
    return <div className="panel p-6 text-center text-muted text-xs">no instances reported</div>;
  }
  return (
    <div className="panel overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="label">
          <tr>
            {["INSTANCE", "STATUS", "CREATED", "UPDATED"].map((h) => (
              <th key={h} className="border-b border-line px-3 py-2 text-left font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {instances.map((instance, idx) => (
            <tr key={instance.id} className={idx > 0 ? "border-t border-line" : ""}>
              <td className="px-3 py-2 font-mono">{instance.name ?? instance.id}</td>
              <td className="px-3 py-2">
                <span className="badge">{instance.status ?? "unknown"}</span>
              </td>
              <td className="px-3 py-2 tabular-nums">{formatDateTime(instance.createdAt)}</td>
              <td className="px-3 py-2 tabular-nums">{formatDateTime(instance.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LogsTable({ logs }: { logs: VitalsLogEntry[] }) {
  return (
    <div className="panel overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="label">
          <tr>
            {["TIME", "LEVEL", "TYPE", "REQUEST", "MESSAGE"].map((h) => (
              <th key={h} className="border-b border-line px-3 py-2 text-left font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {logs.map((log, idx) => (
            <tr key={log.id} className={idx > 0 ? "border-t border-line" : ""}>
              <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                {formatDateTime(log.timestamp)}
              </td>
              <td className="px-3 py-2">{log.level ?? "—"}</td>
              <td className="px-3 py-2">{log.type ?? "—"}</td>
              <td className="whitespace-nowrap px-3 py-2 font-mono">{formatRequest(log)}</td>
              <td className="min-w-96 px-3 py-2 font-mono">{log.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatMetricValue(value: number, unit: VitalsMetricSeries["unit"]): string {
  if (!Number.isFinite(value)) return "—";
  switch (unit) {
    case "percent":
      return `${value.toFixed(value < 10 ? 1 : 0)}%`;
    case "bytes":
      return formatBytes(value);
    case "milliseconds":
      return `${value.toFixed(value < 10 ? 1 : 0)}ms`;
  }
  return "—";
}

function formatBytes(value: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let next = value;
  let idx = 0;
  while (next >= 1024 && idx < units.length - 1) {
    next /= 1024;
    idx += 1;
  }
  return `${next.toFixed(idx === 0 || next >= 10 ? 0 : 1)}${units[idx]}`;
}

function formatChartTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatRequest(log: VitalsLogEntry): string {
  const pieces = [log.method, log.statusCode, log.path].filter(Boolean);
  return pieces.length > 0 ? pieces.join(" ") : "—";
}
