import { useMemo } from "react";
import { buildHunkPatch, parseUnifiedDiff } from "../hunks";
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
  onApplyHunk?: (patch: string, reverse: boolean) => void;
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
}: Props) {
  const parsed = useMemo(
    () => (allowHunks && text.trim() ? parseUnifiedDiff(text) : null),
    [allowHunks, text],
  );

  if (!path) {
    return (
      <div className="panel empty">
        <p>选择左侧一个文件查看差异</p>
        <p className="muted small">
          {hasChanges
            ? "可暂存、取消暂存或放弃改动；选中文件后这里显示具体改动。未暂存改动可按块暂存。"
            : "当前没有未提交改动。修改项目文件后点「刷新」，或直接在资源管理器里保存后再回来。"}
        </p>
      </div>
    );
  }

  return (
    <div className="panel diff-panel">
      <div className="panel-header">
        <strong>{path}</strong>
        <span className="muted">
          {staged ? "已暂存" : "未暂存"}
          {parsed && onApplyHunk ? " · 可按块操作" : ""}
        </span>
      </div>
      {loading ? (
        <p className="muted pad">加载中…</p>
      ) : parsed && onApplyHunk ? (
        <div className="hunk-list">
          {parsed.hunks.map((hunk, index) => (
            <div key={`${hunk.header}-${index}`} className="hunk-block">
              <div className="hunk-toolbar">
                <span className="muted small hunk-title">{hunk.header}</span>
                <button
                  type="button"
                  className={staged ? undefined : "primary"}
                  disabled={busy}
                  onClick={() =>
                    onApplyHunk(
                      buildHunkPatch(parsed.preamble, hunk),
                      staged,
                    )
                  }
                >
                  {staged ? "取消此块" : "暂存此块"}
                </button>
              </div>
              <DiffLines
                text={[hunk.header, ...hunk.lines].join("\n")}
                empty="空块"
              />
            </div>
          ))}
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
