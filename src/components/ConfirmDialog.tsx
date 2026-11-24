import { useEffect, useState } from "react";
import {
  getPendingConfirm,
  resolveConfirm,
  subscribeConfirm,
} from "../confirm";

export function ConfirmDialog() {
  const [, bump] = useState(0);
  const [phrase, setPhrase] = useState("");

  useEffect(() => subscribeConfirm(() => bump((n) => n + 1)), []);

  const pending = getPendingConfirm();

  useEffect(() => {
    setPhrase("");
  }, [pending?.id]);

  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        resolveConfirm(false);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        if (pending.requirePhrase && phrase.trim() !== pending.requirePhrase) {
          return;
        }
        // Don't steal Enter while typing in the phrase box unless phrase matches
        // (handled above). Still prevent default for confirm.
        if (
          e.target instanceof HTMLInputElement &&
          pending.requirePhrase &&
          phrase.trim() !== pending.requirePhrase
        ) {
          return;
        }
        e.preventDefault();
        resolveConfirm(true);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [pending, phrase]);

  if (!pending) return null;

  const lines = pending.message
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  const phraseOk =
    !pending.requirePhrase || phrase.trim() === pending.requirePhrase;

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
            <p
              key={`${pending.id}-${i}`}
              className={i === 0 ? "" : "muted small"}
            >
              {line}
            </p>
          ))}
          {pending.requirePhrase && (
            <label className="confirm-phrase">
              <span className="muted small">
                {pending.phraseHint ||
                  `请输入「${pending.requirePhrase}」以确认`}
              </span>
              <input
                autoFocus
                value={phrase}
                onChange={(e) => setPhrase(e.target.value)}
                placeholder={pending.requirePhrase}
                spellCheck={false}
                autoComplete="off"
              />
            </label>
          )}
        </div>
        <div className="modal-actions">
          <button type="button" onClick={() => resolveConfirm(false)}>
            {pending.cancelLabel}
          </button>
          <button
            type="button"
            className={pending.danger ? "danger confirm-danger-btn" : "primary"}
            disabled={!phraseOk}
            onClick={() => resolveConfirm(true)}
            autoFocus={!pending.requirePhrase}
          >
            {pending.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
