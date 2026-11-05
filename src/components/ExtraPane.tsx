import { useMemo } from "react";
import { layoutCommitGraph, parseRefBadges } from "../commitGraph";
import type { CommitInfo, StashInfo, TagInfo } from "../types";
import { DiffLines } from "./DiffLines";
import { DiffView } from "./DiffView";
import { Terminal } from "./Terminal";

export type Pane = "diff" | "history" | "stash" | "tags" | "terminal";

interface Props {
  pane: Pane;
  onPane: (pane: Pane) => void;
  diffPath: string | null;
  diffStaged: boolean;
  diffText: string;
  diffLoading: boolean;
  hasChanges?: boolean;
  allowHunks?: boolean;
  onApplyHunk?: (patch: string, reverse: boolean) => void;
  showCommitGraph?: boolean;
  commits: CommitInfo[];
  selectedHash: string | null;
  commitPatch: string;
  patchLoading: boolean;
  onSelectCommit: (hash: string) => void;
  onCherryPick: (hash: string) => void;
  onResetCommit: (commit: CommitInfo) => void;
  stashes: StashInfo[];
  stashMessage: string;
  onStashMessage: (value: string) => void;
  stashIncludeUntracked: boolean;
  onStashIncludeUntracked: (value: boolean) => void;
  onStash: () => void;
  onPopStash: (index: number) => void;
  onDropStash: (index: number) => void;
  tags: TagInfo[];
  tagName: string;
  onTagName: (value: string) => void;
  onCreateTag: () => void;
  onPushTag: (name: string) => void;
  onPushAllTags: () => void;
  onDeleteTag: (name: string) => void;
  onDeleteRemoteTag: (name: string) => void;
  terminalText: string;
  onClearTerminal: () => void;
  onRunCommand: (line: string) => void;
  busy: boolean;
}

export function ExtraPane(props: Props) {
  const graphRows = useMemo(() => {
    // Only build the graph while History is open — avoids work on every refresh.
    if (props.pane !== "history") return [];
    if (props.showCommitGraph === false) {
      return props.commits.map((commit) => ({
        commit,
        lane: 0,
        through: [0],
        width: 1,
      }));
    }
    return layoutCommitGraph(props.commits);
  }, [props.commits, props.showCommitGraph, props.pane]);

  return (
    <section className="extra">
      <div className="tabs">
        {(
          [
            ["diff", "差异"],
            ["history", "历史"],
            ["stash", "储藏"],
            ["tags", "标签"],
            ["terminal", "终端"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={props.pane === id ? "tab active" : "tab"}
            onClick={() => props.onPane(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {props.pane === "diff" && (
        <DiffView
          path={props.diffPath}
          staged={props.diffStaged}
          text={props.diffText}
          loading={props.diffLoading}
          hasChanges={props.hasChanges}
          busy={props.busy}
          allowHunks={props.allowHunks}
          onApplyHunk={props.onApplyHunk}
        />
      )}
      {props.pane === "history" && (
        <div className="split-pane">
          <ul className="record-list commit-graph-list">
            {props.commits.length === 0 && (
              <li className="muted pad">
                还没有提交。先在左侧暂存文件，填写说明后点「提交」。
              </li>
            )}
            {graphRows.map((row) => {
              const badges = parseRefBadges(row.commit.refs);
              const colW = 12;
              const width = Math.max(row.width, 1) * colW + 8;
              return (
                <li key={row.commit.hash} className="commit-row">
                  <button
                    type="button"
                    className={
                      props.selectedHash === row.commit.hash ? "active" : ""
                    }
                    onClick={() => props.onSelectCommit(row.commit.hash)}
                  >
                    {props.showCommitGraph !== false && (
                      <span
                        className="graph-cell"
                        style={{ width }}
                        aria-hidden
                      >
                        {Array.from({ length: row.width }, (_, i) => {
                          const active = row.through.includes(i);
                          const isNode = i === row.lane;
                          return (
                            <span
                              key={i}
                              className={[
                                "graph-lane",
                                active ? "is-active" : "",
                                isNode ? "is-node" : "",
                              ]
                                .filter(Boolean)
                                .join(" ")}
                              style={{
                                left: i * colW + 4,
                                ["--lane-color" as string]: laneColor(i),
                              }}
                            />
                          );
                        })}
                      </span>
                    )}
                    <span className="hash">{row.commit.shortHash}</span>
                    <span className="subject">
                      {row.commit.subject}
                      {badges.length > 0 && (
                        <span className="ref-badges">
                          {badges.map((b) => (
                            <span key={b} className="ref-badge">
                              {b}
                            </span>
                          ))}
                        </span>
                      )}
                    </span>
                    <span className="muted small">
                      {row.commit.date} · {row.commit.author}
                    </span>
                  </button>
                  <span className="row-actions history-actions">
                    <button
                      type="button"
                      className="mini"
                      disabled={props.busy}
                      title="把该提交应用到当前分支"
                      onClick={() => props.onCherryPick(row.commit.hash)}
                    >
                      拣选
                    </button>
                    <button
                      type="button"
                      className="mini"
                      disabled={props.busy}
                      title="把当前分支重置到此提交"
                      onClick={() => props.onResetCommit(row.commit)}
                    >
                      重置
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
          {props.patchLoading ? (
            <p className="muted pad">加载中…</p>
          ) : props.selectedHash ? (
            <DiffLines
              className="diff patch"
              text={props.commitPatch}
              empty="该提交没有可显示的补丁内容"
            />
          ) : (
            <p className="muted pad">选择左侧一条提交，查看改动内容</p>
          )}
        </div>
      )}
      {props.pane === "stash" && (
        <div className="panel pad-block">
          <div className="new-branch">
            <input
              value={props.stashMessage}
              onChange={(e) => props.onStashMessage(e.target.value)}
              placeholder="储藏说明，可留空"
            />
            <button
              type="button"
              className="primary"
              disabled={props.busy}
              onClick={props.onStash}
            >
              储藏
            </button>
          </div>
          <label className="check stash-option">
            <input
              type="checkbox"
              checked={props.stashIncludeUntracked}
              onChange={(e) => props.onStashIncludeUntracked(e.target.checked)}
              disabled={props.busy}
            />
            同时储藏未跟踪的新文件
          </label>
          <ul className="record-list">
            {props.stashes.length === 0 && (
              <li className="muted pad">
                没有储藏。有未完成的改动时，可先点「储藏」暂存现场。
              </li>
            )}
            {props.stashes.map((stash) => (
              <li key={stash.index} className="stash-row">
                <span>
                  stash@{`{${stash.index}}`} {stash.message}
                </span>
                <span className="row-actions">
                  <button
                    type="button"
                    disabled={props.busy}
                    onClick={() => props.onPopStash(stash.index)}
                  >
                    弹出
                  </button>
                  <button
                    type="button"
                    className="danger"
                    disabled={props.busy}
                    onClick={() => props.onDropStash(stash.index)}
                  >
                    丢弃
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {props.pane === "tags" && (
        <div className="panel pad-block">
          <div className="new-branch">
            <input
              value={props.tagName}
              onChange={(e) => props.onTagName(e.target.value)}
              placeholder="新标签名"
            />
            <button
              type="button"
              className="primary"
              disabled={props.busy || !props.tagName.trim()}
              onClick={props.onCreateTag}
            >
              创建
            </button>
            <button
              type="button"
              disabled={props.busy || props.tags.length === 0}
              onClick={props.onPushAllTags}
              title="推送全部标签到远程"
            >
              推送全部
            </button>
          </div>
          <ul className="record-list">
            {props.tags.length === 0 && (
              <li className="muted pad">还没有标签。</li>
            )}
            {props.tags.map((tag) => (
              <li key={tag.name} className="stash-row">
                <span>
                  {tag.name}{" "}
                  <span className="muted small">{tag.tip}</span>
                </span>
                <span className="row-actions">
                  <button
                    type="button"
                    disabled={props.busy}
                    onClick={() => props.onPushTag(tag.name)}
                  >
                    推送
                  </button>
                  <button
                    type="button"
                    className="danger"
                    disabled={props.busy}
                    onClick={() => props.onDeleteTag(tag.name)}
                  >
                    删除
                  </button>
                  <button
                    type="button"
                    className="danger"
                    disabled={props.busy}
                    title="删除远程同名标签"
                    onClick={() => props.onDeleteRemoteTag(tag.name)}
                  >
                    删远程
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {props.pane === "terminal" && (
        <Terminal
          text={props.terminalText}
          onClear={props.onClearTerminal}
          onRun={props.onRunCommand}
          busy={props.busy}
          embedded
        />
      )}
    </section>
  );
}

function laneColor(index: number): string {
  const colors = ["#0f6b4c", "#355c7d", "#9b2c2c", "#8a5a00", "#5b4b8a", "#2a6f7f"];
  return colors[index % colors.length];
}
