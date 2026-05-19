# Site uptime

A cron-driven uptime checker that probes a list of URLs every 5 minutes and pings Slack with a single batched message when something's wrong — including a probable-cause hint instead of just "site down".

**Runtimes:** cron (every 5 minutes) + web (for on-demand checks from the operator UI).

**Capabilities pre-selected:** `@render-harness/cap-slack` (read_write, `slack_send_message` HITL-gated first time). HTTP probes use the builtin `fetch_url` tool (no extra cap needed).

**Env vars:** `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, `WATCHED_URLS` (pipe-separated), `UPTIME_CHANNEL`.

**Use this as a starting point if:** you want a lightweight uptime check that's smarter than a `curl -f` loop but cheaper than UptimeRobot's paid tier. The system prompt is explicit about the diagnostic categories (5xx vs 4xx vs DNS) so it doesn't speculate wildly. Add a sibling agent that probes deeper (e.g. running specific business-logic API calls) by copying this manifest.
