# support-agent

A Slack-driven support agent. The web service receives Slack Events webhooks, the worker runs the agent, and the worker posts the final reply back to the originating thread.

This is the canonical Phase 3 example: production shape with a public web entrypoint, a private queue-driven worker, and an MCP server (Slack) running in the worker process.

## Architecture

```
   Slack ─POST /slack/events──▶ web (public)
                                  │
                                  │ enqueueRun() via pg-boss
                                  ▼
                             pg-boss queue (Postgres)
                                  │
                                  │ pulled by
                                  ▼
                            worker (private)
                                  │
                                  │ runAgent() with Slack MCP
                                  ▼
                             Anthropic + Slack
                                  │
                                  │ final message → chat.postMessage
                                  ▼
                              Slack thread
```

- **web** — Hono service, verifies Slack signing secret, parses `app_mention`/`message` events, enqueues a `RunJob` with the channel/thread metadata.
- **worker** — pg-boss consumer, runs each job through `@render-harness/core`, has Slack MCP wired in (read-only by default; posting is done explicitly via the Slack Web API so we control thread attribution).
- **agent definition** in `src/agent.ts` is a single TS object; both processes import the same one.
- **`slack-tone` skill** keeps replies channel-appropriate.

## Try it locally

You need a Slack app with:
- Bot scopes: `app_mentions:read`, `channels:history`, `groups:history`, `chat:write`, `im:history`, `mpim:history`, `users:read`.
- Event Subscriptions enabled, request URL pointing at your `web` (use ngrok / Cloudflare Tunnel locally).
- Subscribed bot events: `app_mention`, `message.channels`, `message.groups` (as needed).

```sh
# in repo root
pnpm db:up
cp examples/support-agent/.env.example examples/support-agent/.env
# fill in ANTHROPIC_API_KEY, SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET

# Two processes, one terminal each:
pnpm --filter @render-harness/example-support-agent dev:worker
pnpm --filter @render-harness/example-support-agent dev:web
```

Expose `web` to Slack:
```sh
ngrok http 8080
# Configure your Slack app's Events URL to https://<ngrok-id>.ngrok.app/slack/events
```

@-mention the bot in any channel it's invited to. The worker will pick up the job, run the agent (which can use Slack MCP to read history), and post the reply to the thread.

## Without Slack

The web service still boots and the `/healthz` endpoint works without Slack credentials, but the agent itself needs `SLACK_BOT_TOKEN` to be useful. For a tool-free chat agent without Slack, see `examples/web-chat`.

## Deploy on Render

Use `blueprints/render.private.yaml` — it provisions:

- A public **web service** running `start:web`
- A private **worker (`type: pserv`)** running `start:worker`
- Managed Postgres + Key Value, both reached over the private network

See the comments in `blueprints/render.private.yaml` for env var setup.

## How replies get back to Slack

The worker's `onJobResult` hook fires after every job. On a `completed` result, it reads the `slack: { channel, thread_ts }` metadata stored on the run row by the web service, extracts the final assistant message, and calls `chat.postMessage` against the original thread. Non-completed results (paused, failed, cancelled, checkpointed) are logged and skipped — extend the hook in `src/worker.ts` if you want to surface those to Slack too.
