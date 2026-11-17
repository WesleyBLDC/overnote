import { useEffect, useRef } from "react";

export interface ConfirmRequest {
  title: string;
  message: string;
  confirm: string;
  destructive?: boolean;
  onConfirm: () => void;
  /** Called when the dialog closes without confirming. */
  onCancel?: () => void;
}

export function ConfirmDialog({ request, onClose }: { request: ConfirmRequest; onClose: () => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Each request settles exactly once: confirmed, cancelled, or cancelled when it goes away unanswered
  // (replaced by another request, or the window closing it), so whoever waits on it never hangs.
  const settled = useRef(false);
  useEffect(() => cancelRef.current?.focus(), []);
  // Checked a microtask later, so StrictMode's dev-only unmount and remount does not count as going away.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      queueMicrotask(() => {
        if (!mounted.current && !settled.current) request.onCancel?.();
      });
    };
  }, [request]);
  const settle = (confirmed: boolean) => {
    if (settled.current) return;
    settled.current = true;
    onClose();
    if (confirmed) request.onConfirm();
    else request.onCancel?.();
  };
  const cancel = () => settle(false);
  return (
    <div className="dialog-backdrop" onMouseDown={cancel}>
      <div
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        aria-describedby="dialog-message"
        data-testid="confirm-dialog"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            cancel();
          }
        }}
      >
        <h2 id="dialog-title">{request.title}</h2>
        <p id="dialog-message">{request.message}</p>
        <div className="dialog-buttons">
          <button type="button" ref={cancelRef} onClick={cancel}>
            Cancel
          </button>
          <button
            type="button"
            className={request.destructive ? "is-destructive" : "is-primary"}
            onClick={() => settle(true)}
          >
            {request.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}
