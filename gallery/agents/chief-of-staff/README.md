# Chief of Staff

A personal chief-of-staff **bundle** — five agents sharing one harness deployment, one Postgres, one Key Value, one memory namespace. Mixes cron and Workflows so each agent runs in the right shape.

| Agent | Trigger | Mode | What it does |
|---|---|---|---|
| `chat` | Web + worker | Inline | Conversational front-end. Reads memory before every reply. Can delegate to workflow-mode siblings via `trigger_workflow` (HITL-gated). |
| `meeting-prep` | Cron every 15 minutes | Inline | Drops a 1-page prep brief into memory for any meeting starting within the next hour. Short fail-stop. |
| `weekly-recap` | Cron Friday 17:00 UTC | Workflow (cron-triggered) | Pulls the week's prep notes + calendar and writes a single recap note. Durable; HITL-capable. |
| `interview-prep` | Cron weekdays 12:00 UTC + on-demand | Workflow | Preps any candidate meetings on today's calendar (background research + memory traversal). Also callable on demand from chat. |
| `interview-feedback` | On-demand from chat | Workflow | After an interview, structures the user's free-form notes into a durable feedback memory note. HITL on the final write so the user reviews before it lands. |

All five agents share `@render-harness/cap-memory-pg`, so notes the cron/workflow agents write are immediately visible to chat. Memory namespace is the bundle name (`chief-of-staff`).

## Deploys to

- 1 web service (chat + operator UI)
- 1 worker pserv (drains the chat queue)
- 1 Render Cron service: `chief-of-staff-cron-meeting-prep` (inline, runs the agent loop)
- 2 Render Cron services in trigger-mode: `chief-of-staff-cron-trigger-weekly-recap` and `chief-of-staff-cron-trigger-interview-prep` (thin services that call `runTask` on the bundle's Workflow service)
- 1 Render Workflow service (`chief-of-staff-workflows`) hosting three tasks: `weekly-recap`, `interview-prep`, `interview-feedback`. Created from the Dashboard once per deploy — see the emitter's checklist.
- 1 Postgres + 1 Key Value

Bundle vs five separate deployments: roughly `$30–50/mo` here vs `$200+/mo` if each agent ran its own harness.

## Env vars

| Var | Required | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | Auto-added by the emitter. |
| `CALENDAR_ICS_URL` | optional | Public iCal feed (e.g. Google Calendar's "secret address"). Without it `meeting-prep` and `weekly-recap` run no-op. |

## Use this as a starting point if

You want a single deployment that feels like a real personal assistant — proactive briefings in the background, chat to ask questions. Edit the system prompts in `src/*.ts` to point at your actual sources (Slack threads, Linear tickets, Google Drive — through their MCP servers).

The bundle is sealed in the wizard: no per-agent questions. Customize after scaffolding.
