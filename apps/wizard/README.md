# @render-harness/wizard

Browser wizard that scaffolds a Render agent project, creates a managed GitHub repo, and returns a Deploy-to-Render link. Phase 3 of the onboarding direction (see [`docs/ui-scaffolder-plan.md`](../../docs/ui-scaffolder-plan.md)).

This is a **deployable application**, not a library. It lives in `apps/` (not `packages/`) and is `private: true` — it isn't published to npm. Production deployment happens by `git push` to a Render web service that runs `node dist/main.js`. Self-hosters install the same way.

The single Hono process serves:

- The Vite-built React SPA at `/` (static files in `dist/static`).
- `/api/*` routes the SPA calls (gallery, scaffold, browse, capabilities catalog, agent-add, capability-install, model-edit, auth, /my).
- `/healthz` for the platform liveness probe.

## Run it locally

The fast path: from the repo root,

```sh
pnpm dev:wizard
# open http://127.0.0.1:5185
```

That runs the Hono server (port 8090) and the Vite SPA (port 5185) concurrently. Vite proxies `/api/*` and `/healthz` to the server. The server is started with `MOCK_SCAFFOLD=true` so `/api/scaffold` returns a fake repo URL and you can click through the entire flow without a GitHub App.

If you want the production-shape env, copy `.env.example` to `.env` and uncomment the tier you need (Tier 0 browse-only, Tier 1 mock, Tier 2 Postgres-backed sessions, Tier 3 real GitHub App). The file documents every var inline.

## Env tiers

| Tier | What you get | Required env |
|---|---|---|
| **0 — browse-only** | `/`, `/browse`, gallery API. `/api/scaffold` 503s. | None. |
| **1 — mock end-to-end** | Above + clickable scaffold flow with fake repo URLs. | `MOCK_SCAFFOLD=true` (set automatically by `pnpm dev`). |
| **2 — Postgres-backed sessions** | Tier 1 + `/my`, session cookies, ownership-aware routes. | `DATABASE_URL` (points at `pnpm db:up`'s Postgres), `WIZARD_SESSION_SECRET`. |
| **3 — real GitHub App** | Tier 2 + actual repo creation in `MANAGED_ORG`. | `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_NAME`, `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`. |

The wizard never *requires* Tier 2 or 3 to boot — every Postgres-backed or GitHub-backed route returns a clean 503 with an actionable error code when its prereqs aren't set, so partial-config dev works fine.

## Layout

```
apps/wizard/
├── package.json
├── tsup.config.ts                  # builds the server entry to dist/main.js
├── src/                            # Hono server
│   ├── main.ts                     # entry — wires routes + boots
│   ├── env.ts                      # env parsing + tier detection
│   ├── routes/                     # one file per HTTP route
│   ├── github-app.ts               # Octokit GitHub App auth
│   ├── store.ts                    # Postgres ownership store
│   ├── db.ts                       # connection pool + migrations
│   ├── rate-limit.ts               # in-memory IP rate limiter
│   ├── turnstile.ts                # Cloudflare Turnstile verification
│   ├── agent-add.ts                # /api/agents/add planner + commit
│   ├── capability-install.ts       # /api/capabilities/install planner + commit
│   ├── runtime-entries.ts          # render-harness.yaml mutators
│   └── yaml-edit.ts                # conservative yaml round-trip
├── web/                            # Vite + React SPA
│   ├── index.html
│   ├── vite.config.ts              # dev proxy to 127.0.0.1:8090
│   ├── tsconfig.json
│   └── src/
│       ├── main.tsx
│       ├── App.tsx                 # the wizard itself (template + steps)
│       ├── BrowsePage.tsx          # /browse list + filters
│       ├── MyHarnesses.tsx         # /my dashboard (session-gated)
│       ├── steps/                  # one file per wizard step
│       ├── components/Select.tsx   # custom dropdown shared across pages
│       ├── lib/                    # api client, types
│       └── index.css               # brutalist black/white theme
├── sql/                            # ownership store migrations
└── dist/                           # build output (server + static SPA)
```

## Build for production

```sh
pnpm --filter @render-harness/wizard build
node apps/wizard/dist/main.js
```

`pnpm build` from the repo root walks `packages/*`, `examples/*`, and `apps/*` in that order, so a workspace build picks the wizard up automatically.

## Tests

```sh
pnpm --filter @render-harness/wizard test            # all 17 files
pnpm --filter @render-harness/wizard test -- agent-add   # one suite by name
```

The wizard tests don't need Postgres or GitHub credentials — fakes for both stores live next to the route tests.

## Deploy

The wizard ships to production via a Render web service whose build command is `pnpm --filter @render-harness/wizard build` and whose start command is `node apps/wizard/dist/main.js`. The required runtime env vars are the Tier 2 + Tier 3 set above plus `TURNSTILE_SECRET_KEY` and `WIZARD_SHARED_SECRET`.

There's no committed `render.yaml` in this repo for the wizard — its Render service is configured in the Dashboard. (We removed the aspirational `render-harness.yaml`/`render.yaml` dogfood plan in May 2026; the wizard isn't an agent and the harness emitter never quite fit it.)

## Why is this private and under `apps/`?

- Private (`"private": true`): nothing imports `@render-harness/wizard`, no `harnessVersion` range checks against it, and there's no `bin` to `npx`. Publishing it brings real coordination cost (Trusted Publisher OIDC config, every coordinated minor cut has to remember to bump it explicitly — see [`AGENTS.md`](../../AGENTS.md)) and zero observable benefit.
- Under `apps/`: `packages/*` is "library code we publish". Wizard isn't either. The split makes the architectural distinction explicit and stops the wizard from being dragged into release-process churn that's irrelevant to it.
