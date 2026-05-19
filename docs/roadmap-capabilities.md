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
| `cap-memory-pg` | Memory / retrieval | `pg_trgm`-backed long-term memory (text trigram, not vector) |
| `cap-filesystem` | Local I/O | Path-scoped, opt-in (worker is multi-tenant so this is never on by default) |
| `cap-webhook-generic` | Inbound chat surface | HMAC-verified webhook |
| `cap-github` | Code repo + inbound | Webhook + read/write tools |
| `cap-linear` | Project management + inbound | Webhook + read/write tools |
| `cap-slack` | Chat + inbound | Slack Events, thread reads, opt-in replies. Permissive `channels:read` / `groups:read` handling. |
| `cap-google` | Productivity (OAuth) | Gmail + Calendar via per-end-user OAuth. **Only pack in-tree that registers `oauthProviders`** — validates the connection API. |

---

## 2. In flight / Planned

The next batch of work, scoped enough to start.

| Pack | Status | Why now | Effort |
|---|---|---|---|
| `cap-render` | **Planned (next-7 #1)** | The harness deploys on Render and there is no first-party pack to talk to Render's own API. `examples/deploy-agent` wires Render MCP raw via `mcpServers`. Bundling it as `cap-render` with skills + sensible `requireApproval` defaults is ~50 lines and showcases the HITL pattern. | Tiny — wraps the existing Render MCP. |
| `cap-rag-pgvector` (or `cap-memory-pg` pgvector mode) | **Planned (next-7 #2)** | `cap-memory-pg` is text-trigram only. Modern agents doing "summarize this PDF" / "answer questions about my docs" need embedding-based retrieval. Extends `cap-memory-pg` with an `index: "trigram" \| "pgvector"` option to avoid a parallel pack. | Medium — needs an embedding-provider abstraction (OpenAI vs voyage vs Cohere). |
| `cap-notion` | **Planned (next-7 #3)** | First non-Google OAuth provider; validates the connection API past one consumer before we extend cap-google. | Small — standard OAuth + REST. |
| `cap-google` Drive / Docs / Sheets expansion | **Planned (next-7 #4)** | Same Google OAuth provider, additional scopes + tools. Agents that "summarize my docs" or "create a sheet from this data" need this. Lives inside the existing `cap-google` package — no new platform plumbing. | Small — additive on a shipped pack. |
| `cap-intercom` | **Planned (next-7 #5)** | First dual inbound+outbound support pack. Combines the chat-surface pattern with the OAuth pattern. | Medium — webhook + OAuth + REST. |
| `cap-granola` | **Planned (next-7 #6)** | First API-key-based productivity pack and first pack using polling for inbound (Granola has no webhooks yet). Meeting-notes assistant pairs well with cap-notion. | Tiny — 2 REST endpoints + a polling primitive. |
| `cap-figma` | **Planned (next-7 #7)** | First pack with granular per-action OAuth scopes (post-Nov-2025 platform update). Validates the granular-scope pattern needed for cap-atlassian / cap-hubspot / cap-salesforce. | Small — standard OAuth (granular scopes) + REST. |
| `cap-whatsapp` | Planned (next batch) | Highest-impact net-new chat surface. Slots into existing connectors infra, no platform work. See main roadmap §5 for v1 design. Likely first pick for batch 2. | Medium — Meta Cloud API, 24h customer-service window state, no SDK. |
| `cap-gitlab` | Planned | Work-monitoring wave alongside cap-github. Same shape: webhook + REST. | Medium. |
| `cap-jira` | Planned | Work-monitoring wave alongside cap-linear. Webhook + REST. | Medium. |
| `cap-sandbox` + first provider adapter | Planned | Modal or Daytona first. Unlocks code-execution agents without weakening the multi-tenant worker boundary. See main roadmap §8 for the provider contract. | Large (contract + first adapter), then medium per additional adapter. |

---

## 3. Direction targets, by category

The full target surface. Order is not a commitment — pick whichever fits a sprint or a customer ask.

### 3.1 Productivity / workspace (per-end-user OAuth)

These mostly fit the standard OAuth 2.0 refresh-token flow already in the connection API (see main roadmap §11). Low platform cost per pack — most of the work is shaping the provider's API into clean tool definitions.

| Pack | Notes |
|---|---|
| `cap-microsoft` (Outlook + Graph) | Direct mirror of cap-google for Office 365. Refresh tokens rotate on every refresh (already handled in core). |
| `cap-notion` | Pages, databases, blocks. Standard OAuth. |
| `cap-atlassian` (Confluence + Jira) | Combines two surfaces under one OAuth app. Confluence read/write + Jira if `cap-jira` doesn't ship separately first. |
| `cap-airtable` | Frequently requested for lightweight CRM / project-tracker agents. OAuth 2.0. |
| `cap-granola` | Meeting notes + transcripts. API-key auth (Personal/Enterprise keys); polling for inbound until webhooks ship. **In the next-7 shipping plan.** |
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
| `cap-figma` | Files, comments, projects. OAuth 2.0 with granular per-action scopes (post-Nov-2025 platform update). **In the next-7 shipping plan.** |
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

## 5. Prioritisation guide

The next 7 packs to ship, in order. Full sequenced execution plan with scope, API surface, tools, env schema, skills, tests, risks, and effort estimate for each lives in [`docs/capabilities-shipping-plan.md`](./capabilities-shipping-plan.md).

1. **`cap-render`** — on-brand, tiny, showcases the HITL pattern, every Render-hosted harness will install it. Probably day-one work.
2. **`cap-rag-pgvector`** (extend `cap-memory-pg`) — current memory pack is text-only; modern agents need embeddings. Standalone subsystem, doesn't need OAuth validation first.
3. **`cap-notion`** — first non-Google OAuth provider. Validates the connection API past one consumer *before* we extend cap-google, so any Google-specific assumptions in core get flushed out first.
4. **`cap-google` Drive / Docs / Sheets expansion** — multiplies cap-google's usefulness without a new OAuth flow. Done after cap-notion so we know the connection API isn't Google-locked.
5. **`cap-intercom`** — first dual inbound+outbound support pack. Combines the chat-surface pattern (cap-slack/cap-github connectors) with the OAuth pattern (cap-notion/cap-google).
6. **`cap-granola`** — first API-key-based productivity pack and first pack using polling as the inbound signal (Granola has no webhooks). New patterns we'll re-use for other ingestion-only providers.
7. **`cap-figma`** — first pack with granular per-action OAuth scopes (Figma's `file_content:read` / `file_comments:write` etc.). Validates the granular-scope pattern needed for cap-atlassian / cap-hubspot / cap-salesforce on a relatively small surface.

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
