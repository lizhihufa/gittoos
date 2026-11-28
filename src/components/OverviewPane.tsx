import { useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "../api";
import { t as i18n } from "../i18n";
import { failureLine } from "../statusMessage";
import type {
  BranchInfo,
  CommitInfo,
  LargeFileInfo,
  PlatformRepoStats,
  RepoStatus,
} from "../types";
import { buildChangeHeatTree, flattenHeat } from "../viz/changeHeat";
import { buildContribCalendar } from "../viz/contribCalendar";
import { loadTimings, type TimingSample } from "../viz/networkTiming";

export type OverviewPlatform = "local" | "github" | "gitee";

type Props = {
  status: RepoStatus | null;
  commits: CommitInfo[];
  branches: BranchInfo[];
  repoPath?: string | null;
  locale?: string;
  githubOwner: string;
  githubRepo: string;
  giteeOwner: string;
  giteeRepo: string;
  githubLoggedIn: boolean;
  giteeLoggedIn: boolean;
  platform: OverviewPlatform;
  onPlatform: (p: OverviewPlatform) => void;
  onOpenAuth: (provider: "github" | "gitee") => void;
};

function dayKey(dateStr: string): string {
  const m = /(\d{4}-\d{2}-\d{2})/.exec(dateStr);
  if (m) return m[1]!;
  return dateStr.slice(0, 10) || dateStr || "?";
}

const LANG_COLORS = [
  "#1a7a62",
  "#355c7d",
  "#c45c26",
  "#5b4b8a",
  "#2a6f7f",
  "#8a5a00",
];

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function runTone(status: string, conclusion: string): string {
  const c = (conclusion || "").toLowerCase();
  const s = (status || "").toLowerCase();
  if (c === "success") return "is-ok";
  if (c === "failure" || c === "timed_out") return "is-fail";
  if (c === "cancelled") return "is-muted";
  if (s === "in_progress" || s === "queued") return "is-run";
  return "is-muted";
}

export function OverviewPane(props: Props) {
  const loc = props.locale || "zh-CN";
  const status = props.status;
  const changes = status?.changes ?? [];
  const staged = changes.filter((c) => c.staged).length;
  const unstaged = changes.filter((c) => c.unstaged || c.untracked).length;
  const conflicted = changes.filter((c) => c.conflicted).length;

  const [stats, setStats] = useState<PlatformRepoStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [largeFiles, setLargeFiles] = useState<LargeFileInfo[]>([]);
  const [timings, setTimings] = useState<TimingSample[]>(() => loadTimings());

  const activity = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of props.commits.slice(0, 120)) {
      const key = dayKey(c.date);
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    const days = [...map.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-14);
    const max = Math.max(1, ...days.map(([, n]) => n));
    return { days, max };
  }, [props.commits]);

  const authors = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of props.commits.slice(0, 120)) {
      const name = (c.author || "?").trim() || "?";
      map.set(name, (map.get(name) ?? 0) + 1);
    }
    const list = [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6);
    const max = Math.max(1, ...list.map(([, n]) => n));
    return { list, max };
  }, [props.commits]);

  const heatRows = useMemo(() => {
    const tree = buildChangeHeatTree(changes);
    return flattenHeat(tree).slice(0, 18);
  }, [changes]);
  const heatMax = Math.max(1, ...heatRows.map((r) => r.count));

  const calendar = useMemo(
    () => buildContribCalendar(props.commits, 26),
    [props.commits],
  );
  const calendarWeeks = useMemo(() => {
    const weeks: (typeof calendar)[] = [];
    for (let i = 0; i < calendar.length; i += 7) {
      weeks.push(calendar.slice(i, i + 7));
    }
    return weeks;
  }, [calendar]);

  const branchRows = useMemo(() => {
    return [...props.branches]
      .sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent) || a.name.localeCompare(b.name))
      .slice(0, 12);
  }, [props.branches]);

  const timingSeries = useMemo(() => {
    const samples = timings.slice(-16);
    const max = Math.max(1, ...samples.map((s) => s.ms));
    return { samples, max };
  }, [timings]);

  const platformTarget = useMemo(() => {
    if (props.platform === "github") {
      return {
        owner: props.githubOwner,
        repo: props.githubRepo,
        loggedIn: props.githubLoggedIn,
      };
    }
    if (props.platform === "gitee") {
      return {
        owner: props.giteeOwner,
        repo: props.giteeRepo,
        loggedIn: props.giteeLoggedIn,
      };
    }
    return null;
  }, [
    props.platform,
    props.githubOwner,
    props.githubRepo,
    props.giteeOwner,
    props.giteeRepo,
    props.githubLoggedIn,
    props.giteeLoggedIn,
  ]);

  useEffect(() => {
    if (props.platform !== "local") return;
    setTimings(loadTimings());
  }, [props.platform, props.status?.ahead, props.status?.behind, props.commits.length]);

  useEffect(() => {
    if (props.platform !== "local" || !props.repoPath) {
      setLargeFiles([]);
      return;
    }
    let cancelled = false;
    void api
      .listStagedLargeFiles(props.repoPath, 100 * 1024)
      .then((files) => {
        if (!cancelled) setLargeFiles(files.slice(0, 10));
      })
      .catch(() => {
        if (!cancelled) setLargeFiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [props.platform, props.repoPath, changes.length]);

  useEffect(() => {
    if (props.platform === "local" || !platformTarget) {
      setStats(null);
      setError(null);
      setLoading(false);
      return;
    }
    if (!platformTarget.owner || !platformTarget.repo) {
      setStats(null);
      setError(i18n(loc, "overview.needRepo"));
      setLoading(false);
      return;
    }
    if (!platformTarget.loggedIn) {
      setStats(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void api
      .getPlatformRepoStats(
        props.platform,
        platformTarget.owner,
        platformTarget.repo,
      )
      .then((data) => {
        if (!cancelled) {
          setStats(data);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setStats(null);
          setError(failureLine(e));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [props.platform, platformTarget, loc]);

  const contribMax = Math.max(
    1,
    ...(stats?.contributors.map((c) => c.contributions) ?? [1]),
  );
  const largeMax = Math.max(1, ...largeFiles.map((f) => f.size));
  const openIssuesOnly = stats
    ? Math.max(0, stats.openIssues - (stats.openPrs ?? 0))
    : 0;

  return (
    <div className="panel pad-block overview-pane">
      <div className="overview-toolbar">
        <div className="release-platform-toggle" role="group" aria-label="Overview source">
          {(
            [
              ["local", "overview.sourceLocal"],
              ["github", "GitHub"],
              ["gitee", "Gitee"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={
                props.platform === id
                  ? "pane-btn is-on"
                  : "pane-btn pane-btn--ghost"
              }
              onClick={() => props.onPlatform(id)}
            >
              {label.startsWith("overview.") ? i18n(loc, label) : label}
            </button>
          ))}
        </div>
        {props.platform !== "local" && platformTarget ? (
          <span className="muted small overview-repo-label">
            {platformTarget.owner && platformTarget.repo
              ? `${platformTarget.owner}/${platformTarget.repo}`
              : i18n(loc, "overview.needRepo")}
          </span>
        ) : null}
      </div>

      {props.platform === "local" ? (
        <>
          <div className="overview-grid">
            <div className="overview-stat">
              <span className="overview-stat-label">
                {i18n(loc, "overview.branch")}
              </span>
              <strong className="overview-stat-value">
                {status?.isDetached
                  ? i18n(loc, "overview.detached")
                  : status?.branch || "—"}
              </strong>
              <span className="muted small">
                {i18n(loc, "overview.branchesCount").replace(
                  "{n}",
                  String(props.branches.length),
                )}
              </span>
            </div>
            <div className="overview-stat">
              <span className="overview-stat-label">
                {i18n(loc, "overview.sync")}
              </span>
              <strong className="overview-stat-value">
                ↑{status?.ahead ?? 0} · ↓{status?.behind ?? 0}
              </strong>
              <span className="muted small">
                {status?.operation
                  ? `${i18n(loc, "overview.operation")}: ${status.operation}`
                  : i18n(loc, "overview.syncHint")}
              </span>
            </div>
            <div className="overview-stat">
              <span className="overview-stat-label">
                {i18n(loc, "overview.changes")}
              </span>
              <strong className="overview-stat-value">
                {staged}/{unstaged}
                {conflicted > 0 ? ` · !${conflicted}` : ""}
              </strong>
              <span className="muted small">
                {i18n(loc, "overview.changesHint")}
              </span>
            </div>
            <div className="overview-stat">
              <span className="overview-stat-label">
                {i18n(loc, "overview.commits")}
              </span>
              <strong className="overview-stat-value">
                {props.commits.length}
              </strong>
              <span className="muted small">
                {i18n(loc, "overview.commitsHint")}
              </span>
            </div>
          </div>

          <div className="overview-charts">
            <div className="overview-chart-card">
              <h5>{i18n(loc, "overview.activity")}</h5>
              {activity.days.length === 0 ? (
                <p className="muted small">{i18n(loc, "overview.noActivity")}</p>
              ) : (
                <div
                  className="overview-bars"
                  role="img"
                  aria-label={i18n(loc, "overview.activity")}
                >
                  {activity.days.map(([day, n]) => (
                    <div
                      key={day}
                      className="overview-bar-col"
                      title={`${day}: ${n}`}
                    >
                      <div
                        className="overview-bar"
                        style={{
                          height: `${Math.max(8, (n / activity.max) * 100)}%`,
                        }}
                      />
                      <span className="overview-bar-label">{day.slice(5)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="overview-chart-card">
              <h5>{i18n(loc, "overview.authors")}</h5>
              {authors.list.length === 0 ? (
                <p className="muted small">{i18n(loc, "overview.noActivity")}</p>
              ) : (
                <ul className="overview-hbars">
                  {authors.list.map(([name, n]) => (
                    <li key={name}>
                      <div className="overview-hbar-meta">
                        <span title={name}>{name}</span>
                        <span className="muted">{n}</span>
                      </div>
                      <div className="overview-hbar-track">
                        <i style={{ width: `${(n / authors.max) * 100}%` }} />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <div className="overview-charts">
            <div className="overview-chart-card overview-chart-card--wide">
              <h5>{i18n(loc, "overview.calendar")}</h5>
              {calendar.every((d) => d.count === 0) ? (
                <p className="muted small">{i18n(loc, "overview.noActivity")}</p>
              ) : (
                <div className="overview-calendar" role="img" aria-label={i18n(loc, "overview.calendar")}>
                  {calendarWeeks.map((week, wi) => (
                    <div key={wi} className="overview-calendar-week">
                      {week.map((day) => (
                        <i
                          key={day.date}
                          className={`overview-calendar-cell level-${day.level}`}
                          title={`${day.date}: ${day.count}`}
                        />
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="overview-chart-card">
              <h5>{i18n(loc, "overview.heat")}</h5>
              {heatRows.length === 0 ? (
                <p className="muted small">{i18n(loc, "overview.heatEmpty")}</p>
              ) : (
                <ul className="overview-heat">
                  {heatRows.map((row) => (
                    <li key={row.path} title={row.path}>
                      <span
                        className="overview-heat-name"
                        style={{ paddingLeft: `${row.depth * 10}px` }}
                      >
                        {row.name}
                      </span>
                      <span className="overview-heat-bar">
                        <i
                          style={{
                            width: `${Math.max(8, (row.count / heatMax) * 100)}%`,
                            opacity: 0.35 + (row.count / heatMax) * 0.65,
                          }}
                        />
                      </span>
                      <span className="muted small">{row.count}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <div className="overview-charts">
            <div className="overview-chart-card">
              <h5>{i18n(loc, "overview.branches")}</h5>
              {branchRows.length === 0 ? (
                <p className="muted small">—</p>
              ) : (
                <ul className="overview-branch-topo">
                  {branchRows.map((b, i) => (
                    <li
                      key={b.name}
                      className={b.isCurrent ? "is-current" : undefined}
                    >
                      <span className="overview-branch-rail" aria-hidden>
                        <i style={{ top: `${(i / Math.max(1, branchRows.length - 1)) * 100}%` }} />
                      </span>
                      <div className="overview-branch-meta">
                        <strong>{b.name}</strong>
                        <span className="muted small">
                          {b.tip.slice(0, 7)}
                          {b.upstream ? ` · ${b.upstream}` : ""}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="overview-chart-card">
              <h5>{i18n(loc, "overview.largeFiles")}</h5>
              {largeFiles.length === 0 ? (
                <p className="muted small">{i18n(loc, "overview.largeEmpty")}</p>
              ) : (
                <ul className="overview-hbars">
                  {largeFiles.map((f) => (
                    <li key={f.path}>
                      <div className="overview-hbar-meta">
                        <span title={f.path}>
                          {f.path.replace(/\\/g, "/").split("/").pop() || f.path}
                        </span>
                        <span className="muted">{f.sizeLabel || formatBytes(f.size)}</span>
                      </div>
                      <div className="overview-hbar-track">
                        <i style={{ width: `${(f.size / largeMax) * 100}%` }} />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <div className="overview-charts">
            <div className="overview-chart-card overview-chart-card--wide">
              <h5>{i18n(loc, "overview.timing")}</h5>
              {timingSeries.samples.length === 0 ? (
                <p className="muted small">{i18n(loc, "overview.timingEmpty")}</p>
              ) : (
                <div
                  className="overview-timing"
                  role="img"
                  aria-label={i18n(loc, "overview.timing")}
                >
                  {timingSeries.samples.map((s, i) => (
                    <div
                      key={`${s.at}-${i}`}
                      className={`overview-timing-col kind-${s.kind}`}
                      title={`${s.kind} · ${formatMs(s.ms)}${s.label ? ` · ${s.label}` : ""}`}
                    >
                      <div
                        className="overview-timing-bar"
                        style={{
                          height: `${Math.max(10, (s.ms / timingSeries.max) * 100)}%`,
                        }}
                      />
                      <span className="overview-bar-label">{s.kind[0]}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      ) : (
        <>
          {platformTarget && !platformTarget.loggedIn ? (
            <div className="overview-empty">
              <p className="muted">
                {i18n(
                  loc,
                  props.platform === "gitee"
                    ? "overview.needGiteeLogin"
                    : "overview.needGithubLogin",
                )}
              </p>
              <button
                type="button"
                className="pane-btn pane-btn--sm"
                onClick={() =>
                  props.onOpenAuth(
                    props.platform === "gitee" ? "gitee" : "github",
                  )
                }
              >
                {i18n(loc, "overview.login")}
              </button>
            </div>
          ) : loading ? (
            <p className="muted pad">{i18n(loc, "overview.loading")}</p>
          ) : error ? (
            <p className="overview-error">{error}</p>
          ) : stats ? (
            <>
              <div className="overview-platform-head">
                <div>
                  <strong>{stats.fullName || `${stats.owner}/${stats.repo}`}</strong>
                  {stats.description ? (
                    <p className="muted small overview-desc">{stats.description}</p>
                  ) : null}
                </div>
                <span className="muted small">
                  {stats.privateRepo
                    ? i18n(loc, "overview.private")
                    : i18n(loc, "overview.public")}
                  {stats.language ? ` · ${stats.language}` : ""}
                </span>
              </div>

              <div className="overview-grid overview-grid--platform">
                <div className="overview-stat">
                  <span className="overview-stat-label">Stars</span>
                  <strong className="overview-stat-value">{stats.stars}</strong>
                </div>
                <div className="overview-stat">
                  <span className="overview-stat-label">Forks</span>
                  <strong className="overview-stat-value">{stats.forks}</strong>
                </div>
                <div className="overview-stat">
                  <span className="overview-stat-label">
                    {i18n(loc, "overview.watchers")}
                  </span>
                  <strong className="overview-stat-value">{stats.watchers}</strong>
                </div>
                <div className="overview-stat">
                  <span className="overview-stat-label">
                    {i18n(loc, "overview.issues")}
                  </span>
                  <strong className="overview-stat-value">
                    {openIssuesOnly}
                  </strong>
                </div>
              </div>

              <div className="overview-charts">
                <div className="overview-chart-card">
                  <h5>{i18n(loc, "overview.board")}</h5>
                  <div className="overview-board">
                    <div className="overview-board-cell">
                      <span className="muted small">{i18n(loc, "overview.issues")}</span>
                      <strong>{openIssuesOnly}</strong>
                    </div>
                    <div className="overview-board-cell">
                      <span className="muted small">{i18n(loc, "overview.prs")}</span>
                      <strong>{stats.openPrs ?? 0}</strong>
                    </div>
                  </div>
                  <div className="overview-board-stack" aria-hidden>
                    {openIssuesOnly + (stats.openPrs ?? 0) > 0 ? (
                      <>
                        <i
                          className="is-issues"
                          style={{
                            width: `${
                              (openIssuesOnly /
                                Math.max(1, openIssuesOnly + (stats.openPrs ?? 0))) *
                              100
                            }%`,
                          }}
                        />
                        <i
                          className="is-prs"
                          style={{
                            width: `${
                              ((stats.openPrs ?? 0) /
                                Math.max(1, openIssuesOnly + (stats.openPrs ?? 0))) *
                              100
                            }%`,
                          }}
                        />
                      </>
                    ) : (
                      <i className="is-empty" style={{ width: "100%" }} />
                    )}
                  </div>
                </div>

                <div className="overview-chart-card">
                  <h5>{i18n(loc, "overview.languages")}</h5>
                  {stats.languages.length === 0 ? (
                    <p className="muted small">—</p>
                  ) : (
                    <>
                      <div className="overview-lang-stack" aria-hidden>
                        {stats.languages.map((lang, i) => (
                          <i
                            key={lang.name}
                            title={`${lang.name} ${lang.percent.toFixed(1)}%`}
                            style={{
                              width: `${Math.max(lang.percent, 1.5)}%`,
                              background: LANG_COLORS[i % LANG_COLORS.length],
                            }}
                          />
                        ))}
                      </div>
                      <ul className="overview-lang-legend">
                        {stats.languages.map((lang, i) => (
                          <li key={lang.name}>
                            <span
                              className="overview-lang-dot"
                              style={{
                                background: LANG_COLORS[i % LANG_COLORS.length],
                              }}
                            />
                            <span>{lang.name}</span>
                            <span className="muted">
                              {lang.percent.toFixed(1)}%
                            </span>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              </div>

              <div className="overview-charts">
                <div className="overview-chart-card">
                  <h5>{i18n(loc, "overview.contributors")}</h5>
                  {stats.contributors.length === 0 ? (
                    <p className="muted small">—</p>
                  ) : (
                    <ul className="overview-hbars">
                      {stats.contributors.map((c) => (
                        <li key={c.login}>
                          <div className="overview-hbar-meta">
                            <span>{c.login}</span>
                            <span className="muted">{c.contributions}</span>
                          </div>
                          <div className="overview-hbar-track">
                            <i
                              style={{
                                width: `${(c.contributions / contribMax) * 100}%`,
                              }}
                            />
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="overview-chart-card">
                  <h5>{i18n(loc, "overview.actions")}</h5>
                  {(stats.workflowRuns ?? []).length === 0 ? (
                    <p className="muted small">
                      {props.platform === "gitee"
                        ? i18n(loc, "overview.actionsGitee")
                        : i18n(loc, "overview.actionsEmpty")}
                    </p>
                  ) : (
                    <ul className="overview-runs">
                      {(stats.workflowRuns ?? []).map((run, i) => (
                        <li key={`${run.name}-${run.createdAt}-${i}`}>
                          <span
                            className={`overview-run-dot ${runTone(run.status, run.conclusion)}`}
                          />
                          <div className="overview-run-meta">
                            <button
                              type="button"
                              className="linkish"
                              disabled={!run.htmlUrl}
                              onClick={() => {
                                if (run.htmlUrl) void openUrl(run.htmlUrl);
                              }}
                            >
                              {run.name}
                            </button>
                            <span className="muted small">
                              {run.conclusion || run.status}
                              {run.createdAt
                                ? ` · ${run.createdAt.replace("T", " ").slice(0, 16)}`
                                : ""}
                            </span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>

              <p className="muted small overview-meta-foot">
                {i18n(loc, "overview.defaultBranch")}:{" "}
                {stats.defaultBranch || "—"}
                {stats.pushedAt
                  ? ` · ${i18n(loc, "overview.pushedAt")}: ${stats.pushedAt.slice(0, 10)}`
                  : ""}
              </p>
            </>
          ) : (
            <p className="muted pad">{i18n(loc, "overview.needRepo")}</p>
          )}
        </>
      )}
    </div>
  );
}
