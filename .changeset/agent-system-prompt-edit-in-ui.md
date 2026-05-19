---
"@render-harness/core": minor
"@render-harness/contracts": minor
"@render-harness/registry": minor
"@render-harness/runtime-cron": minor
"@render-harness/runtime-web": minor
"@render-harness/runtime-worker": minor
"@render-harness/runtime-workflows": minor
"@render-harness/web": minor
"@render-harness/ui": minor
"@render-harness/wizard": minor
"create-render-agent": minor
"@render-harness/cap-browser-browserbase": minor
"@render-harness/cap-figma": minor
"@render-harness/cap-filesystem": minor
"@render-harness/cap-github": minor
"@render-harness/cap-google": minor
"@render-harness/cap-granola": minor
"@render-harness/cap-intercom": minor
"@render-harness/cap-linear": minor
"@render-harness/cap-memory-pg": minor
"@render-harness/cap-notion": minor
"@render-harness/cap-render": minor
"@render-harness/cap-scrape-firecrawl": minor
"@render-harness/cap-search-exa": minor
"@render-harness/cap-search-tavily": minor
"@render-harness/cap-slack": minor
"@render-harness/cap-webhook-generic": minor
---

Edit system prompts in the operator UI's Agents tab. New `PATCH /agents/:slug/system-prompt` route on `@render-harness/web` clones the managed repo via the same deploy-key path that powers the model edit, rewrites `agents[i].agent.systemPrompt` in `render-harness.yaml`, commits, and lets Render auto-deploy roll out the change. The Agents tab grows an "edit" affordance next to the system-prompt section for builtin (`kind: chat`) agents; custom (`kind: custom`) agents stay read-only and surface a "defined in `<entrypoint>` — edit in code and redeploy" hint instead, because their prompt lives in TypeScript source.

Pieces:

- **`@render-harness/core`** — new `AgentSource` type and optional `source` field on `AgentDefinition`. Populated by the registry; unset for hand-authored `defineAgent({...})` calls.
- **`@render-harness/registry`** — new `mutateAgentSystemPrompt` mutator + `AgentNotEditableError` in `repo-mutations`. `defineChatAgent` stamps `source: { kind: "builtin" }`; `defineFromConfig` stamps `source: { kind: "custom", entrypoint }` on dynamic-imported agents. Multi-line prompts emit as `|` block scalars so the on-disk YAML stays readable; round-trip through `parseDocument` preserves comments and unrelated fields.
- **`@render-harness/contracts`** — `AgentSummary` grows `source` and `systemPrompt` (full body). The full prompt is already accessible via `runAgent` at runtime; surfacing it on `GET /agents` lets the operator UI populate its edit modal without a second round-trip.
- **`@render-harness/web`** — new route mounted in `serveWeb`. Deploy-key path is preferred; falls through to wizard-proxy for harnesses scaffolded before May 2026's GITHUB_DEPLOY_KEY migration. Returns 409 `agent_not_editable` (with `entrypoint` pointer) when the targeted agent is `kind: custom`.
- **`@render-harness/ui`** — `EditSystemPromptModal` with a resizable textarea, char count, 50,000-char limit, and the same committed → restarting → restored toast chain the existing edit-model and install-capability flows use.
- **`@render-harness/wizard`** — new `PATCH /api/agents/:slug/system-prompt` route. Sibling of `/api/agents/:slug/model`, same `WIZARD_SHARED_SECRET` auth + Octokit commit shape, same deprecation log warning operators to rotate to the deploy-key path.

Per [AGENTS.md](https://github.com/render-lab/render-agent-harness/blob/main/AGENTS.md#minor-bumps-must-be-coordinated-across-the-whole-family) this is a coordinated minor cut: every published first-party harness package goes to the same `0.8.0` baseline so `harnessVersion: "^0.8.0"` in scaffolded `render-harness.yaml` files satisfies every dep. Existing managed harnesses need a manual bump of `harnessVersion` and their `@render-harness/*` dep ranges before the new route is reachable; the scaffolded `render-harness.yaml` is updated automatically by `bundle-gallery.ts`.
