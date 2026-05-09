import {
  applyMigrations,
  buildLogger,
  getPool,
  listMessages,
  loadRun,
  type Message,
} from "@render-harness/core";
import { startWorkerAndWait } from "@render-harness/runtime-worker";
import { WebClient as SlackClient } from "@slack/web-api";
import { config as loadEnv } from "dotenv";
import { buildSupportAgent } from "./agent.js";

loadEnv({ quiet: true });

/**
 * The worker process for the support agent. Pulls run jobs from the queue,
 * runs each through @render-harness/core (with Slack MCP wired in for read
 * access), then posts the final assistant message back to the originating
 * Slack thread via the Slack Web API.
 */
async function main(): Promise<void> {
  const logger = buildLogger({ service: "support-agent-worker" });
  const pool = getPool({ applicationName: "support-agent-worker" });
  await applyMigrations(pool);

  const slackBotToken = process.env.SLACK_BOT_TOKEN;
  if (!slackBotToken) throw new Error("SLACK_BOT_TOKEN is required");
  const slack = new SlackClient(slackBotToken);

  const agent = buildSupportAgent();
  const queue = process.env.WORKER_QUEUE ?? "support-runs";

  await startWorkerAndWait({
    agent,
    queue,
    logger,
    skipMigrations: true,
    // Override the default soft checkpoint to keep Slack replies snappy.
    checkpoint: { kind: "soft", maxToolCalls: 12, maxSeconds: 90 },
    budget: {
      maxIterations: 20,
      maxCostUsd: 0.5,
      maxWallSeconds: 120,
    },
    onJobResult: async ({ job, result, logger: log }) => {
      if (result.status !== "completed") {
        log.info({ status: result.status }, "non-completed result; not posting to slack");
        return;
      }
      const run = await loadRun(pool, job.runId);
      const meta = run?.metadata as { slack?: SlackMetadata } | undefined;
      const slackMeta = meta?.slack;
      if (!slackMeta) {
        log.warn("completed run has no slack metadata; skipping post");
        return;
      }
      await postReplyToSlack({
        slack,
        channel: slackMeta.channel,
        threadTs: slackMeta.thread_ts,
        finalMessage: result.finalMessage,
        logger: log,
      });
    },
  });
}

interface SlackMetadata {
  channel: string;
  thread_ts: string;
  user?: string;
  team?: string;
}

/**
 * Post a single Slack message into a thread. Skips empty messages and surfaces
 * Slack API errors via the logger so they're visible without crashing the
 * worker.
 */
export async function postReplyToSlack(args: {
  slack: SlackClient;
  channel: string;
  threadTs: string;
  finalMessage: Message;
  logger: ReturnType<typeof buildLogger>;
}): Promise<void> {
  const text = args.finalMessage.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("\n");
  if (!text.trim()) {
    args.logger.warn({ messageId: args.finalMessage.id }, "empty final message; not posting");
    return;
  }
  try {
    const res = await args.slack.chat.postMessage({
      channel: args.channel,
      thread_ts: args.threadTs,
      text,
      unfurl_links: false,
      unfurl_media: false,
    });
    args.logger.info(
      { channel: args.channel, ts: res.ts, threadTs: args.threadTs },
      "posted reply to slack",
    );
  } catch (err) {
    args.logger.error(
      { err: err instanceof Error ? err.message : String(err), channel: args.channel },
      "slack post failed",
    );
  }
}

void listMessages; // re-exported earlier; not needed here but keeping import intentional

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
