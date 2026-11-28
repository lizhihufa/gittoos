import { useEffect, useMemo, useState } from "react";
import {
  bothSides,
  buildResolvedContent,
  parseConflicts,
  type ConflictSegment,
} from "../conflictParse";

interface Props {
  path: string;
  content: string;
  busy?: boolean;
  onSave: (resolved: string, stage: boolean) => void;
  onCancel?: () => void;
}

export function ConflictEditor({
  path,
  content,
  busy = false,
  onSave,
  onCancel,
}: Props) {
  const parsed = useMemo(() => parseConflicts(content), [content]);
  const [resolutions, setResolutions] = useState<Array<string | null>>([]);
  const [manual, setManual] = useState<Record<number, string>>({});

  useEffect(() => {
    setResolutions(Array(parsed.conflictCount).fill(null));
    setManual({});
  }, [content, parsed.conflictCount]);

  const remaining = resolutions.filter((r) => r === null).length;
  const conflicts = parsed.segments.filter(
    (s): s is Extract<ConflictSegment, { kind: "conflict" }> =>
      s.kind === "conflict",
  );

  function setResolution(index: number, value: string) {
    setResolutions((prev) => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
  }

  function save(stage: boolean) {
    const built = buildResolvedContent(parsed.segments, resolutions);
    if (built === null) return;
    onSave(built, stage);
  }

  if (parsed.conflictCount === 0) {
    return (
      <div className="panel pad-block conflict-editor">
        <div className="history-detail-head">
          <strong>冲突编辑 · {path}</strong>
          {onCancel && (
            <button type="button" className="pane-btn pane-btn--sm" onClick={onCancel}>
              返回差异
            </button>
          )}
        </div>
        <p className="muted pad">
          未检测到冲突标记。若已手工解决，可直接暂存该文件后点「继续」。
        </p>
        <div className="row-actions pad">
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => onSave(content, true)}
          >
            暂存当前文件
          </button>
        </div>
      </div>
    );
  }

  let conflictIndex = -1;
  const done = parsed.conflictCount - remaining;
  const progressPct =
    parsed.conflictCount > 0
      ? Math.round((done / parsed.conflictCount) * 100)
      : 100;

  return (
    <div className="panel conflict-editor">
      <div className="history-detail-head">
        <strong>
          冲突编辑 · {path}
          <span className="muted small">
            {" "}
            · 剩余 {remaining} / {parsed.conflictCount}
          </span>
        </strong>
        <span className="row-actions">
          {onCancel && (
            <button
              type="button"
              className="pane-btn pane-btn--sm"
              disabled={busy}
              onClick={onCancel}
            >
              取消
            </button>
          )}
          <button
            type="button"
            className="primary"
            disabled={busy || remaining > 0}
            title={remaining > 0 ? "请先处理每一处冲突" : undefined}
            onClick={() => save(true)}
          >
            保存并暂存
          </button>
          <button
            type="button"
            disabled={busy || remaining > 0}
            onClick={() => save(false)}
          >
            仅保存
          </button>
        </span>
      </div>
      <div className="conflict-progress" aria-label="冲突处理进度">
        <div className="conflict-progress-meta">
          <span>已处理 {done}/{parsed.conflictCount}</span>
          <span className="muted">{progressPct}%</span>
        </div>
        <div className="conflict-progress-track">
          <i style={{ width: `${progressPct}%` }} />
        </div>
        <div className="conflict-minimap" aria-hidden>
          {conflicts.map((_, i) => (
            <span
              key={i}
              className={
                resolutions[i] !== null
                  ? "conflict-minimap-dot is-done"
                  : "conflict-minimap-dot"
              }
              title={`冲突 #${i + 1}`}
            />
          ))}
        </div>
      </div>
      <div className="conflict-editor-body">
        {parsed.segments.map((seg, segIdx) => {
          if (seg.kind === "text") {
            if (!seg.text) return null;
            return (
              <pre key={`t-${segIdx}`} className="conflict-text">
                {seg.text}
              </pre>
            );
          }
          conflictIndex += 1;
          const idx = conflictIndex;
          const resolved = resolutions[idx];
          const draft = manual[idx] ?? resolved ?? seg.ours;
          const oursLines = seg.ours ? seg.ours.split("\n").length : 0;
          const theirsLines = seg.theirs ? seg.theirs.split("\n").length : 0;
          const baseLines =
            seg.base !== null
              ? seg.base
                ? seg.base.split("\n").length
                : 0
              : null;
          const lineMax = Math.max(1, oursLines, theirsLines, baseLines ?? 0);
          return (
            <div
              key={`c-${segIdx}`}
              className={
                "conflict-block" + (resolved !== null ? " is-resolved" : "")
              }
            >
              <div className="conflict-block-head">
                <strong>冲突 #{idx + 1}</strong>
                <span className="row-actions">
                  <button
                    type="button"
                    className="pane-btn pane-btn--sm"
                    disabled={busy}
                    onClick={() => setResolution(idx, seg.ours)}
                  >
                    用当前（{seg.oursLabel}）
                  </button>
                  <button
                    type="button"
                    className="pane-btn pane-btn--sm"
                    disabled={busy}
                    onClick={() => setResolution(idx, seg.theirs)}
                  >
                    用传入（{seg.theirsLabel}）
                  </button>
                  <button
                    type="button"
                    className="pane-btn pane-btn--sm"
                    disabled={busy}
                    onClick={() =>
                      setResolution(idx, bothSides(seg.ours, seg.theirs))
                    }
                  >
                    两边都要
                  </button>
                </span>
              </div>
              <div className="conflict-size-bars" aria-hidden>
                <div className="conflict-size-row is-ours" title={`当前 ${oursLines} 行`}>
                  <span>当前</span>
                  <i style={{ width: `${(oursLines / lineMax) * 100}%` }} />
                  <em>{oursLines}</em>
                </div>
                {baseLines !== null ? (
                  <div className="conflict-size-row is-base" title={`祖先 ${baseLines} 行`}>
                    <span>祖先</span>
                    <i style={{ width: `${(baseLines / lineMax) * 100}%` }} />
                    <em>{baseLines}</em>
                  </div>
                ) : null}
                <div className="conflict-size-row is-theirs" title={`传入 ${theirsLines} 行`}>
                  <span>传入</span>
                  <i style={{ width: `${(theirsLines / lineMax) * 100}%` }} />
                  <em>{theirsLines}</em>
                </div>
              </div>
              <div className="conflict-cols">
                <div className="conflict-col is-ours">
                  <div className="muted small">当前 · {seg.oursLabel}</div>
                  <pre>{seg.ours || "（空）"}</pre>
                </div>
                {seg.base !== null && (
                  <div className="conflict-col is-base">
                    <div className="muted small">共同祖先</div>
                    <pre>{seg.base || "（空）"}</pre>
                  </div>
                )}
                <div className="conflict-col is-theirs">
                  <div className="muted small">传入 · {seg.theirsLabel}</div>
                  <pre>{seg.theirs || "（空）"}</pre>
                </div>
              </div>
              <label className="conflict-manual">
                <span className="muted small">手工结果（可改）</span>
                <textarea
                  value={draft}
                  disabled={busy}
                  rows={Math.min(12, Math.max(3, draft.split("\n").length + 1))}
                  onChange={(e) => {
                    const v = e.target.value;
                    setManual((prev) => ({ ...prev, [idx]: v }));
                    setResolution(idx, v);
                  }}
                />
              </label>
              {resolved !== null && (
                <div className="muted small conflict-resolved-flag">已选定</div>
              )}
            </div>
          );
        })}
      </div>
      {conflicts.length > 0 && (
        <div className="conflict-editor-foot row-actions">
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              setResolutions(conflicts.map((c) => c.ours))
            }
          >
            全部用当前
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              setResolutions(conflicts.map((c) => c.theirs))
            }
          >
            全部用传入
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy || remaining > 0}
            onClick={() => save(true)}
          >
            保存并暂存
          </button>
        </div>
      )}
    </div>
  );
}
