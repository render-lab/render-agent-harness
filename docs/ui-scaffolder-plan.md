# UI scaffolder: browser wizard + managed-repo (v1)

## Context

Phase 3 of [`onboarding-plan.md`](./onboarding-plan.md). The CLI scaffolder ([`cli-scaffolder-plan.md`](./cli-scaffolder-plan.md), shipped) gives technical users an `npx create-render-agent` path. The gallery ([`gallery-plan.md`](./gallery-plan.md), shipped) gives both surfaces a shared source of starter templates. The local-link unblocker (latest commit) lets contributors test before the harness is on npm; the [`publish-plan.md`](./publish-plan.md) covers the rename + first publish.

What's missing is the **no-code path** — a browser wizard end users can hit without a terminal. v1 is the minimum that takes a non-technical user from "nothing" to "deployed agent on Render."

Three decisions locked in conversation before this plan:

- **v1 scope: wizard SPA only.** No "my agents" dashboard, no edit-after-deploy, no graduation/transfer flow. Each wizard run creates a fresh managed repo and returns a one-click Deploy-to-Render Blueprint URL. The user's persistent identity for that agent lives on Render's side once they deploy — we don't carry it on the wizard side.
- **The wizard runs on Render itself.** A new `apps/wizard` Render web service. Eats own dogfood; ships via the same Blueprint we're asking users to use; no Render dashboard/marketing-site coordination required to ship. (Originally scaffolded under `packages/wizard`; relocated to `apps/wizard` once it became clear the wizard is a deployable app, not a library.)
- **Bot identity: new GitHub App.** Render-owned GitHub App with permissions scoped to the managed-agents org, installed once. The wizard backend authenticates as the App (JWT-signed installation tokens) to create repos and push commits.

This plan is the wizard frontend, the wizard backend, the GitHub App integration, the deploy-link generation, and the abuse-mitigation. Everything beyond that (managed dashboard, runtime admin edits, graduation transfer) is explicitly deferred to a future "Phase 3.x — managed dashboard" plan.

## Dependencies

- **`docs/publish-plan.md` ideally lands first.** The wizard's emitted manifests reference `@render-harness/*` deps; until those packages exist on npm, generated scaffolds need local-link (which assumes a harness checkout — defeats the no-code purpose) or `pnpm install` fails. Not strictly blocking — the wizard itself works during publish gaps — but the *generated* agents only run after publish.
- **`create-render-agent` exports `buildFileMap` as a pure function.** Today it exports `generate` (disk-writing) and `runWizard` (TTY-prompt-driven). The wizard backend needs the pure file-map function to commit via GitHub API instead of fs. Trivial follow-up: export the existing `buildFileMap` from `generate.ts`. ~3 lines.
- **GitHub App registration.** Out-of-repo: someone with Render-org GitHub admin creates the App and gives the wizard backend its client ID + private key + installation ID via env vars. Blocking for execution but not for planning.
- **Managed-repo GitHub org.** New GitHub org (proposed name: `render-lab-agents`) where managed agent repos live. Out-of-repo creation step.

## Architecture

### 3.1 Topology

A single new Render service: a Hono web app deployed from this repo. The same service:

1. Serves a Vite-built React SPA from `/` (static asset, no SSR).
2. Exposes Hono routes under `/api/*` (JSON, REST-ish).
3. Holds the GitHub App credentials and talks to the GitHub REST API to create + populate managed repos.
4. Holds short-lived `wizard_sessions` in memory (no DB until we add the dashboard in v2 — anonymous sessions don't need persistence).

```
                       ┌──────────────────────────────────────┐
                       │   apps/wizard/  (Render web)         │
   User browser  ──►   │   ┌─────────────┐   ┌────────────┐   │
                       │   │  React SPA  │   │  Hono API  │   │
                       │   │  (static)   │   │  /api/*    │   │
                       │   └─────────────┘   └─────┬──────┘   │
                       └────────────────────────────┼──────────┘
                                                    │
                                                    ▼
                                       ┌────────────────────────┐
                                       │  GitHub App            │
                                       │  → render-lab-agents/  │
                                       │     <slug>             │
                                       └────────────────────────┘
                                                    │
                                                    ▼
                                       https://render.com/deploy?…
```

No database, no queue, no auth provider for v1. The service is stateless beyond its in-process session cache. This is intentional — when v2 adds the managed dashboard, the persistence layer comes with it.

### 3.2 Wizard frontend (`apps/wizard/web`)

Vite + React + Tailwind, matching [`packages/ui/web`](../packages/ui/web)'s stack. Single-page wizard with the same prompts as the CLI, in the same order:

1. Pick a gallery template (or "blank")
2. Agent name + description
3. System prompt (textarea)
4. Model (select)
5. Trigger surfaces (multi-select) → conditional cron schedule, worker queue
6. Operator UI toggle (with auto-add-worker note when selected)
7. Capability packs (multi-select from gallery)
8. Final review screen → "Create agent" button

State management: plain `useState` / `useReducer`. No Redux, no Zustand. The wizard state is small and short-lived.

After "Create agent":

1. Loading spinner with progress messages: "Creating repository… Committing files… Generating deploy link…"
2. Success screen with:
   - The managed repo URL (clickable but not strictly user-facing — the user doesn't have access to it in v1)
   - A big **Deploy to Render** button → opens Render's Blueprint deploy flow in a new tab
   - A "What happens next" block explaining: fill in API keys on Render, ~2 min to provision, agent URL shows up in their Render dashboard

The SPA fetches `/api/gallery` once at boot to populate the template + capability selectors, mirroring the CLI's `resolveGallery()`.

### 3.3 Wizard backend (`apps/wizard/server`)

Hono routes:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/healthz` | Liveness probe. |
| `GET` | `/api/gallery` | Returns the resolved gallery (`ResolvedGallery` JSON) for the SPA to render. Reads from the bundled snapshot, exactly like the CLI's `resolveGallery()`. |
| `POST` | `/api/scaffold` | Body: wizard `Answers`. Validates against the schema, calls `buildFileMap`, creates a repo + commits files via GitHub App, returns `{ repoUrl, deployUrl }`. |
| `GET` | `/api/render-deploy-url` (helper) | Optional: client-side helper that constructs the Render Blueprint deploy URL from a repo URL + ref. May be inlined into the SPA instead. |

Static asset handler at `/` serves the Vite build output.

### 3.4 GitHub App integration

A new GitHub App owned by the Render organization. Configuration:

- **Name**: "Render Lab Wizard" (display) / `render-lab-wizard` (slug).
- **Installation target**: organization-level, installed once on `render-lab-agents` (the managed-agents org).
- **Permissions**:
  - Repository contents: read & write (commit files to a fresh repo)
  - Repository metadata: read (verify creation)
  - Administration: write (create + delete repos in the org)
  - No user-level permissions; the App acts on the org's behalf only.
- **Events**: none (we don't react to webhooks in v1).
- **Webhook URL**: unused for v1, but reserve a path (`/api/github/webhook`) so v2 can wire repo-deleted, push, etc. without re-registering.

Backend usage (TypeScript, using `@octokit/auth-app` + `@octokit/rest`):

```ts
const app = createAppAuth({
  appId: env.GITHUB_APP_ID,
  privateKey: env.GITHUB_APP_PRIVATE_KEY,
  installationId: env.GITHUB_APP_INSTALLATION_ID,
});

// Per request: mint a short-lived installation token, scope it tight.
const { token } = await app({ type: "installation" });
const octokit = new Octokit({ auth: token });

// 1. Create repo
const { data: repo } = await octokit.repos.createInOrg({
  org: "render-lab-agents",
  name: slug,            // e.g. "my-agent-7af3"
  private: true,
  auto_init: false,
  description: answers.description,
});

// 2. Commit files (one tree, one commit, point branch at it).
const tree = await octokit.git.createTree({
  owner: "render-lab-agents",
  repo: repo.name,
  tree: [...fileMap].map(([path, content]) => ({
    path, mode: "100644", type: "blob", content,
  })),
});
const commit = await octokit.git.createCommit({
  owner: "render-lab-agents",
  repo: repo.name,
  message: "Initial scaffold via create-render-agent wizard",
  tree: tree.data.sha,
  parents: [],
});
await octokit.git.createRef({
  owner: "render-lab-agents",
  repo: repo.name,
  ref: "refs/heads/main",
  sha: commit.data.sha,
});
```

Required env vars on the Render service:
- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY` (the PEM, multi-line — store as secret env var)
- `GITHUB_APP_INSTALLATION_ID`
- `MANAGED_ORG` (default: `render-lab-agents`)
- `WIZARD_PUBLIC_URL` (the public URL of the wizard service, for Deploy-to-Render referer)

### 3.5 Identity model for v1: anonymous

No login. No user accounts on the wizard side. Each wizard run is a fresh, untracked session. The user identifies themselves only when they hit the Deploy-to-Render link and authenticate with their Render account on Render's side.

This is the minimum-viable identity model. Consequences:

- We can't show "my agents" — there's no `my`. Fine for v1.
- We can't do graduation/transfer — there's no user to transfer to. Deferred to v2 when we add login + dashboard.
- Anyone with the wizard URL can create a managed repo. Mitigation: §3.7 abuse controls.

### 3.6 Deploy-to-Render URL

After committing the scaffolded files, the wizard returns:

```
https://render.com/deploy?repo=https://github.com/render-lab-agents/<slug>
```

Render's Blueprint deploy flow reads the committed `render.yaml`, prompts for env vars (model API key + any pack-required keys + UI secrets), and provisions services. The user authenticates with Render at that point. No coordination with Render's web team needed — this is an existing public flow.

The wizard service includes a tiny "After you click Deploy" panel in the success UI explaining what to expect on Render's side, so users aren't blindsided by the API-key prompts.

### 3.7 Abuse mitigation (anonymous wizard)

Anonymous + repo-creation = spam vector. v1 controls:

1. **Cloudflare Turnstile** on `POST /api/scaffold`. The SPA mounts the widget on the final review screen; the API rejects requests without a valid Turnstile token. Free, minimal UX impact, well-understood. Env var: `TURNSTILE_SECRET_KEY`.
2. **Per-IP rate limit** in the Hono service: max N scaffolds per IP per hour (in-memory token bucket; precise threshold tuned post-launch). Survives a single-instance pserv; if we scale-out, move to KV-backed.
3. **Janitor cron** (separate Render cron service or a daily `setInterval` on the wizard service): deletes managed repos older than 14 days that have zero commits beyond the initial scaffold and have no associated Render deploy. This keeps the managed org tidy and reduces the cost of spam getting through.

The janitor is a new tiny package (or a script within `apps/wizard`); fine either way. Plan describes it as part of v1 but it can ship as a follow-up commit if needed.

## Wizard UX flow (end-to-end)

```
1. User lands on https://wizard.render-lab.com (or wherever it deploys).
2. Empty wizard, "Start a new agent" header.
3. Step 1: template select  (← /api/gallery)
4. Step 2: name + description
5. Step 3: system prompt
6. Step 4: model
7. Step 5: trigger surfaces (with conditional cron/worker prompts)
8. Step 6: UI toggle
9. Step 7: capabilities
10. Step 8: review screen with Cloudflare Turnstile widget + "Create agent" button
11. Loading: "Creating repository…" → POST /api/scaffold
12. Success: repo URL (informational) + big "Deploy to Render" CTA + "What happens next"
13. User clicks Deploy → opens render.com/deploy?repo=… in a new tab
14. User completes Render's deploy flow (API keys, plan, region).
15. Agent is live; user gets a Render URL.
```

No persistent session after step 13. The user doesn't return to the wizard for that agent — they manage it via Render's dashboard. A future v2 with "my agents" lets users come back.

## File-by-file changes

### New: `apps/wizard/`

```
apps/wizard/
├── package.json
├── tsconfig.json
├── tsup.config.ts                      # builds the server entry
├── vite.config.ts                      # builds the SPA into web/dist
├── render-harness.yaml                 # this service is itself a Render web service
├── render.yaml                         # generated; committed
├── src/
│   ├── main.ts                         # Hono server entry; mounts SPA + /api
│   ├── routes/
│   │   ├── gallery.ts                  # GET /api/gallery
│   │   ├── scaffold.ts                 # POST /api/scaffold
│   │   └── health.ts                   # GET /healthz
│   ├── github-app.ts                   # GitHub App auth + commit helpers
│   ├── turnstile.ts                    # verify Turnstile token
│   ├── rate-limit.ts                   # in-memory IP rate limit
│   └── janitor.ts                      # repo cleanup (cron-triggered)
└── web/                                # the React SPA
    ├── index.html
    ├── src/
    │   ├── main.tsx
    │   ├── App.tsx
    │   ├── steps/                      # one component per wizard step
    │   ├── lib/api.ts                  # fetch wrappers for /api/*
    │   └── lib/gallery.ts              # types mirroring server response
    └── public/
```

### Modified

- `packages/create-render-agent/src/index.ts` — export `buildFileMap` (currently only exported indirectly through `generate`). One-line change.
- `packages/create-render-agent/src/generate.ts` — no logic change; just add `buildFileMap` to the public surface. Already a pure function returning `Map<string, string>`.
- `pnpm-workspace.yaml` — no change required; `packages/*` glob already picks up the new package.
- `docs/onboarding-plan.md` — flag Phase 3 v1 as in-flight; leave Phase 3.x (managed dashboard) as still-deferred.
- Root `package.json` — add a `dev:wizard` script for local development convenience.

### Files explicitly not changed

- `packages/create-render-agent/src/prompts.ts` — the wizard frontend reimplements its UX in React; the TTY prompts stay for the CLI surface.
- `packages/ui/` — the operator UI is a separate concern. It's mounted on top of an *already-deployed* agent's web service. The wizard is the create-time surface, not the run-time surface.
- The gallery (`gallery/`) — unchanged. The wizard reads from it via the same loader the CLI uses.
- The capability packs — unchanged.

## Reused existing primitives

- `buildFileMap(answers)` from `packages/create-render-agent/src/generate.ts`. Pure function; returns the file map the wizard backend turns into GitHub commits.
- `resolveGallery()` from `packages/create-render-agent/src/gallery.ts` — same gallery, same bundled snapshot via the existing prebuild script.
- `HarnessConfigSchema` for validating wizard inputs before committing (the SPA can call it client-side via the schema export from `@render-harness/registry/schema`).
- The Cloudflare Turnstile verification HTTP API.
- The Render Blueprint deploy URL convention.

## Out of scope for v1

Explicitly deferred (each gets its own plan when picked up):

1. **"My agents" dashboard.** No list, no edit, no live admin. Once a user clicks Deploy, the wizard is out of the picture for that agent. They manage from Render's dashboard. v2.
2. **Auth / login.** Anonymous wizard. v2 adds a login (likely Render OAuth + GitHub OAuth side-by-side) when the dashboard ships.
3. **Graduation / transfer to user's GitHub.** Requires user identity. v2.
4. **Edit-after-create flow.** No "rewizard" of an existing managed repo. If a user wants to change the agent, they edit the repo directly (clone from the managed org URL — they'll need read access, which requires identity, which is v2).
5. **Custom-domain handling on the deploy.** Just whatever Render's deploy flow does today.
6. **Live preview of the agent in the wizard.** No "try this prompt before deploying" — that's a separate surface and a separate compute model.
7. **Capability pack `config` editing.** The wizard adds packs at their default config; users hand-edit the yaml post-clone if they want.
8. **MCP server config UI.** Same logic — defaults only; manual edit for custom.
9. **Custom agent (`kind: custom`) flow.** The wizard only emits `kind: builtin` (chat) agents. Users who want TS tool handlers use the CLI.
10. **Per-user managed-repo quotas.** Not relevant for anonymous v1; comes with v2 + login.

## Open questions (intentionally undecided)

These don't block the plan; flagging them so execution doesn't accidentally commit to a choice:

1. **GitHub App private-key storage on Render.** Render's secret env vars accept multi-line strings, but PEM keys are notoriously fiddly. Plan-level: just declare the env var; execution-level: validate the boot-time parse works.
2. **Janitor scheduling.** Separate Render cron service vs. in-process `setInterval`. Cron service is more correct (survives restarts cleanly, observable in Render dashboard); in-process is fewer moving pieces. Probably cron; decide at execution.
3. **Slug strategy for managed repo names.** Plan-default: `<agent-slug>-<random-4-hex>` so `my-agent-7af3` doesn't collide with `my-agent-9c12`. Open: include user-supplied agent name as the slug, or always generate? Default: use the user's name + random suffix.
4. **Turnstile vs. hCaptcha vs. nothing for v1.** Plan recommends Turnstile (free, low friction). Possible nothing-for-v1 if the wizard URL is only shared in controlled channels at launch.
5. **Public hostname.** `wizard.render-lab.com`? `agents.render-lab.com`? `create.render-lab.com`? Branding decision; not blocking.

## Verification

### Unit / integration

```sh
pnpm --filter @render-harness/wizard test        # server unit tests
```

- `routes/scaffold.test.ts` — POST with valid + invalid answers, mock Octokit, asserts the file-map is computed from the right inputs and that GitHub create/commit calls fire in the right order.
- `github-app.test.ts` — JWT generation, installation-token mint, error paths.
- `turnstile.test.ts` — accepts a valid token, rejects an invalid one (with a mocked Turnstile verify endpoint).
- `rate-limit.test.ts` — burst, recovery, distinct IPs.

### Manual end-to-end (post-deploy of the wizard itself)

1. Hit the wizard URL in a browser.
2. Fill the wizard with template = `chat`, name = `e2e-test`, defaults otherwise.
3. Click "Create agent" → see the success screen with a repo URL.
4. Visit the repo URL (as a Render-lab-agents org admin) → confirm files are present and match the file-map.
5. Click "Deploy to Render" → land on the Render Blueprint flow → fill in `ANTHROPIC_API_KEY` → deploy.
6. Wait for the deploy to complete; visit the deployed agent's URL; confirm it responds to a request.

### Abuse-control verification

- Submit 50 scaffolds from the same IP in 60s; confirm rate limit kicks in.
- Submit with an invalid Turnstile token; confirm rejection.
- Wait 14+ days with a never-deployed orphan repo in the managed org; confirm janitor deletes it.

## Execution order

1. **Export `buildFileMap` from `create-render-agent`** (1-line change in `src/index.ts`). Unblocks everything else.
2. **Scaffold `apps/wizard/`** (package.json, tsconfig, tsup, vite configs; empty `src/main.ts` + `web/index.html`). PR is a no-op functionally but stakes out the package.
3. **Server-side scaffolding logic** — `github-app.ts`, `routes/scaffold.ts`, `routes/gallery.ts`. Unit-tested with Octokit mocks. The GitHub App credentials live in env vars; tests use a fake.
4. **Cloudflare Turnstile + rate limit** before the SPA. Pure server-side. Tested in isolation.
5. **The SPA itself** — one step component per wizard step, the API client, the success screen. Vite-built into `web/dist/`. The server's `main.ts` serves this as static content.
6. **render-harness.yaml for the wizard service** — declare it as a web service so the wizard ships via the same Blueprint flow it generates. (Beautiful symmetry; also serves as the canonical example for "Render can run a Hono service.")
7. **Deploy the wizard manually for the first time** — create the GitHub App, install on the managed-agents org, fill the env vars on Render, point a DNS record at the service.
8. **Janitor** — separate cron service or in-process timer; ships after v1 is otherwise live.
9. **End-to-end manual test** — `chat` template through to deployed agent. The "v1 is shippable" gate.

Steps 1–2 are independently mergeable. Steps 3–6 are also independent of each other once the package skeleton (step 2) exists. Step 7 is a one-time human action that gates the first deploy. Step 8 can land separately.
