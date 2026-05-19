---
name: render-logs-and-debug
description: Pull build/runtime logs from a Render service and diagnose common failures (missing env vars, port binding, OOM, dependency errors).
when_to_use: When the user reports a deploy failure, a 502/503 from their service, an unexpected restart, or any 'why is X not working' question about a Render service.
---

# Debugging on Render

There are two log streams per service:

- **Build logs** — captured during the build phase. `render__get_deploy_logs(deployId)` returns these. Always read the *failing* deploy, not the most recent — they may differ when there's a successful previous deploy.
- **Runtime logs** — what the process writes to stdout/stderr after startup. `render__list_logs(serviceId)` or `render__tail_logs` (if exposed). Use these for crash loops and 502s.

## The diagnose-and-fix loop

1. **Identify the failing deploy.** `render__list_deploys(serviceId)` — most recent non-`live` entry. Note its id.
2. **Pull its logs.** Build phase first; if the build succeeded, runtime next.
3. **Pattern-match the error.** See the table below.
4. **Propose a fix.** If the fix is in code, tell the user what to change in their repo. If the fix is in Render config (env var, env var rename, plan size), propose the `render__update_environment_variables` or similar call — these are destructive, so they pause for HITL.

## Common failure patterns

| Symptom in logs | Likely cause | Fix |
|---|---|---|
| `Error: connect ECONNREFUSED 127.0.0.1:PORT` from inside the running service | Service is trying to reach `localhost` instead of an internal hostname | Use the other service's internal address (e.g. `<service-name>:<port>`) over Render's private network, not `localhost`. |
| `Address already in use` or service stuck "waiting for HTTP" | Port mismatch | The service must bind to the port in `$PORT` (Render injects it). Update the start command or app config to use `process.env.PORT`. |
| `JavaScript heap out of memory`, `MemoryError`, abrupt exits with no error | OOM | Either reduce memory usage or move to a larger plan. Check current plan via `render__get_service`. |
| `Error: Cannot find module 'xxx'` | Build didn't install all deps | Build command missing — for Node, ensure devDependencies are installed if needed for the build (`pnpm install` not `pnpm install --prod`). |
| `psql: error: connection to server failed` | DB connection issue | Confirm `DATABASE_URL` is wired via `fromDatabase` and points to the internal connection string (not external). External URLs hit the public internet and are slower + may be blocked by IP allowlist. |
| `EADDRINUSE` on Postgres | Multiple instances writing | Should not happen on a single-instance Postgres. If on a worker that scaled to 2+, that's a code bug — only one writer should run. |
| 502/503 from the public URL, deploy says `live` | Health check passing but app failing on real traffic | Look at runtime logs around the timestamp the user reports. Often a runtime error inside a request handler. |
| Service restarts every few minutes | Process exiting (status code 0 or non-zero) | App is exiting cleanly — should run a server, not a script. For workers, check that the main loop isn't returning. |
| `Failed to bind to port` in build but not runtime | A build step is trying to listen on a port (rare, but happens with some build-time servers) | Should not need to bind during build. Move the bind step into the start command. |

## Things to check before going deep into logs

- **`autoDeploy`** — is it on? If off and the user said "I pushed a change", they need to trigger a deploy manually (`render__trigger_deploy`).
- **Branch** — is the service deploying from the branch the user is pushing to? `render__get_service` returns `branch`. Mismatches are common after a long absence.
- **Env vars** — the most common single cause of "it worked locally". Compare what the user has in `.env` against what the service has in `render__list_environment_variables`.

## When you can't diagnose from logs

- Ask the user to enable SSH for the service (`render__update_web_service` with `sshAccess: true`), then `render ssh <service-name>` from their machine and inspect live. SSH isn't free of cost (uses a small connection slot) but it's the fastest way to debug something that only happens in the deployed environment.
- Ask for the URL they're hitting and what response code they get. 502 vs 503 vs 504 tells different stories.
- Ask whether anything else in the same workspace is also misbehaving — sometimes it's a Render-side incident; check status.render.com.
