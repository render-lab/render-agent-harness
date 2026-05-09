import { createHmac, timingSafeEqual } from "node:crypto";
import { serve } from "@hono/node-server";
import {
  applyMigrations,
  buildLogger,
  type ContentBlock,
  closeSharedPool,
  getPool,
} from "@render-harness/core";
import { enqueueRun } from "@render-harness/runtime-worker";
import { config as loadEnv } from "dotenv";
import { Hono } from "hono";
import { PgBoss } from "pg-boss";
import { buildSupportAgent } from "./agent.js";

loadEnv({ quiet: true });

/**
 * The web service for the support agent. Receives Slack Events Webhook
 * callbacks, verifies the signing secret, and enqueues a run on the worker.
 *
 * The worker (src/worker.ts) does the actual agent work and posts the final
 * reply back to Slack via the Web API.
 */
async function main(): Promise<void> {
  const logger = buildLogger({ service: "support-agent-web" });
  const pool = getPool({ applicationName: "support-agent-web" });
  await applyMigrations(pool);

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");

  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) throw new Error("SLACK_SIGNING_SECRET is required");

  const queue = process.env.WORKER_QUEUE ?? "support-runs";
  const boss = new PgBoss(connectionString);
  await boss.start();
  await boss.createQueue(queue);

  const agent = buildSupportAgent();

  const app = new Hono();

  app.get("/healthz", (c) => c.json({ ok: true, agent: agent.name }));

  app.post("/slack/events", async (c) => {
    // Read the raw body once so we can both verify the signature and parse it.
    const raw = await c.req.text();
    const ts = c.req.header("x-slack-request-timestamp") ?? "";
    const sig = c.req.header("x-slack-signature") ?? "";
    if (!verifySlackSignature({ signingSecret, raw, ts, sig })) {
      logger.warn("rejected slack event: bad signature");
      return c.json({ error: "bad_signature" }, 401);
    }

    let body: SlackEvent;
    try {
      body = JSON.parse(raw) as SlackEvent;
    } catch {
      return c.json({ error: "bad_json" }, 400);
    }

    if (body.type === "url_verification") {
      return c.json({ challenge: body.challenge });
    }

    if (body.type !== "event_callback" || !body.event) {
      return c.json({ ok: true });
    }

    const event = body.event;
    if (event.type !== "app_mention" && event.type !== "message") {
      return c.json({ ok: true });
    }
    if (event.bot_id || event.subtype === "bot_message") {
      // Ignore our own messages.
      return c.json({ ok: true });
    }

    const userText = stripBotMention(event.text ?? "").trim();
    if (!userText) return c.json({ ok: true });

    const initialContent: ContentBlock[] = [{ type: "text", text: userText }];

    const runId = await enqueueRun({
      pool,
      boss,
      queue,
      agentName: agent.name,
      agentVersion: agent.version,
      ...(event.user ? { userId: event.user } : {}),
      initialContent,
      metadata: {
        slack: {
          channel: event.channel,
          thread_ts: event.thread_ts ?? event.ts,
          user: event.user,
          team: body.team_id,
        },
      },
    });
    logger.info(
      { runId, channel: event.channel, threadTs: event.thread_ts ?? event.ts },
      "slack event enqueued",
    );
    return c.json({ ok: true, runId });
  });

  const port = Number(process.env.PORT ?? 8080);
  serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, (info) => {
    logger.info({ port: info.port }, "support-agent web listening");
  });

  const shutdown = async (signal: NodeJS.Signals) => {
    logger.warn({ signal }, "shutting down");
    await boss.stop({ graceful: true, timeout: 30_000 }).catch(() => {});
    await closeSharedPool().catch(() => {});
    process.exit(0);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});

// --------------------------------------------------------------------
// Slack helpers
// --------------------------------------------------------------------

interface SlackEvent {
  type: "url_verification" | "event_callback";
  challenge?: string;
  team_id?: string;
  event?: {
    type: string;
    subtype?: string;
    bot_id?: string;
    text?: string;
    user?: string;
    channel?: string;
    ts?: string;
    thread_ts?: string;
  };
}

function verifySlackSignature(args: {
  signingSecret: string;
  raw: string;
  ts: string;
  sig: string;
}): boolean {
  if (!args.ts || !args.sig) return false;
  const fiveMinutes = 60 * 5;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(args.ts)) > fiveMinutes) return false;
  const base = `v0:${args.ts}:${args.raw}`;
  const computed = `v0=${createHmac("sha256", args.signingSecret).update(base).digest("hex")}`;
  if (computed.length !== args.sig.length) return false;
  return timingSafeEqual(Buffer.from(computed), Buffer.from(args.sig));
}

function stripBotMention(text: string): string {
  // Remove leading <@U123...> mentions Slack inserts when @-mentioning the bot.
  return text.replace(/^<@[A-Z0-9]+>\s*/u, "");
}
