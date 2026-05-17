import { Octokit } from "@octokit/rest";
import type { LocalToolHandler } from "@render-harness/core";

export type GitHubAccessMode = "read" | "read_write";

export function githubTools(args: {
  token: string;
  accessMode: GitHubAccessMode;
}): LocalToolHandler[] {
  const octokit = new Octokit({ auth: args.token });
  const tools: LocalToolHandler[] = [
    jsonTool("github.get_issue", "Read a GitHub issue.", issueSchema(), async (input) => {
      const { owner, repo, issue_number } = input as IssueInput;
      return octokit.rest.issues.get({ owner, repo, issue_number });
    }),
    jsonTool(
      "github.get_pull_request",
      "Read a GitHub pull request.",
      prSchema(),
      async (input) => {
        const { owner, repo, pull_number } = input as PullInput;
        return octokit.rest.pulls.get({ owner, repo, pull_number });
      },
    ),
    jsonTool(
      "github.list_pull_request_files",
      "List files changed by a GitHub pull request.",
      prSchema(),
      async (input) => {
        const { owner, repo, pull_number } = input as PullInput;
        return octokit.paginate(octokit.rest.pulls.listFiles, { owner, repo, pull_number });
      },
    ),
    jsonTool(
      "github.list_pull_request_reviews",
      "List reviews on a GitHub pull request.",
      prSchema(),
      async (input) => {
        const { owner, repo, pull_number } = input as PullInput;
        return octokit.paginate(octokit.rest.pulls.listReviews, { owner, repo, pull_number });
      },
    ),
    jsonTool(
      "github.list_pull_request_commits",
      "List commits on a GitHub pull request.",
      prSchema(),
      async (input) => {
        const { owner, repo, pull_number } = input as PullInput;
        return octokit.paginate(octokit.rest.pulls.listCommits, { owner, repo, pull_number });
      },
    ),
    jsonTool(
      "github.list_issue_comments",
      "List comments on a GitHub issue or pull request.",
      issueSchema(),
      async (input) => {
        const { owner, repo, issue_number } = input as IssueInput;
        return octokit.paginate(octokit.rest.issues.listComments, { owner, repo, issue_number });
      },
    ),
    jsonTool(
      "github.get_content",
      "Read a file or directory listing from a GitHub repository.",
      contentSchema(),
      async (input) => {
        const { owner, repo, path, ref } = input as ContentInput;
        return octokit.rest.repos.getContent({
          owner,
          repo,
          path,
          ...(ref ? { ref } : {}),
        });
      },
    ),
    jsonTool(
      "github.list_checks",
      "List check runs for a GitHub ref.",
      refSchema(),
      async (input) => {
        const { owner, repo, ref } = input as RefInput;
        return octokit.rest.checks.listForRef({ owner, repo, ref });
      },
    ),
    jsonTool(
      "github.list_workflow_runs",
      "List GitHub Actions workflow runs.",
      repoSchema(),
      async (input) => {
        const { owner, repo } = input as RepoInput;
        return octokit.rest.actions.listWorkflowRunsForRepo({ owner, repo });
      },
    ),
    jsonTool(
      "github.get_workflow_run",
      "Read one GitHub Actions workflow run.",
      workflowRunSchema(),
      async (input) => {
        const { owner, repo, run_id } = input as WorkflowRunInput;
        return octokit.rest.actions.getWorkflowRun({ owner, repo, run_id });
      },
    ),
    jsonTool(
      "github.list_workflow_run_jobs",
      "List jobs for a GitHub Actions workflow run.",
      workflowRunSchema(),
      async (input) => {
        const { owner, repo, run_id } = input as WorkflowRunInput;
        return octokit.rest.actions.listJobsForWorkflowRun({ owner, repo, run_id });
      },
    ),
  ];

  if (args.accessMode === "read_write") {
    tools.push(
      jsonTool(
        "github.create_issue_comment",
        "Create a comment on a GitHub issue or pull request.",
        issueCommentSchema(),
        async (input) => {
          const { owner, repo, issue_number, body } = input as IssueCommentInput;
          return octokit.rest.issues.createComment({ owner, repo, issue_number, body });
        },
      ),
      jsonTool(
        "github.create_pull_request_review_comment",
        "Create a review comment on a GitHub pull request diff.",
        reviewCommentSchema(),
        async (input) => {
          const { owner, repo, pull_number, body, commit_id, path, line, side } =
            input as PullReviewCommentInput;
          return octokit.rest.pulls.createReviewComment({
            owner,
            repo,
            pull_number,
            body,
            commit_id,
            path,
            line,
            ...(side ? { side } : {}),
          });
        },
      ),
      jsonTool(
        "github.update_issue",
        "Update a GitHub issue or pull request issue fields.",
        updateIssueSchema(),
        async (input) => {
          const { owner, repo, issue_number, title, body, state, assignees, labels } =
            input as UpdateIssueInput;
          return octokit.rest.issues.update({
            owner,
            repo,
            issue_number,
            ...(title ? { title } : {}),
            ...(body ? { body } : {}),
            ...(state ? { state } : {}),
            ...(assignees ? { assignees } : {}),
            ...(labels ? { labels } : {}),
          });
        },
      ),
      jsonTool(
        "github.add_issue_labels",
        "Add labels to a GitHub issue or pull request.",
        labelsSchema(),
        async (input) => {
          const { owner, repo, issue_number, labels } = input as LabelsInput;
          return octokit.rest.issues.addLabels({ owner, repo, issue_number, labels });
        },
      ),
      jsonTool(
        "github.set_commit_status",
        "Set a GitHub commit status.",
        commitStatusSchema(),
        async (input) => {
          const { owner, repo, sha, state, description, context, target_url } =
            input as CommitStatusInput;
          return octokit.rest.repos.createCommitStatus({
            owner,
            repo,
            sha,
            state,
            ...(description ? { description } : {}),
            ...(context ? { context } : {}),
            ...(target_url ? { target_url } : {}),
          });
        },
      ),
      jsonTool(
        "github.rerun_workflow_run",
        "Rerun a GitHub Actions workflow run.",
        workflowRunSchema(),
        async (input) => {
          const { owner, repo, run_id } = input as WorkflowRunInput;
          return octokit.rest.actions.reRunWorkflow({ owner, repo, run_id });
        },
      ),
      jsonTool(
        "github.cancel_workflow_run",
        "Cancel a GitHub Actions workflow run.",
        workflowRunSchema(),
        async (input) => {
          const { owner, repo, run_id } = input as WorkflowRunInput;
          return octokit.rest.actions.cancelWorkflowRun({ owner, repo, run_id });
        },
      ),
    );
  }

  return tools;
}

function jsonTool(
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
  call: (input: unknown) => Promise<unknown>,
): LocalToolHandler {
  return {
    definition: { name, description, inputSchema, source: "pack:cap-github" },
    handler: async ({ input }) => {
      try {
        const result = await call(input);
        return { content: JSON.stringify(result, null, 2) };
      } catch (err) {
        return {
          content: err instanceof Error ? err.message : String(err),
          isError: true,
        };
      }
    },
  };
}

interface RepoInput {
  owner: string;
  repo: string;
}
interface IssueInput extends RepoInput {
  issue_number: number;
}
interface PullInput extends RepoInput {
  pull_number: number;
}
interface RefInput extends RepoInput {
  ref: string;
}
interface WorkflowRunInput extends RepoInput {
  run_id: number;
}
interface ContentInput extends RepoInput {
  path: string;
  ref?: string;
}
interface IssueCommentInput extends IssueInput {
  body: string;
}
interface PullReviewCommentInput extends PullInput {
  body: string;
  commit_id: string;
  path: string;
  line: number;
  side?: "LEFT" | "RIGHT";
}
interface UpdateIssueInput extends IssueInput {
  title?: string;
  body?: string;
  state?: "open" | "closed";
  assignees?: string[];
  labels?: string[];
}
interface LabelsInput extends IssueInput {
  labels: string[];
}
interface CommitStatusInput extends RepoInput {
  sha: string;
  state: "error" | "failure" | "pending" | "success";
  description?: string;
  context?: string;
  target_url?: string;
}

function repoSchema() {
  return objectSchema({
    owner: { type: "string" },
    repo: { type: "string" },
  });
}

function issueSchema() {
  return objectSchema({
    owner: { type: "string" },
    repo: { type: "string" },
    issue_number: { type: "number" },
  });
}

function prSchema() {
  return objectSchema({
    owner: { type: "string" },
    repo: { type: "string" },
    pull_number: { type: "number" },
  });
}

function refSchema() {
  return objectSchema({
    owner: { type: "string" },
    repo: { type: "string" },
    ref: { type: "string" },
  });
}

function workflowRunSchema() {
  return objectSchema({
    owner: { type: "string" },
    repo: { type: "string" },
    run_id: { type: "number" },
  });
}

function contentSchema() {
  return objectSchema({
    owner: { type: "string" },
    repo: { type: "string" },
    path: { type: "string" },
    ref: { type: "string", optional: true },
  });
}

function issueCommentSchema() {
  return objectSchema({
    owner: { type: "string" },
    repo: { type: "string" },
    issue_number: { type: "number" },
    body: { type: "string" },
  });
}

function reviewCommentSchema() {
  return objectSchema({
    owner: { type: "string" },
    repo: { type: "string" },
    pull_number: { type: "number" },
    body: { type: "string" },
    commit_id: { type: "string" },
    path: { type: "string" },
    line: { type: "number" },
    side: { type: "string", enum: ["LEFT", "RIGHT"], optional: true },
  });
}

function updateIssueSchema() {
  return objectSchema({
    owner: { type: "string" },
    repo: { type: "string" },
    issue_number: { type: "number" },
    title: { type: "string", optional: true },
    body: { type: "string", optional: true },
    state: { type: "string", enum: ["open", "closed"], optional: true },
    assignees: { type: "array", items: { type: "string" }, optional: true },
    labels: { type: "array", items: { type: "string" }, optional: true },
  });
}

function labelsSchema() {
  return objectSchema({
    owner: { type: "string" },
    repo: { type: "string" },
    issue_number: { type: "number" },
    labels: { type: "array", items: { type: "string" } },
  });
}

function commitStatusSchema() {
  return objectSchema({
    owner: { type: "string" },
    repo: { type: "string" },
    sha: { type: "string" },
    state: { type: "string", enum: ["error", "failure", "pending", "success"] },
    description: { type: "string", optional: true },
    context: { type: "string", optional: true },
    target_url: { type: "string", optional: true },
  });
}

function objectSchema(properties: Record<string, unknown>) {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required: Object.entries(properties)
      .filter(([, value]) => !(value as { optional?: boolean }).optional)
      .map(([key]) => key),
  };
}
