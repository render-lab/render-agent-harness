import { useExternalStoreRuntime } from "@assistant-ui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  cancelRun,
  createRun,
  getActiveRun,
  getRun,
  type MessageRecord,
  type RunStatus,
  type RunSummary,
  sendInput,
  streamRun,
} from "../api.js";
import { convertMessage } from "./converter.js";

/**
 * Drives one chat session against the harness backend. Owns the runId,
 * the current message list, the SSE subscription, and an `isRunning` flag
 * that assistant-ui reads to show/hide the cancel affordance.
 *
 * The backend treats one chat = one long-lived run. The first user message
 * spawns the run via `POST /runs`; subsequent turns reuse the same runId
 * via `POST /runs/:id/input` (which only succeeds while the run sits in
 * `paused` state — the chat-shape loop in `@render-harness/core` ends each
 * turn that way).
 */
export interface UseChatSessionOpts {
  agentName: string | null;
  /** When set, hydrate from this specific run instead of `/runs/active`. */
  initialRunId?: string | null;
  /** Notified after the runId changes (e.g. when a brand-new run is created). */
  onRunIdChange?: (runId: string | null) => void;
}

export interface ChatSessionState {
  runId: string | null;
  status: RunStatus | null;
  /** True while the worker is processing a turn (pending or running). */
  isRunning: boolean;
  /** Set when the most recent API call failed. */
  error: Error | null;
  /** True before the initial `/runs/active` lookup completes. */
  hydrating: boolean;
  /** Drop the current session and clear messages. The next send creates a new run. */
  reset: () => void;
}

interface UseChatSessionResult extends ChatSessionState {
  /** Pass to `<AssistantRuntimeProvider runtime={...}>`. */
  runtime: ReturnType<typeof useExternalStoreRuntime<MessageRecord>>;
}

const ACTIVE_STATUSES: ReadonlySet<RunStatus> = new Set(["pending", "running", "paused"]);

export function useChatSession(opts: UseChatSessionOpts): UseChatSessionResult {
  const { agentName } = opts;
  const initialRunId = opts.initialRunId ?? null;

  const [runId, setRunIdState] = useState<string | null>(initialRunId);
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [hydrating, setHydrating] = useState<boolean>(true);

  const onRunIdChangeRef = useRef(opts.onRunIdChange);
  onRunIdChangeRef.current = opts.onRunIdChange;

  // Set when the user explicitly clicks NEW CHAT. The hydrate effect
  // checks this and skips the `getActiveRun` lookup once — otherwise the
  // most recent paused chat-shape run gets re-hydrated and the reset
  // looks like a no-op.
  const userResetRef = useRef(false);

  const setRunId = useCallback((next: string | null) => {
    setRunIdState((prev) => {
      if (prev === next) return prev;
      onRunIdChangeRef.current?.(next);
      return next;
    });
  }, []);

  const isRunning =
    status === "pending" || status === "running" || (runId !== null && status === null);

  // Hydrate on mount or when the agent / forced runId changes.
  useEffect(() => {
    let cancelled = false;
    setHydrating(true);
    setError(null);

    const hydrate = async () => {
      try {
        // The user just clicked NEW CHAT. Skip the active-run lookup so
        // the previous paused chat doesn't snap back. Subsequent
        // dependency changes (e.g. picking a different agent) reset the
        // flag and re-enable auto-hydration.
        if (userResetRef.current) {
          userResetRef.current = false;
          if (cancelled) return;
          setRunId(null);
          setMessages([]);
          setStatus(null);
          return;
        }

        if (initialRunId) {
          const detail = await getRun(initialRunId);
          if (cancelled) return;
          setRunId(detail.run.id);
          setMessages(detail.messages);
          setStatus(detail.run.status);
        } else if (agentName) {
          const { run } = await getActiveRun(agentName);
          if (cancelled) return;
          if (run) {
            const detail = await getRun(run.id);
            if (cancelled) return;
            setRunId(detail.run.id);
            setMessages(detail.messages);
            setStatus(detail.run.status);
          } else {
            setRunId(null);
            setMessages([]);
            setStatus(null);
          }
        } else {
          setRunId(null);
          setMessages([]);
          setStatus(null);
        }
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
  }, [agentName, initialRunId, setRunId]);

  // Maintain a live SSE subscription for the current run. The connection
  // is intentionally tied to `runId` only — the server keeps the stream
  // open across pending → running → paused transitions and only emits a
  // terminal `done` event for completed/failed/cancelled. Including
  // `status` in the deps would tear the connection down on every status
  // change and race with NOTIFY: the assistant message that arrives
  // between the teardown and the next `LISTEN` is otherwise lost until
  // the next reconnect (which is why the answer only showed up after a
  // refresh or new chat).
  useEffect(() => {
    if (!runId) return;
    // Skip for runs that landed terminal before we got here. They won't
    // produce new events; the static fetch already hydrated the view.
    if (status === "completed" || status === "failed" || status === "cancelled") return;

    const dispose = streamRun(runId, {
      onMessage: (msg) => {
        setMessages((prev) => {
          if (prev.some((m) => m.id === msg.id)) return prev;
          // Drop optimistic placeholders (`local-*` ids) we added before
          // SSE delivered the persisted row. Without this, the user
          // message and the agent's first reply would each appear twice
          // — once as the placeholder, once as the real message.
          const cleaned = prev.filter((m) => !m.id.startsWith("local-"));
          return [...cleaned, msg];
        });
      },
      onStatus: (s) => setStatus(s),
      onError: () => {
        // EventSource retries on its own; surface only after auth bounce.
      },
    });
    return dispose;
    // biome-ignore lint/correctness/useExhaustiveDependencies: status intentionally excluded — see comment.
  }, [runId]);

  const reset = useCallback(() => {
    userResetRef.current = true;
    setRunId(null);
    setMessages([]);
    setStatus(null);
    setError(null);
  }, [setRunId]);

  // Send a turn. First call creates the run; later calls inject input into
  // the paused run.
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
        if (!runId) {
          // First turn: create the run server-side, then let the SSE
          // stream deliver the persisted user message. Skipping the
          // optimistic placeholder avoids a class of dedup bugs (local
          // placeholder + real message both rendering) at the cost of a
          // sub-100ms perceived delay before the user's text shows up.
          const created = await createRun({ input: text, agentName });
          setRunId(created.runId);
          setStatus(created.status);
          return;
        }
        // Subsequent turn — same logic, no optimistic placeholder.
        await sendInput(runId, text);
        setStatus("pending");
      } catch (err) {
        setError(err instanceof Error ? err : new Error(String(err)));
      }
    },
    [agentName, runId, setRunId],
  );

  const onCancel = useCallback(async () => {
    if (!runId) return;
    setError(null);
    try {
      await cancelRun(runId);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  }, [runId]);

  const displayMessages = useMemo(
    () => withThinkingPlaceholder(messages, isRunning),
    [messages, isRunning],
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
    runId,
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

export function isChatSession(run: Pick<RunSummary, "metadata" | "status">): boolean {
  if (!ACTIVE_STATUSES.has(run.status) && run.status !== "completed") {
    // We still want completed runs to be openable for read-only review.
    return run.metadata?.["pauseReason"] === "chat_turn_end";
  }
  return run.metadata?.["pauseReason"] === "chat_turn_end";
}

function withThinkingPlaceholder(messages: MessageRecord[], isRunning: boolean): MessageRecord[] {
  if (!isRunning || messages.length === 0) return messages;
  const last = messages[messages.length - 1];
  if (!last || last.role === "assistant") return messages;
  return [
    ...messages,
    {
      id: `local-thinking-${last.id}`,
      role: "assistant",
      content: [{ type: "text", text: "thinking" }],
      createdAt: new Date().toISOString(),
    },
  ];
}
