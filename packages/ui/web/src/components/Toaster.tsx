import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

/**
 * Minimal toast surface. No external lib — the operator UI's brutalist
 * theme doesn't need motion-rich notifications. Each toast is a panel
 * pinned to the bottom-right with an optional action button.
 *
 * Three intent levels:
 *   - `info`    neutral grey border (default for "in flight" messages)
 *   - `success` accent border + accent text
 *   - `error`   red border + red text
 *
 * Toasts auto-dismiss after `duration` ms (default 4500). Pass
 * `duration: 0` for a sticky toast that only goes away on `dismiss()`
 * or `update()` with a new shape. Re-using the same `id` updates the
 * existing toast in place — handy for "saving → restarting → restored"
 * sequences where we want one persistent slot, not a pile.
 */

export type ToastIntent = "info" | "success" | "error";

export interface ToastInput {
  /**
   * Stable identifier. Passing the same id to {@link useToast.show}
   * replaces the existing toast in place. Falls back to a generated id
   * if omitted.
   */
  id?: string;
  title: string;
  message?: string;
  intent?: ToastIntent;
  /** ms; 0 means sticky (caller must dismiss). Default 4500. */
  duration?: number;
  action?: {
    label: string;
    onClick: () => void;
  };
}

interface Toast extends Required<Omit<ToastInput, "message" | "action">> {
  message: string | null;
  action: ToastInput["action"] | null;
}

interface ToastContextValue {
  show: (input: ToastInput) => string;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const DEFAULT_DURATION = 4500;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timersRef = useRef<Map<string, number>>(new Map());

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timersRef.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const show = useCallback(
    (input: ToastInput): string => {
      const id = input.id ?? `toast-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const toast: Toast = {
        id,
        title: input.title,
        message: input.message ?? null,
        intent: input.intent ?? "info",
        duration: input.duration ?? DEFAULT_DURATION,
        action: input.action ?? null,
      };

      setToasts((prev) => {
        const existing = prev.findIndex((t) => t.id === id);
        if (existing === -1) return [...prev, toast];
        const next = [...prev];
        next[existing] = toast;
        return next;
      });

      const prevTimer = timersRef.current.get(id);
      if (prevTimer !== undefined) window.clearTimeout(prevTimer);
      if (toast.duration > 0) {
        const t = window.setTimeout(() => dismiss(id), toast.duration);
        timersRef.current.set(id, t);
      } else {
        timersRef.current.delete(id);
      }

      return id;
    },
    [dismiss],
  );

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const t of timers.values()) window.clearTimeout(t);
      timers.clear();
    };
  }, []);

  const value = useMemo<ToastContextValue>(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <section
        className="pointer-events-none fixed right-3 bottom-3 z-[60] flex w-full max-w-sm flex-col gap-2"
        aria-label="Notifications"
      >
        {toasts.map((toast) => (
          <ToastView key={toast.id} toast={toast} onDismiss={() => dismiss(toast.id)} />
        ))}
      </section>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}

function ToastView({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const intentClass =
    toast.intent === "success"
      ? "border-accent text-accent"
      : toast.intent === "error"
        ? "border-err text-err"
        : "border-line text-ink";
  return (
    <div
      className={`pointer-events-auto flex gap-3 border bg-bg p-3 text-xs shadow-md ${intentClass}`}
      role={toast.intent === "error" ? "alert" : "status"}
    >
      <div className="min-w-0 flex-1">
        <div className="font-bold uppercase tracking-wide">{toast.title}</div>
        {toast.message ? (
          <div className="mt-1 break-words text-[11px] text-muted">{toast.message}</div>
        ) : null}
        {toast.action ? (
          <button
            type="button"
            onClick={toast.action.onClick}
            className="mt-2 border border-current px-2 py-1 text-[10px] uppercase tracking-wide"
          >
            {toast.action.label}
          </button>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="self-start px-1 text-muted hover:text-ink"
      >
        ✕
      </button>
    </div>
  );
}
