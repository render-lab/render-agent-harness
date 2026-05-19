/**
 * Unit tests for cap-google.
 *
 * Verifies:
 *   - Pack contract: name, version, envSchema, connectionsRequired,
 *     oauthProviders, localTools all populate per the docs.
 *   - accessMode toggles read-only vs read-write tool sets.
 *   - Tool routing: each tool's handler reads the connection from a
 *     stub SecretsContext and calls the right Google REST endpoint with
 *     the right method/body.
 *
 * The Google REST calls are stubbed via the global `fetch` replacement
 * so the tests run offline.
 */

import type { SecretsContext } from "@render-harness/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pack, { GOOGLE_PROVIDER_ID } from "./index.js";
import { buildRfc2822 } from "./tools/gmail.js";

interface RecordedCall {
  url: string;
  method: string;
  body?: string;
  headers?: Record<string, string>;
}

const FAKE_TOKEN = "ya29.test-access-token";

function buildSecrets(): SecretsContext {
  return {
    getConnection: async () => ({
      provider: GOOGLE_PROVIDER_ID,
      accessToken: FAKE_TOKEN,
      expiresAt: new Date(Date.now() + 3600_000),
      scopes: ["https://www.googleapis.com/auth/gmail.modify"],
    }),
    requireConnection: async () => ({
      provider: GOOGLE_PROVIDER_ID,
      accessToken: FAKE_TOKEN,
      expiresAt: new Date(Date.now() + 3600_000),
      scopes: ["https://www.googleapis.com/auth/gmail.modify"],
    }),
  };
}

function installFetchStub(responder: (call: RecordedCall) => Response): RecordedCall[] {
  const recorded: RecordedCall[] = [];
  vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const body = typeof init?.body === "string" ? init.body : undefined;
    const call: RecordedCall = {
      url,
      method,
      ...(body !== undefined ? { body } : {}),
      ...(init?.headers ? { headers: init.headers as Record<string, string> } : {}),
    };
    recorded.push(call);
    return responder(call);
  }) as typeof fetch);
  return recorded;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("cap-google pack contract", () => {
  it("declares name, version, envSchema, connectionsRequired", () => {
    expect(pack.name).toBe("cap-google");
    expect(pack.version).toBeTypeOf("string");
    const envNames = (pack.envSchema ?? []).map((e) => e.name);
    expect(envNames).toContain("GOOGLE_OAUTH_CLIENT_ID");
    expect(envNames).toContain("GOOGLE_OAUTH_CLIENT_SECRET");
    expect(envNames).toContain("CONNECTIONS_ENCRYPTION_KEY");
    expect(pack.connectionsRequired?.[0]?.provider).toBe("google");
  });

  it("contributes a Google OAuth provider with offline access params", async () => {
    if (!pack.oauthProviders) throw new Error("oauthProviders must be defined");
    const providers = await pack.oauthProviders({
      config: {},
      env: (_name) => undefined,
      entryName: "test",
    });
    expect(providers).toHaveLength(1);
    const google = providers[0];
    if (!google) throw new Error("no provider");
    expect(google.id).toBe("google");
    expect(google.authorizeUrl).toContain("accounts.google.com");
    expect(google.extraAuthorizeParams?.access_type).toBe("offline");
    expect(google.extraAuthorizeParams?.prompt).toBe("consent");
    expect(google.defaultScopes).toContain("https://www.googleapis.com/auth/gmail.send");
  });

  it("accessMode=read drops the write tools and narrows scopes", async () => {
    if (!pack.localTools || !pack.oauthProviders) throw new Error("pack hooks missing");
    const ctx = { config: { accessMode: "read" }, env: () => undefined, entryName: "t" };
    const tools = await pack.localTools(ctx);
    const names = tools.map((t) => t.definition.name);
    expect(names).toContain("gmail.search");
    expect(names).toContain("gmail.get_message");
    expect(names).not.toContain("gmail.send");
    expect(names).not.toContain("gmail.modify_labels");
    expect(names).toContain("calendar.list_events");
    expect(names).not.toContain("calendar.create_event");

    const providers = await pack.oauthProviders(ctx);
    expect(providers[0]?.defaultScopes).toContain("https://www.googleapis.com/auth/gmail.readonly");
    expect(providers[0]?.defaultScopes).not.toContain("https://www.googleapis.com/auth/gmail.send");
  });

  it("default accessMode is read_write and contributes 9 tools", async () => {
    if (!pack.localTools) throw new Error("localTools missing");
    const tools = await pack.localTools({
      config: {},
      env: () => undefined,
      entryName: "t",
    });
    const names = tools.map((t) => t.definition.name);
    expect(names).toEqual([
      "gmail.search",
      "gmail.get_message",
      "gmail.send",
      "gmail.modify_labels",
      "calendar.list_events",
      "calendar.get_event",
      "calendar.freebusy",
      "calendar.create_event",
      "calendar.update_event",
      "calendar.delete_event",
    ]);
  });
});

describe("tool routing", () => {
  let tools: Awaited<ReturnType<NonNullable<typeof pack.localTools>>>;

  beforeEach(async () => {
    if (!pack.localTools) throw new Error("localTools missing");
    tools = await pack.localTools({
      config: {},
      env: () => undefined,
      entryName: "t",
    });
  });

  const invoke = async (name: string, input: unknown) => {
    const tool = tools.find((t) => t.definition.name === name);
    if (!tool) throw new Error(`tool ${name} not found`);
    return tool.handler({
      input,
      runId: "test-run",
      toolCallId: "test-call",
      signal: new AbortController().signal,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
        trace: () => {},
        fatal: () => {},
        child: function () {
          return this;
        },
      } as any,
      secrets: buildSecrets(),
    });
  };

  it("gmail.search hits /users/me/messages with the q param and hydrates each id", async () => {
    const calls = installFetchStub((call) => {
      if (call.url.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/messages?")) {
        return Response.json({
          messages: [
            { id: "m1", threadId: "t1" },
            { id: "m2", threadId: "t1" },
          ],
          resultSizeEstimate: 2,
        });
      }
      if (call.url.includes("/users/me/messages/m1")) {
        return Response.json({
          id: "m1",
          threadId: "t1",
          snippet: "hi",
          labelIds: ["INBOX"],
          payload: { headers: [{ name: "Subject", value: "Hello" }] },
        });
      }
      if (call.url.includes("/users/me/messages/m2")) {
        return Response.json({
          id: "m2",
          threadId: "t1",
          snippet: "second",
          labelIds: ["INBOX"],
          payload: { headers: [{ name: "Subject", value: "Re: Hello" }] },
        });
      }
      return new Response("not stubbed", { status: 500 });
    });

    const res = await invoke("gmail.search", { query: "is:unread", max_results: 5 });
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(res.content);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].id).toBe("m1");
    expect(body.messages[0].headers.Subject).toBe("Hello");

    const search = calls[0];
    expect(search?.url).toContain("q=is%3Aunread");
    expect(search?.url).toContain("maxResults=5");
    expect(search?.headers).toMatchObject({ authorization: `Bearer ${FAKE_TOKEN}` });
  });

  it("gmail.send POSTs base64url-encoded RFC2822 to messages/send", async () => {
    const calls = installFetchStub(() =>
      Response.json({ id: "sent-1", threadId: "t-sent", labelIds: ["SENT"] }),
    );

    const res = await invoke("gmail.send", {
      to: "alice@example.com",
      subject: "Hello",
      body: "Test body",
    });
    expect(res.isError).toBeFalsy();
    const call = calls[0];
    expect(call?.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
    expect(call?.method).toBe("POST");
    const parsedBody = JSON.parse(call?.body ?? "{}") as { raw?: string };
    expect(typeof parsedBody.raw).toBe("string");
    const decoded = Buffer.from(
      (parsedBody.raw ?? "").replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf8");
    expect(decoded).toContain("To: alice@example.com");
    expect(decoded).toContain("Subject: Hello");
    expect(decoded).toContain("Test body");
  });

  it("gmail.send threads via thread_id when provided", async () => {
    const calls = installFetchStub(() => Response.json({ id: "x", threadId: "t-99" }));
    await invoke("gmail.send", {
      to: "a@b.com",
      subject: "S",
      body: "B",
      thread_id: "t-99",
    });
    const parsed = JSON.parse(calls[0]?.body ?? "{}");
    expect(parsed.threadId).toBe("t-99");
  });

  it("calendar.list_events defaults to primary calendar and a 7-day window", async () => {
    const calls = installFetchStub(() => Response.json({ items: [] }));
    await invoke("calendar.list_events", {});
    const url = new URL(calls[0]?.url ?? "");
    expect(url.pathname).toBe("/calendar/v3/calendars/primary/events");
    expect(url.searchParams.get("singleEvents")).toBe("true");
    expect(url.searchParams.get("orderBy")).toBe("startTime");
    const tmin = url.searchParams.get("timeMin");
    const tmax = url.searchParams.get("timeMax");
    if (!tmin || !tmax) throw new Error("time bounds missing");
    expect(new Date(tmax).getTime() - new Date(tmin).getTime()).toBeGreaterThan(
      6 * 24 * 3600 * 1000,
    );
  });

  it("calendar.create_event maps fields onto the v3 events.insert payload", async () => {
    const calls = installFetchStub(() => Response.json({ id: "evt-1" }));
    await invoke("calendar.create_event", {
      summary: "Standup",
      start: "2026-06-01T09:00:00-07:00",
      end: "2026-06-01T09:15:00-07:00",
      attendees: ["alice@example.com", "bob@example.com"],
      send_updates: "all",
    });
    expect(calls[0]?.url).toContain("/calendars/primary/events");
    expect(calls[0]?.url).toContain("sendUpdates=all");
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body.summary).toBe("Standup");
    expect(body.start).toEqual({ dateTime: "2026-06-01T09:00:00-07:00" });
    expect(body.attendees).toEqual([{ email: "alice@example.com" }, { email: "bob@example.com" }]);
  });

  it("calendar.freebusy POSTs to /freeBusy with the right items shape", async () => {
    const calls = installFetchStub(() => Response.json({ calendars: { primary: { busy: [] } } }));
    await invoke("calendar.freebusy", {
      time_min: "2026-06-01T00:00:00Z",
      time_max: "2026-06-02T00:00:00Z",
    });
    expect(calls[0]?.url).toBe("https://www.googleapis.com/calendar/v3/freeBusy");
    expect(calls[0]?.method).toBe("POST");
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body.items).toEqual([{ id: "primary" }]);
  });

  it("propagates Google API errors back to the model as is_error tool results", async () => {
    installFetchStub(() =>
      Response.json(
        {
          error: {
            code: 403,
            message: "Insufficient Permission",
            status: "PERMISSION_DENIED",
          },
        },
        { status: 403 },
      ),
    );
    const res = await invoke("gmail.send", {
      to: "x@y.com",
      subject: "s",
      body: "b",
    });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("PERMISSION_DENIED");
    expect(res.content).toContain("Insufficient Permission");
  });

  it("returns is_error when the SecretsContext has no connection", async () => {
    const noConn: SecretsContext = {
      getConnection: async () => null,
      requireConnection: async () => {
        const { NeedsConnectionError } = await import("@render-harness/core");
        throw new NeedsConnectionError("google", ["gmail.readonly"]);
      },
    };
    if (!pack.localTools) throw new Error("localTools missing");
    const ts = await pack.localTools({ config: {}, env: () => undefined, entryName: "t" });
    const tool = ts.find((t) => t.definition.name === "gmail.search");
    if (!tool) throw new Error("tool missing");
    const res = await tool.handler({
      input: { query: "is:unread" },
      runId: "r",
      toolCallId: "c",
      signal: new AbortController().signal,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
        trace: () => {},
        fatal: () => {},
        child: function () {
          return this;
        },
      } as any,
      secrets: noConn,
    });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("/ui/connections");
  });

  it("returns is_error when the harness didn't pass SecretsContext", async () => {
    if (!pack.localTools) throw new Error("localTools missing");
    const ts = await pack.localTools({ config: {}, env: () => undefined, entryName: "t" });
    const tool = ts.find((t) => t.definition.name === "gmail.search");
    if (!tool) throw new Error("tool missing");
    const res = await tool.handler({
      input: {},
      runId: "r",
      toolCallId: "c",
      signal: new AbortController().signal,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
        trace: () => {},
        fatal: () => {},
        child: function () {
          return this;
        },
      } as any,
    });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("connection API");
  });
});

describe("buildRfc2822", () => {
  it("renders headers, MIME parts, and CRLF separators", () => {
    const out = buildRfc2822({
      to: ["a@b.com", "c@d.com"],
      cc: "watcher@example.com",
      subject: "Hello",
      body: "Hi there",
    });
    expect(out).toContain("To: a@b.com, c@d.com\r\n");
    expect(out).toContain("Cc: watcher@example.com\r\n");
    expect(out).toContain("Subject: Hello\r\n");
    expect(out).toContain("MIME-Version: 1.0\r\n");
    expect(out.endsWith("Hi there")).toBe(true);
  });

  it("RFC2047-encodes non-ASCII subjects", () => {
    const out = buildRfc2822({
      to: "a@b.com",
      subject: "café",
      body: "x",
    });
    expect(out).toMatch(/Subject: =\?UTF-8\?B\?Y2Fmw6k=\?=/);
  });

  it("threads via In-Reply-To when reply_to_message_id is set", () => {
    const out = buildRfc2822({
      to: "a@b.com",
      subject: "Re: x",
      body: "y",
      reply_to_message_id: "<orig@example.com>",
    });
    expect(out).toContain("In-Reply-To: <orig@example.com>");
    expect(out).toContain("References: <orig@example.com>");
  });
});

describe("cap-google surfaces config (Drive / Docs / Sheets expansion)", () => {
  it("default surfaces are [gmail, calendar] — existing users see no change", async () => {
    if (!pack.localTools || !pack.oauthProviders) throw new Error("hooks missing");
    const ctx = { config: {}, env: () => undefined, entryName: "t" };
    const tools = await pack.localTools(ctx);
    const names = tools.map((t) => t.definition.name);
    expect(names.filter((n) => n.startsWith("drive."))).toHaveLength(0);
    expect(names.filter((n) => n.startsWith("docs."))).toHaveLength(0);
    expect(names.filter((n) => n.startsWith("sheets."))).toHaveLength(0);

    const providers = await pack.oauthProviders(ctx);
    const scopes = providers[0]?.defaultScopes ?? [];
    expect(scopes).not.toContain("https://www.googleapis.com/auth/drive.file");
    expect(scopes).not.toContain("https://www.googleapis.com/auth/documents");
    expect(scopes).not.toContain("https://www.googleapis.com/auth/spreadsheets");
  });

  it("opting into drive adds drive.file scope (read_write) and 4 drive tools", async () => {
    if (!pack.localTools || !pack.oauthProviders) throw new Error("hooks missing");
    const ctx = {
      config: { surfaces: ["gmail", "calendar", "drive"] },
      env: () => undefined,
      entryName: "t",
    };
    const tools = await pack.localTools(ctx);
    const names = tools.map((t) => t.definition.name);
    expect(names).toContain("drive.list_files");
    expect(names).toContain("drive.search");
    expect(names).toContain("drive.read_file");
    expect(names).toContain("drive.upload_file");

    const providers = await pack.oauthProviders(ctx);
    expect(providers[0]?.defaultScopes).toContain("https://www.googleapis.com/auth/drive.file");
  });

  it("drive in `read` mode uses drive.readonly (broader read) and no upload tool", async () => {
    if (!pack.localTools || !pack.oauthProviders) throw new Error("hooks missing");
    const ctx = {
      config: { surfaces: ["drive"], accessMode: "read" },
      env: () => undefined,
      entryName: "t",
    };
    const tools = await pack.localTools(ctx);
    const names = tools.map((t) => t.definition.name);
    expect(names).toContain("drive.read_file");
    expect(names).not.toContain("drive.upload_file");

    const providers = await pack.oauthProviders(ctx);
    expect(providers[0]?.defaultScopes).toContain("https://www.googleapis.com/auth/drive.readonly");
    expect(providers[0]?.defaultScopes).not.toContain("https://www.googleapis.com/auth/drive.file");
  });

  it("opting into docs adds documents scope and 3 docs tools in read_write", async () => {
    if (!pack.localTools || !pack.oauthProviders) throw new Error("hooks missing");
    const ctx = {
      config: { surfaces: ["docs"] },
      env: () => undefined,
      entryName: "t",
    };
    const tools = await pack.localTools(ctx);
    const names = tools.map((t) => t.definition.name);
    expect(names).toEqual(["docs.read_doc", "docs.create_doc", "docs.append_text"]);

    const providers = await pack.oauthProviders(ctx);
    expect(providers[0]?.defaultScopes).toContain("https://www.googleapis.com/auth/documents");
  });

  it("opting into sheets adds spreadsheets scope and 5 sheets tools in read_write", async () => {
    if (!pack.localTools || !pack.oauthProviders) throw new Error("hooks missing");
    const ctx = {
      config: { surfaces: ["sheets"] },
      env: () => undefined,
      entryName: "t",
    };
    const tools = await pack.localTools(ctx);
    const names = tools.map((t) => t.definition.name);
    expect(names).toEqual([
      "sheets.read_range",
      "sheets.read_sheet_metadata",
      "sheets.append_row",
      "sheets.update_range",
      "sheets.create_sheet",
    ]);

    const providers = await pack.oauthProviders(ctx);
    expect(providers[0]?.defaultScopes).toContain("https://www.googleapis.com/auth/spreadsheets");
  });

  it("all five surfaces in read_write contribute ~22 tools and 6 user-data scopes", async () => {
    if (!pack.localTools || !pack.oauthProviders) throw new Error("hooks missing");
    const ctx = {
      config: { surfaces: ["gmail", "calendar", "drive", "docs", "sheets"] },
      env: () => undefined,
      entryName: "t",
    };
    const tools = await pack.localTools(ctx);
    // 4 gmail + 6 calendar + 4 drive + 3 docs + 5 sheets = 22
    expect(tools).toHaveLength(22);
    const providers = await pack.oauthProviders(ctx);
    const scopes = providers[0]?.defaultScopes ?? [];
    // gmail.modify + gmail.send + calendar + drive.file + documents +
    // spreadsheets + userinfo.email = 7
    expect(scopes).toHaveLength(7);
  });

  it("garbage surfaces config falls back to defaults", async () => {
    if (!pack.localTools) throw new Error("localTools missing");
    const tools = await pack.localTools({
      config: { surfaces: ["not-a-surface", 123, null] },
      env: () => undefined,
      entryName: "t",
    });
    const names = tools.map((t) => t.definition.name);
    expect(names.some((n) => n.startsWith("gmail."))).toBe(true);
    expect(names.some((n) => n.startsWith("calendar."))).toBe(true);
    expect(names.some((n) => n.startsWith("drive."))).toBe(false);
  });

  it("dedupes duplicate surface entries", async () => {
    if (!pack.localTools) throw new Error("localTools missing");
    const tools = await pack.localTools({
      config: { surfaces: ["docs", "docs", "docs"] },
      env: () => undefined,
      entryName: "t",
    });
    const docTools = tools.filter((t) => t.definition.name.startsWith("docs."));
    expect(docTools).toHaveLength(3);
  });

  it("contributes a skill per opted-in non-default surface", async () => {
    if (!pack.skills) throw new Error("skills hook missing");
    const justDefaults = await pack.skills({
      config: {},
      env: () => undefined,
      entryName: "t",
    });
    expect(justDefaults).toHaveLength(0); // gmail+calendar have no skills in this pack

    const all = await pack.skills({
      config: { surfaces: ["gmail", "calendar", "drive", "docs", "sheets"] },
      env: () => undefined,
      entryName: "t",
    });
    const names = all.map((s) => s.name);
    expect(names).toEqual(["google-drive", "google-docs", "google-sheets"]);
  });
});

describe("withScopeHint", () => {
  it("rewrites insufficient-scopes errors into actionable connection guidance", async () => {
    const { withScopeHint } = await import("./lib.js");
    await expect(
      withScopeHint("drive", async () => {
        throw new Error(
          "Google API 403: PERMISSION_DENIED: Request had insufficient authentication scopes",
        );
      }),
    ).rejects.toThrow(/Your Google connection doesn't include drive access/);
  });

  it("passes other errors through unchanged", async () => {
    const { withScopeHint } = await import("./lib.js");
    await expect(
      withScopeHint("drive", async () => {
        throw new Error("Google API 404: not found");
      }),
    ).rejects.toThrow(/not found/);
  });
});
