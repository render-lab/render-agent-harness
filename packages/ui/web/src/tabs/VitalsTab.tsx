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
  listVitalsServices,
  type VitalsInstance,
  type VitalsLogEntry,
  type VitalsMetricSeries,
  type VitalsServiceSummary,
} from "../api.js";
import { AsyncBoundary } from "../components/AsyncBoundary.js";
import { formatDateTime, formatRelative } from "../components/format.js";
import { SectionHeader } from "../components/SectionHeader.js";
import { Select } from "../components/Select.js";

const RANGES: { id: number; label: string; resolutionSeconds: number }[] = [
  { id: 30, label: "30m", resolutionSeconds: 30 },
  { id: 60, label: "1h", resolutionSeconds: 60 },
  { id: 360, label: "6h", resolutionSeconds: 300 },
  { id: 1440, label: "24h", resolutionSeconds: 900 },
];

type LogLevel = "all" | "error" | "warn" | "info";

export function VitalsTab() {
  const [rangeMinutes, setRangeMinutes] = useState(60);
  const [services, setServices] = useState<VitalsServiceSummary[]>([]);
  const [servicesLoading, setServicesLoading] = useState(true);
  const [servicesError, setServicesError] = useState<Error | null>(null);
  const [selectedServiceId, setSelectedServiceId] = useState<string | null>(null);
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

  // Discover sibling services in this harness deployment once on mount.
  // The selected service defaults to the current one so the panel still
  // works on deployments with no Render-side sibling lookup (legacy or
  // hand-rolled).
  useEffect(() => {
    let cancelled = false;
    setServicesLoading(true);
    setServicesError(null);
    listVitalsServices()
      .then((res) => {
        if (cancelled) return;
        setServices(res.services);
        setSelectedServiceId((prev) => prev ?? res.currentServiceId);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) return;
        setServicesError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        if (!cancelled) setServicesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!selectedServiceId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    getVitals({
      rangeMinutes,
      resolutionSeconds: selectedRange?.resolutionSeconds ?? 60,
      serviceId: selectedServiceId,
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
  }, [rangeMinutes, selectedRange, selectedServiceId]);

  useEffect(() => {
    if (!selectedServiceId) return;
    let cancelled = false;
    setLogsLoading(true);
    setLogsError(null);
    const text = logQuery.text.trim();
    listVitalsLogs({
      limit: 100,
      level: logQuery.level === "all" ? [] : [logQuery.level],
      serviceId: selectedServiceId,
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
  }, [logQuery, selectedServiceId]);

  const latest = useMemo(() => {
    const map = new Map<string, string>();
    for (const series of vitals?.metrics ?? []) {
      const point = series.points.at(-1);
      map.set(series.kind, point ? formatMetricValue(point.value, series.unit) : "—");
    }
    return map;
  }, [vitals]);

  const selectedService = services.find((s) => s.serviceId === selectedServiceId) ?? null;

  return (
    <div className="space-y-4">
      <ServicePicker
        services={services}
        loading={servicesLoading}
        error={servicesError}
        selectedServiceId={selectedServiceId}
        onSelect={setSelectedServiceId}
      />

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
              <SummaryCard
                label="service"
                value={selectedService?.name ?? vitals.serviceId}
                hint={vitals.serviceId}
              />
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
        <div className="grid w-32 gap-1">
          <span className="label" id="vitals-log-level-label">
            level
          </span>
          <Select<LogLevel>
            value={logLevel}
            onChange={setLogLevel}
            ariaLabel="log level"
            options={[
              { value: "all", label: "all" },
              { value: "error", label: "error" },
              { value: "warn", label: "warn" },
              { value: "info", label: "info" },
            ]}
          />
        </div>
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

/**
 * Tabbed picker over the sibling services in this harness deployment.
 * Highlights the service the operator UI is itself running on so it
 * stays obvious where logs/metrics are sourced from when switching
 * around.
 */
function ServicePicker({
  services,
  loading,
  error,
  selectedServiceId,
  onSelect,
}: {
  services: VitalsServiceSummary[];
  loading: boolean;
  error: Error | null;
  selectedServiceId: string | null;
  onSelect: (id: string) => void;
}) {
  if (loading) {
    return <div className="panel p-3 text-muted text-xs">loading services…</div>;
  }
  if (error) {
    return (
      <div className="panel p-3 text-xs">
        <div className="label mb-1">services</div>
        <div className="text-muted">could not list sibling services: {error.message}</div>
      </div>
    );
  }
  if (services.length <= 1) {
    return null;
  }
  return (
    <div className="panel p-3">
      <div className="label mb-2">services</div>
      <div className="flex flex-wrap gap-2">
        {services.map((svc) => {
          const active = svc.serviceId === selectedServiceId;
          const suspended = svc.suspended === "suspended";
          return (
            <button
              key={svc.serviceId}
              type="button"
              onClick={() => onSelect(svc.serviceId)}
              className={`btn flex items-center gap-2 ${active ? "btn-active" : ""}`}
              title={`${svc.serviceId}${svc.type ? ` · ${svc.type}` : ""}${svc.isCurrent ? " · current service" : ""}`}
            >
              <span>{svc.name}</span>
              <span className="text-[10px] uppercase tracking-wider text-muted">
                {formatServiceType(svc.type)}
              </span>
              {suspended ? (
                <span className="badge" data-status="warn">
                  suspended
                </span>
              ) : null}
              {svc.isCurrent ? <span className="text-[10px] text-muted">★</span> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SummaryCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="panel min-w-0 p-4">
      <div className="label">{label}</div>
      <div className="mt-1 truncate text-xl tabular-nums" title={hint ?? value}>
        {value}
      </div>
      {hint ? <div className="mt-1 truncate text-[10px] text-muted">{hint}</div> : null}
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

/**
 * Render-API log windows are large (~100 entries by default). Capping
 * the table at ~24rem and scrolling inside keeps the rest of the
 * Vitals tab (metrics, instances) reachable without long scroll
 * sequences. The header is sticky so column meaning stays visible
 * while scrolling.
 */
function LogsTable({ logs }: { logs: VitalsLogEntry[] }) {
  return (
    <div className="panel max-h-96 overflow-auto">
      <table className="w-full text-xs">
        <thead className="label sticky top-0 bg-bg">
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

function formatServiceType(type: string | null): string {
  switch (type) {
    case "web_service":
      return "web";
    case "private_service":
      return "private";
    case "background_worker":
      return "worker";
    case "cron_job":
      return "cron";
    case "static_site":
      return "static";
    default:
      return type ?? "—";
  }
}
