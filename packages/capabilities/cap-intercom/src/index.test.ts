import { createHmac } from "node:crypto";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import pack, { INTERCOM_PROVIDER_ID, intercomConversationId, intercomRunId } from "./index.js";

function ctx(config: Record<string, unknown> = {}, env: Record<string, string | undefined> = {}) {
  return {
    config,
    env: (name: string) => env[name],
    entryName: "test-bundle",
  };
}

describe("cap-intercom pack metadata", () => {
  it("declares env schema for OAuth client id/secret + encryption key", () => {
    const names = (pack.envSchema ?? []).map((e) => e.name).sort();
    expect(names).toEqual(
      [
        "CONNECTIONS_ENCRYPTION_KEY",
        "INTERCOM_OAUTH_CLIENT_ID",
        "INTERCOM_OAUTH_CLIENT_SECRET",
      ].sort(),
    );
  });

  it("marks client id as non-secret; client secret + key as secret", () => {
    const schema = pack.envSchema ?? [];
    expect(schema.find((e) => e.name === "INTERCOM_OAUTH_CLIENT_ID")?.secret).toBe(false);
    expect(schema.find((e) => e.name === "INTERCOM_OAUTH_CLIENT_SECRET")?.secret).toBe(true);
    expect(schema.find((e) => e.name === "CONNECTIONS_ENCRYPTION_KEY")?.secret).toBe(true);
  });

  it("declares connectionsRequired for the intercom provider", () => {
    expect(pack.connectionsRequired).toEqual([{ provider: INTERCOM_PROVIDER_ID, scopes: [] }]);
  });
});

describe("cap-intercom OAuth provider", () => {
  it("registers exactly one provider with the Intercom OAuth URLs", () => {
    const providers = pack.oauthProviders?.(ctx({}));
    expect(providers).toHaveLength(1);
    const p = providers?.[0];
    if (!p) throw new Error("no provider");
    expect(p.id).toBe("intercom");
    expect(p.displayName).toBe("Intercom");
    expect(p.authorizeUrl).toBe("https://app.intercom.com/oauth");
    expect(p.tokenUrl).toBe("https://api.intercom.io/auth/eagle/token");
    expect(p.clientIdEnv).toBe("INTERCOM_OAUTH_CLIENT_ID");
    expect(p.clientSecretEnv).toBe("INTERCOM_OAUTH_CLIENT_SECRET");
    expect(p.defaultScopes).toEqual([]);
  });

  it("honors clientIdEnv / clientSecretEnv overrides", () => {
    const providers = pack.oauthProviders?.(
      ctx({ clientIdEnv: "MY_IC_ID", clientSecretEnv: "MY_IC_SECRET" }),
    );
    const p = providers?.[0];
    expect(p?.clientIdEnv).toBe("MY_IC_ID");
    expect(p?.clientSecretEnv).toBe("MY_IC_SECRET");
  });
});

describe("cap-intercom tool surface", () => {
  it("ships 7 tools in read_write mode (default)", () => {
    const tools = pack.localTools?.(ctx({}));
    expect(tools).toHaveLength(7);
    const names = (tools ?? []).map((t) => t.definition.name).sort();
    expect(names).toEqual(
      [
        "read_conversation",
        "list_recent_conversations",
        "reply",
        "assign",
        "add_tag",
        "close",
        "snooze",
      ].sort(),
    );
  });

  it("ships 2 read-only tools in read mode", () => {
    const tools = pack.localTools?.(ctx({ accessMode: "read" }));
    const names = (tools ?? []).map((t) => t.definition.name).sort();
    expect(names).toEqual(["list_recent_conversations", "read_conversation"]);
  });

  it("every tool's source is namespaced under pack:cap-intercom", () => {
    const tools = pack.localTools?.(ctx({})) ?? [];
    for (const t of tools) {
      expect(t.definition.source).toBe("pack:cap-intercom");
    }
  });
});

describe("cap-intercom skills", () => {
  it("ships the intercom-support skill with a reachable contentPath", () => {
    const skills = pack.skills?.(ctx({})) ?? [];
    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe("intercom-support");
    expect(existsSync(skills[0]?.contentPath ?? "")).toBe(true);
  });
});

describe("cap-intercom connector mounting", () => {
  it("registers a connector at /connectors/intercom", () => {
    const conns = pack.connectors?.(ctx({}));
    expect(conns).toHaveLength(1);
    expect(conns?.[0]?.key).toBe("intercom");
  });

  it("returns 500 when the OAuth client secret env var is unset", async () => {
    const conns = pack.connectors?.(ctx({}, {})) ?? [];
    const c = conns[0];
    if (!c) throw new Error("connector missing");
    const res = await c.webhook(new Request("http://test/", { method: "POST" }), {
      pool: null as never,
      logger: null as never,
      config: {},
      resolveAgent: () => ({ name: "x", version: "0" }) as never,
      enqueueRun: async () => ({ status: "enqueued", runId: "r" as never }),
      enqueueIntoConversation: async () => ({ status: "enqueued", runId: "r" as never }) as never,
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toMatchObject({ error: "missing_secret" });
  });

  it("returns 401 on a tampered signature", async () => {
    const conns = pack.connectors?.(ctx({}, { INTERCOM_OAUTH_CLIENT_SECRET: "secret" })) ?? [];
    const c = conns[0];
    if (!c) throw new Error("connector missing");
    const body = JSON.stringify({ topic: "conversation.user.created" });
    const res = await c.webhook(
      new Request("http://test/", {
        method: "POST",
        headers: { "x-hub-signature": "sha1=deadbeef" },
        body,
      }),
      {
        pool: null as never,
        logger: null as never,
        config: {},
        resolveAgent: () => ({ name: "x", version: "0" }) as never,
        enqueueRun: async () => ({ status: "enqueued", runId: "r" as never }),
        enqueueIntoConversation: async () => ({ status: "enqueued", runId: "r" as never }) as never,
      },
    );
    expect(res.status).toBe(401);
  });

  it("enqueues a run with the right conversation id and metadata on a valid delivery", async () => {
    const secret = "good-secret";
    const payload = {
      type: "notification_event",
      topic: "conversation.user.replied",
      app_id: "ws-42",
      id: "notif-99",
      delivery_attempts: 1,
      data: {
        item: {
          id: "conv-7",
          type: "conversation",
          state: "open",
          source: {
            body: "<p>Hello back.</p>",
            author: { name: "Alice" },
          },
        },
      },
    };
    const rawBody = JSON.stringify(payload);
    const signature = `sha1=${createHmac("sha1", secret).update(rawBody).digest("hex")}`;
    const conns =
      pack.connectors?.(ctx({ userId: "u-1" }, { INTERCOM_OAUTH_CLIENT_SECRET: secret })) ?? [];
    const c = conns[0];
    if (!c) throw new Error("connector missing");

    let enqueueArgs:
      | Parameters<
          Parameters<NonNullable<typeof pack.connectors>>[0] extends never ? never : never
        >[0]
      | null = null;
    const res = await c.webhook(
      new Request("http://test/", {
        method: "POST",
        headers: { "x-hub-signature": signature },
        body: rawBody,
      }),
      {
        pool: null as never,
        logger: null as never,
        config: {},
        resolveAgent: () => ({ name: "support-bot", version: "0.1.0" }) as never,
        enqueueRun: async () => ({ status: "enqueued", runId: "r" as never }),
        enqueueIntoConversation: async (args) => {
          enqueueArgs = args as never;
          return {
            status: "enqueued",
            runId: args.runId ?? ("r" as never),
            conversationId: args.conversationId,
          };
        },
      },
    );
    expect(res.status).toBe(202);
    expect(enqueueArgs).not.toBeNull();
    const a = enqueueArgs as never as {
      conversationId: string;
      runId: string;
      userId: string;
      agentName: string;
      metadata: Record<string, unknown>;
    };
    expect(a.conversationId).toBe(
      intercomConversationId({ workspaceId: "ws-42", conversationId: "conv-7" }),
    );
    expect(a.runId).toBe(
      intercomRunId({ workspaceId: "ws-42", conversationId: "conv-7", notificationId: "notif-99" }),
    );
    expect(a.userId).toBe("u-1");
    expect(a.agentName).toBe("support-bot");
    expect(a.metadata).toMatchObject({
      connector: "cap-intercom",
      topic: "conversation.user.replied",
      workspaceId: "ws-42",
      intercomConversationId: "conv-7",
      notificationId: "notif-99",
    });
  });

  it("idempotency: re-delivery with same notification id produces the same deterministic runId", () => {
    const a = intercomRunId({
      workspaceId: "ws-1",
      conversationId: "c-1",
      notificationId: "n-1",
    });
    const b = intercomRunId({
      workspaceId: "ws-1",
      conversationId: "c-1",
      notificationId: "n-1",
    });
    expect(a).toBe(b);

    // different notification id → different runId
    const c = intercomRunId({
      workspaceId: "ws-1",
      conversationId: "c-1",
      notificationId: "n-2",
    });
    expect(a).not.toBe(c);
  });

  it("returns 200 + skipped on a noop payload (e.g. ping)", async () => {
    const secret = "good-secret";
    const rawBody = JSON.stringify({ type: "ping" });
    const signature = `sha1=${createHmac("sha1", secret).update(rawBody).digest("hex")}`;
    const conns = pack.connectors?.(ctx({}, { INTERCOM_OAUTH_CLIENT_SECRET: secret })) ?? [];
    const c = conns[0];
    if (!c) throw new Error("connector missing");
    const res = await c.webhook(
      new Request("http://test/", {
        method: "POST",
        headers: { "x-hub-signature": signature },
        body: rawBody,
      }),
      {
        pool: null as never,
        logger: null as never,
        config: {},
        resolveAgent: () => ({ name: "x", version: "0" }) as never,
        enqueueRun: async () => ({ status: "enqueued", runId: "r" as never }),
        enqueueIntoConversation: async () => ({ status: "enqueued", runId: "r" as never }) as never,
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ skipped: true, reason: "ping" });
  });
});
