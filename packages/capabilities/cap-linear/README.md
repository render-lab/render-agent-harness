# `@render-harness/cap-linear`

Linear webhook and issue tools for agents in the Render harness.

Use this pack when an agent should react to Linear webhook events, inspect issue context, and optionally create or update Linear issues.

## Configuration

Drop the pack into `render-harness.yaml`:

```yaml
capabilities:
  - pack: "@render-harness/cap-linear"
    config:
      webhookSecretEnv: "LINEAR_WEBHOOK_SECRET"
      apiKeyEnv: "LINEAR_API_KEY"
      accessMode: "read"
```

Set these environment variables on the entry that loads the agent:

- `LINEAR_WEBHOOK_SECRET`: Linear webhook signing secret used to verify events.
- `LINEAR_API_KEY`: Linear API key used for reads and optional write tools.

## Connector

The pack mounts the `linear` connector at `/connectors/linear`. Configure that URL as a Linear webhook endpoint and use the same secret as `LINEAR_WEBHOOK_SECRET`.

Each accepted Linear webhook event enqueues one harness run.

## Config Keys

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `agent` | string | default agent | Agent name to enqueue runs for. |
| `userId` | string | `cap-linear` | User ID stored on enqueued runs. |
| `webhookSecretEnv` | string | `LINEAR_WEBHOOK_SECRET` | Env var that contains the Linear webhook secret. |
| `apiKeyEnv` | string | `LINEAR_API_KEY` | Env var that contains the Linear API key. |
| `accessMode` | `read` or `read_write` | `read` | Enables write tools only when set to `read_write`. |
| `allowedTeams` | string[] | all teams | Restricts events to matching team IDs or team keys. |
| `allowedProjects` | string[] | all projects | Restricts events to matching project IDs or project names. |
| `states` | string[] | all states | Restricts issue events to matching workflow state names. |
| `labels` | string[] | all labels | Restricts issue events to matching label names. |
| `ignoredActors` | string[] | none | Ignores events from matching Linear actor IDs. |

## Tools

Read tools are available when `LINEAR_API_KEY` is set:

- `linear.get_issue`
- `linear.search_issues`
- `linear.list_comments`
- `linear.list_teams`
- `linear.list_projects`
- `linear.list_workflow_states`
- `linear.list_users`

Set `accessMode: read_write` to enable write tools:

- `linear.create_issue`
- `linear.create_comment`
- `linear.update_issue`
- `linear.update_issue_status`
- `linear.assign_issue`
- `linear.link_related_issue`

Use `permissions.requireApproval` for write tools if the agent should ask before mutating Linear state.

## Test Commands

```sh
pnpm --filter @render-harness/cap-linear build
pnpm --filter @render-harness/cap-linear test
```
