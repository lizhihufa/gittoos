import { useEffect, useMemo, useState } from "react";
import {
  buildHunkPatch,
  buildPartialHunkPatch,
  isChangeLine,
  parseUnifiedDiff,
  type DiffHunk,
} from "../hunks";
import { DiffLines } from "./DiffLines";

interface Props {
  path: string | null;
  staged: boolean;
  text: string;
  loading: boolean;
  hasChanges?: boolean;
  busy?: boolean;
  /** Whole-file untracked etc. — hide hunk actions. */
  allowHunks?: boolean;
  /** Return false (or throw) to keep line selection after failure. */
  onApplyHunk?: (
    patch: string,
    reverse: boolean,
  ) => void | boolean | Promise<void | boolean>;
  /** Discard an unstaged hunk / lines from the working tree. */
  onDiscardHunk?: (
    patch: string,
  ) => void | boolean | Promise<void | boolean>;
  onBlame?: () => void;
}

export function DiffView({
  path,
  staged,
  text,
  loading,
  hasChanges = false,
  busy = false,
  allowHunks = true,
  onApplyHunk,
  onDiscardHunk,
  onBlame,
}: Props) {
  const parsed = useMemo(
    () => (allowHunks && text.trim() ? parseUnifiedDiff(text) : null),
    [allowHunks, text],
  );

  /** Selected change-line indices per hunk. */
  const [selected, setSelected] = useState<Record<number, Set<number>>>({});
  const [anchor, setAnchor] = useState<{ hunk: number; line: number } | null>(
    null,
  );

  useEffect(() => {
    setSelected({});
    setAnchor(null);
  }, [path, staged, text]);

  if (!path) {
    return (
      <div className="panel empty">
        <p>选择左侧一个文件查看差异</p>
        <p className="muted small">
          {hasChanges
            ? "可暂存、取消暂存或放弃改动；选中文件后这里显示具体改动。未暂存改动可按块或按行操作。"
            : "当前没有未提交改动。修改项目文件后点「刷新」，或直接在资源管理器里保存后再回来。"}
        </p>
      </div>
    );
  }

  function toggleLine(hunkIndex: number, lineIndex: number, shift: boolean) {
    if (busy) return;
    setSelected((prev) => {
      const next = { ...prev };
      const current = new Set(next[hunkIndex] ?? []);
      if (shift && anchor && anchor.hunk === hunkIndex) {
        const lo = Math.min(anchor.line, lineIndex);
        const hi = Math.max(anchor.line, lineIndex);
        const hunk = parsed?.hunks[hunkIndex];
        if (hunk) {
          for (let i = lo; i <= hi; i++) {
            if (isChangeLine(hunk.lines[i] ?? "")) current.add(i);
          }
        }
      } else if (current.has(lineIndex)) {
        current.delete(lineIndex);
      } else {
        current.add(lineIndex);
      }
      if (current.size === 0) delete next[hunkIndex];
      else next[hunkIndex] = current;
      return next;
    });
    if (!shift) setAnchor({ hunk: hunkIndex, line: lineIndex });
  }

  function clearHunkSelection(hunkIndex: number) {
    setSelected((prev) => {
      if (!(hunkIndex in prev)) return prev;
      const next = { ...prev };
      delete next[hunkIndex];
      return next;
    });
  }

  async function applyPartial(
    hunkIndex: number,
    hunk: DiffHunk,
    action: "apply" | "discard",
  ) {
    if (!parsed || !onApplyHunk || busy) return;
    const indices = selected[hunkIndex];
    if (!indices || indices.size === 0) return;
    const patch = buildPartialHunkPatch(parsed.preamble, hunk, indices);
    if (!patch) return;
    try {
      const result =
        action === "discard"
          ? await onDiscardHunk?.(patch)
          : await onApplyHunk(patch, staged);
      if (result === false) return;
      clearHunkSelection(hunkIndex);
    } catch {
      // Keep selection so the user can retry after fixing the error.
    }
  }

  return (
    <div className="panel diff-panel">
      <div className="panel-header">
        <strong>{path}</strong>
        <span className="row-actions">
          <span className="muted">
            {staged ? "已暂存" : "未暂存"}
            {parsed && onApplyHunk ? " · 可按块/按行操作" : ""}
          </span>
          {onBlame && (
            <button
              type="button"
              className="pane-btn pane-btn--sm"
              disabled={busy}
              title="查看各行最后修改的提交"
              onClick={onBlame}
            >
              追溯
            </button>
          )}
        </span>
      </div>
      {loading ? (
        <p className="muted pad">加载中…</p>
      ) : parsed && onApplyHunk ? (
        <div className="hunk-list">
          <p className="muted small hunk-hint">
            点击 +/- 行可选中；Shift+点击连选。选中后可只操作这些行。
          </p>
          {parsed.hunks.map((hunk, hunkIndex) => {
            const sel = selected[hunkIndex];
            const selCount = sel?.size ?? 0;
            return (
              <div key={`${hunk.header}-${hunkIndex}`} className="hunk-block">
                <div className="hunk-toolbar">
                  <span className="muted small hunk-title">{hunk.header}</span>
                  <span className="hunk-actions">
                    {selCount > 0 ? (
                      <>
                        <button
                          type="button"
                          className={staged ? undefined : "primary"}
                          disabled={busy}
                          onClick={() =>
                            void applyPartial(hunkIndex, hunk, "apply")
                          }
                        >
                          {staged
                            ? `取消所选 (${selCount})`
                            : `暂存所选 (${selCount})`}
                        </button>
                        {!staged && onDiscardHunk && (
                          <button
                            type="button"
                            className="danger"
                            disabled={busy}
                            title="从工作区丢弃所选行"
                            onClick={() =>
                              void applyPartial(hunkIndex, hunk, "discard")
                            }
                          >
                            放弃所选
                          </button>
                        )}
                        <button
                          type="button"
                          className="pane-btn pane-btn--sm"
                          disabled={busy}
                          onClick={() => clearHunkSelection(hunkIndex)}
                        >
                          清除选择
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className={staged ? undefined : "primary"}
                          disabled={busy}
                          onClick={() =>
                            void onApplyHunk(
                              buildHunkPatch(parsed.preamble, hunk),
                              staged,
                            )
                          }
                        >
                          {staged ? "取消此块" : "暂存此块"}
                        </button>
                        {!staged && onDiscardHunk && (
                          <button
                            type="button"
                            className="danger"
                            disabled={busy}
                            title="从工作区丢弃此块改动"
                            onClick={() =>
                              void onDiscardHunk(
                                buildHunkPatch(parsed.preamble, hunk),
                              )
                            }
                          >
                            放弃此块
                          </button>
                        )}
                      </>
                    )}
                  </span>
                </div>
                <pre className="diff hunk-lines">
                  {hunk.lines.map((line, lineIndex) => {
                    const change = isChangeLine(line);
                    const isSel = Boolean(sel?.has(lineIndex));
                    const cls = [
                      lineClass(line),
                      change ? "diff-line--change" : "",
                      isSel ? "diff-line--selected" : "",
                    ]
                      .filter(Boolean)
                      .join(" ");
                    if (!change) {
                      return (
                        <span key={lineIndex} className={cls}>
                          {line || " "}
                          {"\n"}
                        </span>
                      );
                    }
                    return (
                      <button
                        key={lineIndex}
                        type="button"
                        className={`diff-line-btn ${cls}`}
                        disabled={busy}
                        title="点击选中/取消；Shift+点击连选"
                        onClick={(e) =>
                          toggleLine(hunkIndex, lineIndex, e.shiftKey)
                        }
                      >
                        {line || " "}
                      </button>
                    );
                  })}
                </pre>
              </div>
            );
          })}
        </div>
      ) : (
        <DiffLines
          text={text}
          empty="无文本差异（可能是二进制、新建或仅模式变更）"
        />
      )}
    </div>
  );
}

function lineClass(line: string): string {
  if (line.startsWith("+") && !line.startsWith("+++")) return "add";
  if (line.startsWith("-") && !line.startsWith("---")) return "del";
  if (line.startsWith("@@")) return "hunk";
  return "";
}
