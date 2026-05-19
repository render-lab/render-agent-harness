---
name: render-deploy-flow
description: Deploy a repo to Render — when to use create_web_service vs a Blueprint, how to interpret deploy statuses, what to do when a deploy fails.
when_to_use: When the user wants to deploy a new service, redeploy an existing one, or debug a failed deploy. Pair this with the render-overview skill if you haven't oriented yourself yet.
---

# Deploying on Render

Two ways to create services on Render:

1. **`render__create_web_service`** (or `_create_postgres`, `_create_keyvalue`) — one service at a time. The MCP gives you typed args for each field. Good for "the user asked for a single thing".
2. **`render.yaml` Blueprint** — declarative IaC. Multiple services + databases + env groups in one file, wired together with `fromService`/`fromDatabase`/`fromGroup`. Good for "the user wants me to set up their whole app".

If a repo already has a `render.yaml`, prefer the Blueprint path — the user already encoded their intent. If not and they want one service, use the MCP create call.

## The deploy-from-GitHub flow

For a fresh deploy from a GitHub repo:

1. **Inspect the repo** before doing anything. Use `fetch_url` to grab the repo's `Dockerfile`, `render.yaml`, `package.json`, `pyproject.toml`, `Procfile`, etc. Don't guess the runtime.
2. **Pick a build and start command.** If there's a `Dockerfile`, use `runtime: docker`. If not, infer:
   - Node: `pnpm install && pnpm build` build, `node dist/main.js` start (or `npm run start`).
   - Python: `pip install -r requirements.txt` build, `python -m my_app` or `gunicorn ...` start.
   - Static: `npm run build` build, `staticPublishPath: dist` (use `static_site` type, not web).
3. **Pick a plan.** Start cheapest plausible (`starter` for most things). User can scale later.
4. **Propose the full spec back to the user** as one summary message. Then call `render__create_web_service`. This pauses for HITL approval — they review every parameter before anything is created.
5. **If the service depends on Postgres or Key Value**, propose those *separately*. Each gets its own HITL approval.

## After the create call

The deploy starts automatically. Poll `render__list_deploys` (or use the MCP's specific deploy-status tool) until you see `live` or a failure status. Common outcomes:

| Status | Mean | What to do |
|---|---|---|
| `build_in_progress` → `live` | Happy path | Confirm with the user, share the URL. |
| `build_failed` | Build command exited non-zero | Read logs (see render-logs-and-debug skill), propose a fix. |
| `update_failed` | Build succeeded but the new instance failed health checks | Almost always either missing env vars or the wrong port. Check both. |
| `live` for 30s+ then `update_failed` | Crash loop right after going live | Read runtime logs — usually an unhandled error during startup. |

## Redeploy

`render__trigger_deploy` redeploys the current commit. Use this when the user pushed a code change but `autoDeploy: false` is set, or when they want to redeploy with new env vars (though `render__update_environment_variables` already triggers a redeploy).

## Things to never do without explicit user request

- `cap_render__render__delete_service` — irreversible.
- `cap_render__render__delete_postgres` / `cap_render__render__delete_keyvalue` — destroys the data.
- Switch `autoDeploy: true → false` or vice versa.
- Change `region` (requires recreating the service).
- Change `plan` upward (costs money).

All of the destructive tools are in `RENDER_MCP_MUTATING_TOOLS` from `@render-harness/cap-render` and should be in the agent's `permissions.requireApproval`. The harness will pause for human review before they fire.

## Custom domains

`render__add_custom_domain` adds a domain. The user then needs to set DNS (Render returns the target CNAME). Don't promise the cert is issued until you see `verificationStatus: verified` on a follow-up `render__list_custom_domains`. Issuance is usually under 5 minutes but can fail silently if DNS isn't right.
