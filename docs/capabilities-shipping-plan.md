# Capabilities shipping plan — the next 7 packs

Execution plan for the top 7 capability packs to ship, one after the other. Companion to `docs/roadmap-capabilities.md` (which lists the full target surface) and `docs/roadmap.md` (which covers platform substrate).

Order is deliberate: every later pack benefits from validation done in an earlier one. Don't reorder casually.

| # | Pack | Why it's at this slot | Effort | Cumulative |
|---|---|---|---|---|
| 1 | `cap-render` | Smallest possible cap-pack. Validates the pack contract end-to-end with zero external API risk. On-brand. | ~0.5 d | 0.5 d |
| 2 | `cap-rag-pgvector` (extend `cap-memory-pg`) | First time the harness touches embeddings + pgvector. Standalone subsystem — doesn't need OAuth-pack validation first. | ~10 d | 10.5 d |
| 3 | `cap-notion` | First non-Google OAuth provider. Validates the connection API past one consumer *before* we extend cap-google, so any Google-specific assumptions in core get flushed out first. | ~5 d | 15.5 d |
| 4 | `cap-google` Drive / Docs / Sheets expansion | First *expansion* of a shipped pack. Proves the additive-scopes pattern + re-consent flow. Now safer because the connection API is known non-Google-locked. | ~7 d | 22.5 d |
| 5 | `cap-intercom` | First *dual* inbound+outbound support pack. Combines the chat-surface pattern (cap-slack/cap-github connectors) with the OAuth pattern (cap-notion/cap-google). | ~7 d | 29.5 d |
| 6 | `cap-granola` | First API-key-based productivity pack (no OAuth path in v1). Also first pack to use **polling** as the inbound signal — Granola has no webhooks yet. New patterns we'll re-use for other ingestion-only packs. | ~3 d | 32.5 d |
| 7 | `cap-figma` | First pack with **granular per-action OAuth scopes** (Figma's `file_content:read` / `file_comments:write` / etc.). Pattern needed for cap-atlassian, cap-hubspot, cap-salesforce — validates it here on the smallest provider. | ~5 d | 37.5 d |

**Total: ~7.5 weeks of focused pack work** (one engineer, no platform regressions, no debugging side-quests). In practice plan for ~12 calendar weeks.

Each pack section below follows the same template:

- **Scope v1 / v2 split** — what ships in the first release, what's deferred.
- **Provider API** — concrete endpoint(s) + auth model.
- **Tools** — handler names + their signatures.
- **Env schema** — required + optional vars.
- **Config example** — what a user puts in `render-harness.yaml`.
- **Skills** — markdown files bundled in the pack.
- **Tests** — what coverage gates ship.
- **Risks / open questions** — what could go sideways.
- **Definition of done** — pack publishes + something downstream switches to it.

Packs **not** in this top 7 but still on the broader roadmap: `cap-whatsapp` (still Planned in `roadmap-capabilities.md` §2 — biggest design is locked but ship after this wave), `cap-resend` (Direction), `cap-airtable` (Direction), `cap-stripe` (Direction), `cap-microsoft` (Direction — waits for an Office 365 customer ask).

---

## Pack 1 — `cap-render`

**Why first:** Smallest possible cap-pack. Wraps an MCP server we already use raw in `examples/deploy-agent`. Half-day work. Validates the pack contract end-to-end without any external API risk. Every Render-hosted harness will install it.

### Scope v1
- Pass-through Render MCP via the pack's `mcpServers` slot.
- Opinionated `permissions.requireApproval` allowlist for mutating tools (copies the list from `examples/deploy-agent`).
- Three bundled skills (`render-overview.md`, `render-deploy-flow.md`, `render-logs-and-debug.md`).

### Scope v2 (deferred)
- Direct `localTools` that wrap common multi-step flows (e.g. `render.deploy_from_github` that creates the service, sets env, and triggers the first deploy in one call).
- `cap-render` v2 once the Render MCP gets a stable tool catalog.

### Provider API
- `https://mcp.render.com/mcp` (Streamable HTTP MCP).
- Authorization: `Bearer ${RENDER_API_KEY}`.

### Tools
None local. Tools come from the Render MCP catalog.

### Env schema
```ts
[
  {
    name: "RENDER_API_KEY",
    required: true,
    secret: true,
    description: "Render workspace API key. Get one at https://dashboard.render.com/u/settings#api-keys.",
  },
]
```

### Config example
```yaml
capabilities:
  - pack: "@render-harness/cap-render"
    config:
      agent: "deploy"
      requireApprovalForMutations: true  # default true; flip to false in trusted automation
```

### Skills
- `render-overview.md` — services, deploys, env vars, the project/environment hierarchy.
- `render-deploy-flow.md` — when to use `create_web_service` vs Blueprint, how to interpret deploy statuses, what to do on a failed deploy.
- `render-logs-and-debug.md` — pulling logs, common error signatures.

### Tests
- Unit: pack registers the `mcpServer` correctly with the headers wired from env.
- Unit: when `requireApprovalForMutations: true`, the resulting `permissions.requireApproval` contains the known mutation tool patterns (`render__create_*`, `render__update_*`, `render__delete_*`).
- Integration (optional): a recorded MCP fixture verifies tool discovery works.

### Risks / open questions
- The Render MCP tool catalog evolves. We don't want to hardcode tool names in the pack. Approach: glob-match (`render__create_*`) for the approval list. Add a test that asserts no shipped MCP tool slips through the glob.
- Render MCP requires workspace selection — confirm whether the API key alone is enough or whether we need to pass a workspace id at call time.

### Definition of done
- Pack published to npm at `@render-harness/cap-render@0.5.x`.
- `examples/deploy-agent/render-harness.yaml` switches from `mcpServers:` to `capabilities: - pack: "@render-harness/cap-render"`.
- Gallery entry added.
- Docs page in `docs-site/src/content/docs/capabilities/cap-render.mdx`.

---

## Pack 2 — `cap-rag-pgvector` (extend `cap-memory-pg`)

**Why second:** Modern agents need embedding-based retrieval for PDF/doc Q&A — `pg_trgm` is fine for "recall what we said earlier" but not "find the section of the manual that answers X". Lives in a separate subsystem (memory) so it doesn't need OAuth-pack validation before it. Slots in well after the cap-render warm-up.

### Scope v1
- New `index: "trigram" | "pgvector"` option in `cap-memory-pg` config. Default stays `trigram` so existing users see no change.
- New tools (active only when `index: pgvector`):
  - `memory.ingest({ text, metadata?, namespace? })` — chunk + embed + store.
  - `memory.search({ query, namespace?, k? })` — vector top-k.
  - `memory.delete({ id?, namespace? })`.
- Embedding-provider abstraction with the same chain pattern as the `web_search` builtin:
  - `OPENAI_API_KEY` → `text-embedding-3-small` (1536 dims, default).
  - `VOYAGE_API_KEY` → `voyage-3-lite` (1024 dims).
  - `COHERE_API_KEY` → `embed-v3` (1024 dims).
  - Override the chain via `HARNESS_EMBEDDING_PROVIDER`.
- New migration in the pack (`packages/capabilities/cap-memory-pg/sql/0002_pgvector.sql`):
  - Creates the `pgvector` extension (`CREATE EXTENSION IF NOT EXISTS vector;`).
  - Adds `agent_memory_vectors` table with `embedding vector(<dims>)`, `namespace text`, `chunk_index int`, `content text`, `metadata jsonb`.
  - `ivfflat` index with `lists = ceil(sqrt(rows))` heuristic; documented.

### Scope v2 (deferred)
- Hybrid search (combine pgvector + pg_trgm).
- Re-ranking via a second model call.
- Multi-modal embeddings (images, audio).
- HNSW index option (pgvector 0.5+).

### Provider API
- Pgvector extension on the user's existing Postgres (the same DB the harness is already connected to).
- Verify: Render Managed PostgreSQL ships pgvector 0.7+ today (confirm during build; document the minimum required version).
- Embedding providers: standard REST calls per provider docs.

### Tools
- `memory.ingest`, `memory.search`, `memory.delete` (when `index: pgvector`).
- Existing trigram tools (`memory.remember`, `memory.recall`) remain available; they're index-orthogonal.

### Env schema
```ts
// Required only when index: pgvector
[
  {
    name: "OPENAI_API_KEY",
    required: false,
    secret: true,
    description: "At least one of OPENAI_API_KEY / VOYAGE_API_KEY / COHERE_API_KEY required when index: pgvector.",
  },
  { name: "VOYAGE_API_KEY", required: false, secret: true, description: "..." },
  { name: "COHERE_API_KEY", required: false, secret: true, description: "..." },
  { name: "HARNESS_EMBEDDING_PROVIDER", required: false, secret: false, description: "Override the provider chain (openai|voyage|cohere)." },
]
```

The pack's `envSchema` validator should require at least one provider key when `index: pgvector` is set in config (cross-field validation).

### Config example
```yaml
capabilities:
  - pack: "@render-harness/cap-memory-pg"
    config:
      agent: "support"
      index: pgvector
      chunkSize: 1000           # tokens per chunk
      chunkOverlap: 100
      defaultNamespace: support # optional
```

### Skills
- Update `memory.md` to explain trigram vs vector trade-offs (recall vs precision, latency, cost).
- New `rag-ingestion.md` — chunking choices, namespace patterns ("one namespace per source document collection"), when to re-ingest.

### Tests
- Embedding-provider chain: with no keys set, pack fails to start with actionable error; with `OPENAI_API_KEY` only, uses OpenAI; with both `OPENAI_API_KEY` and `VOYAGE_API_KEY`, uses OpenAI unless `HARNESS_EMBEDDING_PROVIDER=voyage`.
- Ingestion: 10k-token document chunks into the expected count; metadata round-trips.
- Search: known query returns the inserted chunk in top-3.
- Migration: fresh DB runs `0002_pgvector.sql` cleanly; existing DB (post-`0001_init`) runs the migration without dropping the trigram data.

### Risks / open questions
- Embedding dimension mismatch across providers (OpenAI 1536, Voyage 1024, Cohere 1024). The table column is fixed-dim. Options:
  - **(A) Per-provider table:** `agent_memory_vectors_openai_1536`, etc. Ugly.
  - **(B) Pad to max dim (e.g. 1536):** Wastes storage and breaks cosine similarity semantics.
  - **(C) Lock dim at migration time:** Pack config takes `embeddingDim: 1536`, migration creates the table at that dim, swapping providers requires re-ingestion. **Recommended.**
- Render Managed PostgreSQL pgvector version: confirm during build. If a customer's Postgres lacks the extension, the pack should fail to start with an actionable hint about how to enable it.
- `lists = ceil(sqrt(rows))` is the rule of thumb; needs documenting for users who scale past 1M chunks.

### Definition of done
- `cap-memory-pg@0.X.0` (minor bump) ships with `index: pgvector` mode behind an explicit config flag.
- Existing trigram users see no behavioral change.
- Docs page in `docs-site/src/content/docs/capabilities/cap-memory-pg.mdx` covers both modes.
- Gallery example "doc-Q&A agent" using pgvector ingestion + search.

---

## Pack 3 — `cap-notion`

**Why third:** First non-Google OAuth provider. Validates the connection API past one consumer — anything Google-specific that snuck into core surfaces here, and there's still time to fix it before we expand cap-google (#4), ship cap-intercom (#5), and add granular-scope cap-figma (#7).

### Scope v1
- Pages: read, create, append blocks, update properties.
- Databases: query, create row, update row.
- Search across the workspace.
- Block tree: handle one level only in v1 (no recursive child fetching). Document the limitation.

### Scope v2 (deferred)
- Recursive block tree traversal with depth caps.
- File uploads to Notion.
- Comments API.
- Schema introspection / database schema changes.

### Provider API
- Notion API v1 (`https://api.notion.com/v1`).
- OAuth 2.0 — standard authorize/token/refresh.
- Token response is *almost* standard but includes `bot_id`, `workspace_id`, `workspace_name`, `workspace_icon` — use `fetchAccountLabel` to pull `workspace_name` for the UI display.

### Tools
- `notion.search({ query, filter? })`
- `notion.read_page({ page_id })`
- `notion.create_page({ parent, properties, children? })`
- `notion.append_blocks({ page_id, children })`
- `notion.update_page_properties({ page_id, properties })`
- `notion.query_database({ database_id, filter?, sorts?, page_size? })`
- `notion.create_database_row({ database_id, properties })`
- `notion.update_database_row({ page_id, properties })`

### Env schema
```ts
[
  { name: "NOTION_OAUTH_CLIENT_ID", required: true, secret: false, description: "OAuth Public Integration client id from Notion's developer settings." },
  { name: "NOTION_OAUTH_CLIENT_SECRET", required: true, secret: true, description: "OAuth client secret." },
  // CONNECTIONS_ENCRYPTION_KEY already required by the connection API.
]
```

### Config example
```yaml
capabilities:
  - pack: "@render-harness/cap-notion"
    config:
      agent: "support"
      accessMode: read_write
      defaultScopes: []   # Notion grants are workspace-wide; no scope list at OAuth time
```

### Skills
- `notion-pages.md` — page vs block, common patterns for "summarize this page".
- `notion-databases.md` — filter shape, properties vs values, why `select` and `multi_select` differ.

### Tests
- OAuth flow: `fetchAccountLabel` returns the workspace name; token response with `bot_id`/`workspace_id` parses correctly via the standard parser (no need for `parseTokenResponse`).
- Tool shape: all 8 tools accept the documented inputs and return shapes the model can consume (text-flattened blocks where appropriate).
- Integration (best effort): full read+write loop against a real test Notion workspace.

### Risks / open questions
- Notion's block tree is recursive. v1 should not try to walk arbitrary depth — it's a slippery slope to N+1 API calls. Cap at depth=1 and document.
- Filter DSL for database queries is its own thing. v1 takes it as a passthrough JSON; we don't try to abstract it.
- This is the first non-Google OAuth provider. **Watch for hardcoded Google assumptions in `packages/core/src/connections.ts`** during implementation (e.g. assumptions about token endpoint shape, refresh-token rotation behavior). Fix any in core, not in the pack.

### Definition of done
- Pack published at `@render-harness/cap-notion@0.X.0`.
- Gallery example "Notion-backed knowledge agent" — search workspace, read pages, summarize.
- Docs page in `docs-site/src/content/docs/capabilities/cap-notion.mdx`.
- Any core-level fixes uncovered by this pack are documented in `AGENTS.md` "Things that bit us recently".

---

## Pack 4 — `cap-google` Drive / Docs / Sheets expansion

**Why fourth:** First *expansion* of a shipped pack. The patterns it establishes (additive scopes, scope mode, migration hint) are reused by every future expansion. Done after cap-notion (#3) so we know the connection API isn't Google-locked before we double down on Google.

### Scope v1
- Drive: list/search/read/upload files. `drive.file` scope (least-privilege — only files the agent created or the user explicitly shared).
- Docs: read, append text, create new doc.
- Sheets: read range, append row, update range, create sheet.
- `surfaces: [...]` config option to opt in per surface (default stays `[gmail, calendar]` so existing users see no change without an explicit opt-in).
- Migration hint: when an existing connection's scope set doesn't include the requested surface, surface the actionable error `"Your Google connection doesn't include Drive access — disconnect and reconnect in the operator UI's Connections tab to grant the new scopes."`

### Scope v2 (deferred)
- Slides API.
- Drive permissions management.
- Sheets charts / pivots / formatting beyond plain values.
- Real-time collaboration / change watching.

### Provider API
- Google APIs over the existing `cap-google` OAuth flow.
- New scopes added to `READ_SCOPES` / `READ_WRITE_SCOPES` in `packages/capabilities/cap-google/src/oauth.ts`:
  - `https://www.googleapis.com/auth/drive.file`
  - `https://www.googleapis.com/auth/documents`
  - `https://www.googleapis.com/auth/spreadsheets`
  - `https://www.googleapis.com/auth/drive.readonly` for the broader-read mode (opt-in via `surfaces` config).

### Tools (~12 new)
- `drive.list_files`, `drive.search`, `drive.read_file`, `drive.upload_file`
- `docs.read_doc`, `docs.append_text`, `docs.create_doc`
- `sheets.read_range`, `sheets.append_row`, `sheets.update_range`, `sheets.create_sheet`, `sheets.read_sheet_metadata`

### Env schema
No new env. Reuses existing `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `CONNECTIONS_ENCRYPTION_KEY`.

### Config example
```yaml
capabilities:
  - pack: "@render-harness/cap-google"
    config:
      agent: "ops"
      accessMode: read_write
      surfaces: [gmail, calendar, drive, docs, sheets]   # opt-in; default = [gmail, calendar]
```

### Skills
- `google-drive.md` — find vs read vs upload; Google Doc/Sheet mime-types vs regular files.
- `google-docs.md` — append-text patterns, when to create a new doc.
- `google-sheets.md` — A1 vs R1C1 notation, append vs update, why batch-update is preferred for >1 cell.

### Tests
- Scope assembly: with `surfaces: [drive]` and `accessMode: read`, the resulting `defaultScopes` includes `drive.file` but not `drive`.
- Migration hint: when a `requireConnection("google")` call resolves a connection with insufficient scopes for the called tool, the tool returns the actionable error message instead of a raw 403.
- Mime-type handling: reading a Google Doc via `drive.read_file` exports to text/plain (or markdown).
- Integration (best effort): full read+write loop against a real test Google account.

### Risks / open questions
- The `drive.file` vs `drive.readonly` choice is genuinely opinionated. Default to `drive.file` for `accessMode: read_write` (least-privilege); offer `drive.readonly` as an explicit opt-in for "summarize all my docs" agents.
- Re-consent UX: this should be a clean operator-UI flow (a "scope drift" badge in the Connections tab next to a "Reconnect" button). The badge work is a follow-up issue, not a blocker — the migration-hint error message is the v1 escape hatch.
- Some Sheets operations (e.g. inserting rows in a table) are subtle. v1 tools should be primitive (append, update range) and let the agent compose; we'll add convenience tools as patterns emerge.

### Definition of done
- `cap-google@0.6.0` ships (minor bump — new opt-in surfaces, documented migration step in CHANGELOG).
- Existing users see no behavioral change without setting `surfaces:`.
- Docs page for each surface (`docs-site/src/content/docs/capabilities/cap-google-drive.mdx`, `cap-google-docs.mdx`, `cap-google-sheets.mdx`).
- Gallery example "Google Workspace agent" (reads Drive, summarizes Doc, drops the summary in a Sheet).

---

## Pack 5 — `cap-intercom`

**Why fifth:** First *dual* inbound+outbound support pack. Combines the chat-surface pattern (cap-slack/cap-github connectors) with the OAuth pattern (cap-notion #3, cap-google #4). This composition wasn't possible until both halves were independently proven.

### Scope v1
- **Inbound:** `POST /connectors/intercom` for webhook events (conversation.user.created, conversation.user.replied, conversation.admin.assigned, conversation.admin.closed). HMAC-verified.
- **Conversation key:** `intercom-${sha256(workspace_id + ":" + conversation_id)}` — one Intercom conversation = one harness conversation.
- **Outbound tools:** reply, assign, add tag, close, snooze, read conversation, list recent conversations.
- Workspace-scoped (one Intercom workspace per pack instance).

### Scope v2 (deferred)
- Multi-workspace fan-out (one harness agent serving multiple Intercom workspaces).
- Bot replies vs admin replies distinction.
- Custom data attributes on conversations / contacts.
- Article / help center API.

### Provider API
- Intercom REST API v2.10 (`https://api.intercom.io`).
- OAuth 2.0 — standard.
- Webhooks via Intercom's Topic subscription, HMAC signature in `X-Hub-Signature` header (HMAC-SHA1 of the raw body using the app's `client_secret`).

### Tools
- `intercom.reply({ conversation_id, body, type? })` — type: comment | note (default comment).
- `intercom.assign({ conversation_id, assignee_id, team_id? })`
- `intercom.add_tag({ conversation_id, tag_id })`
- `intercom.close({ conversation_id, body? })`
- `intercom.snooze({ conversation_id, snoozed_until })`
- `intercom.read_conversation({ conversation_id, display_as? })`
- `intercom.list_recent_conversations({ open?, assignee_id?, k? })`

### Env schema
```ts
[
  { name: "INTERCOM_OAUTH_CLIENT_ID", required: true, secret: false, description: "OAuth app client id." },
  { name: "INTERCOM_OAUTH_CLIENT_SECRET", required: true, secret: true, description: "OAuth app client secret — also used as the HMAC key for webhook signature verification." },
  // CONNECTIONS_ENCRYPTION_KEY already required.
]
```

### Config example
```yaml
capabilities:
  - pack: "@render-harness/cap-intercom"
    config:
      agent: "support"
      accessMode: read_write
      webhookTopics:
        - conversation.user.created
        - conversation.user.replied
        - conversation.admin.assigned
        - conversation.admin.closed
      defaultAssignTo: "team:engineering"  # optional default routing
```

### Skills
- `intercom-support.md` — when to reply vs assign vs close, how to interpret tags, conversation states (open / closed / snoozed), the comment-vs-note distinction.

### Tests
- Webhook signature verification: HMAC-SHA1 with `INTERCOM_OAUTH_CLIENT_SECRET` against raw body. Invalid sig returns 401.
- Conversation key stability: same `conversation_id` across multiple webhook deliveries produces one harness conversation.
- Idempotency: webhook re-delivery for the same `delivery_attempts` count produces one run.
- OAuth: refresh-token rotation works across the connection API.
- Tool shape: `reply({ type: "note" })` posts a private note, not a customer-visible reply (verified via mock).

### Risks / open questions
- Intercom's webhook delivery includes a `delivery_attempts` counter. Use it for idempotency rather than the event id, which Intercom re-uses across retries.
- The OAuth scope set is fine-grained ("Read conversations", "Write conversations", "Read admins"). Default to a sensible bundle in v1 documented as "what the pack actually needs"; per-tool scope opt-in is v2.
- `cap-intercom` competes for connector mount-point with `cap-slack` / `cap-whatsapp` — none of them should conflict, but verify the `/connectors/:key` namespace is clean.

### Definition of done
- Pack published at `@render-harness/cap-intercom@0.X.0`.
- Gallery example "Intercom support agent" — triages new conversations, replies to common questions, escalates rest.
- Docs page in `docs-site/src/content/docs/capabilities/cap-intercom.mdx`.
- Live test against a real Intercom workspace.

---

## Pack 6 — `cap-granola`

**Why sixth:** First **API-key-based productivity pack** (no OAuth path in v1 — Granola's official auth is bearer API keys today) and first pack to use **polling** as the inbound signal (Granola has no webhooks). Both patterns will recur for other ingestion-only providers, so worth nailing the shape here on a small surface.

### Scope v1
- Read-only access to meeting notes + transcripts via the Personal API key.
- Two read tools (`granola.list_notes`, `granola.read_note`).
- Optional polling-based inbound: a cron-triggered `cap-granola.poll_recent` flow that detects new notes and starts a harness run per note. Disabled by default; opt in via config.
- Personal API key tier (Beta) only; Enterprise key support is a config flag.

### Scope v2 (deferred)
- OAuth 2.0 via WorkOS (Granola's reverse-engineered desktop-app flow — wait for an official OAuth offering).
- Write tools (Granola's API is read-only today; revisit when they ship write endpoints).
- Webhook support (Granola roadmap item; switch from polling once available).
- Meeting search / semantic queries.

### Provider API
- `https://public-api.granola.ai/v1`
- Bearer API key auth (`Authorization: Bearer ${GRANOLA_API_KEY}`).
- Endpoints used in v1:
  - `GET /v1/notes` — paginated list of accessible notes (filter by date range).
  - `GET /v1/notes/{note_id}` — full note including transcript, summary, attendees.
- Rate limits: 25 burst / 5 req/sec sustained on Personal API keys. Tighter than most. The pack should respect retry-after on 429.

### Tools
- `granola.list_notes({ since?, until?, page_token?, limit? })`
- `granola.read_note({ note_id, include_transcript? })`

### Env schema
```ts
[
  {
    name: "GRANOLA_API_KEY",
    required: true,
    secret: true,
    description: "Personal API key from Granola (Business/Enterprise plans; Beta). Or an Enterprise API key when key_type: enterprise. Generate at https://app.granola.ai/settings/api-keys.",
  },
  {
    name: "GRANOLA_KEY_TYPE",
    required: false,
    secret: false,
    description: "personal | enterprise — affects which notes are accessible. Default personal.",
  },
]
```

### Config example
```yaml
capabilities:
  - pack: "@render-harness/cap-granola"
    config:
      agent: "chief-of-staff"
      keyType: personal       # or "enterprise"
      polling:
        enabled: false        # opt-in
        intervalMinutes: 15   # cron schedule for poll_recent
        sinceLookbackMinutes: 30
        startRunPerNewNote: true
```

When `polling.enabled: true`, the pack registers a cron schedule (via the same primitive that `cap-webhook-generic` uses for fan-out) that calls `poll_recent`, diffs against a `granola_seen_notes` table (one new migration in the pack), and enqueues a harness run per unseen note. Idempotency seed: the `note_id`.

### Skills
- `granola-notes.md` — meeting-note structure (transcript vs summary vs action items), when polling makes sense vs just calling `list_notes` from the agent on demand, attendee disambiguation.

### Tests
- Rate-limit handling: synthetic 429 with retry-after triggers a single backoff + retry, not unbounded.
- Polling: with three new notes since the last poll, three runs are enqueued, each with a unique deterministic `runId`. A second poll with the same notes enqueues zero new runs.
- API key tier: `keyType: enterprise` with a personal key surfaces an actionable error from the first list call.

### Risks / open questions
- **Open question: should polling live in the pack or as a generic `connectors.poll` primitive?** The pattern (cron → list → diff → enqueue) will recur for cap-email-inbound, cap-twilio-sms (if no webhook), and any future polling-only provider. Decide during the cap-granola design phase whether to do it ad-hoc here and extract later, or extract first. Default: ad-hoc here, extract during cap-figma if Figma webhooks turn out to need a fallback poll path.
- Granola's WorkOS-based OAuth flow exists (per reverse-engineered docs) but isn't officially documented. **Don't ship OAuth in v1** — wait for Granola to publish it as a supported integration path.
- Personal API key is Beta; the underlying contract may shift. Pin against the documented `/v1/` surface; treat anything else as undocumented.

### Definition of done
- Pack published at `@render-harness/cap-granola@0.X.0`.
- Gallery example "meeting-notes assistant" — polls Granola every 15 minutes, summarizes new meetings into a Notion page (combines `cap-granola` + `cap-notion` from #3).
- Docs page in `docs-site/src/content/docs/capabilities/cap-granola.mdx`.
- Decision recorded (in `AGENTS.md` or a new ADR) on whether the polling pattern stays in-pack or moves into a shared primitive.

---

## Pack 7 — `cap-figma`

**Why seventh:** First pack with **granular per-action OAuth scopes** (Figma uses `file_content:read`, `file_metadata:read`, `file_comments:read`, `file_comments:write`, etc. — they replaced the deprecated coarse `files:read` scope in November 2025). Same shape we'll need for cap-atlassian, cap-hubspot, and cap-salesforce, so validating granular scope handling here on a relatively small surface is worth the slot.

### Scope v1
- Files: read file structure, read specific nodes by id, read file metadata.
- Comments: read comments, post comments, reply to comments.
- Projects / teams: list projects in a team, list files in a project.
- Current-user info for the connection account label.

### Scope v2 (deferred)
- Components / styles library introspection.
- Webhooks (Figma supports them; defer until we have a "react to file changes" use case).
- Write operations beyond comments (Figma's Plugin API for actual file edits is a different surface).
- Variables API.

### Provider API
- `https://api.figma.com/v1`
- OAuth 2.0 with **granular scopes** (post Nov 2025 platform update):
  - `file_content:read`
  - `file_metadata:read`
  - `file_comments:read`
  - `file_comments:write`
  - `current_user:read`
  - (`webhooks:read` / `webhooks:write` deferred to v2)
- Public OAuth apps require Figma's app-review approval; private/internal apps skip review. Document this in the pack README — first-time customers will need to either register a private app or go through review.

### Tools
- `figma.read_file({ file_key, depth?, ids? })`
- `figma.read_file_nodes({ file_key, ids })`
- `figma.read_file_metadata({ file_key })`
- `figma.list_team_projects({ team_id })`
- `figma.list_project_files({ project_id })`
- `figma.read_comments({ file_key })`
- `figma.post_comment({ file_key, message, client_meta? })`

### Env schema
```ts
[
  { name: "FIGMA_OAUTH_CLIENT_ID", required: true, secret: false, description: "OAuth client id from https://www.figma.com/developers/apps." },
  { name: "FIGMA_OAUTH_CLIENT_SECRET", required: true, secret: true, description: "OAuth client secret." },
  // CONNECTIONS_ENCRYPTION_KEY already required.
]
```

### Config example
```yaml
capabilities:
  - pack: "@render-harness/cap-figma"
    config:
      agent: "design-ops"
      accessMode: read_write_comments   # read | read_write_comments
```

The `accessMode` controls which granular scopes get requested at OAuth time:

- `read` → `file_content:read`, `file_metadata:read`, `file_comments:read`, `current_user:read`
- `read_write_comments` → adds `file_comments:write`

### Skills
- `figma-files.md` — file structure (document → pages → frames → nodes), node id encoding, when to use `read_file` vs `read_file_nodes`.
- `figma-comments.md` — pinning to coordinates vs frames, threading replies, when to post a comment vs use a different tool.

### Tests
- Scope assembly: `accessMode: read` → 4 scopes; `accessMode: read_write_comments` → 5 scopes including `file_comments:write`. Asserts on the exact scope strings (these are the new granular ones, not the deprecated coarse `files:read`).
- Scope-drift error: calling `post_comment` with a `read`-only connection returns an actionable error message ("Your Figma connection doesn't include comment-write access — reconnect with read_write_comments mode") rather than a raw 403.
- OAuth round-trip: refresh-token rotation works (Figma rotates on refresh).
- Tool shape: `read_file_nodes` accepts the array-of-ids format Figma expects.

### Risks / open questions
- **App-review gate:** customers running public OAuth apps need Figma review. Document the dev path (private/internal apps work without review) loudly in the pack README.
- **Granular-scope drift in core?** When this pack ships, audit `packages/core/src/connections.ts` for any assumptions that scopes are workspace-wide (Notion's model) vs per-action (Figma's model). The `accessMode` → scope-list mapping might want to move into a shared helper so cap-atlassian/cap-hubspot can reuse it.
- Figma's `read_file` returns the entire document tree by default — can be huge. Default `depth: 2` in the pack to avoid surprise token blowups; document how to use `ids: [...]` for targeted reads.

### Definition of done
- Pack published at `@render-harness/cap-figma@0.X.0`.
- Gallery example "design-review agent" — reads a file, summarizes recent changes, posts a comment on the cover page.
- Docs page in `docs-site/src/content/docs/capabilities/cap-figma.mdx`.
- Granular-scope helper extracted into `@render-harness/registry` if cap-figma + a planned-next pack (cap-atlassian probably) would clearly reuse it.

---

## After the wave

Once all 7 packs ship:

- Re-evaluate the prioritisation guide in `docs/roadmap-capabilities.md` §5 based on which customer asks landed during the work.
- **`cap-whatsapp` is the top demoted item** — biggest design is locked in `docs/roadmap.md` §5, just bumped out of this wave. Likely first pick for the next batch unless customer signal shifts it.
- Likely batch-2 candidates (informed by patterns surfaced here): **`cap-microsoft`** (now that the OAuth-extension pattern is proven on cap-google), **`cap-atlassian`** (granular scopes proven on cap-figma), **`cap-resend`** (trivial outbound-email pack), **`cap-airtable`** (dual auth: OAuth + PAT).
- The polling primitive question from cap-granola will have an answer — extract or stay in-pack.
- The granular-scope helper from cap-figma may have been extracted into `@render-harness/registry` — if so, cap-atlassian + cap-hubspot become smaller.
- Revisit the per-pack docs structure — by the time 7 docs land in `docs-site/src/content/docs/capabilities/`, an index page and consistent template are worth doing.

## Cross-references

- `docs/roadmap.md` — platform substrate, runtimes, scheduling, admin UI, sandbox.
- `docs/roadmap-capabilities.md` — full target surface across 14 categories.
- `docs-site/src/content/docs/authoring-capability-packs.mdx` — pack author contract.
- `docs-site/src/content/docs/connections-api.mdx` — per-end-user OAuth design.
- `docs/connectors-plan.md` — inbound chat surface design notes.
