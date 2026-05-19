# Meeting prepper

A standalone version of the `meeting-prep` agent that ships inside the `chief-of-staff` bundle — drops a 1-pager into memory for every meeting starting within the next hour.

**Runtime:** cron (every 15 min) + web (operator UI for OAuth + memory inspection).

**Capabilities pre-selected:** `@render-harness/cap-google` (per-end-user OAuth, calendar read scope) and `@render-harness/cap-memory-pg`. The 15-minute cadence overlaps with the next-hour window so even back-to-back meetings get prep time.

**Env vars:** `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `CONNECTIONS_ENCRYPTION_KEY`. The Google OAuth consent flow runs in the operator UI; each user grants calendar read scope.

**Use this as a starting point if:** you want the meeting-prep behavior without the rest of the `chief-of-staff` bundle. Add a memory-aware chat agent (or compose with the chief-of-staff bundle) so a human can ask "what's up with the 11am with Sarah?" and the chat agent retrieves the prep note. Tight budget (`maxIterations: 30`, `maxWallSeconds: 600`) keeps cron tick cost predictable.
