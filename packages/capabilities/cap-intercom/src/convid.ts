/**
 * Conversation key derivation for inbound Intercom webhook events.
 *
 * One Intercom conversation = one harness conversation. The key is
 * stable across multiple webhook deliveries for the same conversation
 * (initial customer message, customer reply, admin reply, close, etc.)
 * so the harness's enqueueIntoConversation can stitch them onto one
 * `agent_conversations` row.
 *
 * Format: `intercom-${sha256(workspace_id + ":" + conversation_id)}`.
 * The hash is for opacity in URL paths and metadata; both the
 * workspace_id and conversation_id are visible in the Intercom UI so
 * there's no privacy gain from the hash, just consistent length.
 */

import { createHash } from "node:crypto";

export function intercomConversationId(args: {
  workspaceId: string;
  conversationId: string;
}): string {
  const h = createHash("sha256").update(`${args.workspaceId}:${args.conversationId}`).digest("hex");
  return `intercom-${h}`;
}

/**
 * Deterministic runId for a webhook delivery — derived from the
 * conversation id plus the delivery's notification id, so re-deliveries
 * of the same notification produce the same runId and the harness's
 * run-dedup catches them.
 *
 * Intercom's notification body has a top-level `id` (the delivery id)
 * AND `data.item.id` (the conversation id). We hash both so we don't
 * collide across conversations OR across retries of the same delivery.
 */
export function intercomRunId(args: {
  workspaceId: string;
  conversationId: string;
  notificationId: string;
}): string {
  const h = createHash("sha256")
    .update(`${args.workspaceId}:${args.conversationId}:${args.notificationId}`)
    .digest("hex")
    .slice(0, 16);
  return `intercom-${h}`;
}
