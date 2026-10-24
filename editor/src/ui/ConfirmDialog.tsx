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
  useEffect(() => cancelRef.current?.focus(), []);
  const cancel = () => {
    onClose();
    request.onCancel?.();
  };
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
            onClick={() => {
              onClose();
              request.onConfirm();
            }}
          >
            {request.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}
