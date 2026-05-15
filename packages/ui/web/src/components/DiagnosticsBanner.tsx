import { useEffect, useState } from "react";
import { ApiError, type DiagnosticCheck, getDiagnostics } from "../api.js";

const POLL_INTERVAL_MS = 30_000;

/**
 * Top-of-page banner that polls `/diagnostics` and surfaces error- and
 * warn-level checks. Operators can click "details" to expand the full
 * list and see each check's hint.
 */
export function DiagnosticsBanner() {
  const [checks, setChecks] = useState<DiagnosticCheck[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const res = await getDiagnostics();
        if (cancelled) return;
        setChecks(res.checks);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) return;
        // Don't surface fetch errors here; we don't want the banner to
        // become noise when the network is flaky.
      } finally {
        if (!cancelled) timer = setTimeout(tick, POLL_INTERVAL_MS);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const errors = checks.filter((c) => c.level === "error");
  const warnings = checks.filter((c) => c.level === "warn");
  if (errors.length === 0 && warnings.length === 0) return null;

  const hasErrors = errors.length > 0;
  const headlineCheck = errors[0] ?? warnings[0];
  if (!headlineCheck) return null;

  return (
    <div
      className={`mb-4 border ${hasErrors ? "border-err text-err" : "border-accent text-accent"}`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs"
      >
        <div className="flex items-center gap-2">
          <span className="label !text-current">{hasErrors ? "// setup error" : "// warning"}</span>
          <span>{headlineCheck.title}</span>
          {errors.length + warnings.length > 1 && (
            <span className="text-muted">· {errors.length + warnings.length - 1} more</span>
          )}
        </div>
        <span className="text-muted">{open ? "[-]" : "[+]"}</span>
      </button>
      {open && (
        <ul className="border-t border-current px-3 py-2 text-xs">
          {[...errors, ...warnings].map((c) => (
            <li key={c.id} className="mb-2 last:mb-0">
              <div className="font-medium">
                <span className="mr-2 text-muted">[{c.level.toUpperCase()}]</span>
                {c.title}
              </div>
              <div className="text-muted">{c.message}</div>
              {c.hint && (
                <div className="mt-0.5 text-muted">
                  <span className="text-current">→</span> {c.hint}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
