import type { MessageRecord, RunSummary } from "@render-harness/contracts";
import type { AgentRun, Message } from "@render-harness/core";

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
    cursor: run.cursor,
    totalCostUsd: run.totalCostUsd,
    metadata: run.metadata,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
  };
}
