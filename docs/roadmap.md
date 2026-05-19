# Roadmap

The single source of truth for what's shipped, in flight, and planned. Replaces the scattered `docs/*-plan.md` files as the canonical place to look — those plans remain as historical record but new direction belongs here.

Status legend:

- **Shipped** — in `main`, covered by tests, published to npm where applicable.
- **In flight** — branch open or active uncommitted work.
- **Planned** — designed, not started.
- **Direction** — agreed shape, no design doc yet.

---

## 1. Core platform

| Item | Status | Notes |
|---|---|---|
| `runAgent` core loop, model adapter, MCP, state, skills, prompts, idempotency, cancellation | Shipped | `@render-harness/core` |
| `runtime-cron` (one-shot, 11h budget) | Shipped | `examples/citations-monitor` |
| `runtime-web` (sub-30s synchronous) | Shipped | `examples/web-chat` |
| `runtime-worker` (pg-boss, always-on, streaming) | Shipped | `examples/support-agent` |
| `runtime-workflows` (durable, HITL approvals) | Shipped | `examples/deploy-agent` |
| `@render-harness/web` (multi-tenant public API + SSE) | Shipped | API-key auth, `/runs`, `/conversations`, `/connectors/*` |
| `@render-harness/ui` (read-only operator SPA) | Shipped | `serveWeb({ ui: true })` |
| Conversations model (`agent_conversations`, `conversation_id` FK, fan-in stream) | Shipped | Migration `0002_conversations.sql` |
| Multi-agent bundles (`schemaVersion: 2`, fan-out emitter, `chief-of-staff` gallery entry) | Shipped | `gallery/agents/chief-of-staff` |
| `trigger_workflow` builtin + cron-triggers-workflow mode | Shipped | Three-mode scheduling for V2 bundles |
| Per-end-user OAuth connection API (`SecretsContext`, `oauthProviders` pack contract, `agent_user_connections`, `/connections` routes, Connections UI tab) | Shipped | See §11 |
| npm publishing via Trusted Publishing OIDC | Shipped | Family live on npm at `0.6.x` (coordinated 0.6.0 minor cut shipped the pack-level migration runner) |
| **Hardened deployment mode** (`blueprints/render.hardened.yaml` — egress allowlist + audit) | **Planned** | Phase 5 |

## 2. Built-in tools (`packages/core/src/builtins/`)

| Tool | Tier | Status |
|---|---|---|
| `load_skill`, `fetch_full_result`, `current_time`, `ask_user`, `todo` | A always-on | Shipped |
| `fetch_url` (SSRF guard, 1 MB cap, 15s timeout, 3-redirect cap) | A | Shipped |
| `web_search` (Exa → Tavily → Brave chain) | B env-gated | Shipped |
| `web_extract` (Firecrawl → Exa) | B | Shipped |
| `image_generate` (OpenAI → Fal) | B | Shipped |
| `list_my_runs` (Postgres, `userId`-scoped) | C primitive | Shipped |
| `trigger_workflow` (delegation to Workflows task) | B | Shipped |
| **`schedule_run`, `list_schedules`, `update_schedule`, `cancel_schedule`, `list_scheduled_outputs`** | C | **Planned** — see §6 |

## 3. Capability packs (`packages/capabilities/`)

> **Full pack-by-pack roadmap (14 categories, 50+ targeted integrations) lives in [`docs/roadmap-capabilities.md`](./roadmap-capabilities.md). Sequenced execution plan for the next 7 packs lives in [`docs/capabilities-shipping-plan.md`](./capabilities-shipping-plan.md).** This section keeps the high-level shape only.

**14 packs shipped today** — the wave-1 next-7 completed in May 2026 (Phases 1 → 7 plus the Phase 1.5 pack-migration-runner platform substrate). Active priorities now point at batch 2; see [`docs/roadmap-capabilities.md`](./roadmap-capabilities.md) §5 for the full batch-2 list and §6 for the wave-1 retro decisions.

| Front | Status | Notes |
|---|---|---|
| Shipped (14): `cap-search-exa`, `cap-search-tavily`, `cap-scrape-firecrawl`, `cap-browser-browserbase`, `cap-memory-pg` (trigram + pgvector modes), `cap-filesystem`, `cap-webhook-generic`, `cap-github`, `cap-linear`, `cap-slack`, `cap-google` (Gmail + Calendar + opt-in Drive/Docs/Sheets), `cap-render`, `cap-notion`, `cap-intercom`, `cap-granola`, `cap-figma` | Shipped | See §1 of `roadmap-capabilities.md` for the table. |
| **Batch-2 #1 — `cap-whatsapp`** | **Planned** | Biggest net-new chat surface still on the deck. Design locked in §5. First pick unless customer signal shifts. |
| `cap-microsoft`, `cap-atlassian`, `cap-airtable` | Planned (batch 2) | Productivity OAuth wave. `cap-atlassian` lands the granular-scope helper extraction (see retro Q2). |
| `cap-resend`, `cap-stripe`, `cap-shopify` | Planned (batch 2) | Trivial API-key packs — ship when a clear gallery story / customer ask pairs with each. |
| `cap-gitlab`, `cap-jira` | Planned | Work-monitoring wave alongside cap-github / cap-linear. |
| `cap-sandbox` + first provider adapter | Planned | See §8. |
| Observability: `cap-sentry`, `cap-posthog`, `cap-datadog`, `cap-pagerduty` | Direction | Debugging / product / incident agents. |
| CRM (rest): `cap-hubspot`, `cap-salesforce`, `cap-zendesk`, `cap-front` | Direction | Intercom/Zendesk/Front are dual inbound+outbound. |
| Productivity OAuth (long tail): `cap-zoom`, `cap-coda`, `cap-dropbox`, `cap-box`, `cap-cal-com` | Direction | All fit the connection API (§11). |
| Inbound chat (long tail): `cap-discord`, `cap-telegram`, `cap-twilio-sms`, `cap-email-*` | Direction | See §5; need lifecycle design per surface. |
| Design tooling (beyond cap-figma): `cap-figjam` | Direction | Future companion. |
| Long tail (project mgmt beyond Linear/Jira, e-sign, HR, banking, storage, voice, more RAG providers) | Direction | See [`roadmap-capabilities.md`](./roadmap-capabilities.md) §3.7–3.14. |

## 4. Onboarding & distribution

| Item | Status | Notes |
|---|---|---|
| CLI scaffolder (`npx create-render-agent`) | Shipped | `packages/create-render-agent` |
| In-monorepo gallery (`gallery/agents/*`) | Shipped | 5 entries including `chief-of-staff` bundle |
| Browser wizard v1 (anonymous, managed-repo, Deploy-to-Render) | Shipped | `apps/wizard` |
| Wizard "add agent to existing harness" (zero-config from deployed harness) | Shipped | `apps/wizard/src/agent-add.ts` + `routes/agent-add.ts`; landed in `f9c2524` and shipped in the 0.5.x cuts |
| Wizard v2: "my agents" dashboard, auth, graduate-managed-repo-to-user-GitHub | Planned | Phase 3 v2 |

## 5. Chat surfaces (inbound channels)

Mount as `POST /connectors/:key` on `@render-harness/web` via the `connectors` slot on `CapabilityPack`. No fifth runtime. Threading rides on the conversations model.

| Surface | Pack | Status | Conversation key |
|---|---|---|---|
| Generic HMAC webhook | `cap-webhook-generic` | Shipped | None (single-run per delivery) |
| GitHub Events | `cap-github` | Shipped | None (per-delivery; PR/issue grouping deferred) |
| Linear Events | `cap-linear` | Shipped | None (per-delivery) |
| Slack Events | `cap-slack` | Shipped | `slack-${sha256(team:channel:thread_ts)}` |
| **WhatsApp Business Cloud API** | **`cap-whatsapp`** | **Planned** | `whatsapp-${sha256(phone_number_id:from)}` |
| Discord | `cap-discord` | Direction | Gateway/WebSocket — different lifecycle |
| Telegram | `cap-telegram` | Direction | Webhook or long-poll |
| SMS (Twilio) | `cap-twilio-sms` | Direction | Phone-number-pair conversation, similar to WhatsApp |
| Email (Gmail, Outlook) | `cap-email-*` | Direction | Push subscriptions; thread-id conversation |

### `cap-whatsapp` v1 design

- **Provider:** Meta WhatsApp Business Cloud API (`graph.facebook.com/v21.0/{phone_number_id}/messages`). No official npm SDK; direct typed HTTP per the connectors-plan's "official SDK if good, else thin HTTP wrapper" rule.
- **Webhook auth:** two paths on `POST /connectors/whatsapp`.
  - `GET` request from Meta with `hub.mode=subscribe`, `hub.verify_token`, `hub.challenge` — echo `hub.challenge` when the verify-token env matches. One-time subscription handshake.
  - `POST` payloads — verify `X-Hub-Signature-256` HMAC-SHA256 against the App Secret over the raw body. Same shape as `cap-github`.
- **Conversation key:** `whatsapp-${sha256(phone_number_id + ":" + from)}` — there is no native threading in WhatsApp; one customer's phone number is one conversation. Group chats are out of scope for v1.
- **Idempotency seed:** `messages[].id` from the payload (`wamid.xxxx` format). Deterministic `runId`.
- **Outbound tools (require `accessMode: read_write`):**
  - `cap-whatsapp.send_message({ to, text })` — POST text message back to the user.
  - `cap-whatsapp.send_template({ to, template, language, components })` — required for outbound outside the 24h customer-service window.
  - `cap-whatsapp.mark_read({ message_id })` — optional read receipt.
- **24-hour service window:** the pack records `last_inbound_at` per conversation in `agent_conversations.metadata`. `send_message` returns a typed error (not a string) if the window has closed, prompting the agent to fall back to `send_template`.
- **Config:**

  ```yaml
  capabilities:
    - pack: "@render-harness/cap-whatsapp"
      config:
        agent: "support"
        accessMode: read_write
        verifyTokenEnv: WHATSAPP_VERIFY_TOKEN
        appSecretEnv: WHATSAPP_APP_SECRET
        phoneNumberIdEnv: WHATSAPP_PHONE_NUMBER_ID
        accessTokenEnv: WHATSAPP_ACCESS_TOKEN
        allowedFromNumbers: ["+15551234567"]   # optional allowlist
  ```

- **Out of scope for v1:** WhatsApp groups, media messages (image / audio / document downloads), interactive list/button replies, status callbacks (delivered / read), template management API. Add in v2 once the text-only path is stable.

## 6. Scheduling & recurring tasks

| Item | Status | Notes |
|---|---|---|
| Static cron schedules (`runtime-cron`, declared in `render-harness.yaml`) | Shipped | One Render Cron service per schedule |
| Three-mode cron (`inline`, `cron→workflow`, `workflow-only`) | Shipped | `trigger_workflow` builtin |
| **Chat-driven recurring runs** (`agent_schedules` table + `schedule_*` builtins) | **Planned** | Migration `0003_schedules.sql` |
| **Worker pg-boss reconciler + `harness-scheduled-runs` queue** | **Planned** | Reconciles DB ↔ pg-boss every 30s, NOTIFY-driven immediate sync |
| **Notifications** (Slack incoming webhook, generic outbound webhook, in-UI inbox) | **Planned** | `notification_deliveries` table + default `onJobResult` dispatch |
| **"Scheduled tasks" UI tab** + `GET /schedules`, `GET /inbox` read endpoints | **Planned** | CRUD stays in chat tools |
| Email notifications | Direction | Not in v1 |

## 7. Operator UI / admin plane

| Item | Status | Notes |
|---|---|---|
| Read-only operator SPA (chat, runs, agents, usage) | Shipped | `@render-harness/ui` |
| **DB-overlay admin plane** (`agent_config_overlay` table) | **Planned** | Edit prompt / model / sampling / budget / permissions live |
| **Toggle capability packs + per-tool enable/disable** | **Planned** | `capability_state.toolEnabled["<pack>.<tool>"]` |
| **MCP server + per-tool toggles** | **Planned** | `mcp_state.toolEnabled[…]` |
| **Skill management** (load/unload, metadata) | **Planned** | `skill_state.enabled` |
| **Schedule tab** (read-only for YAML cron, full CRUD for chat-created schedules) | **Planned** | Depends on §6 |
| Hot-reload via `pg_notify('agent_config_changed', name)` + getter resolver | Planned | `runtime-worker` already accepts a resolver function |
| Edit audit log (`agent_config_edits` table) | Planned | queryable via psql in v1, UI later |
| Overlay → YAML export ("promote my edits") | Direction | v2 |
| `@file` / `@url` / `@run` / `@deployment` context injection in chat | Direction | Borrows from Hermes; depends on `cap-filesystem` for `@file` |
| Reviewed memory-to-skill suggestions | Direction | Drafts a `SKILL.md` from repeated patterns; operator approves |

## 8. Sandbox / code execution

`cap-sandbox` defines tools + provider contract; provider adapters are separate packages. Terminal and arbitrary filesystem stay out of core because the worker pserv is multi-tenant.

| Item | Status | Notes |
|---|---|---|
| `cap-sandbox` package (tools: `create_workspace`, `run_command`, `read_files`, `destroy_workspace`) | Planned | |
| `SandboxProvider` interface | Planned | |
| `@render-harness/sandbox-modal` adapter | Planned | Ephemeral Python/container jobs |
| `@render-harness/sandbox-daytona` adapter | Planned | Per-agent dev environments |
| `@render-harness/sandbox-e2b` adapter | Direction | Notebook-style execution |
| `@render-harness/sandbox-fly` adapter | Direction | For users on Fly Machines |
| `@render-harness/sandbox-render` adapter | Direction | First-party Render sandbox primitive — not yet available |
| Sandbox UI (workspaces, commands, exit codes per run) | Direction | After first adapter ships |

Safety floor every adapter must enforce: TTL + cleanup, hard per-command timeout, output truncation, no inherited app secrets, network policy (`disabled` / `allowlist` / `full`), structured execution logs.

## 9. Future runtimes

| Item | Status | Notes |
|---|---|---|
| Voice / realtime runtime | Direction | OpenAI Realtime or STT-LLM-TTS chain. Different loop shape; out of scope for the config registry. |
| Per-run sandbox runtime | Direction | Throwaway container per run via Daytona / e2b / future Render-native. Enables a `cap-sandbox-tools` pack with default `terminal` + unscoped FS. |

## 10. Locked decisions (not on the roadmap — won't change)

These are settled. Don't re-open in PRs without explicit discussion.

1. TypeScript end-to-end. No agent framework dependency.
2. Direct `@anthropic-ai/sdk` + `openai` SDKs behind `LLMClient` (Token.js rejected — `architecture.md` Phase 0).
3. Four runtimes on a shared core; cron came first to force runtime-agnosticism.
4. State in Postgres, signals in KV, streaming via `LISTEN/NOTIFY`. No Redis dependency.
5. Private services as production default; demo mode collapses to one web service.
6. MCP for tools — stdio + Streamable HTTP in v1.
7. Default model `claude-sonnet-4-6`; override with `LLM_MODEL`.
8. `defineAgent()` is the canonical agent format; `render-harness.yaml` is the deploy-time interface.
9. Independent (not lockstep) versioning for the `@render-harness/*` family. Capability packs and `ui` may drift onto their own minor lines.

## 11. Per-end-user OAuth / connection API

Lets capability packs act *as* each end user (their mailbox, calendar, workspace) instead of as a single deployment-wide service account. Shipped in the coordinated 0.5.0 cut. Full design in `docs-site/src/content/docs/connections-api.mdx`.

| Item | Status | Notes |
|---|---|---|
| `SecretsContext` primitive + `requireConnection(provider)` for tool handlers | Shipped | `@render-harness/core` |
| `agent_user_connections` table (AES-256-GCM at rest, `key_version` for rotation) | Shipped | Migration in `packages/core/sql/` |
| `oauthProviders` pack contract + `connectionsRequired` env-schema field | Shipped | `@render-harness/contracts` + `@render-harness/registry` |
| `/connections` routes (`GET`, `POST /:provider/start`, `GET /:provider/callback`, `DELETE /:provider`) | Shipped | `@render-harness/web`; callback is anonymous + HMAC-signed `state` token |
| Connections tab in operator UI (Connect / Disconnect, account label, diagnostics) | Shipped | `@render-harness/ui` |
| `cap-google` (Gmail + Calendar) — first and only consumer today | Shipped | Validates standard OAuth 2.0 + refresh-token flow. Only pack in-tree that registers `oauthProviders`. |
| `cap-microsoft` (Outlook + Graph) | Direction | Realistic next-up pack — covers the Office 365 mirror of cap-google's surface. Refresh tokens rotate on every refresh (already handled in core). |
| Other standard-OAuth packs (`cap-notion`, `cap-atlassian`, `cap-zoom`, `cap-hubspot`, `cap-salesforce`) | Direction | All fit the standard wire shape; low platform cost per pack. |
| OAuth mode inside existing packs (`cap-linear`, `cap-github`, `cap-slack`) | Direction | Currently use deployment-wide tokens; OAuth becomes a config flag rather than a separate pack. |
| `parseTokenResponse(raw)` + `revoke()` hooks on `OAuthProviderConfig` | Shipped (API only) | Defined in core for non-standard providers (e.g. Slack `authed_user`). No in-tree pack exercises them yet — first non-standard provider will validate. |
| Service-account / domain-wide delegation primitive (workspace admin grants once) | Direction | Different primitive than refresh tokens; deferred |
| Encryption key rotation tooling (`key_version` is reserved but no rotation script yet) | Planned | Low priority until we have >1 tenant per key |
| Connection-scoped per-tool rate limits / quota visibility | Direction | Quota errors today surface as raw tool errors |

Out of scope on purpose: OAuth 1.0a providers (Twitter v1.1) — request signing per call doesn't fit the refresh-token model.

---

## Sequencing

A pragmatic order if you're asking "what should I work on next?":

1. **Recurring tasks (§6)** — unblocks Hermes-style "schedule me a daily X" UX and gives the admin UI a schedule tab to render. Touches core, runtime-worker, and adds five builtins. Highest leverage.
2. **Admin UI overlay (§7)** — turns the read-only operator surface into a real config plane. Cleanest seam: one new migration, `defineFromConfig` grows an `overlay` option, hot-reload via the resolver pattern that already exists.
3. **`cap-whatsapp` (§5)** — slots into the existing connectors infra with no platform work. New surface, same shape as `cap-slack`. Good demo for "agent reachable on the channel users actually use."
4. **Phase 5 hardened mode (§1)** — `render.hardened.yaml` + egress allowlist + audit. Prereq for serious production deployments.
5. **`cap-sandbox` + first provider adapter (§8)** — Modal or Daytona first. Unlocks code-execution agents without weakening the multi-tenant worker boundary.
6. Everything else flows after these four.
