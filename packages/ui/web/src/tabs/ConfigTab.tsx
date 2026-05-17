import { useCallback, useEffect, useState } from "react";
import { type DeploymentEnvVar, listEnvVars, setEnvVar } from "../api.js";
import { AsyncBoundary } from "../components/AsyncBoundary.js";
import { SectionHeader } from "../components/SectionHeader.js";
import { useDeployment } from "../deployment-context.js";

/**
 * Config tab: lists every env var the running stack needs (from
 * `envSchema` merged across the manifest and capability packs) plus
 * an edit affordance.
 *
 * Two paths to set a value:
 *
 *   - When `renderService.serviceId` and `RENDER_API_KEY` are wired
 *     up, the modal PUTs the value directly via Render's API. Render
 *     auto-deploys, which restarts the worker.
 *
 *   - Otherwise, the modal shows a deeplink to the Render dashboard's
 *     env page for this service. The operator pastes in the dashboard
 *     and Render handles the rest.
 */
export function ConfigTab() {
  const deployment = useDeployment();
  const [envVars, setEnvVars] = useState<DeploymentEnvVar[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [editing, setEditing] = useState<DeploymentEnvVar | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await listEnvVars();
      setEnvVars(res.envVars);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const canWrite = Boolean(
    deployment?.renderService?.serviceId && deployment.renderService.apiKeyConfigured,
  );
  const renderServiceId = deployment?.renderService?.serviceId ?? null;

  return (
    <div className="space-y-6">
      <HarnessVersionPanel deployment={deployment} />

      <section>
        <SectionHeader title="ENV VARS" />
        <ConfigStatusBanner deployment={deployment} />
        <AsyncBoundary
          loading={loading}
          error={error}
          empty={{
            when: envVars.length === 0,
            message:
              "// no env vars declared in render-harness.yaml — capability packs and the harness manifest can add entries to envSchema",
          }}
        >
          <ul className="space-y-1.5">
            {envVars.map((v) => (
              <EnvVarRow key={v.name} envVar={v} onEdit={() => setEditing(v)} />
            ))}
          </ul>
        </AsyncBoundary>
      </section>

      {editing ? (
        <EditEnvVarModal
          envVar={editing}
          canWrite={canWrite}
          renderServiceId={renderServiceId}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            // Render's redeploy may kill us; re-poll a couple times in case.
            void refresh();
            window.setTimeout(() => void refresh(), 5_000);
            window.setTimeout(() => void refresh(), 15_000);
          }}
        />
      ) : null}
    </div>
  );
}

function HarnessVersionPanel({ deployment }: { deployment: ReturnType<typeof useDeployment> }) {
  const harness = deployment?.harness;
  if (!harness) return null;
  const rows = Object.entries(harness.running).sort(([a], [b]) => a.localeCompare(b));
  return (
    <section>
      <SectionHeader title="HARNESS VERSION" />
      <div className="border border-line p-3 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <span className="badge">{harness.status}</span>
          <span className="text-muted">
            declared: <span className="font-mono">{harness.declaredRange ?? "unknown"}</span>
          </span>
        </div>
        {harness.messages.length > 0 ? (
          <ul className="mt-3 space-y-1 text-[11px] text-muted">
            {harness.messages.map((msg) => (
              <li key={msg}>{`// ${msg}`}</li>
            ))}
          </ul>
        ) : null}
        <dl className="mt-3 grid gap-1 text-[11px] sm:grid-cols-2">
          {rows.map(([name, version]) => (
            <div key={name} className="flex justify-between gap-3 border border-line px-2 py-1">
              <dt className="truncate font-mono">{name}</dt>
              <dd className="font-mono text-muted">{version}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

function ConfigStatusBanner({ deployment }: { deployment: ReturnType<typeof useDeployment> }) {
  if (!deployment) return null;
  const wired = Boolean(
    deployment.renderService?.serviceId && deployment.renderService.apiKeyConfigured,
  );
  if (wired) {
    return (
      <p className="mb-3 text-[11px] text-muted">
        {"// edits write through the Render API — service auto-restarts on save"}
      </p>
    );
  }
  const missing: string[] = [];
  if (!deployment.renderService?.serviceId) missing.push("RENDER_SERVICE_ID");
  if (!deployment.renderService?.apiKeyConfigured) missing.push("RENDER_API_KEY");
  return (
    <p className="mb-3 border border-line p-2 text-[11px] text-muted">
      {`// ${missing.join(" + ")} not set — edits will open the Render dashboard instead. Set those env vars on this service to enable in-UI writes.`}
    </p>
  );
}

function EnvVarRow({ envVar, onEdit }: { envVar: DeploymentEnvVar; onEdit: () => void }) {
  // Visual hierarchy without a redundant status pill:
  //   - already set    → bordered "rotate" (subtle; no action required)
  //   - unset optional → solid accent "set" (clear call to action)
  //   - unset required → solid red "set" (urgent — service won't work)
  const buttonClass = envVar.isSet
    ? "btn"
    : envVar.required
      ? "btn btn-danger-solid"
      : "btn btn-primary";
  return (
    <li className="flex items-start gap-3 border border-line p-3 text-xs">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="font-mono text-sm">{envVar.name}</span>
          {envVar.secret ? <span className="badge">secret</span> : null}
          {envVar.source === "capability" && envVar.packName ? (
            <span className="text-[10px] text-muted">{envVar.packName}</span>
          ) : null}
        </div>
        {envVar.description ? (
          <p className="mt-1 text-[11px] text-muted">{envVar.description}</p>
        ) : null}
        {envVar.default !== undefined && !envVar.isSet ? (
          <p className="mt-1 text-[11px] text-muted">
            default: <span className="font-mono">{envVar.default}</span>
          </p>
        ) : null}
      </div>
      <button type="button" onClick={onEdit} className={buttonClass}>
        {envVar.isSet ? "rotate" : "set"}
      </button>
    </li>
  );
}

function EditEnvVarModal({
  envVar,
  canWrite,
  renderServiceId,
  onClose,
  onSaved,
}: {
  envVar: DeploymentEnvVar;
  canWrite: boolean;
  renderServiceId: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reveal, setReveal] = useState(false);

  const dashboardUrl = renderServiceId
    ? `https://dashboard.render.com/services/${encodeURIComponent(renderServiceId)}/env`
    : "https://dashboard.render.com";

  const onSave = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await setEnvVar(envVar.name, value);
      if (res.ok || res.restart) {
        onSaved();
        return;
      }
      setError(res.details ?? res.error ?? "save failed");
    } catch (err) {
      // Render may kill the process mid-flight on env-var change; a
      // disconnect after submit is almost always success. Treat
      // network errors as "probably saved, re-poll".
      if (err instanceof TypeError) {
        onSaved();
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 cursor-default"
        onClick={onClose}
      />
      <div
        className="panel relative max-h-[90vh] w-full max-w-lg overflow-auto bg-bg p-5 text-xs"
        role="dialog"
        aria-modal="true"
        aria-label={`Edit ${envVar.name}`}
      >
        <header className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-bold uppercase tracking-wide">
            {envVar.isSet ? "rotate" : "set"} — <span className="font-mono">{envVar.name}</span>
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="border border-line px-2 py-1 text-xs"
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        {envVar.description ? (
          <p className="mb-3 text-[11px] text-muted">{envVar.description}</p>
        ) : null}

        {canWrite ? (
          <>
            <label className="block">
              <span className="block text-[10px] uppercase tracking-wide text-muted">value</span>
              <div className="mt-1 flex gap-2">
                <input
                  type={envVar.secret && !reveal ? "password" : "text"}
                  className="w-full border border-line bg-transparent p-2 font-mono text-xs"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                />
                {envVar.secret ? (
                  <button
                    type="button"
                    onClick={() => setReveal((r) => !r)}
                    className="border border-line px-2 py-1 text-[10px]"
                  >
                    {reveal ? "hide" : "show"}
                  </button>
                ) : null}
              </div>
            </label>
            <p className="mt-2 text-[10px] text-muted">
              Saving writes through the Render API. The service will restart automatically once the
              new value is committed.
            </p>
            {error ? (
              <p className="mt-3 border border-line p-2 text-[11px] text-err">{error}</p>
            ) : null}
            <footer className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={submitting}
                className="border border-line px-3 py-1.5 text-xs"
              >
                cancel
              </button>
              <button
                type="button"
                onClick={onSave}
                disabled={submitting || value.length === 0}
                className="border border-accent bg-accent px-3 py-1.5 text-xs text-bg disabled:opacity-50"
              >
                {submitting ? "saving…" : "save & restart"}
              </button>
            </footer>
          </>
        ) : (
          <>
            <p className="mb-3 text-[11px]">
              In-UI writes aren't enabled on this deployment. To set{" "}
              <span className="font-mono">{envVar.name}</span>, open the Render dashboard and add it
              to this service's env vars.
            </p>
            <p className="mb-3 text-[10px] text-muted">
              To enable in-UI editing, set <span className="font-mono">RENDER_API_KEY</span> on this
              service. (RENDER_SERVICE_ID is injected by Render automatically.)
            </p>
            <footer className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="border border-line px-3 py-1.5 text-xs"
              >
                close
              </button>
              <a
                href={dashboardUrl}
                target="_blank"
                rel="noreferrer"
                className="border border-accent bg-accent px-3 py-1.5 text-xs text-bg"
              >
                open Render dashboard →
              </a>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
