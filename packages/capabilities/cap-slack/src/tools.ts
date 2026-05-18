import type { LocalToolHandler } from "@render-harness/core";
import { WebClient } from "@slack/web-api";

export type SlackAccessMode = "read" | "read_write";

interface ResolvedUser {
  id: string;
  name?: string;
  real_name?: string;
  display_name?: string;
  is_bot?: boolean;
}

interface ResolvedChannel {
  id: string;
  name?: string;
  is_private?: boolean;
  is_archived?: boolean;
}

interface SlackResolver {
  user: (id: string) => Promise<ResolvedUser>;
  channel: (id: string) => Promise<ResolvedChannel>;
}

export function slackTools(args: {
  botToken: string;
  accessMode: SlackAccessMode;
  allowedChannels?: string[];
}): LocalToolHandler[] {
  const client = new WebClient(args.botToken);
  const resolver = createResolver(client);

  const tools: LocalToolHandler[] = [
    jsonTool(
      "slack.get_thread",
      "Read a Slack thread's messages. Responses include resolved user display names and a rewritten text_resolved field.",
      objectSchema({
        channel: { type: "string" },
        thread_ts: { type: "string" },
      }),
      async (input) => {
        const { channel, thread_ts } = input as { channel: string; thread_ts: string };
        assertAllowedChannel(channel, args.allowedChannels);
        const resp = await client.conversations.replies({ channel, ts: thread_ts });
        return enrichConversationResponse(resp, channel, resolver);
      },
    ),
    jsonTool(
      "slack.get_channel_history",
      "Read recent Slack channel messages. Responses include resolved user display names and a rewritten text_resolved field.",
      objectSchema({
        channel: { type: "string" },
        limit: { type: "number", optional: true },
      }),
      async (input) => {
        const { channel, limit } = input as { channel: string; limit?: number };
        assertAllowedChannel(channel, args.allowedChannels);
        const resp = await client.conversations.history({ channel, limit: limit ?? 20 });
        return enrichConversationResponse(resp, channel, resolver);
      },
    ),
    jsonTool(
      "slack.get_user_info",
      "Resolve a Slack user ID (e.g. U0B4357MH7H) to a display name, real name, and handle.",
      objectSchema({
        user: { type: "string" },
      }),
      async (input) => {
        const { user } = input as { user: string };
        return resolver.user(user);
      },
    ),
    jsonTool(
      "slack.get_channel_info",
      "Resolve a Slack channel ID (e.g. C0AQHA6M3PS) to a channel name and metadata.",
      objectSchema({
        channel: { type: "string" },
      }),
      async (input) => {
        const { channel } = input as { channel: string };
        assertAllowedChannel(channel, args.allowedChannels);
        return resolver.channel(channel);
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

function createResolver(client: WebClient): SlackResolver {
  const users = new Map<string, ResolvedUser>();
  const channels = new Map<string, ResolvedChannel>();
  const pendingUsers = new Map<string, Promise<ResolvedUser>>();
  const pendingChannels = new Map<string, Promise<ResolvedChannel>>();

  return {
    async user(id: string): Promise<ResolvedUser> {
      const cached = users.get(id);
      if (cached) return cached;
      const pending = pendingUsers.get(id);
      if (pending) return pending;
      const fetchOne = (async (): Promise<ResolvedUser> => {
        try {
          const resp = await client.users.info({ user: id });
          const raw = (resp as unknown as { user?: Record<string, unknown> }).user;
          const info = buildResolvedUser(id, raw);
          users.set(id, info);
          return info;
        } catch {
          const info: ResolvedUser = { id };
          users.set(id, info);
          return info;
        } finally {
          pendingUsers.delete(id);
        }
      })();
      pendingUsers.set(id, fetchOne);
      return fetchOne;
    },
    async channel(id: string): Promise<ResolvedChannel> {
      const cached = channels.get(id);
      if (cached) return cached;
      const pending = pendingChannels.get(id);
      if (pending) return pending;
      const fetchOne = (async (): Promise<ResolvedChannel> => {
        try {
          const resp = await client.conversations.info({ channel: id });
          const raw = (resp as unknown as { channel?: Record<string, unknown> }).channel;
          const info = buildResolvedChannel(id, raw);
          channels.set(id, info);
          return info;
        } catch {
          const info: ResolvedChannel = { id };
          channels.set(id, info);
          return info;
        } finally {
          pendingChannels.delete(id);
        }
      })();
      pendingChannels.set(id, fetchOne);
      return fetchOne;
    },
  };
}

function buildResolvedUser(id: string, raw: Record<string, unknown> | undefined): ResolvedUser {
  if (!raw) return { id };
  const profile = (raw.profile as Record<string, unknown> | undefined) ?? undefined;
  const info: ResolvedUser = { id };
  const name = typeof raw.name === "string" ? raw.name : undefined;
  if (name) info.name = name;
  const realName =
    typeof raw.real_name === "string"
      ? raw.real_name
      : typeof profile?.real_name === "string"
        ? (profile.real_name as string)
        : undefined;
  if (realName) info.real_name = realName;
  const displayName =
    typeof profile?.display_name === "string" && (profile.display_name as string).length > 0
      ? (profile.display_name as string)
      : undefined;
  if (displayName) info.display_name = displayName;
  if (raw.is_bot === true) info.is_bot = true;
  return info;
}

function buildResolvedChannel(
  id: string,
  raw: Record<string, unknown> | undefined,
): ResolvedChannel {
  if (!raw) return { id };
  const info: ResolvedChannel = { id };
  if (typeof raw.name === "string") info.name = raw.name;
  if (raw.is_private === true) info.is_private = true;
  if (raw.is_archived === true) info.is_archived = true;
  return info;
}

function displayLabel(user: ResolvedUser | undefined): string | undefined {
  return user?.display_name ?? user?.real_name ?? user?.name;
}

const USER_MENTION = /<@(U[A-Z0-9]+)(?:\|[^>]+)?>/g;
const CHANNEL_MENTION = /<#(C[A-Z0-9]+)(?:\|([^>]+))?>/g;

async function enrichConversationResponse(
  resp: unknown,
  channelId: string,
  resolver: SlackResolver,
): Promise<unknown> {
  if (!resp || typeof resp !== "object") return resp;
  const body = resp as Record<string, unknown>;
  const rawMessages = Array.isArray(body.messages) ? (body.messages as unknown[]) : [];
  const userIds = new Set<string>();
  const channelIds = new Set<string>([channelId]);
  for (const msg of rawMessages) {
    if (!msg || typeof msg !== "object") continue;
    const m = msg as Record<string, unknown>;
    if (typeof m.user === "string") userIds.add(m.user);
    if (typeof m.text === "string") collectMentions(m.text, userIds, channelIds);
  }

  const [resolvedUserList, resolvedChannelList] = await Promise.all([
    Promise.all([...userIds].map(async (id) => [id, await resolver.user(id)] as const)),
    Promise.all([...channelIds].map(async (id) => [id, await resolver.channel(id)] as const)),
  ]);
  const usersById = new Map<string, ResolvedUser>(resolvedUserList);
  const channelsById = new Map<string, ResolvedChannel>(resolvedChannelList);

  const enrichedMessages = rawMessages.map((msg) => {
    if (!msg || typeof msg !== "object") return msg;
    const m = msg as Record<string, unknown>;
    const out: Record<string, unknown> = { ...m };
    if (typeof m.user === "string") {
      const label = displayLabel(usersById.get(m.user));
      if (label) out.user_display_name = label;
    }
    if (typeof m.text === "string") {
      out.text_resolved = rewriteMentions(m.text, usersById, channelsById);
    }
    return out;
  });

  const resolvedUsers: Record<string, ResolvedUser> = {};
  for (const [id, info] of usersById) resolvedUsers[id] = info;
  const channelInfo = channelsById.get(channelId);

  return {
    ...body,
    messages: enrichedMessages,
    resolved_users: resolvedUsers,
    ...(channelInfo ? { resolved_channel: channelInfo } : {}),
  };
}

function collectMentions(text: string, userIds: Set<string>, channelIds: Set<string>): void {
  for (const match of text.matchAll(USER_MENTION)) {
    const id = match[1];
    if (id) userIds.add(id);
  }
  for (const match of text.matchAll(CHANNEL_MENTION)) {
    const id = match[1];
    if (id) channelIds.add(id);
  }
}

function rewriteMentions(
  text: string,
  users: Map<string, ResolvedUser>,
  channels: Map<string, ResolvedChannel>,
): string {
  return text
    .replace(USER_MENTION, (_match, id: string) => {
      const label = displayLabel(users.get(id));
      return label ? `@${label}` : `<@${id}>`;
    })
    .replace(CHANNEL_MENTION, (_match, id: string, fallbackName?: string) => {
      const name = channels.get(id)?.name ?? fallbackName;
      return name ? `#${name}` : `<#${id}>`;
    });
}
