# Inbox coach

A personal-productivity bundle that combines three Google Workspace agents with a chat front-end. Per-end-user OAuth means each user gets their own inbox + calendar context — no shared service account.

| Agent | Trigger | What it does |
|---|---|---|
| `coach-chat` | Web + worker | Chat front-end. Answers "what's on today?", "prep me for the 11am with Sarah", "draft a reply to X". |
| `gmail-triage` | On-demand from chat | Labels unread mail (URGENT / FOLLOW-UP / FYI / NOISE) — HITL-gated. |
| `inbox-digest-cron` | Daily 8:00 UTC | Emails a morning briefing (calendar + pending replies + memory carryovers + today's focus). |
| `meeting-prepper` | Every 15 min | Drops 1-pagers into memory for meetings starting in the next hour. |

All four share `cap-google` (per-end-user OAuth) and `cap-memory-pg`. Memory is the lingua franca — the chat agent reads briefings the cron agents wrote so users don't have to re-ask the same questions.

## Deploys to

- 1 web service (chat surface + operator UI for per-user OAuth sign-in)
- 1 worker pserv (drains chat queue + gmail-triage runs)
- 2 Render Cron services (inbox-digest-cron daily, meeting-prepper every 15 min)
- 1 Postgres + 1 Key Value

## Env vars

| Var | Required | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | Auto-added. |
| `GOOGLE_OAUTH_CLIENT_ID` | yes | Google Cloud OAuth 2.0 client id. |
| `GOOGLE_OAUTH_CLIENT_SECRET` | yes | Google Cloud OAuth 2.0 client secret. |
| `CONNECTIONS_ENCRYPTION_KEY` | yes | 32-byte base64; generate with `openssl rand -base64 32`. |

Configure the OAuth consent screen + Web application credentials in Google Cloud Console first; see [connections-api docs](../../../docs-site/src/content/docs/connections-api.mdx) for the redirect URI.

## Use this as a starting point if

You want a Google-native personal-productivity assistant that operates per-user (no shared inbox tokens, no shared calendar account). Each agent in the bundle also exists standalone as an atomic entry (`gmail-triage`, `inbox-digest-cron`, `meeting-prepper`) if you'd rather pick a subset. Pairs naturally with `chief-of-staff` (which adds the harder workflow-mode pieces — `weekly-recap`, `interview-prep`, `interview-feedback`) for users who want the full personal-assistant experience.
