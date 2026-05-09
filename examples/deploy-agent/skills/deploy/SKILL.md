---
name: deploy
description: How to deploy a fresh GitHub repo as a Render web service.
when_to_use: At the start of every run. Read this before making any Render API calls.
---

# Deploy

You're deploying a GitHub repo to Render as a web service. The user supplies the repo URL and (optionally) a service name. You produce a running service or a clear failure with next steps.

## What you have access to

- `render__list_workspaces`, `render__select_workspace` — pick the right Render workspace before touching services.
- `render__list_services`, `render__get_service` — read the current state.
- `render__create_web_service`, `render__update_web_service` — create or update a service. Both require human approval (see the `requireApproval` list).
- `render__list_deploys`, `render__get_deploy` — watch a deploy after it kicks off.
- `render__list_logs` — read build logs and runtime logs. Use this when a deploy fails or doesn't go healthy.

## Sequence

1. **Pick a workspace.** If `RENDER_WORKSPACE_ID` is set in the run metadata, use it directly. Otherwise call `render__list_workspaces` and either select the only one or surface the choice to the operator and pause.
2. **Check for conflicts.** Call `render__list_services` and look for an existing service with the proposed name. If one exists, do NOT silently update it — pause with a question for the operator.
3. **Inspect the repo.** Use the repo URL the user gave you. Don't try to read the repo directly; the deploy itself is the validation.
4. **Choose runtime + build/start commands.** Pick the simplest config that works for the language signals in the repo URL:
   - Node project (no Dockerfile): `runtime: node`, `buildCommand: npm install && npm run build`, `startCommand: npm start`.
   - Python project: `runtime: python`, `buildCommand: pip install -r requirements.txt`, `startCommand` from a Procfile / gunicorn / uvicorn invocation as appropriate.
   - Dockerfile present: `runtime: docker`, no buildCommand, `dockerCommand` left blank to use the image's CMD.
   When in doubt, propose a config and pause for operator confirmation.
5. **Create the service.** `render__create_web_service` — this requires approval. The operator sees the proposed config in the Workflows UI and approves.
6. **Watch the deploy.** Poll `render__list_deploys` (or `render__get_deploy` once you have the id) until status is `live`, `build_failed`, or `update_failed`.
7. **On success:** report the assigned `*.onrender.com` URL, the deploy id, and the time-to-live.
8. **On failure:** load the `debug-build` skill and follow it.

## Hard rules

- Never call a destructive tool without the operator approving via the workflow's pause / resume gate. Destructive = creates, updates, or deletes any Render resource.
- Never invent a region, plan, or instance type — use Render's defaults (`oregon`, `starter`) unless the operator specified otherwise in the run input.
- Don't poll deploys faster than every 10 seconds; it's wasted tool calls.
