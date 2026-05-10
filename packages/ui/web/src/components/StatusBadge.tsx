import type { RunStatus } from "../api.js";

const STYLES: Record<RunStatus, string> = {
  pending: "badge",
  running: "badge badge-fill",
  paused: "badge badge-warn",
  completed: "badge",
  failed: "badge badge-err",
  cancelled: "badge",
};

const LABELS: Record<RunStatus, string> = {
  pending: "PENDING",
  running: "RUNNING",
  paused: "PAUSED",
  completed: "DONE",
  failed: "FAILED",
  cancelled: "CANCELLED",
};

export function StatusBadge({ status }: { status: RunStatus }) {
  return <span className={STYLES[status]}>[{LABELS[status]}]</span>;
}
