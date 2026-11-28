import { useMemo, useState } from "react";
import {
  layoutCommitGraph,
  parseRefBadges,
  type GraphRow,
} from "../commitGraph";
import type { CommitInfo, ReflogInfo, StashInfo, TagInfo } from "../types";
import { ConflictEditor } from "./ConflictEditor";
import { DiffLines } from "./DiffLines";
import { DiffView, type DiffViewMode } from "./DiffView";
import { t as i18n } from "../i18n";
import {
  ReleaseManager,
  type ReleasePlatform,
} from "./ReleaseManager";
import { WikiManager } from "./WikiManager";
import {
  OverviewPane,
  type OverviewPlatform,
} from "./OverviewPane";
import { Terminal } from "./Terminal";
import type { BranchInfo, RepoStatus } from "../types";

export type Pane =
  | "overview"
  | "diff"
  | "history"
  | "stash"
  | "tags"
  | "terminal"
  | "releases"
  | "wiki";

interface Props {
  pane: Pane;
  onPane: (pane: Pane) => void;
  overviewStatus?: RepoStatus | null;
  overviewBranches?: BranchInfo[];
  overviewPlatform?: OverviewPlatform;
  onOverviewPlatform?: (p: OverviewPlatform) => void;
  overviewGithubOwner?: string;
  overviewGithubRepo?: string;
  overviewGiteeOwner?: string;
  overviewGiteeRepo?: string;
  overviewRepoPath?: string | null;
  diffPath: string | null;
  diffStaged: boolean;
  diffText: string;
  diffLoading: boolean;
  hasChanges?: boolean;
  allowHunks?: boolean;
  diffViewMode?: DiffViewMode;
  onDiffViewMode?: (mode: DiffViewMode) => void;
  onApplyHunk?: (
    patch: string,
    reverse: boolean,
  ) => void | boolean | Promise<void | boolean>;
  onDiscardHunk?: (
    patch: string,
  ) => void | boolean | Promise<void | boolean>;
  onBlame?: () => void;
  showCommitGraph?: boolean;
  commits: CommitInfo[];
  historyScope?: string | null;
  onClearHistoryScope?: () => void;
  selectedHash: string | null;
  commitPatch: string;
  patchLoading: boolean;
  onSelectCommit: (hash: string) => void;
  onCherryPick: (hash: string) => void;
  onRevert: (hash: string) => void;
  onCheckoutCommit: (commit: CommitInfo) => void;
  onResetCommit: (commit: CommitInfo) => void;
  stashes: StashInfo[];
  stashMessage: string;
  onStashMessage: (value: string) => void;
  stashIncludeUntracked: boolean;
  onStashIncludeUntracked: (value: boolean) => void;
  onStash: () => void;
  onPopStash: (index: number) => void;
  onApplyStash: (index: number) => void;
  onShowStash: (index: number) => void;
  onDropStash: (index: number) => void;
  stashPreview: string | null;
  onClearStashPreview: () => void;
  tags: TagInfo[];
  tagName: string;
  onTagName: (value: string) => void;
  tagMessage: string;
  onTagMessage: (value: string) => void;
  onCreateTag: () => void;
  onPushTag: (name: string) => void;
  onPushAllTags: () => void;
  onDeleteTag: (name: string) => void;
  onDeleteRemoteTag: (name: string) => void;
  compareLeft: string;
  compareRight: string;
  onCompareLeft: (value: string) => void;
  onCompareRight: (value: string) => void;
  onCompare: () => void;
  compareResult: string | null;
  showReflog?: boolean;
  reflogEntries?: ReflogInfo[];
  onToggleReflog?: () => void;
  onSelectReflog?: (entry: ReflogInfo) => void;
  blameText?: string | null;
  onClearBlame?: () => void;
  /** When set, diff pane shows the built-in conflict editor. */
  conflictContent?: string | null;
  conflictLoading?: boolean;
  onSaveConflict?: (content: string, stage: boolean) => void;
  onCloseConflict?: () => void;
  onOpenConflict?: () => void;
  fileConflicted?: boolean;
  terminalText: string;
  onClearTerminal: () => void;
  onRunCommand: (line: string) => void;
  busy: boolean;
  terminalWallpaperUrl?: string | null;
  terminalWallpaperKind?: "image" | "video" | "none";
  terminalWallpaperScrim?: number;
  releaseOwner: string;
  releaseRepo: string;
  releaseGiteeOwner: string;
  releaseGiteeRepo: string;
  releaseDefaultTag: string;
  releasePlatform: ReleasePlatform;
  onReleasePlatform: (p: ReleasePlatform) => void;
  githubLoggedIn: boolean;
  giteeLoggedIn: boolean;
  updateBusy: boolean;
  onUpdateBusy: (busy: boolean) => void;
  onNotice: (text: string | null) => void;
  onError: (text: string | null) => void;
  onOpenAuth: (provider: "github" | "gitee") => void;
  /** When false, Release pane actions are blocked (Settings → 权限). */
  releaseAllowed?: boolean;
  /** When false, Wiki pane actions are blocked (Settings → 权限). */
  wikiAllowed?: boolean;
  onFeatureDenied?: (feature: "release" | "wiki") => void;
  onConfigureReleaseRepo?: () => void;
  updateProgress: { percent: number; label: string } | null;
  wikiProgress?: { percent: number; label: string } | null;
  locale?: string;
}

export function ExtraPane(props: Props) {
  const [commitSearch, setCommitSearch] = useState("");
  const [hoverLane, setHoverLane] = useState<number | null>(null);
  const loc = props.locale || "zh-CN";

  const filteredCommits = useMemo(() => {
    const q = commitSearch.trim().toLowerCase();
    if (!q) return props.commits;
    return props.commits.filter((c) => {
      const hay = [
        c.subject,
        c.hash,
        c.shortHash,
        c.author,
        c.date,
        c.refs ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [props.commits, commitSearch]);

  const graphRows = useMemo(() => {
    // Only build the graph while History is open — avoids work on every refresh.
    if (props.pane !== "history") return [];
    if (props.showCommitGraph === false) {
      return filteredCommits.map(
        (commit): GraphRow => ({
          commit,
          lane: 0,
          through: [0],
          edges: [{ lane: 0 }],
          width: 1,
          isTip: false,
        }),
      );
    }
    return layoutCommitGraph(filteredCommits);
  }, [filteredCommits, props.showCommitGraph, props.pane]);

  return (
    <section className="extra">
      <div className="tabs">
        {(
          [
            ["overview", "pane.overview"],
            ["diff", "pane.diff"],
            ["history", "pane.history"],
            ["stash", "pane.stash"],
            ["tags", "pane.tags"],
            ["terminal", "pane.terminal"],
            ["releases", "pane.releases"],
            ["wiki", "pane.wiki"],
          ] as const
        ).map(([id, key]) => (
          <button
            key={id}
            type="button"
            className={props.pane === id ? "tab active" : "tab"}
            onClick={() => props.onPane(id)}
          >
            {i18n(loc, key)}
          </button>
        ))}
      </div>
      {props.pane === "overview" && (
        <OverviewPane
          status={props.overviewStatus ?? null}
          commits={props.commits}
          branches={props.overviewBranches ?? []}
          repoPath={props.overviewRepoPath ?? null}
          locale={loc}
          githubOwner={props.overviewGithubOwner ?? ""}
          githubRepo={props.overviewGithubRepo ?? ""}
          giteeOwner={props.overviewGiteeOwner ?? ""}
          giteeRepo={props.overviewGiteeRepo ?? ""}
          githubLoggedIn={props.githubLoggedIn}
          giteeLoggedIn={props.giteeLoggedIn}
          platform={props.overviewPlatform ?? "local"}
          onPlatform={(p) => props.onOverviewPlatform?.(p)}
          onOpenAuth={props.onOpenAuth}
        />
      )}
      {props.pane === "diff" &&
        (props.conflictLoading || props.conflictContent != null ? (
          props.conflictLoading || props.conflictContent == null ? (
            <p className="muted pad">正在加载冲突文件…</p>
          ) : (
            <ConflictEditor
              path={props.diffPath ?? ""}
              content={props.conflictContent}
              busy={props.busy}
              onSave={(content, stage) => props.onSaveConflict?.(content, stage)}
              onCancel={props.onCloseConflict}
            />
          )
        ) : props.blameText ? (
          <div className="panel pad-block blame-panel">
            <div className="history-detail-head">
              <strong>文件追溯（blame）</strong>
              <button
                type="button"
                className="pane-btn pane-btn--sm"
                onClick={props.onClearBlame}
              >
                关闭
              </button>
            </div>
            <DiffLines
              className="diff patch blame-text"
              text={props.blameText}
              empty="没有可显示的追溯内容"
            />
          </div>
        ) : (
          <>
            {props.fileConflicted && props.onOpenConflict && (
              <div className="conflict-open-bar">
                <span className="muted small">
                  该文件有合并冲突，可用内置编辑器处理标记。
                </span>
                <button
                  type="button"
                  className="primary"
                  disabled={props.busy}
                  onClick={props.onOpenConflict}
                >
                  打开冲突编辑器
                </button>
              </div>
            )}
            <DiffView
              path={props.diffPath}
              staged={props.diffStaged}
              text={props.diffText}
              loading={props.diffLoading}
              hasChanges={props.hasChanges}
              busy={props.busy}
              allowHunks={props.allowHunks}
              viewMode={props.diffViewMode}
              onViewMode={props.onDiffViewMode}
              onApplyHunk={props.onApplyHunk}
              onDiscardHunk={props.onDiscardHunk}
              onBlame={props.onBlame}
            />
          </>
        ))}
      {props.pane === "history" && (
        <div className="split-pane history-pane">
          <div className="history-list-pane">
            <div className="history-list-head">
              <strong>{props.showReflog ? "操作记录" : "提交记录"}</strong>
              <span className="row-actions">
                <span className="muted small">
                  {props.showReflog
                    ? `${props.reflogEntries?.length ?? 0} 条`
                    : `${filteredCommits.length}${
                        commitSearch.trim() ||
                        props.commits.length !== filteredCommits.length
                          ? ` / ${props.commits.length}`
                          : ""
                      } 条`}
                </span>
                {props.onToggleReflog && (
                  <button
                    type="button"
                    className="pane-btn pane-btn--sm"
                    disabled={props.busy}
                    onClick={props.onToggleReflog}
                  >
                    {props.showReflog ? "提交历史" : "操作记录"}
                  </button>
                )}
              </span>
            </div>
            {props.showReflog ? (
              <ul className="record-list history-commit-list">
                {(props.reflogEntries?.length ?? 0) === 0 && (
                  <li className="history-empty muted">暂无操作记录。</li>
                )}
                {(props.reflogEntries ?? []).map((entry) => (
                  <li key={`${entry.index}-${entry.hash}`} className="commit-row">
                    <button
                      type="button"
                      className="commit-main"
                      onClick={() => props.onSelectReflog?.(entry)}
                    >
                      <span className="commit-body">
                        <span className="commit-top">
                          <span className="hash commit-hash">{entry.shortHash}</span>
                          <span className="muted small">{entry.selector}</span>
                        </span>
                        <span className="subject commit-subject">{entry.subject}</span>
                        <span className="commit-meta muted small">{entry.date}</span>
                      </span>
                    </button>
                    <span className="row-actions history-actions">
                      <button
                        type="button"
                        className="pane-btn pane-btn--soft pane-btn--sm"
                        disabled={props.busy}
                        onClick={() => props.onCheckoutCommit({
                          hash: entry.hash,
                          shortHash: entry.shortHash,
                          author: "",
                          date: entry.date,
                          subject: entry.subject,
                        })}
                      >
                        检出
                      </button>
                      <button
                        type="button"
                        className="pane-btn pane-btn--danger pane-btn--sm"
                        disabled={props.busy}
                        onClick={() =>
                          props.onResetCommit({
                            hash: entry.hash,
                            shortHash: entry.shortHash,
                            author: "",
                            date: entry.date,
                            subject: entry.subject,
                          })
                        }
                      >
                        重置
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <>
            {props.historyScope ? (
              <div className="history-scope-bar">
                <span className="muted small">文件历史：{props.historyScope}</span>
                <button
                  type="button"
                  className="pane-btn pane-btn--sm"
                  disabled={props.busy}
                  onClick={props.onClearHistoryScope}
                >
                  显示全部
                </button>
              </div>
            ) : null}
            <div className="history-search-row">
              <input
                value={commitSearch}
                onChange={(e) => setCommitSearch(e.target.value)}
                placeholder="搜索提交（说明 / 哈希 / 作者）"
                disabled={props.busy}
              />
            </div>
            <div className="history-compare-row">
              <input
                value={props.compareLeft}
                onChange={(e) => props.onCompareLeft(e.target.value)}
                placeholder="比较：左（如 main）"
                disabled={props.busy}
              />
              <input
                value={props.compareRight}
                onChange={(e) => props.onCompareRight(e.target.value)}
                placeholder="右（如 HEAD）"
                disabled={props.busy}
              />
              <button
                type="button"
                className="pane-btn pane-btn--sm"
                disabled={
                  props.busy ||
                  !props.compareLeft.trim() ||
                  !props.compareRight.trim()
                }
                onClick={props.onCompare}
              >
                比较
              </button>
            </div>
            {props.compareResult ? (
              <DiffLines
                className="diff patch history-compare-result"
                text={props.compareResult}
                empty="无差异"
              />
            ) : null}
            <ul className="record-list commit-graph-list history-commit-list">
              {filteredCommits.length === 0 && (
                <li className="history-empty muted">
                  {props.commits.length === 0
                    ? "还没有提交。先在左侧暂存文件，填写说明后点「提交」。"
                    : "没有匹配的提交。"}
                </li>
              )}
              {graphRows.map((row) => {
                const badges = parseRefBadges(row.commit.refs);
                const colW = 14;
                const width = Math.max(row.width, 1) * colW + 10;
                const selected = props.selectedHash === row.commit.hash;
                const laneHot = hoverLane !== null && row.lane === hoverLane;
                const h = 28;
                return (
                  <li
                    key={row.commit.hash}
                    className={`commit-row${selected ? " is-selected" : ""}${
                      laneHot ? " is-lane-hot" : ""
                    }${row.isTip ? " is-tip" : ""}`}
                    onMouseEnter={() => setHoverLane(row.lane)}
                    onMouseLeave={() => setHoverLane(null)}
                  >
                    <button
                      type="button"
                      className={`commit-main${selected ? " active" : ""}`}
                      onClick={() => props.onSelectCommit(row.commit.hash)}
                    >
                      {props.showCommitGraph !== false && (
                        <span
                          className="graph-cell"
                          style={{ width, height: h }}
                          aria-hidden
                        >
                          <svg
                            className="graph-svg"
                            width={width}
                            height={h}
                            viewBox={`0 0 ${width} ${h}`}
                          >
                            {row.through.map((i) => {
                              const x = i * colW + 7;
                              const hot =
                                hoverLane !== null && hoverLane === i;
                              return (
                                <line
                                  key={`v-${i}`}
                                  className={`graph-rail${hot ? " is-hot" : ""}`}
                                  x1={x}
                                  y1={0}
                                  x2={x}
                                  y2={h}
                                  stroke={laneColor(i)}
                                  strokeWidth={hot ? 2.4 : 1.6}
                                />
                              );
                            })}
                            {row.edges
                              .filter((e) => e.mergeTo != null)
                              .map((e, idx) => {
                                const x1 = e.lane * colW + 7;
                                const x2 = (e.mergeTo as number) * colW + 7;
                                const y = h / 2;
                                return (
                                  <path
                                    key={`m-${idx}`}
                                    className="graph-merge"
                                    d={`M ${x1} ${y} C ${x1} ${y + 8}, ${x2} ${y + 8}, ${x2} ${h}`}
                                    stroke={laneColor(e.mergeTo as number)}
                                    strokeWidth={1.6}
                                    fill="none"
                                  />
                                );
                              })}
                            <circle
                              className={`graph-node${
                                row.isTip ? " is-tip" : ""
                              }${selected ? " is-selected" : ""}`}
                              cx={row.lane * colW + 7}
                              cy={h / 2}
                              r={row.isTip ? 4.5 : 3.5}
                              fill={laneColor(row.lane)}
                            />
                          </svg>
                        </span>
                      )}
                      <span className="commit-body">
                        <span className="commit-top">
                          <span className="hash commit-hash">
                            {row.commit.shortHash}
                            {row.isTip ? (
                              <span className="commit-tip-mark" title="分支尖端">
                                ●
                              </span>
                            ) : null}
                          </span>
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
                        <span className="subject commit-subject">
                          {row.commit.subject}
                        </span>
                        <span className="commit-meta muted small">
                          <span>{row.commit.author}</span>
                          <span className="commit-meta-dot" aria-hidden>
                            ·
                          </span>
                          <span>{row.commit.date}</span>
                        </span>
                      </span>
                    </button>
                    <span className="row-actions history-actions">
                      <button
                        type="button"
                        className="pane-btn pane-btn--soft pane-btn--sm"
                        disabled={props.busy}
                        title="把该提交应用到当前分支"
                        onClick={() => props.onCherryPick(row.commit.hash)}
                      >
                        拣选
                      </button>
                      <button
                        type="button"
                        className="pane-btn pane-btn--soft pane-btn--sm"
                        disabled={props.busy}
                        title="生成还原该提交的新提交"
                        onClick={() => props.onRevert(row.commit.hash)}
                      >
                        还原
                      </button>
                      <button
                        type="button"
                        className="pane-btn pane-btn--soft pane-btn--sm"
                        disabled={props.busy}
                        title="检出到此提交（可新建分支）"
                        onClick={() => props.onCheckoutCommit(row.commit)}
                      >
                        检出
                      </button>
                      <button
                        type="button"
                        className="pane-btn pane-btn--danger pane-btn--sm"
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
              </>
            )}
          </div>
          <div className="history-detail-pane">
            {props.patchLoading ? (
              <div className="history-detail-empty muted">加载中…</div>
            ) : props.selectedHash ? (
              <>
                <div className="history-detail-head">
                  <strong>改动内容</strong>
                  <span className="hash commit-hash">
                    {props.selectedHash.slice(0, 7)}
                  </span>
                </div>
                <DiffLines
                  className="diff patch history-patch"
                  text={props.commitPatch}
                  empty="该提交没有可显示的补丁内容"
                />
              </>
            ) : (
              <div className="history-detail-empty">
                <strong>选择一条提交</strong>
                <p className="muted small">在左侧点选后，这里会显示改动详情</p>
              </div>
            )}
          </div>
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
          {props.stashPreview ? (
            <div className="stash-preview">
              <div className="history-detail-head">
                <strong>储藏内容</strong>
                <button
                  type="button"
                  className="pane-btn pane-btn--sm"
                  onClick={props.onClearStashPreview}
                >
                  关闭
                </button>
              </div>
              <DiffLines
                className="diff patch"
                text={props.stashPreview}
                empty="（空）"
              />
            </div>
          ) : null}
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
                    title="查看差异（不应用）"
                    onClick={() => props.onShowStash(stash.index)}
                  >
                    查看
                  </button>
                  <button
                    type="button"
                    disabled={props.busy}
                    title="应用后仍保留储藏"
                    onClick={() => props.onApplyStash(stash.index)}
                  >
                    应用
                  </button>
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
          <input
            className="tag-message-input"
            value={props.tagMessage}
            onChange={(e) => props.onTagMessage(e.target.value)}
            placeholder="附注说明（可选；填写后创建附注标签）"
            disabled={props.busy}
          />
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
          wallpaperUrl={props.terminalWallpaperUrl}
          wallpaperKind={props.terminalWallpaperKind}
          wallpaperScrim={props.terminalWallpaperScrim}
        />
      )}
      {props.pane === "releases" && (
        <ReleaseManager
          platform={props.releasePlatform}
          onPlatform={props.onReleasePlatform}
          owner={props.releaseOwner}
          repo={props.releaseRepo}
          giteeOwner={props.releaseGiteeOwner}
          giteeRepo={props.releaseGiteeRepo}
          defaultTag={props.releaseDefaultTag}
          githubLoggedIn={props.githubLoggedIn}
          giteeLoggedIn={props.giteeLoggedIn}
          busy={props.busy || props.updateBusy}
          onBusy={props.onUpdateBusy}
          onNotice={props.onNotice}
          onError={props.onError}
          onOpenAuth={props.onOpenAuth}
          featureAllowed={props.releaseAllowed !== false}
          onFeatureDenied={() => props.onFeatureDenied?.("release")}
          onConfigureRepo={props.onConfigureReleaseRepo}
          progress={props.updateProgress}
          locale={loc}
        />
      )}
      {props.pane === "wiki" && (
        <WikiManager
          platform={props.releasePlatform}
          onPlatform={props.onReleasePlatform}
          owner={props.releaseOwner}
          repo={props.releaseRepo}
          giteeOwner={props.releaseGiteeOwner}
          giteeRepo={props.releaseGiteeRepo}
          githubLoggedIn={props.githubLoggedIn}
          giteeLoggedIn={props.giteeLoggedIn}
          busy={props.busy || props.updateBusy}
          onBusy={props.onUpdateBusy}
          onNotice={props.onNotice}
          onError={props.onError}
          onOpenAuth={props.onOpenAuth}
          featureAllowed={props.wikiAllowed !== false}
          onFeatureDenied={() => props.onFeatureDenied?.("wiki")}
          onConfigureRepo={props.onConfigureReleaseRepo}
          progress={props.wikiProgress ?? null}
          locale={loc}
        />
      )}
    </section>
  );
}

function laneColor(index: number): string {
  const colors = ["#0f6b4c", "#355c7d", "#9b2c2c", "#8a5a00", "#5b4b8a", "#2a6f7f"];
  return colors[index % colors.length];
}
