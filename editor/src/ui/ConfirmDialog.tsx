import { useEffect, useRef, useState } from "react";

export interface ConfirmRequest {
  title: string;
  message: string;
  confirm: string;
  destructive?: boolean;
  onConfirm: () => void;
  /** Called when the dialog closes without confirming. */
  onCancel?: () => void;
  /** A word the person must type before the confirm button works (Delete All's DELETE, SPEC §11). */
  typeToConfirm?: string;
}

export function ConfirmDialog({ request, onClose }: { request: ConfirmRequest; onClose: () => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const typedRef = useRef<HTMLInputElement>(null);
  const [typed, setTyped] = useState("");
  const armed = !request.typeToConfirm || typed === request.typeToConfirm;
  // Each request settles exactly once: confirmed, cancelled, or cancelled when it goes away unanswered
  // (replaced by another request, or the window closing it), so whoever waits on it never hangs.
  const settled = useRef(false);
  useEffect(() => (typedRef.current ?? cancelRef.current)?.focus(), []);
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
    if (settled.current || (confirmed && !armed)) return;
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
        {request.typeToConfirm ? (
          <input
            ref={typedRef}
            className="dialog-input"
            value={typed}
            aria-label={`Type ${request.typeToConfirm} to confirm`}
            placeholder={request.typeToConfirm}
            spellCheck={false}
            autoComplete="off"
            data-testid="dialog-input"
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                settle(true);
              }
            }}
          />
        ) : null}
        <div className="dialog-buttons">
          <button type="button" ref={cancelRef} onClick={cancel}>
            Cancel
          </button>
          <button
            type="button"
            className={request.destructive ? "is-destructive" : "is-primary"}
            disabled={!armed}
            onClick={() => settle(true)}
          >
            {request.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}
