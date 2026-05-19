# Gmail triage

A per-end-user Gmail triage agent. The user signs in once via the operator UI ("Connect Google"), then asks the agent to triage their inbox — the agent labels mail and drafts replies (never sends, never deletes).

**Runtimes:** web + worker. The web service mounts the operator UI for per-user OAuth + chat; the worker drains chat turns.

**Capabilities pre-selected:** `@render-harness/cap-google` (Gmail + Calendar). Auth is **per-end-user** via the harness connections API — no shared service account, no API key in env. The agent uses the signed-in user's token at runtime.

**Env vars:** `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `CONNECTIONS_ENCRYPTION_KEY` (32-byte base64; generate with `openssl rand -base64 32`). Configure the OAuth consent screen + Web application credentials in Google Cloud Console first; see [connections-api docs](../../../docs-site/src/content/docs/connections-api.mdx) for the redirect URI.

**Use this as a starting point if:** you want an inbox-zero coach that works per user without you running a shared inbox or holding everyone's Gmail tokens. Both `gmail_send` and `gmail_modify_labels` are HITL-gated by default; the agent surfaces a triage report in chat and waits for you to confirm before any label or send action lands.
