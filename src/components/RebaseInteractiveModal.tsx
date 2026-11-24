import { useState } from "react";
import type { CommitInfo } from "../types";

export type RebaseAction = "pick" | "squash" | "fixup" | "drop";

export interface RebaseTodoRow {
  action: RebaseAction;
  hash: string;
  shortHash: string;
  subject: string;
}

interface Props {
  onto: string;
  rows: RebaseTodoRow[];
  busy?: boolean;
  onChange: (rows: RebaseTodoRow[]) => void;
  onCancel: () => void;
  onConfirm: () => void;
}

export function commitsToRebaseRows(commits: CommitInfo[]): RebaseTodoRow[] {
  return commits.map((c) => ({
    action: "pick" as const,
    hash: c.hash,
    shortHash: c.shortHash,
    subject: c.subject,
  }));
}

export function RebaseInteractiveModal({
  onto,
  rows,
  busy = false,
  onChange,
  onCancel,
  onConfirm,
}: Props) {
  const [error, setError] = useState<string | null>(null);

  function move(index: number, dir: -1 | 1) {
    const j = index + dir;
    if (j < 0 || j >= rows.length) return;
    const next = rows.slice();
    const tmp = next[index]!;
    next[index] = next[j]!;
    next[j] = tmp;
    onChange(next);
  }

  function setAction(index: number, action: RebaseAction) {
    const next = rows.slice();
    next[index] = { ...next[index]!, action };
    onChange(next);
  }

  function validateAndConfirm() {
    const kept = rows.filter((r) => r.action !== "drop");
    if (kept.length === 0) {
      setError("请至少保留一个提交（不能全部丢弃）");
      return;
    }
    if (kept[0]!.action !== "pick") {
      setError("第一条有效提交必须是 pick");
      return;
    }
    setError(null);
    onConfirm();
  }

  return (
    <div className="modal-mask" onClick={onCancel}>
      <div
        className="modal sync-modal rebase-interactive-modal"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <h3>交互变基到「{onto}」</h3>
        <p className="muted small">
          调整顺序与动作后开始。支持 pick / squash / fixup / drop。若出现冲突，仍用顶部「继续 / 放弃」。
        </p>
        {rows.length === 0 ? (
          <p className="muted">相对该分支没有可回放的提交。</p>
        ) : (
          <ul className="rebase-todo-list">
            {rows.map((row, index) => (
              <li key={row.hash} className="rebase-todo-row">
                <select
                  value={row.action}
                  disabled={busy}
                  onChange={(e) =>
                    setAction(index, e.target.value as RebaseAction)
                  }
                >
                  <option value="pick">pick</option>
                  <option value="squash">squash</option>
                  <option value="fixup">fixup</option>
                  <option value="drop">drop</option>
                </select>
                <span className="hash commit-hash">{row.shortHash}</span>
                <span className="rebase-todo-subject" title={row.subject}>
                  {row.subject}
                </span>
                <span className="row-actions">
                  <button
                    type="button"
                    className="pane-btn pane-btn--sm"
                    disabled={busy || index === 0}
                    onClick={() => move(index, -1)}
                  >
                    上移
                  </button>
                  <button
                    type="button"
                    className="pane-btn pane-btn--sm"
                    disabled={busy || index === rows.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    下移
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
        {error && <p className="error-text">{error}</p>}
        <div className="modal-actions">
          <button type="button" disabled={busy} onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy || rows.length === 0}
            onClick={validateAndConfirm}
          >
            开始变基
          </button>
        </div>
      </div>
    </div>
  );
}
