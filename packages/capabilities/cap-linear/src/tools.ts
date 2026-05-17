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
    jsonTool("linear.list_teams", "List Linear teams.", emptySchema(), async () =>
      client.client.request(
        `query Teams {
          teams {
            nodes {
              id
              key
              name
            }
          }
        }`,
      ),
    ),
    jsonTool("linear.list_projects", "List Linear projects.", emptySchema(), async () =>
      client.client.request(
        `query Projects {
          projects {
            nodes {
              id
              name
              url
              state
              teams { nodes { id key name } }
            }
          }
        }`,
      ),
    ),
    jsonTool(
      "linear.list_workflow_states",
      "List Linear workflow states, optionally scoped to a team.",
      objectSchema({ teamId: { type: "string", optional: true } }),
      async (input) => {
        const { teamId } = input as { teamId?: string };
        return client.client.request(
          `query WorkflowStates($filter: WorkflowStateFilter) {
            workflowStates(filter: $filter) {
              nodes {
                id
                name
                type
                team { id key name }
              }
            }
          }`,
          { filter: teamId ? { team: { id: { eq: teamId } } } : undefined },
        );
      },
    ),
    jsonTool("linear.list_users", "List Linear users.", emptySchema(), async () =>
      client.client.request(
        `query Users {
          users {
            nodes {
              id
              name
              email
              active
            }
          }
        }`,
      ),
    ),
  ];

  if (args.accessMode === "read_write") {
    tools.push(
      jsonTool(
        "linear.create_issue",
        "Create a Linear issue.",
        createIssueSchema(),
        async (input) => {
          const { teamId, title, description, assigneeId, projectId, cycleId, stateId, priority } =
            input as CreateIssueInput;
          return client.client.request(
            `mutation IssueCreate($input: IssueCreateInput!) {
              issueCreate(input: $input) {
                success
                issue { id identifier title url }
              }
            }`,
            {
              input: {
                teamId,
                title,
                ...(description ? { description } : {}),
                ...(assigneeId ? { assigneeId } : {}),
                ...(projectId ? { projectId } : {}),
                ...(cycleId ? { cycleId } : {}),
                ...(stateId ? { stateId } : {}),
                ...(priority !== undefined ? { priority } : {}),
              },
            },
          );
        },
      ),
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
        "linear.update_issue",
        "Update Linear issue fields.",
        updateIssueSchema(),
        async (input) => {
          const {
            issueId,
            title,
            description,
            stateId,
            assigneeId,
            projectId,
            cycleId,
            priority,
            labelIds,
          } = input as UpdateIssueInput;
          return client.client.request(
            `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
              issueUpdate(id: $id, input: $input) {
                success
                issue {
                  id
                  identifier
                  title
                  state { id name }
                  assignee { id name }
                  project { id name }
                  cycle { id name }
                }
              }
            }`,
            {
              id: issueId,
              input: {
                ...(title ? { title } : {}),
                ...(description ? { description } : {}),
                ...(stateId ? { stateId } : {}),
                ...(assigneeId ? { assigneeId } : {}),
                ...(projectId ? { projectId } : {}),
                ...(cycleId ? { cycleId } : {}),
                ...(priority !== undefined ? { priority } : {}),
                ...(labelIds ? { labelIds } : {}),
              },
            },
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
      jsonTool(
        "linear.link_related_issue",
        "Create a Linear issue relation between two issues.",
        objectSchema({
          issueId: { type: "string" },
          relatedIssueId: { type: "string" },
          type: { type: "string" },
        }),
        async (input) => {
          const { issueId, relatedIssueId, type } = input as {
            issueId: string;
            relatedIssueId: string;
            type: string;
          };
          return client.client.request(
            `mutation IssueRelationCreate($input: IssueRelationCreateInput!) {
              issueRelationCreate(input: $input) {
                success
                issueRelation { id type }
              }
            }`,
            { input: { issueId, relatedIssueId, type } },
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

interface CreateIssueInput {
  teamId: string;
  title: string;
  description?: string;
  assigneeId?: string;
  projectId?: string;
  cycleId?: string;
  stateId?: string;
  priority?: number;
}

interface UpdateIssueInput {
  issueId: string;
  title?: string;
  description?: string;
  stateId?: string;
  assigneeId?: string;
  projectId?: string;
  cycleId?: string;
  priority?: number;
  labelIds?: string[];
}

function emptySchema() {
  return objectSchema({});
}

function idSchema(name: string) {
  return objectSchema({ [name]: { type: "string" } });
}

function createIssueSchema() {
  return objectSchema({
    teamId: { type: "string" },
    title: { type: "string" },
    description: { type: "string", optional: true },
    assigneeId: { type: "string", optional: true },
    projectId: { type: "string", optional: true },
    cycleId: { type: "string", optional: true },
    stateId: { type: "string", optional: true },
    priority: { type: "number", optional: true },
  });
}

function updateIssueSchema() {
  return objectSchema({
    issueId: { type: "string" },
    title: { type: "string", optional: true },
    description: { type: "string", optional: true },
    stateId: { type: "string", optional: true },
    assigneeId: { type: "string", optional: true },
    projectId: { type: "string", optional: true },
    cycleId: { type: "string", optional: true },
    priority: { type: "number", optional: true },
    labelIds: { type: "array", items: { type: "string" }, optional: true },
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
