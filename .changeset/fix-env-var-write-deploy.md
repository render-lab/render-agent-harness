---
"@render-harness/web": patch
"@render-harness/ui": patch
---

`PUT /config/env-vars/:name` now explicitly POSTs to
`/v1/services/:id/deploys` with `deployMode: "deploy_only"` after the
env-var write succeeds. Render's env-var API endpoint only persists
the value — it does not roll the service — so the previous flow
saved the new value but the running container kept the old
`process.env`. Symptoms: clicking "Save & restart" in the Config tab
appeared to do nothing, and toggling Vitals (which writes
`RENDER_HARNESS_VITALS_ENABLED`) never flipped the feature on
because the freshly-saved env never made it into a restarted
process. The response now reports `restart: "queued"` or
`restart: "save_only"` (with a `deployError` payload) so the UI can
surface when Render rejected the deploy trigger and the operator
needs to redeploy manually.
