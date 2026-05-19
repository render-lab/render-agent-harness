/**
 * Connections tab — per-end-user OAuth connections (cap-google,
 * cap-microsoft, etc.).
 *
 * Lists every OAuth provider the deployed harness has registered
 * (populated by `defineFromConfig` via capability packs' `oauthProviders`
 * field). For each provider, shows either:
 *
 *   - "Connect" button → POSTs to `/connections/:provider/start`,
 *     gets an authorize URL, full-page navigates the browser to it.
 *     The provider redirects to `/connections/:provider/callback`
 *     which exchanges the code, stores the encrypted tokens, and 302s
 *     back here with `?connected=<provider>`.
 *
 *   - "Disconnect" button when the user already has a row, with the
 *     connected account label and scope summary.
 *
 * Surfaces actionable hints when:
 *   - the deployment didn't set `CONNECTIONS_ENCRYPTION_KEY`
 *     (server returns 503 — clientCredentialsConfigured is the proxy
 *      signal we surface here, though the Diagnostics tab carries the
 *      detailed message)
 *   - per-provider OAuth client credentials are missing
 */

import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  type ConnectionProviderSummary,
  type ConnectionsResp,
  deleteConnection,
  listConnections,
  startConnection,
  type UserConnectionSummary,
} from "../api.js";
import { AsyncBoundary } from "../components/AsyncBoundary.js";
import { SectionHeader } from "../components/SectionHeader.js";
import { useToast } from "../components/Toaster.js";

export function ConnectionsTab() {
  const [data, setData] = useState<ConnectionsResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const toast = useToast();

  const refresh = useCallback(async () => {
    try {
      const res = await listConnections();
      setData(res);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, []);

  // Surface success / error from the OAuth round-trip via query params
  // the callback route sets (`?connected=<provider>` or `?error=<code>`).
  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
    const connected = params.get("connected");
    const errorCode = params.get("error");
    if (connected) {
      toast.show({
        id: "conn-ok",
        intent: "success",
        title: "Connected",
        message: `${connected} is connected and ready to use.`,
      });
    }
    if (errorCode) {
      toast.show({
        id: "conn-err",
        intent: "error",
        title: "Connection failed",
        message: errorCode,
        duration: 0,
      });
    }
    if (connected || errorCode) {
      const clean = window.location.hash.split("?")[0] ?? "#/connections";
      window.history.replaceState(null, "", clean);
    }
  }, [toast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onConnect = useCallback(
    async (provider: string) => {
      try {
        const res = await startConnection(provider);
        // Full-page navigation — the provider needs to set its own cookies
        // and redirect back to our callback route, which then 302s the
        // browser back to /ui#/connections.
        window.location.href = res.authorizeUrl;
      } catch (err) {
        toast.show({
          id: `conn-start-${provider}`,
          intent: "error",
          title: `Could not start ${provider} connection`,
          message: err instanceof ApiError ? err.message : String(err),
          duration: 0,
        });
      }
    },
    [toast],
  );

  const onDisconnect = useCallback(
    async (provider: string) => {
      try {
        await deleteConnection(provider);
        toast.show({
          id: `conn-disc-${provider}`,
          intent: "success",
          title: "Disconnected",
          message: `${provider} connection removed.`,
        });
        await refresh();
      } catch (err) {
        toast.show({
          id: `conn-disc-${provider}`,
          intent: "error",
          title: `Could not disconnect ${provider}`,
          message: err instanceof ApiError ? err.message : String(err),
          duration: 0,
        });
      }
    },
    [refresh, toast],
  );

  return (
    <div className="space-y-6">
      <section>
        <SectionHeader title="CONNECTIONS" />
        <p className="mb-3 text-[11px] text-muted">
          {
            "// per-end-user OAuth tokens stored encrypted in the loop's database and refreshed on use"
          }
        </p>
        <AsyncBoundary
          loading={loading}
          error={error}
          empty={{
            when: !data || data.providers.length === 0,
            message:
              "// no OAuth providers registered — install a capability pack that declares oauthProviders (e.g. @render-harness/cap-google)",
          }}
        >
          {data ? (
            <ul className="space-y-2">
              {data.providers.map((provider) => (
                <ProviderRow
                  key={provider.id}
                  provider={provider}
                  connection={data.connections.find((c) => c.provider === provider.id) ?? null}
                  onConnect={() => onConnect(provider.id)}
                  onDisconnect={() => onDisconnect(provider.id)}
                />
              ))}
            </ul>
          ) : null}
        </AsyncBoundary>
      </section>
    </div>
  );
}

function ProviderRow({
  provider,
  connection,
  onConnect,
  onDisconnect,
}: {
  provider: ConnectionProviderSummary;
  connection: UserConnectionSummary | null;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const ready = provider.clientCredentialsConfigured;
  return (
    <li className="flex flex-wrap items-start gap-3 border border-line p-3 text-xs">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="font-mono text-sm">{provider.displayName}</span>
          <span className="text-[10px] text-muted">{provider.id}</span>
          {connection ? <span className="badge badge-fill">connected</span> : null}
          {!ready ? <span className="badge !text-err">not configured</span> : null}
        </div>
        {connection ? (
          <p className="mt-1 text-[11px] text-muted">
            connected as <span className="font-mono">{connection.accountLabel ?? "(unknown)"}</span>{" "}
            on {new Date(connection.connectedAt).toLocaleString()}
          </p>
        ) : null}
        {provider.requiredBy.length > 0 ? (
          <p className="mt-1 text-[11px] text-muted">
            required by: <span className="font-mono">{provider.requiredBy.join(", ")}</span>
          </p>
        ) : null}
        <p className="mt-1 text-[10px] text-muted">
          scopes:{" "}
          <span className="font-mono">
            {(connection?.scopes ?? provider.defaultScopes).join(" ")}
          </span>
        </p>
        {!ready ? (
          <p className="mt-2 text-[11px] text-err">
            OAuth client id/secret env vars are not set. See the Diagnostics tab for details.
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 gap-2">
        {connection ? (
          <>
            <button type="button" className="btn" onClick={onConnect} disabled={!ready}>
              reconnect
            </button>
            <button type="button" className="btn btn-danger-solid" onClick={onDisconnect}>
              disconnect
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-primary" onClick={onConnect} disabled={!ready}>
            connect
          </button>
        )}
      </div>
    </li>
  );
}
