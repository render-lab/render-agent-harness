import { afterEach, describe, expect, it, vi } from "vitest";
import pack from "./index.js";
import { slackTools } from "./tools.js";

// Shared mock fn refs between the mock factory and the tests, hoisted so
// `vi.mock` (which itself runs in a hoisted phase before imports) can see
// them. Tests inspect `slackMocks.chat.postMessage.mock.calls` etc. to
// assert the underlying Slack Web API was called with the resolved IDs.
const slackMocks = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    chat: { postMessage: fn(), update: fn() },
    conversations: { open: fn(), list: fn() },
    reactions: { add: fn() },
  };
});

// Reset every shared slackMock back to its default behavior after each
// test so tests that swap in failure-case implementations (missing_scope,
// not_in_channel, etc.) don't leak into subsequent assertions.
afterEach(() => {
  slackMocks.conversations.list.mockReset();
  slackMocks.conversations.list.mockImplementation(async ({ types }: { types?: string } = {}) => {
    if (types === "private_channel") {
      return { ok: true, channels: [] };
    }
    return {
      ok: true,
      channels: [
        { id: "C123", name: "raph-agent-build-diagnostics" },
        { id: "C999", name: "other-channel" },
      ],
    };
  });
  slackMocks.conversations.open.mockReset();
  slackMocks.conversations.open.mockImplementation(async ({ users: u }: { users: string }) => ({
    ok: true,
    channel: { id: `D-${u}` },
  }));
  slackMocks.chat.postMessage.mockReset();
  slackMocks.chat.postMessage.mockResolvedValue({ ok: true, ts: "1.0", channel: "C123" });
  slackMocks.chat.update.mockReset();
  slackMocks.chat.update.mockResolvedValue({ ok: true, ts: "1.0" });
  slackMocks.reactions.add.mockReset();
  slackMocks.reactions.add.mockResolvedValue({ ok: true });
});

vi.mock("@slack/web-api", () => {
  const USER_FIXTURES: Record<string, Record<string, unknown>> = {
    U111: {
      id: "U111",
      name: "ada",
      real_name: "Ada Lovelace",
      profile: { display_name: "ada.l", real_name: "Ada Lovelace" },
    },
    U222: {
      id: "U222",
      name: "grace",
      real_name: "Grace Hopper",
      profile: { display_name: "", real_name: "Grace Hopper" },
      is_bot: false,
    },
  };
  const CHANNEL_FIXTURES: Record<string, Record<string, unknown>> = {
    C123: { id: "C123", name: "raph-agent-build-diagnostics" },
    C999: { id: "C999", name: "other-channel" },
  };
  const usersInfo = vi.fn(async ({ user }: { user: string }) => ({
    ok: true,
    user: USER_FIXTURES[user] ?? { id: user },
  }));
  const usersList = vi.fn(async () => ({
    ok: true,
    members: Object.values(USER_FIXTURES),
  }));
  const channelsInfo = vi.fn(async ({ channel }: { channel: string }) => ({
    ok: true,
    channel: CHANNEL_FIXTURES[channel] ?? { id: channel },
  }));
  // Per-type-list mock so tests can simulate bots that have channels:read
  // (public_channel succeeds) but not groups:read (private_channel throws
  // missing_scope). Tests override slackMocks.conversations.list to swap
  // in failure cases.
  slackMocks.conversations.list.mockImplementation(async ({ types }: { types?: string } = {}) => {
    if (types === "private_channel") {
      return { ok: true, channels: [] };
    }
    return { ok: true, channels: Object.values(CHANNEL_FIXTURES) };
  });
  slackMocks.conversations.open.mockImplementation(async ({ users: u }: { users: string }) => ({
    ok: true,
    channel: { id: `D-${u}` },
  }));
  slackMocks.chat.postMessage.mockResolvedValue({ ok: true, ts: "1.0", channel: "C123" });
  slackMocks.chat.update.mockResolvedValue({ ok: true, ts: "1.0" });
  slackMocks.reactions.add.mockResolvedValue({ ok: true });
  class WebClient {
    users = { info: usersInfo, list: usersList };
    conversations = {
      info: channelsInfo,
      list: slackMocks.conversations.list,
      open: slackMocks.conversations.open,
      history: vi.fn(async () => ({
        ok: true,
        messages: [
          { user: "U111", text: "hello <@U222> please check <#C999|other-channel>", ts: "1.0" },
          { user: "U222", text: "ack", ts: "2.0" },
        ],
      })),
      replies: vi.fn(async () => ({
        ok: true,
        messages: [
          { user: "U222", text: "thread reply from <@U111>", ts: "3.0", thread_ts: "1.0" },
        ],
      })),
    };
    chat = slackMocks.chat;
    reactions = slackMocks.reactions;
  }
  return { WebClient };
});

describe("slackTools", () => {
  it("registers read tools by default", () => {
    const names = slackTools({ botToken: "xoxb-test", accessMode: "read" }).map(
      (tool) => tool.definition.name,
    );
    expect(names).toEqual([
      "slack.get_thread",
      "slack.get_channel_history",
      "slack.get_user_info",
      "slack.get_channel_info",
    ]);
  });

  it("registers write tools in read_write mode", () => {
    const names = slackTools({ botToken: "xoxb-test", accessMode: "read_write" }).map(
      (tool) => tool.definition.name,
    );
    expect(names).toContain("slack.send_message");
    expect(names).toContain("slack.add_reaction");
    expect(names).toContain("slack.update_message");
  });
});

describe("slack read tools (enrichment)", () => {
  it("enriches channel history with resolved user names and rewritten mentions", async () => {
    const tools = slackTools({ botToken: "xoxb-test", accessMode: "read" });
    const history = tools.find((t) => t.definition.name === "slack.get_channel_history");
    if (!history) throw new Error("missing slack.get_channel_history");
    const result = await history.handler({
      input: { channel: "C123", limit: 10 },
      ctx: {},
    } as never);
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content);
    expect(parsed.resolved_channel).toEqual({ id: "C123", name: "raph-agent-build-diagnostics" });
    expect(parsed.resolved_users.U111).toMatchObject({ display_name: "ada.l" });
    expect(parsed.resolved_users.U222).toMatchObject({ real_name: "Grace Hopper" });
    expect(parsed.messages[0].user_display_name).toBe("ada.l");
    expect(parsed.messages[0].text_resolved).toBe(
      "hello @Grace Hopper please check #other-channel",
    );
    expect(parsed.messages[1].user_display_name).toBe("Grace Hopper");
  });

  it("resolves a Slack user ID via slack.get_user_info", async () => {
    const tools = slackTools({ botToken: "xoxb-test", accessMode: "read" });
    const lookup = tools.find((t) => t.definition.name === "slack.get_user_info");
    if (!lookup) throw new Error("missing slack.get_user_info");
    const result = await lookup.handler({ input: { user: "U111" }, ctx: {} } as never);
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content)).toMatchObject({
      id: "U111",
      display_name: "ada.l",
      real_name: "Ada Lovelace",
      name: "ada",
    });
  });

  it("resolves a Slack channel ID via slack.get_channel_info", async () => {
    const tools = slackTools({ botToken: "xoxb-test", accessMode: "read" });
    const lookup = tools.find((t) => t.definition.name === "slack.get_channel_info");
    if (!lookup) throw new Error("missing slack.get_channel_info");
    const result = await lookup.handler({ input: { channel: "C123" }, ctx: {} } as never);
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content)).toEqual({
      id: "C123",
      name: "raph-agent-build-diagnostics",
    });
  });

  it("rejects slack.get_channel_info for channels outside allowedChannels", async () => {
    const tools = slackTools({
      botToken: "xoxb-test",
      accessMode: "read",
      allowedChannels: ["C123"],
    });
    const lookup = tools.find((t) => t.definition.name === "slack.get_channel_info");
    if (!lookup) throw new Error("missing slack.get_channel_info");
    const result = await lookup.handler({ input: { channel: "C999" }, ctx: {} } as never);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not allowed");
  });
});

describe("name → id resolution", () => {
  it("slack.get_channel_info accepts a #channel-name and looks up via conversations.list", async () => {
    const tools = slackTools({ botToken: "xoxb-test", accessMode: "read" });
    const lookup = tools.find((t) => t.definition.name === "slack.get_channel_info");
    if (!lookup) throw new Error("missing slack.get_channel_info");
    const result = await lookup.handler({
      input: { channel: "#raph-agent-build-diagnostics" },
      ctx: {},
    } as never);
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content)).toEqual({
      id: "C123",
      name: "raph-agent-build-diagnostics",
    });
  });

  it("slack.get_user_info accepts an @handle and resolves to the user ID", async () => {
    const tools = slackTools({ botToken: "xoxb-test", accessMode: "read" });
    const lookup = tools.find((t) => t.definition.name === "slack.get_user_info");
    if (!lookup) throw new Error("missing slack.get_user_info");
    const result = await lookup.handler({ input: { user: "@ada.l" }, ctx: {} } as never);
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content)).toMatchObject({ id: "U111", display_name: "ada.l" });
  });

  it("slack.get_user_info accepts a bare handle (no @)", async () => {
    const tools = slackTools({ botToken: "xoxb-test", accessMode: "read" });
    const lookup = tools.find((t) => t.definition.name === "slack.get_user_info");
    if (!lookup) throw new Error("missing slack.get_user_info");
    const result = await lookup.handler({ input: { user: "ada" }, ctx: {} } as never);
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content)).toMatchObject({ id: "U111" });
  });

  it("slack.send_message accepts #channel-name and posts to the resolved ID", async () => {
    slackMocks.chat.postMessage.mockClear();
    const tools = slackTools({ botToken: "xoxb-test", accessMode: "read_write" });
    const send = tools.find((t) => t.definition.name === "slack.send_message");
    if (!send) throw new Error("missing slack.send_message");
    const result = await send.handler({
      input: { channel: "#raph-agent-build-diagnostics", text: "hi" },
      ctx: {},
    } as never);
    expect(result.isError).toBeFalsy();
    expect(slackMocks.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "C123", text: "hi" }),
    );
  });

  it("slack.send_message accepts @user-handle and opens a DM channel before posting", async () => {
    slackMocks.chat.postMessage.mockClear();
    slackMocks.conversations.open.mockClear();
    const tools = slackTools({ botToken: "xoxb-test", accessMode: "read_write" });
    const send = tools.find((t) => t.definition.name === "slack.send_message");
    if (!send) throw new Error("missing slack.send_message");
    const result = await send.handler({
      input: { channel: "@ada.l", text: "dm me" },
      ctx: {},
    } as never);
    expect(result.isError).toBeFalsy();
    expect(slackMocks.conversations.open).toHaveBeenCalledWith(
      expect.objectContaining({ users: "U111" }),
    );
    expect(slackMocks.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "D-U111", text: "dm me" }),
    );
  });

  it("returns a clear error when a #channel-name is not found", async () => {
    const tools = slackTools({ botToken: "xoxb-test", accessMode: "read_write" });
    const send = tools.find((t) => t.definition.name === "slack.send_message");
    if (!send) throw new Error("missing slack.send_message");
    const result = await send.handler({
      input: { channel: "#does-not-exist", text: "x" },
      ctx: {},
    } as never);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/not found/);
    expect(result.content).toMatch(/channels:read/);
  });

  // Regression: bots with only `channels:read` (not `groups:read`) used
  // to get missing_scope on every name lookup because the resolver
  // requested both channel kinds in a single `conversations.list` call.
  // Now we list each kind independently; the public_channel call
  // succeeds, the private_channel call fails (caught), and the public
  // channel name still resolves to its ID. See May 2026 incident
  // documented in AGENTS.md "Things that bit us recently".
  it("name lookup succeeds for public channels when private_channel list fails (channels:read only)", async () => {
    slackMocks.conversations.list.mockReset();
    slackMocks.conversations.list.mockImplementation(async ({ types }: { types?: string } = {}) => {
      if (types === "private_channel") {
        const err = new Error("An API error occurred: missing_scope") as Error & {
          data?: Record<string, unknown>;
        };
        err.data = {
          ok: false,
          error: "missing_scope",
          needed: "groups:read",
          provided: "chat:write,channels:read",
        };
        throw err;
      }
      return {
        ok: true,
        channels: [{ id: "C123", name: "raph-agent-build-diagnostics" }],
      };
    });
    const tools = slackTools({ botToken: "xoxb-test", accessMode: "read" });
    const lookup = tools.find((t) => t.definition.name === "slack.get_channel_info");
    if (!lookup) throw new Error("missing slack.get_channel_info");
    const result = await lookup.handler({
      input: { channel: "#raph-agent-build-diagnostics" },
      ctx: {},
    } as never);
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content)).toEqual({
      id: "C123",
      name: "raph-agent-build-diagnostics",
    });
  });

  it("surfaces an actionable missing_scope error when ALL channel kinds fail", async () => {
    slackMocks.conversations.list.mockReset();
    slackMocks.conversations.list.mockImplementation(async () => {
      const err = new Error("An API error occurred: missing_scope") as Error & {
        data?: Record<string, unknown>;
      };
      err.data = {
        ok: false,
        error: "missing_scope",
        needed: "channels:read",
        provided: "chat:write",
      };
      throw err;
    });
    const tools = slackTools({ botToken: "xoxb-test", accessMode: "read" });
    const lookup = tools.find((t) => t.definition.name === "slack.get_channel_info");
    if (!lookup) throw new Error("missing slack.get_channel_info");
    const result = await lookup.handler({
      input: { channel: "#anything" },
      ctx: {},
    } as never);
    expect(result.isError).toBe(true);
    // formatSlackError rewrites the generic message into an
    // operator-actionable hint that names the scope to enable.
    expect(result.content).toMatch(/missing_scope/);
    expect(result.content).toMatch(/channels:read/);
    expect(result.content).toMatch(/Add 'channels:read'/);
    expect(result.content).toMatch(/api\.slack\.com/);
  });

  it("formatSlackError rewrites not_in_channel into an invite hint", async () => {
    slackMocks.chat.postMessage.mockReset();
    slackMocks.chat.postMessage.mockImplementation(async () => {
      const err = new Error("An API error occurred: not_in_channel") as Error & {
        data?: Record<string, unknown>;
      };
      err.data = { ok: false, error: "not_in_channel" };
      throw err;
    });
    const tools = slackTools({ botToken: "xoxb-test", accessMode: "read_write" });
    const send = tools.find((t) => t.definition.name === "slack.send_message");
    if (!send) throw new Error("missing slack.send_message");
    const result = await send.handler({
      input: { channel: "C123", text: "x" },
      ctx: {},
    } as never);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/not_in_channel/);
    expect(result.content).toMatch(/\/invite/);
  });

  it("allowedChannels gate runs against the *resolved* ID, not the raw input", async () => {
    const tools = slackTools({
      botToken: "xoxb-test",
      accessMode: "read_write",
      allowedChannels: ["C123"],
    });
    const send = tools.find((t) => t.definition.name === "slack.send_message");
    if (!send) throw new Error("missing slack.send_message");
    // The name resolves to C123 which IS in allowedChannels — should succeed.
    const ok = await send.handler({
      input: { channel: "#raph-agent-build-diagnostics", text: "y" },
      ctx: {},
    } as never);
    expect(ok.isError).toBeFalsy();
    // The name resolves to C999 which is NOT in allowedChannels — should fail.
    const blocked = await send.handler({
      input: { channel: "#other-channel", text: "no" },
      ctx: {},
    } as never);
    expect(blocked.isError).toBe(true);
    expect(blocked.content).toContain("not allowed");
  });
});

describe("cap-slack pack", () => {
  it("skips local tools when SLACK_BOT_TOKEN is missing", async () => {
    const tools = await pack.localTools?.({
      config: {},
      env: () => undefined,
      entryName: "test",
    });
    expect(tools).toEqual([]);
  });
});
