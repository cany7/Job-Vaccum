import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { CloseIcon } from "./icons";

export interface ToastInput {
  text: ReactNode;
  /** Failure toasts use the dark red background and state the reason. */
  error?: boolean;
  /** Undoable actions (remove, batch status) also answer ⌘Z while the toast shows. */
  undo?: () => void;
  action?: { label: string; run: () => void };
  /** Small secondary code after the reason, for failures. */
  code?: string;
}
interface Toast extends ToastInput {
  id: number;
}

const ToastContext = createContext<(toast: ToastInput) => void>(() => {});
export const useToast = () => useContext(ToastContext);

const VISIBLE_MS = 8000;
const MAX_TOASTS = 2;

/** Small toasts at the window's lower right; ~8 s, kept while hovered or focused. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const push = useCallback((toast: ToastInput) => {
    const id = next.current++;
    setToasts((current) => [...current, { ...toast, id }].slice(-MAX_TOASTS));
  }, []);
  const dismiss = useCallback((id: number) => setToasts((current) => current.filter((toast) => toast.id !== id)), []);

  const latestUndo = [...toasts].reverse().find((toast) => toast.undo);
  useEffect(() => {
    if (!latestUndo) return;
    const onKey = (event: KeyboardEvent) => {
      if (!event.metaKey || event.shiftKey || event.altKey || event.ctrlKey || event.key.toLowerCase() !== "z") return;
      const target = event.target as HTMLElement | null;
      // Text fields keep ⌘Z for their own editing.
      if (target?.isContentEditable || target?.matches?.("input, textarea")) return;
      event.preventDefault();
      dismiss(latestUndo.id);
      latestUndo.undo!();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [latestUndo, dismiss]);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="region" aria-label="Notifications" aria-live="polite">
        {toasts.map((toast) => (
          <ToastView key={toast.id} toast={toast} dismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastView({ toast, dismiss }: { toast: Toast; dismiss: (id: number) => void }) {
  const [held, setHeld] = useState(false);
  const onDismiss = () => dismiss(toast.id);
  useEffect(() => {
    if (held) return;
    const timer = window.setTimeout(() => dismiss(toast.id), VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, [held, dismiss, toast.id]);
  return (
    <div
      className={toast.error ? "toast toast-error" : "toast"}
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setHeld(false);
      }}
    >
      <span className="toast-text">
        {toast.text}
        {toast.code ? <span className="toast-code"> {toast.code}</span> : null}
      </span>
      {toast.undo ? (
        <button
          type="button"
          className="link-button toast-link"
          title="Undo (⌘Z)"
          onClick={() => {
            onDismiss();
            toast.undo!();
          }}
        >
          Undo
        </button>
      ) : null}
      {toast.action ? (
        <button
          type="button"
          className="link-button toast-link"
          onClick={() => {
            onDismiss();
            toast.action!.run();
          }}
        >
          {toast.action.label}
        </button>
      ) : null}
      <button type="button" className="toast-close" aria-label="Dismiss" onClick={onDismiss}>
        <CloseIcon size={12} />
      </button>
    </div>
  );
}
