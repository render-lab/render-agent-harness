import type { LocalToolHandler } from "@render-harness/core";
import { type RetryOptions, WebClient } from "@slack/web-api";

export type SlackAccessMode = "read" | "read_write";

// @slack/web-api defaults to `tenRetriesInAboutThirtyMinutes` and no per-request
// timeout, which means a single rate-limited or transient-failure response can
// hang a tool call for up to 30 minutes with no surfaced progress. We replace
// that with a bounded retry policy + 15s per-request timeout so the agent gets a
// clear error within ~70s worst case instead of appearing stuck forever.
const SLACK_REQUEST_TIMEOUT_MS = 15_000;
const BOUNDED_RETRY_CONFIG: RetryOptions = {
  retries: 3,
  factor: 2,
  minTimeout: 500,
  maxTimeout: 3_000,
};

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
  /** Look up a user by ID. Backed by `users.info`, cached for the agent process. */
  user: (id: string) => Promise<ResolvedUser>;
  /** Look up a channel by ID. Backed by `conversations.info`, cached for the agent process. */
  channel: (id: string) => Promise<ResolvedChannel>;
  /**
   * Resolve a channel input — either a raw Slack ID (`C…` / `G…` / `D…`),
   * a `#channel-name` string, or an `@user-handle` string (which opens or
   * reuses a DM channel). Returns the canonical channel ID for `chat.*` /
   * `conversations.*` calls. Lazy-fetches `conversations.list` and
   * `users.list` and caches by name/handle for subsequent lookups.
   */
  channelInput: (input: string) => Promise<string>;
  /**
   * Resolve a user input — either a raw `U…` ID or an `@handle` string
   * (with or without the leading `@`). Returns the user ID. Lazy-fetches
   * `users.list` and caches by handle.
   */
  userInput: (input: string) => Promise<string>;
}

// Slack channel/user/DM IDs are always `<prefix><A-Z0-9>+`; channel names
// are restricted to lowercase letters / digits / `-` / `_`, so an input
// that matches one of these patterns is unambiguously an ID. The {2,}
// lower bound is intentionally loose so short test fixtures (`C123`) work
// the same as real-world ids (`C0AQHA6M3PS`).
const CHANNEL_ID_PATTERN = /^[CGD][A-Z0-9]{2,}$/;
const USER_ID_PATTERN = /^U[A-Z0-9]{2,}$/;

export function slackTools(args: {
  botToken: string;
  accessMode: SlackAccessMode;
  allowedChannels?: string[];
}): LocalToolHandler[] {
  const client = new WebClient(args.botToken, {
    timeout: SLACK_REQUEST_TIMEOUT_MS,
    retryConfig: BOUNDED_RETRY_CONFIG,
  });
  const resolver = createResolver(client);

  const tools: LocalToolHandler[] = [
    jsonTool(
      "slack.get_thread",
      "Read a Slack thread's messages. `channel` accepts a Slack ID (C…/G…/D…), a `#channel-name`, or an `@user-handle` (opens a DM). Responses include resolved user display names and a rewritten text_resolved field.",
      objectSchema({
        channel: { type: "string" },
        thread_ts: { type: "string" },
      }),
      async (input) => {
        const { channel, thread_ts } = input as { channel: string; thread_ts: string };
        const channelId = await resolver.channelInput(channel);
        assertAllowedChannel(channelId, args.allowedChannels);
        const resp = await client.conversations.replies({ channel: channelId, ts: thread_ts });
        return enrichConversationResponse(resp, channelId, resolver);
      },
    ),
    jsonTool(
      "slack.get_channel_history",
      "Read recent Slack channel messages. `channel` accepts a Slack ID (C…/G…/D…), a `#channel-name`, or an `@user-handle` (opens a DM). Responses include resolved user display names and a rewritten text_resolved field.",
      objectSchema({
        channel: { type: "string" },
        limit: { type: "number", optional: true },
      }),
      async (input) => {
        const { channel, limit } = input as { channel: string; limit?: number };
        const channelId = await resolver.channelInput(channel);
        assertAllowedChannel(channelId, args.allowedChannels);
        const resp = await client.conversations.history({
          channel: channelId,
          limit: limit ?? 20,
        });
        return enrichConversationResponse(resp, channelId, resolver);
      },
    ),
    jsonTool(
      "slack.get_user_info",
      "Resolve a Slack user to display name, real name, and handle. Accepts a user ID (U0B4357MH7H), an `@handle`, or a bare handle.",
      objectSchema({
        user: { type: "string" },
      }),
      async (input) => {
        const { user } = input as { user: string };
        const userId = await resolver.userInput(user);
        return resolver.user(userId);
      },
    ),
    jsonTool(
      "slack.get_channel_info",
      "Resolve a Slack channel to name and metadata. Accepts a channel ID (C0AQHA6M3PS), a `#channel-name`, or an `@user-handle` (opens a DM).",
      objectSchema({
        channel: { type: "string" },
      }),
      async (input) => {
        const { channel } = input as { channel: string };
        const channelId = await resolver.channelInput(channel);
        assertAllowedChannel(channelId, args.allowedChannels);
        return resolver.channel(channelId);
      },
    ),
  ];

  if (args.accessMode === "read_write") {
    tools.push(
      jsonTool(
        "slack.send_message",
        "Send a Slack message, optionally as a thread reply. `channel` accepts a Slack ID (C…/G…/D…), a `#channel-name`, or an `@user-handle` (opens a DM).",
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
          const channelId = await resolver.channelInput(channel);
          assertAllowedChannel(channelId, args.allowedChannels);
          return client.chat.postMessage({
            channel: channelId,
            text,
            ...(thread_ts ? { thread_ts } : {}),
          });
        },
      ),
      jsonTool(
        "slack.add_reaction",
        "Add a reaction to a Slack message. `channel` accepts a Slack ID, a `#channel-name`, or an `@user-handle`.",
        objectSchema({
          channel: { type: "string" },
          ts: { type: "string" },
          name: { type: "string" },
        }),
        async (input) => {
          const { channel, ts, name } = input as { channel: string; ts: string; name: string };
          const channelId = await resolver.channelInput(channel);
          assertAllowedChannel(channelId, args.allowedChannels);
          return client.reactions.add({ channel: channelId, timestamp: ts, name });
        },
      ),
      jsonTool(
        "slack.update_message",
        "Update a Slack message. `channel` accepts a Slack ID, a `#channel-name`, or an `@user-handle`.",
        objectSchema({
          channel: { type: "string" },
          ts: { type: "string" },
          text: { type: "string" },
        }),
        async (input) => {
          const { channel, ts, text } = input as { channel: string; ts: string; text: string };
          const channelId = await resolver.channelInput(channel);
          assertAllowedChannel(channelId, args.allowedChannels);
          return client.chat.update({ channel: channelId, ts, text });
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

  // Name → ID indexes for reverse lookup. Populated lazily by
  // `ensureChannelsIndex` / `ensureUsersIndex` (which page through
  // `conversations.list` / `users.list` once and cache the full map for
  // the lifetime of this resolver — i.e. the agent process). DM channel
  // ids opened via `conversations.open` are written back into `dmByUserId`
  // so repeated `@handle` sends only hit the API once.
  let channelsIndex: Promise<Map<string, string>> | null = null;
  let usersIndex: Promise<Map<string, string>> | null = null;
  const dmByUserId = new Map<string, string>();

  const ensureChannelsIndex = (): Promise<Map<string, string>> => {
    if (channelsIndex) return channelsIndex;
    channelsIndex = (async () => {
      const byName = new Map<string, string>();
      let cursor: string | undefined;
      do {
        const resp = (await client.conversations.list({
          limit: 1000,
          types: "public_channel,private_channel",
          exclude_archived: true,
          ...(cursor ? { cursor } : {}),
        })) as unknown as {
          channels?: Array<{ id?: unknown; name?: unknown }>;
          response_metadata?: { next_cursor?: unknown };
        };
        for (const c of resp.channels ?? []) {
          if (typeof c.id === "string" && typeof c.name === "string") {
            byName.set(c.name.toLowerCase(), c.id);
            // Also warm the by-ID resolver cache so a later
            // `slack.get_channel_info` lookup is a hit.
            if (!channels.has(c.id)) channels.set(c.id, { id: c.id, name: c.name });
          }
        }
        cursor =
          typeof resp.response_metadata?.next_cursor === "string" &&
          resp.response_metadata.next_cursor.length > 0
            ? resp.response_metadata.next_cursor
            : undefined;
      } while (cursor);
      return byName;
    })().catch((err) => {
      // Reset on failure so a subsequent lookup retries (e.g. once
      // `channels:read` scope is added without the agent restarting).
      channelsIndex = null;
      throw err;
    });
    return channelsIndex;
  };

  const ensureUsersIndex = (): Promise<Map<string, string>> => {
    if (usersIndex) return usersIndex;
    usersIndex = (async () => {
      const byHandle = new Map<string, string>();
      let cursor: string | undefined;
      do {
        const resp = (await client.users.list({
          limit: 200,
          ...(cursor ? { cursor } : {}),
        })) as unknown as {
          members?: Array<{
            id?: unknown;
            name?: unknown;
            real_name?: unknown;
            profile?: { display_name?: unknown; display_name_normalized?: unknown };
            deleted?: unknown;
          }>;
          response_metadata?: { next_cursor?: unknown };
        };
        for (const u of resp.members ?? []) {
          if (typeof u.id !== "string" || u.deleted === true) continue;
          // Index every name variant the agent might use. Slack handles
          // are unique, but display names + real names can collide — last
          // writer wins, which is acceptable for an LLM hint.
          for (const candidate of [
            u.name,
            u.real_name,
            u.profile?.display_name,
            u.profile?.display_name_normalized,
          ]) {
            if (typeof candidate === "string" && candidate.length > 0) {
              byHandle.set(candidate.toLowerCase(), u.id);
            }
          }
          if (!users.has(u.id)) {
            users.set(u.id, buildResolvedUser(u.id, u as unknown as Record<string, unknown>));
          }
        }
        cursor =
          typeof resp.response_metadata?.next_cursor === "string" &&
          resp.response_metadata.next_cursor.length > 0
            ? resp.response_metadata.next_cursor
            : undefined;
      } while (cursor);
      return byHandle;
    })().catch((err) => {
      usersIndex = null;
      throw err;
    });
    return usersIndex;
  };

  const openDmFor = async (userId: string): Promise<string> => {
    const cached = dmByUserId.get(userId);
    if (cached) return cached;
    const resp = (await client.conversations.open({ users: userId })) as unknown as {
      channel?: { id?: unknown };
    };
    const channelId = resp.channel?.id;
    if (typeof channelId !== "string") {
      throw new Error(`conversations.open for ${userId} returned no channel id`);
    }
    dmByUserId.set(userId, channelId);
    return channelId;
  };

  const resolveUserInput = async (input: string): Promise<string> => {
    const trimmed = input.trim();
    if (trimmed.length === 0) throw new Error("Slack user input is empty");
    // Accept Slack's `<@U123>` mention wrapping verbatim.
    const mention = /^<@(U[A-Z0-9]+)(?:\|[^>]+)?>$/.exec(trimmed);
    if (mention?.[1]) return mention[1];
    if (USER_ID_PATTERN.test(trimmed)) return trimmed;
    const handle = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
    if (handle.length === 0) throw new Error("Slack user input has no handle after '@'");
    const index = await ensureUsersIndex();
    const id = index.get(handle.toLowerCase());
    if (!id) {
      throw new Error(
        `Slack user "${input}" not found. Check the handle, or ensure the bot has 'users:read' scope.`,
      );
    }
    return id;
  };

  const resolveChannelInput = async (input: string): Promise<string> => {
    const trimmed = input.trim();
    if (trimmed.length === 0) throw new Error("Slack channel input is empty");
    // Accept Slack's `<#C123|name>` mention wrapping verbatim.
    const mention = /^<#([CGD][A-Z0-9]+)(?:\|[^>]+)?>$/.exec(trimmed);
    if (mention?.[1]) return mention[1];
    if (CHANNEL_ID_PATTERN.test(trimmed)) return trimmed;
    if (trimmed.startsWith("@")) {
      const userId = await resolveUserInput(trimmed);
      return openDmFor(userId);
    }
    const name = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
    if (name.length === 0) throw new Error("Slack channel input has no name after '#'");
    const index = await ensureChannelsIndex();
    const id = index.get(name.toLowerCase());
    if (!id) {
      throw new Error(
        `Slack channel "${input}" not found. Check the name, or ensure the bot has 'channels:read' / 'groups:read' scope and is a member of the channel.`,
      );
    }
    return id;
  };

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
    channelInput: resolveChannelInput,
    userInput: resolveUserInput,
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
