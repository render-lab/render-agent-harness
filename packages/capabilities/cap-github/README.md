# `@render-harness/cap-github`

GitHub webhook and repository tools for agents in the Render harness.

Use this pack when an agent should react to GitHub events, inspect issues and pull requests, read workflow status, and optionally comment or update GitHub objects.

## Configuration

Drop the pack into `render-harness.yaml`:

```yaml
capabilities:
  - pack: "@render-harness/cap-github"
    config:
      webhookSecretEnv: "GITHUB_WEBHOOK_SECRET"
      tokenEnv: "GITHUB_TOKEN"
      accessMode: "read"
```

Set these environment variables on the entry that loads the agent:

- `GITHUB_WEBHOOK_SECRET`: GitHub webhook secret used to verify deliveries.
- `GITHUB_TOKEN`: GitHub token used for repository reads and optional write tools.

## Connector

The pack mounts the `github` connector at `/connectors/github`. Configure that URL as a GitHub webhook endpoint and use the same secret as `GITHUB_WEBHOOK_SECRET`.

Supported webhook events:

- `issues`
- `issue_comment`
- `pull_request`
- `pull_request_review`
- `pull_request_review_comment`
- `push`
- `check_run`
- `check_suite`
- `workflow_run`

Each accepted GitHub delivery enqueues one harness run.

## Config Keys

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `agent` | string | default agent | Agent name to enqueue runs for. |
| `userId` | string | `cap-github` | User ID stored on enqueued runs. |
| `webhookSecretEnv` | string | `GITHUB_WEBHOOK_SECRET` | Env var that contains the GitHub webhook secret. |
| `tokenEnv` | string | `GITHUB_TOKEN` | Env var that contains the GitHub token. |
| `accessMode` | `read` or `read_write` | `read` | Enables write tools only when set to `read_write`. |
| `allowedRepositories` | string[] | all repositories | Restricts events to repositories such as `owner/repo`. |
| `events` | string[] | all supported events | Restricts accepted webhook event names. |
| `branches` | string[] | all branches | Restricts branch-scoped events. |
| `labels` | string[] | all labels | Restricts issue and pull request events to matching labels. |
| `ignoredActors` | string[] | none | Ignores events from matching GitHub usernames. |

## Tools

Read tools are available when `GITHUB_TOKEN` is set:

- `github.get_issue`
- `github.get_pull_request`
- `github.list_pull_request_files`
- `github.list_pull_request_reviews`
- `github.list_pull_request_commits`
- `github.list_issue_comments`
- `github.get_content`
- `github.list_checks`
- `github.list_workflow_runs`
- `github.get_workflow_run`
- `github.list_workflow_run_jobs`

Set `accessMode: read_write` to enable write tools:

- `github.create_issue_comment`
- `github.create_pull_request_review_comment`
- `github.update_issue`
- `github.add_issue_labels`
- `github.set_commit_status`
- `github.rerun_workflow_run`
- `github.cancel_workflow_run`

Use `permissions.requireApproval` for write tools if the agent should ask before mutating GitHub state.

## Test Commands

```sh
pnpm --filter @render-harness/cap-github build
pnpm --filter @render-harness/cap-github test
```
