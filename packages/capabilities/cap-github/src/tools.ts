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
interface IssueCommentInput extends IssueInput {
  body: string;
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

function issueCommentSchema() {
  return objectSchema({
    owner: { type: "string" },
    repo: { type: "string" },
    issue_number: { type: "number" },
    body: { type: "string" },
  });
}

function commitStatusSchema() {
  return objectSchema({
    owner: { type: "string" },
    repo: { type: "string" },
    sha: { type: "string" },
    state: { type: "string", enum: ["error", "failure", "pending", "success"] },
    description: { type: "string" },
    context: { type: "string" },
    target_url: { type: "string" },
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
