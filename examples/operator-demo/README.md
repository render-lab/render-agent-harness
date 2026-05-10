# operator-demo

End-to-end demo of the operator UI: Postgres, Valkey, the multi-tenant web service (`serveWeb({ ui: true })`), and a worker — all in containers, with a fast iteration loop.

## First run

```sh
pnpm install
pnpm apps:operator-demo
```

That builds the workspace (~10s the first time, faster after) and brings up the four containers. Then open:

```
http://127.0.0.1:8082/ui/login
```

Sign in with the API key `demo`.

## After code changes (~5s loop)

```sh
pnpm apps:operator-demo:reload
```

That rebuilds the dist/ directories on the host, then restarts only the two app containers. The compose stack bind-mounts each workspace package's `dist/` into the image, so a host build is enough — no image rebuild, no `pnpm install` re-run.

If you change `package.json` or `pnpm-lock.yaml`, do a real image rebuild instead:

```sh
docker compose --profile operator-demo build operator-demo-web
pnpm apps:operator-demo
```

## Using the UI

You'll land on the **Chat** tab — type a message and hit Enter to talk to the demo agent.

The Chat tab keeps the whole conversation on one long-lived run that pauses between turns, so you can refresh the page, switch tabs, and come back to the same session. Each turn streams in via SSE; the **stop** button mid-response cancels the in-flight turn.

If you'd rather drive things over HTTP, the JSON+SSE API is unchanged:

```sh
curl -sS http://127.0.0.1:8082/runs \
  -H 'authorization: Bearer demo' \
  -H 'content-type: application/json' \
  -d '{"input":"hello"}'
```

Curl-enqueued runs land in the Runs tab the same way Chat-tab runs do. Without `ANTHROPIC_API_KEY` (see below) the model call fails, but the UI shell, the Runs/Agents/Usage tabs, and the failure traceback all render fine.

Tear down:

```sh
docker compose --profile operator-demo down
```

## Letting the agent actually run

The demo agent uses Anthropic. Drop the key in a root-level `.env`:

```sh
echo 'ANTHROPIC_API_KEY=sk-ant-...' >> .env
pnpm apps:operator-demo:reload
```

Compose reads `.env` from the project root automatically and substitutes `${ANTHROPIC_API_KEY:-}` into the service env. The `.env` file is `.gitignore`d, so the key never gets committed.

Without it, the UI still works fully — every tab renders, including Chat (you'll just see runs fail at the model call). The login form, history rehydration, and the SSE plumbing don't depend on the model.

## What's running

| Container | Source | Role |
|---|---|---|
| `render-harness-operator-web` | [`Dockerfile`](Dockerfile) → `dist/web.js` | `serveWeb({ ui: true })` — JSON+SSE API + `/ui/*` |
| `render-harness-operator-worker` | shared image → `dist/worker.js` | `startWorkerAndWait` consuming `operator-demo-runs` |
| `render-harness-postgres` | `compose.yaml` | run state + queue |
| `render-harness-valkey` | `compose.yaml` | cancel-flag KV |

The image bakes pnpm install + a workspace build, so a cold `pnpm apps:operator-demo` works without anything else. The compose stack then bind-mounts the host's built `dist/` directories over the image's baked copies — that's what makes `apps:operator-demo:reload` a 5-second loop.

## Inner-loop dev (HMR)

If you're iterating on the SPA, run Vite dev mode on the host instead of relying on container restarts:

```sh
# In one terminal: keep the compose backend running.
pnpm apps:operator-demo

# In another: Vite dev server with HMR; proxies API calls to :8082.
pnpm --filter @render-harness/ui dev:web
# open http://127.0.0.1:5184
```

Log in once via `http://127.0.0.1:8082/ui/login` to seed the session cookie, then HMR-edit at `:5184`.

## How the UI auth works in this demo

- `WEB_API_KEY=demo` is hardcoded in `compose.yaml` for the demo profile.
- The cookie session secret (`UI_COOKIE_SECRET`) is also hardcoded — fine for local-only, do not reuse on Render.
- Both can be overridden by exporting them in your shell before `docker compose up`.

For production deploys, see `blueprints/render.private.yaml` (`UI_COOKIE_SECRET` uses `generateValue: true`; `WEB_API_KEY` is `sync: false`).
