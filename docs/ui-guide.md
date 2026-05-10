# Operator UI

`@render-harness/ui` is an opt-in operator control plane that mounts on top of `@render-harness/web`. It serves a small React SPA at `/ui` so a developer or operator can chat directly with their agent, list runs, watch live streams, cancel runs, inject HITL input, inspect loaded agents, and see daily usage rollups — without writing curl commands.

The split between the two packages is deliberate:

- `@render-harness/web` owns **all** HTTP endpoints — the existing JSON+SSE surface (`POST /runs`, `GET /runs/:id`, `GET /runs/:id/stream`, `POST /runs/:id/cancel`, `POST /runs/:id/input`) plus the read APIs the UI needs (`GET /runs`, `GET /runs/active`, `GET /runs/:id/tool-calls`, `GET /agents`, `GET /usage`).
- `@render-harness/ui` owns **only** the browser-facing surface — the React SPA bundle, the `/ui/*` routes (shell, assets, login form, logout), and a cookie-session helper that web plugs into its auth resolver.

That keeps the API surface in one place. Any non-browser client can hit the read APIs over HTTP without involving the UI package at all.

## What's in the UI

- **Chat** *(default tab)*: a Claude-Code-style chat surface that talks directly to your agent. Each conversation lives on one long-lived run; turns stream in via SSE and the same run stays open across page refreshes and across the operator's session. Built on [`@assistant-ui/react`](https://www.assistant-ui.com/), so the composer, autoscrolling viewport, and stop button come for free. Requires the agent to declare `shape: "chat"` in `defineAgent()` — without it the runner ends each turn in `completed` and the next user message starts a fresh run instead of continuing.
- **Runs**: list with status/agent filters and keyset pagination. Click a row for a detail view that merges the message stream and the tool-call timeline, updates live via SSE, and exposes Cancel and HITL Send-input controls. Runs that came from the Chat tab show a `chat` badge in the status column and an **Open in chat** button on the detail view.
- **Agents**: read-only inspector for the agents loaded into this web service — model, system prompt preview, MCP servers, permissions, budget, sampling.
- **Usage**: daily and per-agent rollups of run count, cost, and tokens across a 7/30/90-day window.

What it deliberately doesn't do (yet):

- Doesn't redefine agents. They stay code-first via `defineAgent()`.
- Doesn't edit env vars or secrets. That's planned for Phase 2/3 of the UI roadmap.
- Doesn't model conversations as a first-class object. One chat session = one run; if you want list-of-past-sessions UI, branching, or per-conversation cost rollups, that calls for a real `conversations` table — out of scope for this iteration.

## Chat shape: how the multi-turn loop works

The Chat tab leans entirely on existing primitives in `@render-harness/core` plus one small flag:

```ts
defineAgent({
  name: "demo",
  version: "0.2.0",
  model: { provider: "anthropic", model: "claude-sonnet-4-6" },
  systemPrompt: "...",
  shape: "chat",
});
```

When `shape: "chat"` is set, the agent loop in [packages/core/src/loop.ts](../packages/core/src/loop.ts) ends each turn in `paused` (with `metadata.pauseReason = "chat_turn_end"`) instead of `completed`. The Chat tab appends the next user message via the existing `POST /runs/:id/input` rail, which sets the run back to `pending` and re-enqueues it. The next iteration loads the full message history from Postgres and feeds it to the model. No new endpoints, no schema migration, no separate `conversations` table — just a small behavior flip on the loop's terminal branch.

Cancel works as before: the **stop** button issues `POST /runs/:id/cancel`, the worker observes the KV flag between turns and tool calls, and the in-flight turn ends in `cancelled`. The chat session is gone at that point — clicking **new chat** starts a fresh run.

## Enabling the UI

The UI is opt-in via `serveWeb({ ui: true })`. When `ui` is unset, behavior is unchanged from before this package existed.

```ts
import { serveWeb } from "@render-harness/web";
import { agent } from "./agent.js";

await serveWeb({
  agent,
  ui: true,
});
```

Defaults that apply when you pass `ui: true`:

- Mount path: `/ui`.
- Auth: cookie session backed by `UI_COOKIE_SECRET` (set this — see below). The cookie is signed, HTTP-only, and `Secure` in production.
- The login form validates the API key against the same `auth` resolver the JSON API uses (default: `Authorization: Bearer <WEB_API_KEY>`).
- The SPA bundle ships in `node_modules/@render-harness/ui/dist/static/` after `pnpm build`. To serve from a different directory, pass `ui: { staticDir: "..." }`.

Override the defaults by passing an object:

```ts
await serveWeb({
  agent,
  ui: {
    path: "/admin",
    cookieName: "harness_admin",
    cookieMaxAge: 60 * 60, // 1 hour
  },
});
```

`@render-harness/ui` is an optional peer dependency. The web service loads it via dynamic import only when `ui` is set, so services that don't enable the UI don't pull in React or Tailwind.

## Required environment variables

Set both before enabling the UI:

| Variable           | Purpose                                                      |
| ------------------ | ------------------------------------------------------------ |
| `WEB_API_KEY`      | Bearer key the existing JSON API already validates. The login form authenticates against this. |
| `UI_COOKIE_SECRET` | HMAC secret for the session cookie. Use a random 32-byte hex string. The Blueprint generates one automatically with `generateValue: true`. |

Without `UI_COOKIE_SECRET` the package falls back to a per-process random secret — fine for local dev, but operator browser sessions don't survive a restart.

## On Render: Blueprint wiring

[`blueprints/render.private.yaml`](../blueprints/render.private.yaml) declares both env vars on the public web service:

```yaml
- key: UI_COOKIE_SECRET
  generateValue: true
- key: WEB_API_KEY
  sync: false
```

Render generates `UI_COOKIE_SECRET` once on first deploy and keeps it stable across redeploys. Set `WEB_API_KEY` in the Dashboard before enabling the UI.

## Local development

The fastest way to see the UI working is the operator-demo profile — one command, no host setup:

```sh
docker compose --profile operator-demo up -d --wait
# http://127.0.0.1:8082/ui/login — sign in with "demo"
```

See [`examples/operator-demo/README.md`](../examples/operator-demo/README.md) for full details (Anthropic key, teardown, what's inside the image).

### Inner-loop dev on the SPA

The UI ships pre-built. To rebuild after editing the SPA:

```sh
pnpm --filter @render-harness/ui build
```

For HMR while editing the SPA:

```sh
# terminal 1: a harness web service with the UI mounted (compose works too)
pnpm db:up
docker compose --profile operator-demo up -d --wait

# terminal 2: vite dev server with HMR; proxies API calls to :8082
pnpm --filter @render-harness/ui dev:web
# open http://127.0.0.1:5184
```

In the dev server you'll need to log in once via `http://127.0.0.1:8082/ui/login` to seed the cookie, then HMR-edit at `:5184`.

## Endpoints

All JSON+SSE endpoints live on `@render-harness/web` and are available whether or not the UI is enabled:

| Method | Path                       | Purpose                                                |
| ------ | -------------------------- | ------------------------------------------------------ |
| POST   | `/runs`                    | Enqueue a new run.                                    |
| GET    | `/runs`                    | Filter+paginate runs (`?status=`, `?agent=`, `?cursor=`, `?limit=`, `?allUsers=1`). |
| GET    | `/runs/active`             | Caller's most recent non-terminal run for an agent (`?agent=`). Used by the Chat tab to rehydrate the current session on page load. Returns `{ run: null }` when no active run exists. |
| GET    | `/runs/:id`                | Run detail + full message history.                    |
| GET    | `/runs/:id/tool-calls`     | Tool calls joined to results for the run timeline.    |
| GET    | `/runs/:id/stream`         | SSE stream of messages and status updates.            |
| POST   | `/runs/:id/cancel`         | Cooperative cancel via KV flag.                       |
| POST   | `/runs/:id/input`          | Inject input into a paused run (HITL or chat-shape next turn). |
| GET    | `/agents`                  | Summary of agents loaded into this web service.       |
| GET    | `/usage`                   | Daily/per-agent rollups (`?from=`, `?to=`, `?allUsers=1`). |
| GET    | `/healthz`                 | Liveness probe.                                       |

When `ui: true` is set, web additionally mounts the browser surface from `@render-harness/ui`:

| Method | Path                | Purpose                                          |
| ------ | ------------------- | ------------------------------------------------ |
| GET    | `/ui/`              | SPA shell (HTML).                                |
| GET    | `/ui/assets/*`      | SPA static bundle.                               |
| GET    | `/ui/login`         | Login form.                                      |
| POST   | `/ui/login`         | Validate API key, set session cookie.            |
| POST   | `/ui/logout`        | Clear the session cookie.                        |

## Auth

Two ways in, both honoured by every endpoint above:

- **Cookie session**: visit `/ui/login` in a browser and submit the API key. The server validates it against `auth()` and sets a signed cookie. Subsequent requests carry the cookie.
- **Bearer header**: every endpoint also accepts `Authorization: Bearer <key>`. Useful for curl-driven smoke tests and non-browser clients.

The plumbing: when you set `ui: true`, `serveWeb` calls `wrapWithSession()` from `@render-harness/ui` to wrap your `auth()` resolver. The wrapped resolver tries the signed cookie first and falls back to the upstream resolver. The same wrapped resolver is used by every route on the Hono app — there's no per-route duplication. The cookie carries whatever `userId` your `auth()` returned at login time. The default resolver returns the literal string `"api-key"`.

## When you'd want a separate UI service

The UI runs in the same process as the public web service. That's the right shape for almost every deployment — the UI is a thin wrapper over the same Postgres pool and agent map. If you outgrow it (e.g. you want the UI behind separate auth, on a separate domain, or with a separate scale plan), `mountUi()` is exported directly from `@render-harness/ui` and you can mount it on any standalone Hono app pointed at the same Postgres.
