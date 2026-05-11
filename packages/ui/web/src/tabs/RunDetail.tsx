import type { RunDetailResp } from "@render-harness/contracts";
import { useEffect, useMemo, useState } from "react";
import {
  ApiError,
  type ContentBlock,
  cancelRun,
  getRun,
  getToolCalls,
  type MessageRecord,
  type RunStatus,
  sendInput,
  streamRun,
  type ToolCallRecord,
} from "../api.js";
import { AsyncBoundary } from "../components/AsyncBoundary.js";
import {
  formatDateTime,
  formatDuration,
  formatRelative,
  formatTokens,
  formatUsd,
} from "../components/format.js";
import { StatusBadge } from "../components/StatusBadge.js";

type RunDetailDto = RunDetailResp;

interface RunDetailProps {
  runId: string;
  onBack: () => void;
  /** Jump to the chat tab and hydrate the conversation this run belongs to. */
  onOpenInChat?: (conversationId: string) => void;
}

export function RunDetail({ runId, onBack, onOpenInChat }: RunDetailProps) {
  const [data, setData] = useState<RunDetailDto | null>(null);
  const [toolCalls, setToolCalls] = useState<ToolCallRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [hitlInput, setHitlInput] = useState("");
  const [hitlBusy, setHitlBusy] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([getRun(runId), getToolCalls(runId)])
      .then(([detail, tc]) => {
        if (cancelled) return;
        setData(detail);
        setToolCalls(tc.toolCalls);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) return;
        setError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  useEffect(() => {
    if (!data) return;
    if (
      data.run.status === "completed" ||
      data.run.status === "failed" ||
      data.run.status === "cancelled"
    ) {
      return;
    }
    const dispose = streamRun(runId, {
      onMessage: (msg) => {
        setData((prev) => {
          if (!prev) return prev;
          if (prev.messages.some((m) => m.id === msg.id)) return prev;
          return { ...prev, messages: [...prev.messages, msg] };
        });
      },
      onStatus: (status) => {
        setData((prev) => (prev ? { ...prev, run: { ...prev.run, status } } : prev));
        getToolCalls(runId)
          .then((tc) => setToolCalls(tc.toolCalls))
          .catch(() => {});
      },
    });
    return dispose;
  }, [runId, data]);

  const items = useMemo(
    () => buildTimeline(data?.messages ?? [], toolCalls),
    [data?.messages, toolCalls],
  );

  const onCancel = async () => {
    setActionError(null);
    setCancelBusy(true);
    try {
      await cancelRun(runId);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setCancelBusy(false);
    }
  };

  const onSendInput = async (e: React.FormEvent) => {
    e.preventDefault();
    setActionError(null);
    if (!hitlInput.trim()) return;
    setHitlBusy(true);
    try {
      await sendInput(runId, hitlInput);
      setHitlInput("");
      const refreshed = await getRun(runId);
      setData(refreshed);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setHitlBusy(false);
    }
  };

  const conversationId = data?.run.conversationId ?? null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={onBack}
          className="text-xs uppercase tracking-widest text-muted hover:text-accent"
        >
          ← back to runs
        </button>
        {conversationId && onOpenInChat && (
          <button
            type="button"
            onClick={() => onOpenInChat(conversationId)}
            className="btn"
            title="Open the parent conversation in the Chat tab."
          >
            open in chat
          </button>
        )}
      </div>
      <AsyncBoundary loading={loading} error={error}>
        {data && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_1fr_280px]">
            <RunMetaCard run={data.run} />
            <Timeline items={items} />
            <ActionsCard
              status={data.run.status}
              onCancel={onCancel}
              cancelBusy={cancelBusy}
              hitlInput={hitlInput}
              setHitlInput={setHitlInput}
              hitlBusy={hitlBusy}
              onSendInput={onSendInput}
              actionError={actionError}
            />
          </div>
        )}
      </AsyncBoundary>
    </div>
  );
}

function RunMetaCard({ run }: { run: RunDetailDto["run"] }) {
  const tokens = (run.cursor.usage?.inputTokens ?? 0) + (run.cursor.usage?.outputTokens ?? 0);
  return (
    <aside className="panel space-y-4 p-4 text-xs">
      <div>
        <StatusBadge status={run.status} />
      </div>
      <Metric label="run id" value={<span className="break-all">{run.id}</span>} />
      <Metric label="agent" value={`${run.agentName}@${run.agentVersion}`} />
      <Metric label="user" value={run.userId ?? "—"} />
      <Metric label="created" value={formatDateTime(run.createdAt)} />
      <Metric label="started" value={formatDateTime(run.startedAt)} />
      <Metric label="finished" value={formatDateTime(run.finishedAt)} />
      <Metric label="turns" value={String(run.cursor.turn ?? 0)} />
      <Metric label="tool calls" value={String(run.cursor.toolCalls ?? 0)} />
      <Metric label="tokens" value={formatTokens(tokens)} />
      <Metric label="cost" value={formatUsd(run.totalCostUsd)} />
    </aside>
  );
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="label">{label}</div>
      <div className="mt-0.5 break-all">{value}</div>
    </div>
  );
}

interface ActionsCardProps {
  status: RunStatus;
  onCancel: () => void;
  cancelBusy: boolean;
  hitlInput: string;
  setHitlInput: (s: string) => void;
  hitlBusy: boolean;
  onSendInput: (e: React.FormEvent) => void;
  actionError: string | null;
}

function ActionsCard({
  status,
  onCancel,
  cancelBusy,
  hitlInput,
  setHitlInput,
  hitlBusy,
  onSendInput,
  actionError,
}: ActionsCardProps) {
  const isTerminal = status === "completed" || status === "failed" || status === "cancelled";
  return (
    <aside className="panel space-y-3 p-4 text-xs">
      <div className="label">actions</div>
      <button
        type="button"
        onClick={onCancel}
        disabled={isTerminal || cancelBusy}
        className="btn btn-danger w-full"
      >
        {cancelBusy ? "Cancelling…" : "Cancel run"}
      </button>

      {status === "paused" && (
        <form onSubmit={onSendInput} className="space-y-2">
          <div className="label">send hitl input</div>
          <div className="flex items-start gap-2">
            <span className="text-accent">{">"}</span>
            <textarea
              rows={4}
              value={hitlInput}
              onChange={(e) => setHitlInput(e.target.value)}
              placeholder="reply to the paused agent…"
              className="w-full text-xs"
              autoFocus
            />
          </div>
          <button
            type="submit"
            disabled={hitlBusy || !hitlInput.trim()}
            className="btn btn-primary w-full"
          >
            {hitlBusy ? "Sending…" : "Resume run"}
          </button>
        </form>
      )}

      {actionError && <div className="border border-err p-2 text-xs text-err">{actionError}</div>}
    </aside>
  );
}

type TimelineItem =
  | { kind: "message"; at: number; message: MessageRecord }
  | { kind: "tool"; at: number; call: ToolCallRecord };

function buildTimeline(messages: MessageRecord[], toolCalls: ToolCallRecord[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const m of messages) {
    items.push({ kind: "message", at: new Date(m.createdAt).getTime(), message: m });
  }
  for (const c of toolCalls) {
    items.push({ kind: "tool", at: new Date(c.createdAt).getTime(), call: c });
  }
  return items.sort((a, b) => a.at - b.at);
}

function Timeline({ items }: { items: TimelineItem[] }) {
  if (items.length === 0) {
    return <div className="panel p-6 text-center text-xs text-muted">// no activity yet</div>;
  }
  return (
    <div className="space-y-3">
      {items.map((item) => {
        if (item.kind === "message") {
          return <MessageCard key={`m-${item.message.id}`} message={item.message} />;
        }
        return <ToolCallCard key={`t-${item.call.id}`} call={item.call} />;
      })}
    </div>
  );
}

function MessageCard({ message }: { message: MessageRecord }) {
  return (
    <div className="panel p-4 text-xs">
      <div className="mb-2 flex items-center justify-between">
        <span className="badge">{message.role.toUpperCase()}</span>
        <span className="text-muted">{formatRelative(message.createdAt)}</span>
      </div>
      <div className="space-y-2">
        {message.content.map((block, blockIdx) => (
          <ContentBlockView key={contentBlockKey(message.id, block, blockIdx)} block={block} />
        ))}
      </div>
      {message.usage && (
        <div className="mt-2 text-[11px] text-muted">
          {formatTokens(message.usage.inputTokens)} in · {formatTokens(message.usage.outputTokens)}{" "}
          out
        </div>
      )}
    </div>
  );
}

function contentBlockKey(messageId: string, block: ContentBlock, fallbackIdx: number): string {
  if (block.type === "tool_use") return `${messageId}-tu-${block.id}`;
  if (block.type === "tool_result") return `${messageId}-tr-${block.tool_use_id}`;
  return `${messageId}-${block.type}-${fallbackIdx}`;
}

function ContentBlockView({ block }: { block: ContentBlock }) {
  if (block.type === "text") {
    return <pre className="whitespace-pre-wrap wrap-break-word">{block.text}</pre>;
  }
  if (block.type === "thinking") {
    return (
      <details className="border border-line p-2">
        <summary className="label cursor-pointer">[thinking]</summary>
        <pre className="mt-2 whitespace-pre-wrap text-[11px] text-muted">{block.thinking}</pre>
      </details>
    );
  }
  if (block.type === "tool_use") {
    return (
      <div className="border border-line p-2">
        <div className="mb-1">
          <span className="badge">TOOL_USE</span>
          <span className="ml-2">{block.name}</span>
        </div>
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all text-[11px]">
          {JSON.stringify(block.input, null, 2)}
        </pre>
      </div>
    );
  }
  if (block.type === "tool_result") {
    return (
      <div className={`border p-2 ${block.is_error ? "border-err" : "border-line"}`}>
        <div>
          <span className={block.is_error ? "badge badge-err" : "badge"}>
            TOOL_RESULT{block.is_error ? " · ERROR" : ""}
          </span>
        </div>
        <details className="mt-2">
          <summary className="label cursor-pointer">raw result</summary>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all text-[11px]">
            {block.content}
          </pre>
        </details>
      </div>
    );
  }
  return null;
}

function ToolCallCard({ call }: { call: ToolCallRecord }) {
  const [open, setOpen] = useState(false);
  const failed = call.result?.isError === true || call.status === "failed";
  return (
    <div className={`border p-3 text-xs ${failed ? "border-err" : "border-line"}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 text-left"
      >
        <div className="flex items-center gap-2">
          <span className={failed ? "badge badge-err" : "badge"}>TOOL</span>
          <span>{call.name}</span>
          <span className="label">{call.status}</span>
        </div>
        <div className="text-muted">
          {formatDuration(call.result?.durationMs ?? null)}
          <span className="ml-2">{open ? "[-]" : "[+]"}</span>
        </div>
      </button>
      {open && (
        <div className="mt-3 space-y-3">
          <div>
            <div className="label">input</div>
            <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all text-[11px]">
              {JSON.stringify(call.input, null, 2)}
            </pre>
          </div>
          {call.result ? (
            <div>
              <div className="label">result · {formatTokens(call.result.tokenCount)} tokens</div>
              <details className="mt-1">
                <summary className="label cursor-pointer">raw result</summary>
                <pre className="mt-1 max-h-96 overflow-auto whitespace-pre-wrap break-all text-[11px]">
                  {call.result.content}
                </pre>
              </details>
            </div>
          ) : (
            <div className="text-muted">// result not yet recorded</div>
          )}
        </div>
      )}
    </div>
  );
}
