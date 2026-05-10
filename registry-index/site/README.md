## Discovery site

A single-page static site that lists every entry in [`../index.json`](../index.json) with its description, categories, repo, pinned SHA, and a Deploy-to-Render badge.

The site is purely client-side: it fetches `index.json` at load time and renders cards. No build step beyond copying `../index.json` next to `index.html` (handled by the `render.yaml` here).

### Deploying

The included `render.yaml` is a Render Static Site that publishes this directory. Push the `render-harness-index` repo, click Deploy-to-Render, point it at this `render.yaml`. Updates to `index.json` flow through automatically on each deploy.
