---
name: render-overview
description: Orient yourself in a Render workspace — services, deploys, env vars, the project/environment hierarchy.
when_to_use: Read this first whenever a user asks you to do anything with their Render account. It explains what 'service', 'deploy', 'project', and 'environment' mean and how they relate.
---

# Render workspace overview

Render is a cloud platform. A user's *workspace* is the top-level container — billing, members, and API keys live there. Inside a workspace are *services* (running compute) and *databases* (Postgres + Key Value).

## Service types

| Type | What it is | When you'll see it |
|---|---|---|
| `web` | HTTP service with TLS + a public URL | Most user apps |
| `pserv` (private service) | Internal HTTP/gRPC, no public URL | Microservices, MCP servers, sidecars |
| `worker` | Always-on background process (no inbound HTTP) | Queue consumers, pollers |
| `cron` | Scheduled one-shot job | Periodic tasks |
| `static_site` | Pre-built static files on a CDN | Frontends, docs sites |

The MCP returns these as `serviceType` on each service object. Read it before suggesting changes — what works for a web service may break a worker.

## Projects + environments

A *project* groups related services (e.g. all of one app's web + worker + db). Each project has one or more *environments* — typically `production`, `staging`, `preview-*`. A service lives in exactly one environment.

Two services in the same environment can talk over Render's private network (use the service's internal hostname). Two services in *different* environments cannot — that's the boundary.

You'll only see project/environment info when you query for it. The Render MCP has a `render__list_projects` and similar; check before assuming a flat service list.

## Deploys

Every service has a *deploy* history. A deploy is one build + release cycle. Statuses you'll see:

- `created`, `build_in_progress`, `update_in_progress`, `live` — happy path.
- `build_failed`, `update_failed`, `pre_deploy_failed` — failure modes.
- `deactivated`, `canceled` — manual interventions.

A `live` status means the new instances are passing health checks and receiving traffic. A previously-`live` deploy stays `live` until the next one replaces it; you can scroll back in `render__list_deploys` to find when the current code went out.

## Env vars

Env vars are per-service. Render injects them into the process at boot. You can update them via `render__update_environment_variables` — this triggers an automatic redeploy. **This is destructive in the sense that the running process restarts; treat it as approval-required.**

`fromService` / `fromDatabase` / `fromGroup` references in a Blueprint resolve to literal values at deploy time. You can read the resolved values via the MCP but you can't query the reference itself after deploy.

## Workspace API key vs OAuth

The harness's `RENDER_API_KEY` is a workspace-scoped key — it can do anything the user can do in that workspace. There's no per-tool scoping today. That's why the deploy-agent's HITL pattern matters: any mutation the agent makes can affect production.

## What to do first

Almost always: `render__list_services` first to see what's there, then `render__get_service` on the one(s) the user is asking about. Don't propose changes blind.
