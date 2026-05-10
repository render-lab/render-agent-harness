---
name: browserbase
description: Drive a real browser via Browserbase when scraping isn't enough.
when_to_use: When the page requires JS execution, login, click flows, or screenshots that aren't possible with HTTP scraping.
---

# Browser automation with Browserbase

The `cap-browser-browserbase.browserbase` MCP exposes Browserbase's full tool set: create sessions, navigate, click, type, screenshot, and read DOM state. Sessions are hosted on Browserbase's infrastructure; nothing runs locally on the agent.

## When to use Browserbase

- The target page is a single-page app whose content only renders after JS executes.
- You need to log in, click through a flow, or fill a form to get the data the user asked for.
- You need a screenshot for the final reply.

## When not to use Browserbase

- A simple `firecrawl_scrape` would do. Browser sessions are expensive — try the cheaper path first.
- The target is rate-limited or detection-aware. Browserbase resists most bot detection but isn't a license to abuse a site.

## Hard rules

- Always close the session when you're done (`browserbase_session_close`). Open sessions cost money.
- Never enter credentials that aren't explicitly provided in the run input or stored under a deliberate "credential" key in long-term memory. If you need a login and don't have one, ask.
- If you're scraping at scale, use `firecrawl_scrape` and batch — Browserbase is for interactive flows, not crawling.
