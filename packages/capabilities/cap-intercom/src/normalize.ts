/**
 * Normalize an inbound Intercom webhook payload into the minimal
 * shape the connector needs to enqueue a harness run.
 *
 * Intercom's webhook envelope:
 *
 *   {
 *     type: "notification_event",
 *     app_id: "abc123",                  // workspace
 *     data: { item: { id, type, ... } }, // the resource
 *     topic: "conversation.user.created" // or ...replied, ...assigned, ...closed
 *     id: "notif_xxx",                   // delivery id (for idempotency)
 *     delivery_attempts: 1
 *   }
 *
 * For conversation events the data.item is a Conversation object.
 * We extract the conversation id, workspace id, topic, the latest
 * customer-visible message body (when present), and the delivery id.
 *
 * v1 only handles the four conversation topics. Other topics are
 * normalized to `kind: "noop"` with a reason so the connector can
 * 200-OK Intercom without enqueueing a run.
 */

export type IntercomNormalized =
  | {
      kind: "conversation_event";
      topic: string;
      workspaceId: string;
      conversationId: string;
      conversationState?: string;
      notificationId: string;
      deliveryAttempt: number;
      latestMessageBody?: string;
      latestMessageAuthor?: string;
    }
  | { kind: "noop"; reason: string };

const SUPPORTED_TOPICS = new Set([
  "conversation.user.created",
  "conversation.user.replied",
  "conversation.admin.assigned",
  "conversation.admin.closed",
  // The wider conversation.* family is allowed too — these are the
  // four documented as default topics; if the operator subscribes
  // their app to extras, we still pass them through.
  "conversation.admin.replied",
  "conversation.admin.noted",
  "conversation.admin.opened",
  "conversation.admin.snoozed",
  "conversation.admin.unsnoozed",
]);

interface IntercomItem {
  id?: string;
  type?: string;
  state?: string;
  source?: { body?: string; author?: { name?: string; email?: string; type?: string } };
  conversation_parts?: {
    conversation_parts?: Array<{
      part_type?: string;
      body?: string | null;
      author?: { name?: string; email?: string; type?: string };
    }>;
  };
}

export function normalizeIntercomWebhook(raw: unknown): IntercomNormalized {
  const env = (raw ?? {}) as {
    type?: unknown;
    topic?: unknown;
    app_id?: unknown;
    id?: unknown;
    delivery_attempts?: unknown;
    data?: { item?: unknown };
  };
  if (env.type === "ping") return { kind: "noop", reason: "ping" };
  if (typeof env.topic !== "string") return { kind: "noop", reason: "no_topic" };
  if (!SUPPORTED_TOPICS.has(env.topic)) {
    return { kind: "noop", reason: `unsupported_topic:${env.topic}` };
  }
  const workspaceId = typeof env.app_id === "string" ? env.app_id : "";
  if (!workspaceId) return { kind: "noop", reason: "no_app_id" };
  const notificationId = typeof env.id === "string" ? env.id : "";
  if (!notificationId) return { kind: "noop", reason: "no_notification_id" };

  const item = (env.data?.item ?? {}) as IntercomItem;
  if (item.type !== "conversation" || !item.id) {
    return { kind: "noop", reason: "item_not_conversation" };
  }
  const conversationId = String(item.id);

  // Pull the latest body — for conversation.user.replied this is the
  // latest customer message; for conversation.user.created it's the
  // initial customer message (in `source.body`). Both forms appear
  // depending on the topic.
  const parts = item.conversation_parts?.conversation_parts ?? [];
  let latestBody: string | undefined;
  let latestAuthor: string | undefined;
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (p?.part_type === "comment" && p.body) {
      latestBody = p.body;
      latestAuthor = p.author?.name ?? p.author?.email ?? p.author?.type ?? undefined;
      break;
    }
  }
  if (!latestBody && item.source?.body) {
    latestBody = item.source.body;
    latestAuthor =
      item.source.author?.name ??
      item.source.author?.email ??
      item.source.author?.type ??
      undefined;
  }

  return {
    kind: "conversation_event",
    topic: env.topic,
    workspaceId,
    conversationId,
    notificationId,
    deliveryAttempt: typeof env.delivery_attempts === "number" ? env.delivery_attempts : 1,
    ...(item.state ? { conversationState: item.state } : {}),
    ...(latestBody ? { latestMessageBody: latestBody } : {}),
    ...(latestAuthor ? { latestMessageAuthor: latestAuthor } : {}),
  };
}
