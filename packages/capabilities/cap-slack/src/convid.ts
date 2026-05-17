import { createHash } from "node:crypto";

export function slackConversationId(args: {
  teamId: string;
  channel: string;
  threadTs: string;
}): string {
  const digest = createHash("sha256")
    .update(`${args.teamId}:${args.channel}:${args.threadTs}`)
    .digest("hex")
    .slice(0, 24);
  return `slack-${digest}`;
}
