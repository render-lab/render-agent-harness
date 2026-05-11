import type { ConversationSummary, MessageRecord, RunSummary } from "@render-harness/contracts";
import type { AgentConversation, AgentRun, Message } from "@render-harness/core";

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
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
  };
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
