import { useEffect, useState } from "react";
import { withConfirm } from "../confirm";
import type { FileChange } from "../types";

interface Props {
  title: string;
  /** Stable id for remembering collapse state (e.g. unstaged / staged). */
  sectionId: string;
  /** Sticky offset so multiple section headers can stack while scrolling. */
  stickyTop?: string;
  files: FileChange[];
  selected: string | null;
  stagedSection: boolean;
  busy?: boolean;
  onSelect: (path: string, staged: boolean) => void;
  onStage?: (paths: string[]) => void;
  onUnstage?: (paths: string[]) => void;
  onDiscard?: (paths: string[]) => void;
}

function collapseKey(sectionId: string) {
  return `gittool.collapse.${sectionId}`;
}

function loadCollapsed(sectionId: string): boolean {
  try {
    return sessionStorage.getItem(collapseKey(sectionId)) === "1";
  } catch {
    return false;
  }
}

function saveCollapsed(sectionId: string, collapsed: boolean) {
  try {
    sessionStorage.setItem(collapseKey(sectionId), collapsed ? "1" : "0");
  } catch {
    // ignore
  }
}

export function ChangeList({
  title,
  sectionId,
  stickyTop = "0",
  files,
  selected,
  stagedSection,
  busy = false,
  onSelect,
  onStage,
  onUnstage,
  onDiscard,
}: Props) {
  const [collapsed, setCollapsed] = useState(() => loadCollapsed(sectionId));

  useEffect(() => {
    saveCollapsed(sectionId, collapsed);
  }, [sectionId, collapsed]);

  const toggle = () => setCollapsed((v) => !v);

  return (
    <div className={`change-group${collapsed ? " is-collapsed" : ""}`}>
      <div
        className="group-header sticky-group-header"
        style={{ top: stickyTop }}
      >
        <button
          type="button"
          className="group-toggle"
          onClick={toggle}
          aria-expanded={!collapsed}
          title={collapsed ? "展开列表" : "收起列表"}
        >
          <span className="group-chevron" aria-hidden>
            {collapsed ? "▸" : "▾"}
          </span>
          <span>
            {title} ({files.length})
          </span>
        </button>
        <div className="row-actions">
          {onStage && files.length > 0 && !collapsed && (
            <button
              type="button"
              disabled={busy}
              title="全部暂存（Ctrl+S）"
              onClick={() => onStage(files.map((f) => f.path))}
            >
              全部暂存
            </button>
          )}
          {onUnstage && files.length > 0 && !collapsed && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onUnstage(files.map((f) => f.path))}
            >
              全部取消
            </button>
          )}
        </div>
      </div>
      {!collapsed &&
        (files.length === 0 ? (
          <p className="muted small pad">
            {stagedSection ? "暂无已暂存文件" : "暂无未暂存改动"}
          </p>
        ) : (
          <ul className="file-list">
            {files.map((file) => (
              <li
                key={`${stagedSection ? "s" : "u"}:${file.path}`}
                className={[
                  selected === file.path ? "active" : "",
                  file.conflicted ? "is-conflict-row" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                <button
                  type="button"
                  className="file-btn"
                  onClick={() => onSelect(file.path, stagedSection)}
                >
                  <span className={`status ${statusClass(file)}`}>
                    {statusLabel(file, stagedSection)}
                  </span>
                  <span className="path">{file.path}</span>
                </button>
                <div className="row-actions">
                  {onStage && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onStage([file.path])}
                    >
                      暂存
                    </button>
                  )}
                  {onUnstage && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onUnstage([file.path])}
                    >
                      取消
                    </button>
                  )}
                  {onDiscard && !file.conflicted && (
                    <button
                      type="button"
                      className="danger"
                      disabled={busy}
                      onClick={() =>
                        withConfirm(
                          file.untracked
                            ? `删除未跟踪文件 ${file.path}？`
                            : `放弃对 ${file.path} 的修改？`,
                          () => onDiscard([file.path]),
                        )
                      }
                    >
                      放弃
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}

function statusLabel(file: FileChange, stagedSection: boolean): string {
  if (file.conflicted) return "冲突";
  if (file.untracked) return "新建";

  const code = stagedSection ? file.status[0] : file.status[1] || file.status[0];
  switch (code) {
    case "A":
      return "新增";
    case "M":
      return "修改";
    case "D":
      return "删除";
    case "R":
      return "重命名";
    case "C":
      return "复制";
    case "U":
      return "冲突";
    case "?":
      return "新建";
    default:
      return file.status.trim() || "变更";
  }
}

function statusClass(file: FileChange): string {
  if (file.conflicted) return "is-conflict";
  if (file.untracked) return "is-new";
  const code = file.status.replace(/\./g, "").trim();
  if (code.includes("D")) return "is-del";
  if (code.includes("A") || code.includes("?")) return "is-new";
  if (code.includes("M")) return "is-mod";
  return "";
}
