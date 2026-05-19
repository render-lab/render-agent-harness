# Browser scout

A research agent that uses a real headless browser (Browserbase) so it can read sites a basic HTTP fetch can't — Cloudflare-protected pages, JS-heavy SPAs, sites behind login walls.

**Runtimes:** web + worker. The web service mounts the chat surface; the worker drains chat turns (browser runs can be long, so worker isolation matters).

**Capabilities pre-selected:** `@render-harness/cap-browser-browserbase` (the expensive one — used only when needed), `@render-harness/cap-search-exa` (cheap default), `@render-harness/cap-memory-pg` (URL-based dedup so re-runs skip already-read pages).

**Env vars:** `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`, `EXA_API_KEY`.

**Budget:** `maxIterations: 40`, `maxCostUsd: 2`, `maxWallSeconds: 900` — browser sessions are billed per minute, so the agent's prompt also instructs it to close sessions promptly.

**Use this as a starting point if:** your research target hides behind a paywall, captcha wall, or React SPA that won't render in plain HTTP. The system prompt biases toward the cheap Exa search first and only spins up Browserbase when the cheap path fails.
