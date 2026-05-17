import { LinearClient } from "@linear/sdk";
import type { LocalToolHandler } from "@render-harness/core";

export type LinearAccessMode = "read" | "read_write";

export function linearTools(args: {
  apiKey: string;
  accessMode: LinearAccessMode;
}): LocalToolHandler[] {
  const client = new LinearClient({ apiKey: args.apiKey });
  const tools: LocalToolHandler[] = [
    jsonTool(
      "linear.get_issue",
      "Read a Linear issue by id.",
      idSchema("issueId"),
      async (input) => {
        const { issueId } = input as { issueId: string };
        return client.client.request(
          `query Issue($id: String!) {
          issue(id: $id) {
            id
            identifier
            title
            description
            url
            state { id name }
            team { id key name }
            project { id name }
            assignee { id name email }
            labels { nodes { id name } }
          }
        }`,
          { id: issueId },
        );
      },
    ),
    jsonTool(
      "linear.search_issues",
      "Search Linear issues with a text query.",
      objectSchema({ query: { type: "string" } }),
      async (input) => {
        const { query } = input as { query: string };
        return client.client.request(
          `query SearchIssues($query: String!) {
            issueSearch(query: $query) {
              nodes {
                id
                identifier
                title
                url
                state { name }
                team { key name }
              }
            }
          }`,
          { query },
        );
      },
    ),
    jsonTool(
      "linear.list_comments",
      "List comments for a Linear issue.",
      idSchema("issueId"),
      async (input) => {
        const { issueId } = input as { issueId: string };
        return client.client.request(
          `query IssueComments($id: String!) {
            issue(id: $id) {
              comments {
                nodes {
                  id
                  body
                  createdAt
                  user { id name email }
                }
              }
            }
          }`,
          { id: issueId },
        );
      },
    ),
  ];

  if (args.accessMode === "read_write") {
    tools.push(
      jsonTool(
        "linear.create_comment",
        "Create a comment on a Linear issue.",
        objectSchema({ issueId: { type: "string" }, body: { type: "string" } }),
        async (input) => {
          const { issueId, body } = input as { issueId: string; body: string };
          return client.client.request(
            `mutation CommentCreate($input: CommentCreateInput!) {
              commentCreate(input: $input) {
                success
                comment { id url body }
              }
            }`,
            { input: { issueId, body } },
          );
        },
      ),
      jsonTool(
        "linear.update_issue_status",
        "Update a Linear issue's status.",
        objectSchema({ issueId: { type: "string" }, stateId: { type: "string" } }),
        async (input) => {
          const { issueId, stateId } = input as { issueId: string; stateId: string };
          return client.client.request(
            `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
              issueUpdate(id: $id, input: $input) {
                success
                issue { id identifier state { id name } }
              }
            }`,
            { id: issueId, input: { stateId } },
          );
        },
      ),
      jsonTool(
        "linear.assign_issue",
        "Assign a Linear issue to a user.",
        objectSchema({ issueId: { type: "string" }, assigneeId: { type: "string" } }),
        async (input) => {
          const { issueId, assigneeId } = input as { issueId: string; assigneeId: string };
          return client.client.request(
            `mutation IssueAssign($id: String!, $input: IssueUpdateInput!) {
              issueUpdate(id: $id, input: $input) {
                success
                issue { id identifier assignee { id name } }
              }
            }`,
            { id: issueId, input: { assigneeId } },
          );
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
    definition: { name, description, inputSchema, source: "pack:cap-linear" },
    handler: async ({ input }) => {
      try {
        return { content: JSON.stringify(await call(input), null, 2) };
      } catch (err) {
        return { content: err instanceof Error ? err.message : String(err), isError: true };
      }
    },
  };
}

function idSchema(name: string) {
  return objectSchema({ [name]: { type: "string" } });
}

function objectSchema(properties: Record<string, unknown>) {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required: Object.keys(properties),
  };
}
