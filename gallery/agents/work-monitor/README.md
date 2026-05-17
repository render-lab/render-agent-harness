# Work monitor

A web + worker agent that monitors GitHub and Linear work events.

**Runtimes:** web + worker.

Use this as a starting point if you want an agent to watch PRs, issues, checks, workflow runs, Linear issues, projects, and comments. The template uses `accessMode: read` by default, so it can inspect work but cannot mutate provider state.

Configure provider webhooks after deploy:

- GitHub: `https://<service>/connectors/github`
- Linear: `https://<service>/connectors/linear`

Set `GITHUB_WEBHOOK_SECRET`, `GITHUB_TOKEN`, `LINEAR_WEBHOOK_SECRET`, and `LINEAR_API_KEY` in Render and locally in `.env`.
