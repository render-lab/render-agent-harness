import { describe, expect, it, vi } from "vitest";
import pack from "./index.js";
import { slackTools } from "./tools.js";

vi.mock("@slack/web-api", () => {
  const usersInfo = vi.fn(async ({ user }: { user: string }) => {
    const fixtures: Record<string, Record<string, unknown>> = {
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
    return { ok: true, user: fixtures[user] ?? { id: user } };
  });
  const channelsInfo = vi.fn(async ({ channel }: { channel: string }) => {
    const fixtures: Record<string, Record<string, unknown>> = {
      C123: { id: "C123", name: "raph-agent-build-diagnostics" },
      C999: { id: "C999", name: "other-channel" },
    };
    return { ok: true, channel: fixtures[channel] ?? { id: channel } };
  });
  class WebClient {
    users = { info: usersInfo };
    conversations = {
      info: channelsInfo,
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
    chat = { postMessage: vi.fn(), update: vi.fn() };
    reactions = { add: vi.fn() };
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
