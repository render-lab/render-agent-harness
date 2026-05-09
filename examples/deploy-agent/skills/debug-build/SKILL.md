---
name: debug-build
description: How to read a failed Render build and decide what to do next.
when_to_use: When a deploy reaches `build_failed` or `update_failed` status, or when a service is stuck in `update_in_progress` past 10 minutes.
---

# Debug build

A Render deploy failed. Your job is to read the logs, attribute the failure to one of the common buckets, and propose a fix or escalate.

## Read the right logs

Call `render__list_logs` with the failed deploy id. The platform separates **build** logs (the `npm install`, `pip install`, `docker build` phase) from **runtime** logs (the started process). Both can fail a deploy.

- `build_failed`: read build logs only.
- `update_failed` after a successful build: read runtime logs.
- Stuck `update_in_progress`: read both — most likely the process is starting but never binding the assigned `PORT`.

## Common buckets

Categorize the failure into one of these. Most real-world failures fall here.

### 1. Wrong build/start command

**Symptoms:** `command not found`, `script "build" not found`, `Error: Cannot find module`.
**Fix:** propose an updated `buildCommand` / `startCommand` and pause for operator approval before calling `render__update_web_service`.

### 2. Missing env var

**Symptoms:** `KeyError`, `undefined is not an object`, `connection refused`, `DATABASE_URL is required`.
**Fix:** identify which env var is missing from the runtime logs. Propose adding it via `render__update_environment_variables` (requires approval). If it's a secret you don't know (API key, etc.), surface the exact env var name in your final message and pause.

### 3. Port binding

**Symptoms:** runtime logs show "Listening on 3000" or "Server started on :8080" but Render's health check times out. The service must bind to `process.env.PORT`, not a hardcoded port.
**Fix:** propose a code change to the user (you can't edit the repo, only describe the fix). Don't loop on this.

### 4. Out of memory

**Symptoms:** `JavaScript heap out of memory`, `MemoryError`, killed by OOM at runtime.
**Fix:** propose upgrading the plan via `render__update_web_service` with a larger plan. Requires approval.

### 5. External dependency

**Symptoms:** "Cannot connect to redis://...", "ECONNREFUSED", "DNS lookup failed".
**Fix:** describe the missing dependency in your final message. Don't try to provision it implicitly — that's a separate run.

## When to give up

If you've made one fix attempt and the next deploy fails again, stop. Surface the failure with the build id, the deploy id, the error excerpt, and a one-line theory in your final message. Don't keep iterating; the operator will take over.

## Don't

- Never delete the service to "start fresh" — surface the failure instead.
- Never tail logs continuously — pull them once per check.
- Never tell the user "the deploy succeeded" if any deploy in this run reached a failed status.
