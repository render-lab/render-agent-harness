# Capabilities roadmap

Companion to `docs/roadmap.md`. The main roadmap covers platform substrate (core, runtimes, web/UI, scheduling, sandbox, admin plane); **this doc enumerates every capability pack we ship today and every integration we want to target**.

A "capability pack" is the unit of reusable agent functionality — a published `@render-harness/cap-*` npm package contributing tools, MCP servers, connectors (inbound chat surfaces), OAuth providers (per-end-user connections), env-schema entries, and optional Render service templates. See `docs-site/src/content/docs/authoring-capability-packs.mdx` for the full pack-author contract.

Status legend matches the main roadmap:

- **Shipped** — published to npm, covered by tests.
- **In flight** — branch open or active uncommitted work.
- **Planned** — designed, scoped, next ~6 months.
- **Direction** — agreed shape, no design doc yet. Order within Direction is not a commitment.

---

## 1. Shipped today

11 packs in `packages/capabilities/`, all published under `@render-harness/cap-*`.

| Pack | Category | Notes |
|---|---|---|
| `cap-search-exa` | Search | Exa search MCP + skill |
| `cap-search-tavily` | Search | Tavily fallback |
| `cap-scrape-firecrawl` | Web scraping | Firecrawl MCP + `scrape_and_store` |
| `cap-browser-browserbase` | Browser automation | Hosted browser MCP |
| `cap-memory-pg` | Memory / retrieval | Trigram (default) OR `pgvector` mode for embedding-based RAG. Embedding-provider chain (OpenAI / Voyage / Cohere) with `HARNESS_EMBEDDING_PROVIDER` override. Schema for pgvector mode registered via the pack-migration runner. |
| `cap-filesystem` | Local I/O | Path-scoped, opt-in (worker is multi-tenant so this is never on by default) |
| `cap-webhook-generic` | Inbound chat surface | HMAC-verified webhook |
| `cap-github` | Code repo + inbound | Webhook + read/write tools |
| `cap-linear` | Project management + inbound | Webhook + read/write tools |
| `cap-slack` | Chat + inbound | Slack Events, thread reads, opt-in replies. Permissive `channels:read` / `groups:read` handling. |
| `cap-google` | Productivity (OAuth) | Gmail + Calendar + opt-in Drive / Docs / Sheets via per-end-user OAuth. `surfaces` config picks the bundle, `withScopeHint` translates 403 scope-drift into operator-actionable reconnect guidance. |
| `cap-render` | Render platform | Wraps the hosted Render MCP via `mcpServers` + ships `RENDER_MCP_MUTATING_TOOLS` for HITL gating. Smallest possible cap-pack — wave-1 warm-up. |
| `cap-notion` | Productivity (OAuth) | Pages, databases, workspace search via per-end-user OAuth. First non-Google OAuth provider; surfaced the `refreshTokenOptional` flag added to `OAuthProviderConfig` in 0.6.1 (Notion's public flow issues long-lived tokens with no refresh). |
| `cap-intercom` | CRM + connector | First **dual inbound+outbound** pack — HMAC-verified webhook on `/connectors/intercom` plus per-end-user OAuth tools (reply, assign, tag, close, snooze). Workspace-scoped in v1; conversation key `intercom-${sha256(workspace_id:conversation_id)}`. |
| `cap-granola` | Productivity | First **API-key + polling** pack. Three read tools (list_notes, read_note, poll_recent). The `poll_recent` dedup table (`granola_seen_notes`) is the second real consumer of the pack-migration runner. |
| `cap-figma` | Design tooling (OAuth) | First **granular per-action OAuth scopes** pack (post-Nov-2025 Figma platform update). 7 tools across files, projects/teams, comments. `accessMode` → scope-list assembly via `assembleFigmaScopes`. |

---

## 2. In flight / Planned

Next batch of work, scoped enough to start. (The wave-1 next-7 — cap-render, cap-rag-pgvector, cap-notion, cap-google expansion, cap-intercom, cap-granola, cap-figma — all shipped; see §1.)

| Pack | Status | Why now | Effort |
|---|---|---|---|
| `cap-whatsapp` | **Planned (batch-2 #1)** | Highest-impact net-new chat surface. Slots into existing connectors infra, no platform work. See main roadmap §5 for v1 design. First pick for batch 2 unless customer signal shifts it. | Medium — Meta Cloud API, 24h customer-service window state, no SDK. |
| `cap-gitlab` | Planned | Work-monitoring wave alongside cap-github. Same shape: webhook + REST. | Medium. |
| `cap-jira` | Planned | Work-monitoring wave alongside cap-linear. Webhook + REST. | Medium. |
| `cap-sandbox` + first provider adapter | Planned | Modal or Daytona first. Unlocks code-execution agents without weakening the multi-tenant worker boundary. See main roadmap §8 for the provider contract. | Large (contract + first adapter), then medium per additional adapter. |

### Wave-1 gallery follow-ups (deferred)

Each of the five OAuth-shaped packs that shipped in wave 1 was supposed to land with a gallery example. They were deferred because validating the demos end-to-end needs a real external account per provider (Notion, Intercom, Granola, Figma, plus a Google account with Drive/Docs/Sheets scopes). They're tracked as a single follow-up:

- `doc-qa-agent` — cap-memory-pg pgvector mode (Phase 2).
- `notion-knowledge-agent` — cap-notion (Phase 3).
- `chief-of-staff` extension — cap-google Drive/Docs/Sheets (Phase 4).
- `intercom-support-agent` — cap-intercom (Phase 5).
- `meeting-notes-assistant` — cap-granola + cap-notion cross-pack pairing (Phase 6).
- `design-review-agent` — cap-figma (Phase 7).

---

## 3. Direction targets, by category

The full target surface. Order is not a commitment — pick whichever fits a sprint or a customer ask.

### 3.1 Productivity / workspace (per-end-user OAuth)

These mostly fit the standard OAuth 2.0 refresh-token flow already in the connection API (see main roadmap §11). Low platform cost per pack — most of the work is shaping the provider's API into clean tool definitions.

| Pack | Notes |
|---|---|
| `cap-microsoft` (Outlook + Graph) | Direct mirror of cap-google for Office 365. Refresh tokens rotate on every refresh (already handled in core). Top candidate to validate the granular-scope helper extraction (see §6 retro). |
| `cap-atlassian` (Confluence + Jira) | Combines two surfaces under one OAuth app. Granular scopes — second consumer of cap-figma's `assembleFigmaScopes`-style pattern; lands the scope-list helper extraction into `@render-harness/registry`. |
| `cap-airtable` | Frequently requested for lightweight CRM / project-tracker agents. OAuth 2.0. |
| `cap-zoom` | Meetings, recordings, transcripts. |
| `cap-coda` | Niche but similar shape to Notion. |
| `cap-cal-com` | Open-source scheduling, mirror of Google Calendar. |
| `cap-dropbox` / `cap-box` | File storage + sync. |

### 3.2 CRM / customer data

| Pack | Notes |
|---|---|
| `cap-hubspot` | OAuth, REST. Contacts, deals, marketing automation. |
| `cap-salesforce` | OAuth + SOQL. Heavier than HubSpot but huge install base. |
| `cap-intercom` | Both **inbound** (handle a conversation) and outbound (post reply). Mirrors `cap-slack`'s shape for support workflows. |
| `cap-zendesk` | Same dual shape — tickets in, replies out. |
| `cap-front` | Shared inbox. Same pattern as Intercom/Zendesk. |
| `cap-attio` | Modern CRM, REST API. |
| `cap-pipedrive` | Sales-focused CRM. |

### 3.3 Payments / commerce

| Pack | Notes |
|---|---|
| `cap-stripe` | SaaS billing — refunds, MRR, invoices. Server-side API key, no OAuth. Tiny pack; high-leverage but no specific customer pull yet so not in the top 8. |
| `cap-shopify` | Admin API key (no OAuth needed for single-store). Inventory, orders, customers — unlocks e-commerce agents. |
| `cap-paddle` / `cap-lemon-squeezy` | SaaS billing alternatives to Stripe. |
| `cap-chargebee` / `cap-recurly` | Subscription billing. |

### 3.4 Email / messaging (outbound transactional)

| Pack | Notes |
|---|---|
| `cap-resend` | Modern transactional email. Trivial pack — POST a templated email. High utility for "agent sends a follow-up" / "agent notifies you when a job completes". |
| `cap-sendgrid` | Older but huge install base. |
| `cap-postmark` | Reliable, transactional-focused. |
| `cap-mailchimp` | Bulk marketing email. |
| `cap-loops` / `cap-customer-io` | Lifecycle email. |

### 3.5 Analytics / observability

| Pack | Notes |
|---|---|
| `cap-sentry` | Errors + performance. Debugging agents need this. Read-only fine for v1. |
| `cap-posthog` | Product analytics — "summarize this week's funnel drop". Read-only. |
| `cap-datadog` | Logs, metrics, monitors. Read-only fine for v1. |
| `cap-snowflake` / `cap-bigquery` / `cap-databricks` | Data warehouses. Read-only SQL with strict allowlist. |
| `cap-dbt` | Modeling — kick off runs, read manifests. |
| `cap-pagerduty` | Incident management — list incidents, ack, resolve. |

### 3.6 Knowledge / RAG / retrieval (beyond pgvector)

| Pack | Notes |
|---|---|
| `cap-rag-pinecone` | Managed vector DB. |
| `cap-rag-weaviate` | Open-source vector DB. |
| `cap-rag-qdrant` | Open-source vector DB. |
| `cap-llamaparse` | Document parsing for RAG ingestion. |
| `cap-mendable` / `cap-vectara` | Managed RAG-as-a-service. |

### 3.7 Project / work management (beyond Linear/Jira)

| Pack | Notes |
|---|---|
| `cap-asana` | Standard REST API. |
| `cap-clickup` | Standard REST API. |
| `cap-monday` | GraphQL. |
| `cap-shortcut` | Standard REST API. |

### 3.8 Storage / files

| Pack | Notes |
|---|---|
| `cap-s3` / `cap-r2` / `cap-gcs` | Blob storage. Useful for "save this output", "ingest this bucket of PDFs". |

### 3.9 Design tooling

| Pack | Notes |
|---|---|
| `cap-figjam` | Future companion to cap-figma if Figma exposes FigJam-specific endpoints. |

### 3.10 E-sign / contracts

| Pack | Notes |
|---|---|
| `cap-docusign` | High-value agentic workflow: send contract → poll for signature → trigger downstream. OAuth 2.0. |
| `cap-hellosign` (Dropbox Sign) | Alternative to DocuSign. |

### 3.11 HR / hiring

| Pack | Notes |
|---|---|
| `cap-greenhouse` | ATS. |
| `cap-lever` | ATS alternative. |

### 3.12 Banking / finance

| Pack | Notes |
|---|---|
| `cap-plaid` | Account data, transactions. Finance agents. |

### 3.13 Inbound chat surfaces (covered in main roadmap §5)

These are connectors (mount `POST /connectors/:key`), not tool packs. Listed here for completeness; design is in main roadmap §5.

| Pack | Status |
|---|---|
| `cap-discord` | Direction — needs Gateway/WebSocket lifecycle design (different shape than webhooks). |
| `cap-telegram` | Direction — webhook or long-poll. |
| `cap-twilio-sms` | Direction — phone-number-pair conversation, similar to WhatsApp. |
| `cap-email-google` / `cap-email-microsoft` (inbound) | Direction — thread-id conversation. Distinct from `cap-google` / `cap-microsoft`'s outbound mail tools. Push subscriptions vs polling TBD. |

### 3.14 Voice / phone

| Pack | Notes |
|---|---|
| `cap-twilio-voice` | Outbound calls + transcripts. Pairs with the voice runtime in main roadmap §9. |
| `cap-vapi` / `cap-retell` | Voice-agent platforms. |

---

## 4. Out of scope (don't add)

| Provider / surface | Why |
|---|---|
| X / Twitter | OAuth 1.0a requires request signing per call. Doesn't fit the connection API; explicit in `docs-site/src/content/docs/connections-api.mdx`. |
| WhatsApp groups | Deferred from `cap-whatsapp` v1 — text-only customer DMs first. |
| Service account / domain-wide delegation (Google Workspace admin grants once, agent impersonates org members) | Different primitive than per-end-user refresh tokens. Tracked in main roadmap §11 as Direction; a separate auth path, not a normal cap. |
| Direct stdio tools that need root or device access (USB, raw network) | Worker pserv is multi-tenant. Use `cap-sandbox` adapters instead. |

---

## 5. Prioritisation guide — batch 2

Wave 1 (the next-7) shipped — see §1 "Shipped today" for the 5 new packs (cap-render, cap-notion, cap-intercom, cap-granola, cap-figma) plus the two existing-pack expansions (cap-memory-pg pgvector mode, cap-google Drive/Docs/Sheets). The wave-1 execution plan history is preserved in [`docs/capabilities-shipping-plan.md`](./capabilities-shipping-plan.md).

Batch 2, in rough order of leverage:

1. **`cap-whatsapp`** — biggest net-new chat surface still on the deck. Design is locked in main roadmap §5; slots into the existing connectors infra with no platform work. First pick unless a customer ask shifts the order.
2. **`cap-microsoft`** (Outlook + Graph) — Office 365 mirror of cap-google's `surfaces` pattern. Refresh tokens rotate on every refresh (already handled in core). Customer-ask gated but cheap when one arrives.
3. **`cap-atlassian`** (Confluence + Jira) — second consumer of cap-figma's granular-scope pattern. **Lands the scope-list helper extraction into `@render-harness/registry`** (see §6 retro decision Q2).
4. **`cap-resend`** — trivial pack, lands the "agent emails me when done" UX. Pair with a gallery example to validate.
5. **`cap-airtable`** — long-tail customer reach for lightweight CRM / project-tracker agents. OAuth 2.0 (or PAT for single-tenant).
6. **`cap-stripe`** — universal SaaS-agent need (refunds, MRR, invoices). Server-side API key, no OAuth. Build when a customer asks.
7. **`cap-sentry` / `cap-posthog` / `cap-datadog` / `cap-pagerduty`** — observability cluster, all read-only first cuts.

Everything else stays in §3 Direction; promote to batch-3 when a customer ask or a pattern-validation need lines up.

## 6. Wave-1 retro decisions

Three open calls were resolved before kickoff (Q1/Q2/Q3 in the [shipping plan](./capabilities-shipping-plan.md)). Two new questions surfaced *during* the wave; resolved here:

### Q1 (carried) — extract `definePollingConnector` into `@render-harness/registry`?

**Decision: defer.** Only one in-tree consumer in wave 1 (`cap-granola.poll_recent`). cap-figma was the candidate second consumer but its webhook story is fine — the granular-scope work was the design challenge, not polling. Per the kickoff threshold ("two real in-tree consumers + a clear third on the horizon"), one consumer is below bar.

Re-evaluate when **cap-email-google / cap-email-microsoft** lands (those packs are polling-shaped because push subscriptions are heavier than they're worth for one-mailbox-per-deployment cases) or **cap-twilio-sms** lands (Twilio webhooks are first-class, but fallback polling for outage windows would reuse the same shape).

### Q2 (new) — extract granular-scope helper into `@render-harness/registry`?

Two consumers in-tree now: `cap-google.assembleGoogleScopes(accessMode, surfaces)` (Phase 4) and `cap-figma.assembleFigmaScopes(accessMode)` (Phase 7). Both follow the same shape — config → scope-list assembly — but the surface inputs differ (cap-google has a `surfaces` axis; cap-figma has only `accessMode`).

**Decision: defer; extract when cap-atlassian lands.** The two existing consumers diverge slightly because their config axes differ, so the abstraction would need to support both shapes. With `cap-atlassian` (Confluence + Jira, granular scopes) as the natural third consumer, we'd have three concrete shapes to design against. Extracting now would either over-fit cap-google's or cap-figma's specifics, or invent a general-purpose API that nothing exercises beyond its first user.

Until then both packs keep their inline assembler. The extraction issue is documented in `cap-atlassian`'s eventual planning notes.

### Q3 (new) — scope-drift error helper (`withScopeHint` / `formatFigmaError`) — extract?

Two consumers: `cap-google.withScopeHint(surface, fn)` (wrapper function) and `cap-figma.formatFigmaError(tool, expectedAction, err)` (error-formatter). Different ergonomics, same purpose — translate 403/scope errors into operator-actionable "reconnect at /ui/connections" messages.

**Decision: defer pending shape convergence.** Wrapper vs formatter is a real choice — wrapper is more terse at tool sites, formatter is more flexible for non-API-call errors. The next granular-scope pack picks one and the helper extracts at that point. Both shapes are well-documented in the existing packs.

### Coordinated 0.7.0 minor — needed?

**No.** Only Phase 1.5 added new public API to core / contracts / registry / runtime-* / web (the `migrations` slot + `applyMigrations` second arg). That triggered the wave's only coordinated minor (0.6.0). Phase 3 added the additive `OAuthProviderConfig.refreshTokenOptional` field — shipped as a patch on core + web per the additive-opt-in rule (Q2=A from kickoff). Phases 4-7 didn't touch core/registry/contracts; they're all pack-internal patches.

Family stays on 0.6.x. Operators upgrading from 0.5.x bump `harnessVersion` and `@render-harness/*` dep ranges to `"^0.6.0"`; everything else is automatic.

Demoted from the top list (still tracked in §2 / §3 above):

- **`cap-whatsapp`** — biggest net-new chat surface; design is locked in main roadmap §5. Likely first pick for batch 2 unless customer signal shifts it.
- **`cap-resend`** — moved to Direction. Trivial pack, ship when there's a clear "agent emails me" gallery story to pair it with.
- **`cap-airtable`** — moved to Direction. Long-tail customer reach; no novel platform validation.
- **`cap-stripe`** — moved to Direction. Build when a customer asks.
- **`cap-microsoft`** — moved to Direction. Build when a customer on Office 365 asks.

Everything below the top 7 is "build when a customer asks or when it slots into a sprint".

---

## 6. Cross-references

- Main roadmap: `docs/roadmap.md` (platform substrate, runtimes, scheduling, admin UI, sandbox)
- Pack author contract: `docs-site/src/content/docs/authoring-capability-packs.mdx`
- Connection API (per-end-user OAuth): `docs-site/src/content/docs/connections-api.mdx`
- Connector design notes (inbound chat surfaces): `docs/connectors-plan.md`
