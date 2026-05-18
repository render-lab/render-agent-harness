import type {
  ConversationSummary,
  InboxItem,
  MessageRecord,
  RunPauseInfo,
  RunSummary,
  ScheduleSummary,
} from "@render-harness/contracts";
import type {
  AgentConversation,
  AgentRun,
  Message,
  NotificationDelivery,
  Schedule,
} from "@render-harness/core";

export function serializeMessage(m: Message): MessageRecord {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    createdAt: m.createdAt.toISOString(),
    ...(m.usage ? { usage: m.usage } : {}),
  };
}

export function serializeRun(run: AgentRun): RunSummary {
  return {
    id: run.id,
    agentName: run.agentName,
    agentVersion: run.agentVersion,
    status: run.status,
    userId: run.userId,
    conversationId: run.conversationId,
    cursor: run.cursor,
    totalCostUsd: run.totalCostUsd,
    metadata: run.metadata,
    pause: derivePauseInfo(run),
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
  };
}

/**
 * Derive a typed `RunPauseInfo` from the run row's metadata. Core's
 * `pauseForAwaitingInput` and `pauseForApproval` both write the pause shape
 * into `metadata` so the operator UI can branch on `pause.reason` without
 * having to walk the message log. Returns `null` for any run that isn't
 * currently paused or has incomplete pause metadata (stale entries from a
 * prior pause that has since resumed and completed).
 */
function derivePauseInfo(run: AgentRun): RunPauseInfo | null {
  if (run.status !== "paused") return null;
  const meta = (run.metadata ?? {}) as Record<string, unknown>;
  const reason = meta.pauseReason;
  if (reason === "awaiting_input") {
    const askUser = meta.askUser as
      | { question?: unknown; options?: unknown; tool_use_id?: unknown }
      | undefined;
    if (!askUser || typeof askUser.question !== "string" || typeof askUser.tool_use_id !== "string")
      return null;
    return {
      reason: "awaiting_input",
      payload: {
        question: askUser.question,
        tool_use_id: askUser.tool_use_id,
        ...(Array.isArray(askUser.options) && askUser.options.every((o) => typeof o === "string")
          ? { options: askUser.options as string[] }
          : {}),
      },
    };
  }
  if (reason === "awaiting_approval") {
    const approval = meta.awaitingApproval as
      | { tool_use_id?: unknown; name?: unknown; input?: unknown }
      | undefined;
    if (!approval || typeof approval.tool_use_id !== "string" || typeof approval.name !== "string")
      return null;
    return {
      reason: "awaiting_approval",
      payload: {
        tool_use_id: approval.tool_use_id,
        name: approval.name,
        input: approval.input,
      },
    };
  }
  return null;
}

export function serializeConversation(c: AgentConversation): ConversationSummary {
  return {
    id: c.id,
    userId: c.userId,
    agentName: c.agentName,
    agentVersion: c.agentVersion,
    title: c.title,
    totalCostUsd: c.totalCostUsd,
    metadata: c.metadata,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
    lastActiveAt: c.lastActiveAt.toISOString(),
  };
}

export function serializeSchedule(s: Schedule): ScheduleSummary {
  return {
    id: s.id,
    userId: s.userId,
    agentName: s.agentName,
    input: s.input,
    metadata: s.metadata,
    cronExpr: s.cronExpr,
    timezone: s.timezone,
    notifications: s.notifications,
    enabled: s.enabled,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
    lastFiredAt: s.lastFiredAt?.toISOString() ?? null,
    nextFireAt: s.nextFireAt?.toISOString() ?? null,
  };
}

export function serializeInboxItem(item: NotificationDelivery): InboxItem {
  return {
    id: item.id,
    runId: item.runId,
    scheduleId: item.scheduleId,
    userId: item.userId,
    kind: item.kind,
    target: item.target,
    summary: item.summary,
    status: item.status,
    error: item.error,
    createdAt: item.createdAt.toISOString(),
  };
}
