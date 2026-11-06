import { useEffect, useState } from "react";
import {
  getPendingConfirm,
  resolveConfirm,
  subscribeConfirm,
} from "../confirm";

export function ConfirmDialog() {
  const [, bump] = useState(0);

  useEffect(() => subscribeConfirm(() => bump((n) => n + 1)), []);

  const pending = getPendingConfirm();

  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        resolveConfirm(false);
      } else if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        // Don't steal Enter from nested inputs — this dialog has none.
        e.preventDefault();
        resolveConfirm(true);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [pending?.id]);

  if (!pending) return null;

  const lines = pending.message.split(/\n+/).map((l) => l.trim()).filter(Boolean);

  return (
    <div
      className="modal-mask confirm-mask"
      onClick={() => resolveConfirm(false)}
      role="presentation"
    >
      <div
        className={`modal confirm-dialog${pending.danger ? " is-danger" : ""}`}
        onClick={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-body"
      >
        <div className="confirm-dialog-head">
          <span className="confirm-dialog-icon" aria-hidden>
            {pending.danger ? "!" : "?"}
          </span>
          <h3 id="confirm-dialog-title">{pending.title}</h3>
        </div>
        <div id="confirm-dialog-body" className="confirm-dialog-body">
          {lines.map((line, i) => (
            <p key={`${pending.id}-${i}`} className={i === 0 ? "" : "muted small"}>
              {line}
            </p>
          ))}
        </div>
        <div className="modal-actions">
          <button type="button" onClick={() => resolveConfirm(false)}>
            {pending.cancelLabel}
          </button>
          <button
            type="button"
            className={pending.danger ? "danger confirm-danger-btn" : "primary"}
            onClick={() => resolveConfirm(true)}
            autoFocus
          >
            {pending.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
