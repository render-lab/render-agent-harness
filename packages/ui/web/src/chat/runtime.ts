import { useExternalStoreRuntime } from "@assistant-ui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  cancelRun,
  createConversation,
  getConversation,
  type MessageRecord,
  type RunStatus,
  type RunSummary,
  sendConversationMessage,
  streamConversation,
} from "../api.js";
import { convertMessage } from "./converter.js";

/**
 * Drives one chat session as a conversation. Owns the conversationId, the
 * currently active runId (so cancel can target it), the message list, and
 * an `isRunning` flag that assistant-ui reads to show/hide the cancel
 * affordance.
 *
 * Multi-turn now means: one `agent_conversations` row + many `agent_runs`
 * rows. The conversation SSE stream stays open across run boundaries —
 * each user message enqueues a fresh run on the same conversation and
 * pushes new events down the same channel.
 *
 * Lifecycle:
 *   - URL `?conversationId=X` → hydrate from `GET /conversations/X` and
 *     subscribe to its stream.
 *   - URL has no id → blank slate; the first `onNew` call creates a
 *     conversation up front, then sends the message. The parent gets
 *     notified via `onConversationIdChange` so it can update the URL.
 *   - `reset()` clears local state, sets conversationId back to null.
 *     The next send creates a fresh conversation.
 */
export interface UseConversationSessionOpts {
  agentName: string | null;
  /** Hydrate this specific conversation. When null, the hook is in "no conversation yet" mode. */
  conversationId: string | null;
  /** Notified after the conversationId changes (so the parent can update the URL). */
  onConversationIdChange?: (id: string | null) => void;
}

export interface ConversationSessionState {
  conversationId: string | null;
  /** runId of the most recent run on this conversation (live or terminal). */
  activeRunId: string | null;
  /** Status of the most recent run; null when no run yet. */
  status: RunStatus | null;
  /** True while a run is in flight (pending / running / paused-for-HITL). */
  isRunning: boolean;
  /** Set when the most recent API call failed. */
  error: Error | null;
  /** True before the initial conversation fetch completes. */
  hydrating: boolean;
  /** Clear local state. The next send starts a fresh conversation. */
  reset: () => void;
}

interface UseConversationSessionResult extends ConversationSessionState {
  /** Pass to `<AssistantRuntimeProvider runtime={...}>`. */
  runtime: ReturnType<typeof useExternalStoreRuntime<MessageRecord>>;
}

const ACTIVE_STATUSES: ReadonlySet<RunStatus> = new Set(["pending", "running", "paused"]);

export function useConversationSession(
  opts: UseConversationSessionOpts,
): UseConversationSessionResult {
  const { agentName } = opts;
  const initialConversationId = opts.conversationId ?? null;

  const [conversationId, setConversationIdState] = useState<string | null>(initialConversationId);
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [hydrating, setHydrating] = useState<boolean>(initialConversationId !== null);
  const [loadingTick, setLoadingTick] = useState(0);

  const onConversationIdChangeRef = useRef(opts.onConversationIdChange);
  onConversationIdChangeRef.current = opts.onConversationIdChange;

  const setConversationId = useCallback((next: string | null) => {
    setConversationIdState((prev) => {
      if (prev === next) return prev;
      onConversationIdChangeRef.current?.(next);
      return next;
    });
  }, []);

  // Treat any non-terminal run as "running" for the composer. A paused run
  // inside a conversation means HITL — the operator still can't enqueue
  // another turn until /runs/:id/input resolves it, so showing the stop
  // button rather than send is the honest affordance.
  const isRunning = status !== null && ACTIVE_STATUSES.has(status);

  useEffect(() => {
    if (!isRunning) {
      setLoadingTick(0);
      return;
    }
    const id = window.setInterval(() => setLoadingTick((tick) => tick + 1), 1800);
    return () => window.clearInterval(id);
  }, [isRunning]);

  // Hydrate when the URL conversationId changes (mount, back/forward,
  // explicit reset to a different one).
  useEffect(() => {
    let cancelled = false;
    setError(null);

    if (!initialConversationId) {
      // Blank slate. No fetch needed.
      setConversationId(null);
      setMessages([]);
      setActiveRunId(null);
      setStatus(null);
      setHydrating(false);
      return;
    }

    setHydrating(true);
    const hydrate = async () => {
      try {
        const detail = await getConversation(initialConversationId);
        if (cancelled) return;
        setConversationId(detail.conversation.id);
        setMessages(detail.messages);
        setActiveRunId(null);
        setStatus(null);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) return;
        setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        if (!cancelled) setHydrating(false);
      }
    };
    void hydrate();
    return () => {
      cancelled = true;
    };
  }, [initialConversationId, setConversationId]);

  // Maintain a live SSE subscription on the conversation. The stream is
  // intentionally tied to `conversationId` only — it stays open across
  // every run, picking up the next turn's events without re-subscribing.
  useEffect(() => {
    if (!conversationId) return;
    const dispose = streamConversation(conversationId, {
      onMessage: (msg) => {
        setMessages((prev) => {
          if (prev.some((m) => m.id === msg.id)) return prev;
          // Drop optimistic placeholders (`local-*` ids) we may have
          // added before SSE delivered the persisted row.
          const cleaned = prev.filter((m) => !m.id.startsWith("local-"));
          return [...cleaned, msg];
        });
      },
      onStatus: (runId, s) => {
        setActiveRunId((prev) => prev ?? runId);
        // Only follow the status of the most recently created run; ignore
        // stale flips on prior runs.
        setStatus((prevStatus) => {
          // If we don't have an active run yet, accept this one.
          // Otherwise, only update if it's the same run.
          return prevStatus === null || prevStatus !== null ? s : prevStatus;
        });
      },
      onRunCreated: (runId) => {
        setActiveRunId(runId);
        setStatus("pending");
      },
      onError: () => {
        // EventSource retries on its own; surface only after auth bounce.
      },
    });
    return dispose;
  }, [conversationId]);

  const reset = useCallback(() => {
    setConversationId(null);
    setMessages([]);
    setActiveRunId(null);
    setStatus(null);
    setError(null);
  }, [setConversationId]);

  const onNew = useCallback(
    async (appendMessage: { content: readonly { type: string; text?: string }[] }) => {
      const text = extractText(appendMessage.content);
      if (!text.trim()) return;
      if (!agentName) {
        setError(new Error("no agent selected"));
        return;
      }

      setError(null);
      try {
        let convId = conversationId;
        if (!convId) {
          // First turn on a fresh chat: create the conversation up front
          // so the URL gets a stable id we can share / refresh against.
          const created = await createConversation({ agentName });
          convId = created.conversation.id;
          setConversationId(convId);
        }
        const res = await sendConversationMessage(convId, { input: text });
        setActiveRunId(res.runId);
        setStatus(res.status);
      } catch (err) {
        setError(err instanceof Error ? err : new Error(String(err)));
      }
    },
    [agentName, conversationId, setConversationId],
  );

  const onCancel = useCallback(async () => {
    if (!activeRunId) return;
    setError(null);
    try {
      await cancelRun(activeRunId);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  }, [activeRunId]);

  const displayMessages = useMemo(
    () => withThinkingPlaceholder(messages, isRunning, loadingTick),
    [messages, isRunning, loadingTick],
  );

  const runtime = useExternalStoreRuntime<MessageRecord>({
    messages: displayMessages,
    isRunning,
    convertMessage,
    onNew,
    onCancel,
  });

  return {
    runtime,
    conversationId,
    activeRunId,
    status,
    isRunning,
    error,
    hydrating,
    reset,
  };
}

function extractText(parts: readonly { type: string; text?: string }[]): string {
  const out: string[] = [];
  for (const p of parts) {
    if (p.type === "text" && typeof p.text === "string") {
      out.push(p.text);
    }
  }
  return out.join("\n");
}

/**
 * A run is part of a chat if it belongs to a conversation. Used by the
 * Runs tab to show the "open in chat" affordance on a run row.
 */
export function isChatSession(run: Pick<RunSummary, "conversationId">): boolean {
  return run.conversationId !== null;
}

const LOADING_MESSAGES = [
  "checking memory",
  "queueing the run",
  "warming tools",
  "reading context",
  "waiting on the model",
  "streaming soon",
] as const;

function withThinkingPlaceholder(
  messages: MessageRecord[],
  isRunning: boolean,
  loadingTick: number,
): MessageRecord[] {
  if (!isRunning || messages.length === 0) return messages;
  const last = messages[messages.length - 1];
  if (!last || last.role === "assistant") return messages;
  const text = LOADING_MESSAGES[loadingTick % LOADING_MESSAGES.length] ?? "thinking";
  return [
    ...messages,
    {
      id: `local-thinking-${last.id}`,
      role: "assistant",
      content: [{ type: "text", text }],
      createdAt: new Date().toISOString(),
    },
  ];
}
