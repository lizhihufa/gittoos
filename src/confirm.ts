export type ConfirmOptions = {
  title?: string;
  /** Emphasize destructive action (red confirm button). */
  danger?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
};

type PendingConfirm = {
  id: number;
  title: string;
  message: string;
  danger: boolean;
  confirmLabel: string;
  cancelLabel: string;
  resolve: (ok: boolean) => void;
};

let seq = 0;
let pending: PendingConfirm | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

/** Subscribe to pending confirm changes (used by in-app dialog host). */
export function subscribeConfirm(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getPendingConfirm(): PendingConfirm | null {
  return pending;
}

export function resolveConfirm(ok: boolean) {
  const current = pending;
  pending = null;
  notify();
  current?.resolve(ok);
}

/**
 * In-app confirm dialog (matches 青枝 UI). Replaces system/native prompts.
 */
export function confirmAction(
  message: string,
  titleOrOptions: string | ConfirmOptions = "请确认",
  maybeOptions?: ConfirmOptions,
): Promise<boolean> {
  const options: ConfirmOptions =
    typeof titleOrOptions === "string"
      ? { title: titleOrOptions, ...maybeOptions }
      : titleOrOptions;

  // If a dialog is already open, cancel it first so callers don't hang.
  if (pending) {
    const prev = pending;
    pending = null;
    prev.resolve(false);
  }

  return new Promise<boolean>((resolve) => {
    seq += 1;
    pending = {
      id: seq,
      title: options.title?.trim() || "请确认",
      message,
      danger: Boolean(options.danger),
      confirmLabel: options.confirmLabel?.trim() || (options.danger ? "确定" : "确定"),
      cancelLabel: options.cancelLabel?.trim() || "取消",
      resolve,
    };
    notify();
  });
}

/** Fire-and-forget confirm then run callback. */
export function withConfirm(
  message: string,
  then: () => void,
  titleOrOptions: string | ConfirmOptions = "请确认",
): void {
  void confirmAction(message, titleOrOptions).then((ok) => {
    if (ok) then();
  });
}
