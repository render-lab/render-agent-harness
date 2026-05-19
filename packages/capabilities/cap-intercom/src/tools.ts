import type { LocalToolHandler } from "@render-harness/core";
import {
  type ConversationPart,
  flattenConversationParts,
  formatIntercomError,
  intercomFetch,
} from "./lib.js";

export type IntercomAccessMode = "read" | "read_write";

export function intercomTools(args: { accessMode: IntercomAccessMode }): LocalToolHandler[] {
  const tools: LocalToolHandler[] = [readConversation(), listRecentConversations()];
  if (args.accessMode === "read_write") {
    tools.push(reply(), assign(), addTag(), close(), snooze());
  }
  return tools;
}

// --------------------------------------------------------------------
// Read
// --------------------------------------------------------------------

function readConversation(): LocalToolHandler {
  return {
    definition: {
      name: "read_conversation",
      description:
        "Fetch one Intercom conversation by id, returning the state (open/closed/snoozed), assignee, tags, and the conversation parts (each customer message, admin reply, internal note, assignment, close) flattened to a chronological transcript.",
      source: "pack:cap-intercom",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          conversation_id: {
            type: "string",
            description: "Intercom conversation id (e.g. from a webhook payload).",
            minLength: 1,
          },
        },
        required: ["conversation_id"],
      },
    },
    async handler({ input, secrets }) {
      const args = (input ?? {}) as { conversation_id?: string };
      if (!args.conversation_id) {
        return {
          content: "intercom.read_conversation: conversation_id is required",
          isError: true,
        };
      }
      if (!secrets) {
        return {
          content: "intercom.read_conversation: no SecretsContext on this run",
          isError: true,
        };
      }
      const conn = await secrets.requireConnection("intercom");
      try {
        const c = await intercomFetch<{
          id: string;
          state?: string;
          source?: { delivered_as?: string; subject?: string; body?: string };
          assignee?: { id?: string; type?: string };
          team_assignee_id?: string | null;
          tags?: { tags?: Array<{ id?: string; name?: string }> };
          conversation_parts?: { conversation_parts?: ConversationPart[] };
        }>({
          accessToken: conn.accessToken,
          path: `/conversations/${encodeURIComponent(args.conversation_id)}`,
          query: { display_as: "plaintext" },
        });
        const partsList = c.conversation_parts?.conversation_parts ?? [];
        const initial: ConversationPart = c.source
          ? {
              type: "comment",
              part_type: "comment",
              body: c.source.body ?? c.source.subject ?? "",
            }
          : {};
        const transcript = flattenConversationParts(
          initial.body ? [initial, ...partsList] : partsList,
        );
        return {
          content: [
            `# conversation ${c.id}`,
            `state: ${c.state ?? "?"}`,
            c.assignee?.id ? `assignee: admin ${c.assignee.id}` : "assignee: (unassigned)",
            c.team_assignee_id ? `team: ${c.team_assignee_id}` : null,
            (c.tags?.tags ?? []).length
              ? `tags: ${(c.tags?.tags ?? []).map((t) => t.name ?? t.id).join(", ")}`
              : "tags: (none)",
            "",
            "## transcript",
            transcript || "(empty)",
          ]
            .filter(Boolean)
            .join("\n"),
        };
      } catch (err) {
        return formatIntercomError("intercom.read_conversation", err);
      }
    },
  };
}

function listRecentConversations(): LocalToolHandler {
  return {
    definition: {
      name: "list_recent_conversations",
      description:
        "List recent Intercom conversations, optionally filtered by open-state or assignee. Returns id, state, assignee, last update, and a short snippet of the latest message. Pass open: true to skip closed/snoozed.",
      source: "pack:cap-intercom",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          open: {
            type: "boolean",
            description: "Only conversations in the open state.",
          },
          assignee_id: {
            type: "string",
            description: "Only conversations currently assigned to this admin id.",
          },
          k: {
            type: "integer",
            description: "Max conversations. Default 10, max 50.",
            minimum: 1,
            maximum: 50,
          },
        },
      },
    },
    async handler({ input, secrets }) {
      const args = (input ?? {}) as { open?: boolean; assignee_id?: string; k?: number };
      if (!secrets) {
        return {
          content: "intercom.list_recent_conversations: no SecretsContext on this run",
          isError: true,
        };
      }
      const conn = await secrets.requireConnection("intercom");
      try {
        const k = Math.min(args.k ?? 10, 50);
        const query: Record<string, string | number> = { per_page: k };
        // Intercom's REST GET /conversations doesn't directly filter
        // by state — for that we'd use the search endpoint. For
        // simplicity in v1, fetch the most-recent page and filter
        // client-side. With per_page=50 max this is bounded.
        const res = await intercomFetch<{
          conversations?: Array<{
            id: string;
            state?: string;
            updated_at?: number;
            assignee?: { id?: string };
            source?: { body?: string; subject?: string };
          }>;
        }>({
          accessToken: conn.accessToken,
          path: "/conversations",
          query,
        });
        let convos = res.conversations ?? [];
        if (args.open) convos = convos.filter((c) => c.state === "open");
        if (args.assignee_id) convos = convos.filter((c) => c.assignee?.id === args.assignee_id);
        if (convos.length === 0)
          return { content: "intercom.list_recent_conversations: no matches" };
        const lines = convos.map((c, i) => {
          const updated = c.updated_at ? new Date(c.updated_at * 1000).toISOString() : "?";
          const snippet = (c.source?.body ?? c.source?.subject ?? "").slice(0, 200);
          return `${i + 1}. id=${c.id}  state=${c.state ?? "?"}  updated=${updated}  assignee=${c.assignee?.id ?? "—"}\n   ${snippet}`;
        });
        return { content: lines.join("\n\n") };
      } catch (err) {
        return formatIntercomError("intercom.list_recent_conversations", err);
      }
    },
  };
}

// --------------------------------------------------------------------
// Write
// --------------------------------------------------------------------

function reply(): LocalToolHandler {
  return {
    definition: {
      name: "reply",
      description:
        "Post a reply on an Intercom conversation. Set `type: 'comment'` (default) for a customer-visible reply, OR `type: 'note'` for a private admin-only note. Always set `admin_id` to the admin id the reply should be attributed to (Intercom requires this).",
      source: "pack:cap-intercom",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          conversation_id: { type: "string", minLength: 1 },
          admin_id: {
            type: "string",
            description: "The Intercom admin id the reply is attributed to.",
            minLength: 1,
          },
          body: {
            type: "string",
            description: "Reply body. HTML allowed for customer-visible comments.",
            minLength: 1,
          },
          type: {
            type: "string",
            enum: ["comment", "note"],
            description: "Public customer reply (default) or private admin note.",
          },
        },
        required: ["conversation_id", "admin_id", "body"],
      },
    },
    async handler({ input, secrets }) {
      const args = (input ?? {}) as {
        conversation_id?: string;
        admin_id?: string;
        body?: string;
        type?: "comment" | "note";
      };
      if (!args.conversation_id || !args.admin_id || !args.body) {
        return {
          content: "intercom.reply: conversation_id, admin_id, and body are required",
          isError: true,
        };
      }
      if (!secrets) return { content: "intercom.reply: no SecretsContext", isError: true };
      const conn = await secrets.requireConnection("intercom");
      try {
        const messageType = args.type === "note" ? "note" : "comment";
        await intercomFetch({
          accessToken: conn.accessToken,
          path: `/conversations/${encodeURIComponent(args.conversation_id)}/reply`,
          method: "POST",
          body: {
            message_type: messageType,
            type: "admin",
            admin_id: args.admin_id,
            body: args.body,
          },
        });
        return {
          content: `intercom.reply: posted ${messageType} to conversation ${args.conversation_id}`,
        };
      } catch (err) {
        return formatIntercomError("intercom.reply", err);
      }
    },
  };
}

function assign(): LocalToolHandler {
  return {
    definition: {
      name: "assign",
      description:
        "Assign an Intercom conversation to an admin and/or team. Pass `assignee_id` for the admin or `team_id` for the team. The acting `admin_id` is the admin performing the assignment.",
      source: "pack:cap-intercom",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          conversation_id: { type: "string", minLength: 1 },
          admin_id: {
            type: "string",
            description: "Acting admin id.",
            minLength: 1,
          },
          assignee_id: { type: "string", description: "Target admin id (optional)." },
          team_id: { type: "string", description: "Target team id (optional)." },
        },
        required: ["conversation_id", "admin_id"],
      },
    },
    async handler({ input, secrets }) {
      const args = (input ?? {}) as {
        conversation_id?: string;
        admin_id?: string;
        assignee_id?: string;
        team_id?: string;
      };
      if (!args.conversation_id || !args.admin_id) {
        return {
          content: "intercom.assign: conversation_id and admin_id are required",
          isError: true,
        };
      }
      if (!args.assignee_id && !args.team_id) {
        return {
          content: "intercom.assign: one of assignee_id or team_id is required",
          isError: true,
        };
      }
      if (!secrets) return { content: "intercom.assign: no SecretsContext", isError: true };
      const conn = await secrets.requireConnection("intercom");
      try {
        const body: Record<string, unknown> = {
          message_type: "assignment",
          type: "admin",
          admin_id: args.admin_id,
        };
        if (args.assignee_id) body.assignee_id = args.assignee_id;
        if (args.team_id) body.team_id = args.team_id;
        await intercomFetch({
          accessToken: conn.accessToken,
          path: `/conversations/${encodeURIComponent(args.conversation_id)}/parts`,
          method: "POST",
          body,
        });
        return {
          content: `intercom.assign: assigned conversation ${args.conversation_id} to ${args.assignee_id ?? `team ${args.team_id}`}`,
        };
      } catch (err) {
        return formatIntercomError("intercom.assign", err);
      }
    },
  };
}

function addTag(): LocalToolHandler {
  return {
    definition: {
      name: "add_tag",
      description:
        "Add a tag (by id) to an Intercom conversation. The acting admin_id is recorded.",
      source: "pack:cap-intercom",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          conversation_id: { type: "string", minLength: 1 },
          tag_id: { type: "string", minLength: 1 },
          admin_id: { type: "string", minLength: 1 },
        },
        required: ["conversation_id", "tag_id", "admin_id"],
      },
    },
    async handler({ input, secrets }) {
      const args = (input ?? {}) as {
        conversation_id?: string;
        tag_id?: string;
        admin_id?: string;
      };
      if (!args.conversation_id || !args.tag_id || !args.admin_id) {
        return {
          content: "intercom.add_tag: conversation_id, tag_id, and admin_id are required",
          isError: true,
        };
      }
      if (!secrets) return { content: "intercom.add_tag: no SecretsContext", isError: true };
      const conn = await secrets.requireConnection("intercom");
      try {
        await intercomFetch({
          accessToken: conn.accessToken,
          path: `/conversations/${encodeURIComponent(args.conversation_id)}/tags`,
          method: "POST",
          body: { id: args.tag_id, admin_id: args.admin_id },
        });
        return {
          content: `intercom.add_tag: added tag ${args.tag_id} to conversation ${args.conversation_id}`,
        };
      } catch (err) {
        return formatIntercomError("intercom.add_tag", err);
      }
    },
  };
}

function close(): LocalToolHandler {
  return {
    definition: {
      name: "close",
      description:
        "Close an Intercom conversation. Optionally include a closing message body (customer-visible).",
      source: "pack:cap-intercom",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          conversation_id: { type: "string", minLength: 1 },
          admin_id: { type: "string", minLength: 1 },
          body: { type: "string", description: "Optional closing message body." },
        },
        required: ["conversation_id", "admin_id"],
      },
    },
    async handler({ input, secrets }) {
      const args = (input ?? {}) as {
        conversation_id?: string;
        admin_id?: string;
        body?: string;
      };
      if (!args.conversation_id || !args.admin_id) {
        return {
          content: "intercom.close: conversation_id and admin_id are required",
          isError: true,
        };
      }
      if (!secrets) return { content: "intercom.close: no SecretsContext", isError: true };
      const conn = await secrets.requireConnection("intercom");
      try {
        const body: Record<string, unknown> = {
          message_type: "close",
          type: "admin",
          admin_id: args.admin_id,
        };
        if (args.body) body.body = args.body;
        await intercomFetch({
          accessToken: conn.accessToken,
          path: `/conversations/${encodeURIComponent(args.conversation_id)}/parts`,
          method: "POST",
          body,
        });
        return { content: `intercom.close: closed conversation ${args.conversation_id}` };
      } catch (err) {
        return formatIntercomError("intercom.close", err);
      }
    },
  };
}

function snooze(): LocalToolHandler {
  return {
    definition: {
      name: "snooze",
      description:
        "Snooze an Intercom conversation until a given timestamp (Unix seconds). The conversation will re-open at that time. The acting admin_id is recorded.",
      source: "pack:cap-intercom",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          conversation_id: { type: "string", minLength: 1 },
          admin_id: { type: "string", minLength: 1 },
          snoozed_until: {
            type: "integer",
            description:
              "Unix seconds when the conversation should re-open. Intercom requires a future time.",
          },
        },
        required: ["conversation_id", "admin_id", "snoozed_until"],
      },
    },
    async handler({ input, secrets }) {
      const args = (input ?? {}) as {
        conversation_id?: string;
        admin_id?: string;
        snoozed_until?: number;
      };
      if (!args.conversation_id || !args.admin_id || !args.snoozed_until) {
        return {
          content: "intercom.snooze: conversation_id, admin_id, and snoozed_until are required",
          isError: true,
        };
      }
      if (!secrets) return { content: "intercom.snooze: no SecretsContext", isError: true };
      const conn = await secrets.requireConnection("intercom");
      try {
        await intercomFetch({
          accessToken: conn.accessToken,
          path: `/conversations/${encodeURIComponent(args.conversation_id)}/parts`,
          method: "POST",
          body: {
            message_type: "snoozed",
            type: "admin",
            admin_id: args.admin_id,
            snoozed_until: args.snoozed_until,
          },
        });
        return {
          content: `intercom.snooze: snoozed conversation ${args.conversation_id} until ${new Date(args.snoozed_until * 1000).toISOString()}`,
        };
      } catch (err) {
        return formatIntercomError("intercom.snooze", err);
      }
    },
  };
}
