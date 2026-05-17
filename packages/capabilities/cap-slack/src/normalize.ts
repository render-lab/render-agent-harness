export type SlackNormalizedEvent =
  | { kind: "challenge"; challenge: string }
  | { kind: "noop"; reason: string }
  | {
      kind: "message";
      text: string;
      teamId: string;
      channel: string;
      ts: string;
      threadTs: string;
      eventId: string;
      userId?: string;
    };

export interface SlackNormalizeConfig {
  includeEdits?: boolean;
  allowedChannels?: string[];
}

export function normalizeSlackEvent(
  body: unknown,
  cfg: SlackNormalizeConfig = {},
): SlackNormalizedEvent {
  if (!body || typeof body !== "object") return { kind: "noop", reason: "invalid_body" };
  const payload = body as Record<string, unknown>;
  if (payload.type === "url_verification") {
    const challenge = stringValue(payload.challenge);
    return challenge
      ? { kind: "challenge", challenge }
      : { kind: "noop", reason: "missing_challenge" };
  }
  if (payload.type !== "event_callback") return { kind: "noop", reason: "unsupported_type" };

  const event = objectValue(payload.event);
  if (!event) return { kind: "noop", reason: "missing_event" };
  const eventType = stringValue(event.type);
  if (eventType !== "app_mention" && eventType !== "message") {
    return { kind: "noop", reason: "unsupported_event" };
  }
  if (event.bot_id || event.subtype === "bot_message")
    return { kind: "noop", reason: "bot_message" };
  if (event.subtype === "message_changed" && !cfg.includeEdits) {
    return { kind: "noop", reason: "edit_ignored" };
  }

  const channel = stringValue(event.channel);
  if (!channel) return { kind: "noop", reason: "missing_channel" };
  if (cfg.allowedChannels?.length && !cfg.allowedChannels.includes(channel)) {
    return { kind: "noop", reason: "channel_not_allowed" };
  }

  const teamId = stringValue(payload.team_id) ?? stringValue(event.team);
  const ts = stringValue(event.ts);
  const text = stringValue(event.text) ?? "";
  const eventId =
    stringValue(payload.event_id) ?? `${teamId ?? "team"}-${channel}-${ts ?? "event"}`;
  if (!teamId || !ts || text.trim().length === 0) return { kind: "noop", reason: "missing_fields" };
  const userId = stringValue(event.user);

  return {
    kind: "message",
    text,
    teamId,
    channel,
    ts,
    threadTs: stringValue(event.thread_ts) ?? ts,
    eventId,
    ...(userId ? { userId } : {}),
  };
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
