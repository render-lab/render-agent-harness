import type { LocalToolHandler } from "@render-harness/core";
import { WebClient } from "@slack/web-api";

export type SlackAccessMode = "read" | "read_write";

export function slackTools(args: {
  botToken: string;
  accessMode: SlackAccessMode;
  allowedChannels?: string[];
}): LocalToolHandler[] {
  const client = new WebClient(args.botToken);
  const tools: LocalToolHandler[] = [
    jsonTool(
      "slack.get_thread",
      "Read a Slack thread's messages.",
      objectSchema({
        channel: { type: "string" },
        thread_ts: { type: "string" },
      }),
      async (input) => {
        const { channel, thread_ts } = input as { channel: string; thread_ts: string };
        assertAllowedChannel(channel, args.allowedChannels);
        return client.conversations.replies({ channel, ts: thread_ts });
      },
    ),
    jsonTool(
      "slack.get_channel_history",
      "Read recent Slack channel messages.",
      objectSchema({
        channel: { type: "string" },
        limit: { type: "number", optional: true },
      }),
      async (input) => {
        const { channel, limit } = input as { channel: string; limit?: number };
        assertAllowedChannel(channel, args.allowedChannels);
        return client.conversations.history({ channel, limit: limit ?? 20 });
      },
    ),
  ];

  if (args.accessMode === "read_write") {
    tools.push(
      jsonTool(
        "slack.send_message",
        "Send a Slack message, optionally as a thread reply.",
        objectSchema({
          channel: { type: "string" },
          text: { type: "string" },
          thread_ts: { type: "string", optional: true },
        }),
        async (input) => {
          const { channel, text, thread_ts } = input as {
            channel: string;
            text: string;
            thread_ts?: string;
          };
          assertAllowedChannel(channel, args.allowedChannels);
          return client.chat.postMessage({
            channel,
            text,
            ...(thread_ts ? { thread_ts } : {}),
          });
        },
      ),
      jsonTool(
        "slack.add_reaction",
        "Add a reaction to a Slack message.",
        objectSchema({
          channel: { type: "string" },
          ts: { type: "string" },
          name: { type: "string" },
        }),
        async (input) => {
          const { channel, ts, name } = input as { channel: string; ts: string; name: string };
          assertAllowedChannel(channel, args.allowedChannels);
          return client.reactions.add({ channel, timestamp: ts, name });
        },
      ),
      jsonTool(
        "slack.update_message",
        "Update a Slack message.",
        objectSchema({
          channel: { type: "string" },
          ts: { type: "string" },
          text: { type: "string" },
        }),
        async (input) => {
          const { channel, ts, text } = input as { channel: string; ts: string; text: string };
          assertAllowedChannel(channel, args.allowedChannels);
          return client.chat.update({ channel, ts, text });
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
    definition: { name, description, inputSchema, source: "pack:cap-slack" },
    handler: async ({ input }) => {
      try {
        return { content: JSON.stringify(await call(input), null, 2) };
      } catch (err) {
        return { content: err instanceof Error ? err.message : String(err), isError: true };
      }
    },
  };
}

function assertAllowedChannel(channel: string, allowedChannels: string[] | undefined): void {
  if (allowedChannels?.length && !allowedChannels.includes(channel)) {
    throw new Error(`Slack channel "${channel}" is not allowed by cap-slack config`);
  }
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
