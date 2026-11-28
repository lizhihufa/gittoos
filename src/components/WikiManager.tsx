import { useCallback, useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "../api";
import { confirmAction } from "../confirm";
import { t as i18n } from "../i18n";
import { failureLine } from "../statusMessage";
import type { WikiPageInfo, WikiPlatform, WikiStatus } from "../types";
import { buildWikiGraph } from "../viz/wikiGraph";
import { renderWikiMarkdown } from "../wikiMarkdown";

type WikiViewMode = "edit" | "preview" | "split" | "graph";

type Props = {
  platform: WikiPlatform;
  onPlatform: (p: WikiPlatform) => void;
  owner: string;
  repo: string;
  giteeOwner: string;
  giteeRepo: string;
  githubLoggedIn: boolean;
  giteeLoggedIn: boolean;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onNotice: (text: string | null) => void;
  onError: (text: string | null) => void;
  onOpenAuth: (provider: "github" | "gitee") => void;
  featureAllowed?: boolean;
  onFeatureDenied?: () => void;
  onConfigureRepo?: () => void;
  progress: { percent: number; label: string } | null;
  locale?: string;
};

const SPECIAL_SLUGS = ["_Footer", "_Sidebar"] as const;
type SpecialSlug = (typeof SPECIAL_SLUGS)[number];

function isSpecialSlug(slug: string): slug is SpecialSlug {
  return SPECIAL_SLUGS.some((s) => s.toLowerCase() === slug.toLowerCase());
}

function pageLabel(slug: string, loc: string): string {
  if (slug.toLowerCase() === "_footer") return i18n(loc, "wiki.footer");
  if (slug.toLowerCase() === "_sidebar") return i18n(loc, "wiki.sidebar");
  return slug;
}

export function WikiManager(props: Props) {
  const loc = props.locale || "zh-CN";
  const isGitee = props.platform === "gitee";
  const owner = isGitee ? props.giteeOwner : props.owner;
  const repo = isGitee ? props.giteeRepo : props.repo;
  const loggedIn = isGitee ? props.giteeLoggedIn : props.githubLoggedIn;
  const hasTarget = Boolean(owner && repo);
  const featureAllowed = props.featureAllowed !== false;

  function requireFeature(): boolean {
    if (featureAllowed) return true;
    props.onFeatureDenied?.();
    return false;
  }

  const [status, setStatus] = useState<WikiStatus | null>(null);
  const [pages, setPages] = useState<WikiPageInfo[]>([]);
  const [slug, setSlug] = useState("Home");
  const [content, setContent] = useState("");
  const [draftDirty, setDraftDirty] = useState(false);
  const [loading, setLoading] = useState(false);
  const [newPageName, setNewPageName] = useState("");
  const [viewMode, setViewMode] = useState<WikiViewMode>("split");
  const [graphBusy, setGraphBusy] = useState(false);
  const [graphPages, setGraphPages] = useState<
    { slug: string; content?: string }[]
  >([]);

  const normalPages = pages.filter((p) => !isSpecialSlug(p.slug));
  const hasFooter = pages.some((p) => p.slug.toLowerCase() === "_footer");
  const hasSidebar = pages.some((p) => p.slug.toLowerCase() === "_sidebar");
  const previewHtml = useMemo(() => renderWikiMarkdown(content), [content]);
  const wikiGraph = useMemo(() => buildWikiGraph(graphPages), [graphPages]);

  const refresh = useCallback(async () => {
    if (!hasTarget) {
      setStatus(null);
      setPages([]);
      return;
    }
    setLoading(true);
    try {
      const st = await api.wikiStatus(props.platform, owner, repo);
      setStatus(st);
      if (st.cloned) {
        const list = await api.wikiListPages(props.platform, owner, repo);
        setPages(list);
        setSlug((cur) => {
          const prefer =
            list.find((p) => p.slug.toLowerCase() === cur.toLowerCase()) ||
            list.find((p) => p.slug.toLowerCase() === "home") ||
            list[0];
          if (!prefer) {
            setContent("");
            setDraftDirty(false);
            return cur;
          }
          void api
            .wikiReadPage(props.platform, owner, repo, prefer.slug)
            .then((text) => {
              setContent(text);
              setDraftDirty(false);
            })
            .catch((e) => props.onError(failureLine(e)));
          return prefer.slug;
        });
      } else {
        setPages([]);
        setContent("");
        setDraftDirty(false);
      }
    } catch (e) {
      props.onError(failureLine(e));
    } finally {
      setLoading(false);
    }
  }, [hasTarget, owner, props.platform, props.onError, repo]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function selectPage(next: string) {
    if (!hasTarget) return;
    if (draftDirty) {
      const ok = await confirmAction("当前页面有未保存修改，切换将丢弃。继续？", {
        title: "切换页面",
        confirmLabel: "丢弃并切换",
        danger: true,
      });
      if (!ok) return;
    }
    setLoading(true);
    try {
      const text = await api.wikiReadPage(props.platform, owner, repo, next);
      setSlug(next);
      setContent(text);
      setDraftDirty(false);
    } catch (e) {
      props.onError(failureLine(e));
    } finally {
      setLoading(false);
    }
  }

  async function runBusy(label: string, action: () => Promise<void>) {
    if (props.busy) return;
    props.onBusy(true);
    props.onError(null);
    props.onNotice(label);
    try {
      await action();
    } catch (e) {
      props.onNotice(null);
      props.onError(failureLine(e));
    } finally {
      props.onBusy(false);
    }
  }

  async function loadWikiGraph() {
    if (!hasTarget || !status?.cloned) return;
    setGraphBusy(true);
    try {
      const targets = normalPages.slice(0, 24);
      const loaded = await Promise.all(
        targets.map(async (p) => {
          try {
            const text = await api.wikiReadPage(
              props.platform,
              owner,
              repo,
              p.slug,
            );
            return { slug: p.slug, content: text };
          } catch {
            return { slug: p.slug };
          }
        }),
      );
      // include current draft so unsaved links show up
      const withDraft = loaded.map((p) =>
        p.slug.toLowerCase() === slug.toLowerCase()
          ? { ...p, content }
          : p,
      );
      setGraphPages(withDraft);
    } finally {
      setGraphBusy(false);
    }
  }

  async function ensureSpecialPage(kind: SpecialSlug) {
    if (!hasTarget || !status?.cloned) return;
    if (draftDirty) {
      const ok = await confirmAction("当前页面有未保存修改，切换将丢弃。继续？", {
        title: "切换页面",
        confirmLabel: "丢弃并切换",
        danger: true,
      });
      if (!ok) return;
    }
    const existing = pages.find(
      (p) => p.slug.toLowerCase() === kind.toLowerCase(),
    );
    if (existing) {
      await selectPage(existing.slug);
      return;
    }
    const body =
      kind === "_Footer"
        ? i18n(loc, "wiki.footerStub")
        : i18n(loc, "wiki.sidebarStub");
    void runBusy(i18n(loc, "wiki.creating"), async () => {
      await api.wikiWritePage(props.platform, owner, repo, kind, body);
      setSlug(kind);
      setContent(body);
      setDraftDirty(true);
      const list = await api.wikiListPages(props.platform, owner, repo);
      setPages(list);
      props.onNotice(i18n(loc, "wiki.createdLocal"));
    });
  }

  return (
    <div className="wiki-manager">
      <div className="release-bar wiki-bar">
        <div className="release-platform-toggle" role="group" aria-label="Wiki 平台">
          <button
            type="button"
            className={!isGitee ? "pane-btn is-on" : "pane-btn pane-btn--ghost"}
            disabled={props.busy}
            onClick={() => props.onPlatform("github")}
          >
            GitHub
          </button>
          <button
            type="button"
            className={isGitee ? "pane-btn is-on" : "pane-btn pane-btn--ghost"}
            disabled={props.busy}
            onClick={() => props.onPlatform("gitee")}
          >
            Gitee
          </button>
        </div>
        <div className="release-actions">
          <button
            type="button"
            className="pane-btn pane-btn--ghost"
            disabled={props.busy || !hasTarget || loading}
            onClick={() => void refresh()}
          >
            {loading ? i18n(loc, "wiki.refreshing") : i18n(loc, "wiki.refresh")}
          </button>
          <button
            type="button"
            className="pane-btn pane-btn--ghost"
            disabled={props.busy || !hasTarget}
            onClick={() => {
              if (!requireFeature()) return;
              if (!loggedIn) {
                props.onOpenAuth(isGitee ? "gitee" : "github");
                return;
              }
              void runBusy(i18n(loc, "wiki.syncing"), async () => {
                await api.wikiSync(props.platform, owner, repo);
                props.onNotice(i18n(loc, "wiki.synced"));
                await refresh();
              });
            }}
          >
            {i18n(loc, "wiki.sync")}
          </button>
          <button
            type="button"
            className="pane-btn"
            disabled={props.busy || !hasTarget}
            onClick={() => {
              if (!requireFeature()) return;
              if (!loggedIn) {
                props.onOpenAuth(isGitee ? "gitee" : "github");
                return;
              }
              void runBusy(i18n(loc, "wiki.initing"), async () => {
                await api.wikiInit(props.platform, owner, repo);
                props.onNotice(i18n(loc, "wiki.inited"));
                await refresh();
              });
            }}
          >
            {i18n(loc, "wiki.init")}
          </button>
          <button
            type="button"
            className="pane-btn pane-btn--ghost"
            disabled={!hasTarget}
            onClick={() =>
              void (async () => {
                try {
                  const url =
                    status?.webUrl ||
                    (await api.wikiWebUrl(props.platform, owner, repo));
                  await openUrl(url);
                } catch (e) {
                  props.onError(failureLine(e));
                }
              })()
            }
          >
            {i18n(loc, "wiki.openWeb")}
          </button>
        </div>
      </div>

      <div className="release-toolbar-meta">
        <span className="muted small">
          {!hasTarget
            ? i18n(
                loc,
                isGitee ? "wiki.noGiteeRepo" : "wiki.noGithubRepo",
              )
            : `${owner}/${repo}${
                status?.cloned
                  ? ` · ${status.pageCount} 页${status.dirty ? " · 有未推送" : ""}`
                  : ` · ${i18n(loc, "wiki.notSynced")}`
              }${!loggedIn ? ` · ${i18n(loc, "wiki.needLoginHint")}` : ""}`}
        </span>
        {!hasTarget && props.onConfigureRepo ? (
          <button
            type="button"
            className="pane-btn pane-btn--soft pane-btn--sm"
            onClick={props.onConfigureRepo}
          >
            {i18n(loc, "wiki.goSettings")}
          </button>
        ) : null}
      </div>

      {props.progress && (
        <div className="about-progress release-progress">
          <div className="about-progress-head">
            <span>{props.progress.label}</span>
            <span>{props.progress.percent}%</span>
          </div>
          <div className="about-progress-bar">
            <i style={{ width: `${props.progress.percent}%` }} />
          </div>
        </div>
      )}

      {!hasTarget ? (
        <p className="muted pad">{i18n(loc, "wiki.needRepo")}</p>
      ) : !status?.cloned ? (
        <div className="wiki-empty pad">
          <p className="muted">{i18n(loc, "wiki.emptyHint")}</p>
        </div>
      ) : (
        <div className="wiki-layout">
          <aside className="wiki-sidebar">
            <ul className="wiki-page-list">
              {normalPages.map((p) => (
                <li key={p.slug}>
                  <button
                    type="button"
                    className={
                      p.slug === slug
                        ? "wiki-page-item is-active"
                        : "wiki-page-item"
                    }
                    disabled={props.busy || loading}
                    onClick={() => void selectPage(p.slug)}
                  >
                    {p.slug}
                  </button>
                </li>
              ))}
            </ul>
            <div className="wiki-special">
              <span className="wiki-special-label muted small">
                {i18n(loc, "wiki.special")}
              </span>
              {hasSidebar ? (
                <button
                  type="button"
                  className={
                    slug.toLowerCase() === "_sidebar"
                      ? "wiki-page-item is-active"
                      : "wiki-page-item"
                  }
                  disabled={props.busy || loading}
                  title={i18n(loc, "wiki.sidebarHint")}
                  onClick={() => void selectPage("_Sidebar")}
                >
                  {i18n(loc, "wiki.sidebar")}
                </button>
              ) : (
                <button
                  type="button"
                  className="wiki-add-special"
                  disabled={props.busy}
                  title={i18n(loc, "wiki.sidebarHint")}
                  onClick={() => void ensureSpecialPage("_Sidebar")}
                >
                  + {i18n(loc, "wiki.addSidebar")}
                </button>
              )}
              {hasFooter ? (
                <button
                  type="button"
                  className={
                    slug.toLowerCase() === "_footer"
                      ? "wiki-page-item is-active"
                      : "wiki-page-item"
                  }
                  disabled={props.busy || loading}
                  title={i18n(loc, "wiki.footerHint")}
                  onClick={() => void selectPage("_Footer")}
                >
                  {i18n(loc, "wiki.footer")}
                </button>
              ) : (
                <button
                  type="button"
                  className="wiki-add-special"
                  disabled={props.busy}
                  title={i18n(loc, "wiki.footerHint")}
                  onClick={() => void ensureSpecialPage("_Footer")}
                >
                  + {i18n(loc, "wiki.addFooter")}
                </button>
              )}
            </div>
            <div className="wiki-new-row">
              <input
                value={newPageName}
                placeholder={i18n(loc, "wiki.newPagePh")}
                disabled={props.busy}
                onChange={(e) => setNewPageName(e.target.value)}
              />
              <button
                type="button"
                className="pane-btn pane-btn--sm"
                disabled={props.busy || !newPageName.trim()}
                onClick={() => {
                  const name = newPageName.trim();
                  if (!name) return;
                  void runBusy(i18n(loc, "wiki.creating"), async () => {
                    const body = `# ${name}\n\n`;
                    await api.wikiWritePage(
                      props.platform,
                      owner,
                      repo,
                      name,
                      body,
                    );
                    setNewPageName("");
                    setSlug(name.replace(/\s+/g, "-"));
                    setContent(body);
                    setDraftDirty(true);
                    const list = await api.wikiListPages(
                      props.platform,
                      owner,
                      repo,
                    );
                    setPages(list);
                    props.onNotice(i18n(loc, "wiki.createdLocal"));
                  });
                }}
              >
                {i18n(loc, "wiki.newPage")}
              </button>
            </div>
          </aside>
          <div className="wiki-editor">
            <div className="wiki-editor-head">
              <div className="wiki-editor-title">
                <strong>{pageLabel(slug, loc)}</strong>
                {isSpecialSlug(slug) ? (
                  <span className="muted small">
                    {slug.toLowerCase() === "_footer"
                      ? i18n(loc, "wiki.footerHint")
                      : i18n(loc, "wiki.sidebarHint")}
                  </span>
                ) : null}
              </div>
              <div className="wiki-editor-actions">
                <div className="wiki-view-toggle" role="group" aria-label="Wiki view">
                  {(
                    [
                      ["edit", "wiki.viewEdit"],
                      ["preview", "wiki.viewPreview"],
                      ["split", "wiki.viewSplit"],
                      ["graph", "wiki.viewGraph"],
                    ] as const
                  ).map(([mode, key]) => (
                    <button
                      key={mode}
                      type="button"
                      className={
                        viewMode === mode
                          ? "pane-btn pane-btn--sm is-on"
                          : "pane-btn pane-btn--ghost pane-btn--sm"
                      }
                      disabled={props.busy || graphBusy}
                      onClick={() => {
                        setViewMode(mode);
                        if (mode === "graph") void loadWikiGraph();
                      }}
                    >
                      {i18n(loc, key)}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  className="pane-btn pane-btn--sm"
                  disabled={props.busy || (!draftDirty && !status.dirty)}
                  onClick={() => {
                    if (!requireFeature()) return;
                    if (!loggedIn) {
                      props.onOpenAuth(isGitee ? "gitee" : "github");
                      return;
                    }
                    void runBusy(i18n(loc, "wiki.saving"), async () => {
                      await api.wikiWritePage(
                        props.platform,
                        owner,
                        repo,
                        slug,
                        content,
                      );
                      await api.wikiCommitPush(
                        props.platform,
                        owner,
                        repo,
                        `Update ${slug}`,
                      );
                      setDraftDirty(false);
                      props.onNotice(i18n(loc, "wiki.saved"));
                      await refresh();
                    });
                  }}
                >
                  {i18n(loc, "wiki.savePush")}
                </button>
                {slug.toLowerCase() !== "home" && (
                  <button
                    type="button"
                    className="pane-btn pane-btn--ghost pane-btn--sm"
                    disabled={props.busy}
                    onClick={() => {
                      void (async () => {
                        const ok = await confirmAction(
                          `删除 Wiki 页面「${pageLabel(slug, loc)}」并推送？`,
                          {
                            title: "删除页面",
                            danger: true,
                            confirmLabel: "删除",
                          },
                        );
                        if (!ok) return;
                        if (!requireFeature()) return;
                        if (!loggedIn) {
                          props.onOpenAuth(isGitee ? "gitee" : "github");
                          return;
                        }
                        void runBusy(i18n(loc, "wiki.deleting"), async () => {
                          await api.wikiDeletePage(
                            props.platform,
                            owner,
                            repo,
                            slug,
                          );
                          await api.wikiCommitPush(
                            props.platform,
                            owner,
                            repo,
                            `Delete ${slug}`,
                          );
                          props.onNotice(i18n(loc, "wiki.deleted"));
                          setSlug("Home");
                          await refresh();
                        });
                      })();
                    }}
                  >
                    {i18n(loc, "wiki.delete")}
                  </button>
                )}
              </div>
            </div>
            <div
              className={`wiki-editor-body${
                viewMode === "split" ? " is-split" : ""
              }${viewMode === "graph" ? " is-graph" : ""}`}
            >
              {viewMode === "graph" ? (
                <div className="wiki-graph-pane">
                  {graphBusy ? (
                    <p className="muted pad">{i18n(loc, "wiki.graphLoading")}</p>
                  ) : wikiGraph.nodes.length === 0 ? (
                    <p className="muted pad">{i18n(loc, "wiki.graphEmpty")}</p>
                  ) : (
                    <>
                      <svg
                        className="wiki-graph-svg"
                        viewBox="0 0 640 360"
                        role="img"
                        aria-label={i18n(loc, "wiki.viewGraph")}
                      >
                        {(() => {
                          const n = wikiGraph.nodes.length;
                          const pos = new Map<string, { x: number; y: number }>();
                          wikiGraph.nodes.forEach((node, i) => {
                            const angle = (i / Math.max(1, n)) * Math.PI * 2;
                            const r = 110 + (node.links % 3) * 18;
                            pos.set(node.id, {
                              x: 320 + Math.cos(angle) * r,
                              y: 180 + Math.sin(angle) * r,
                            });
                          });
                          return (
                            <>
                              {wikiGraph.edges.map((e, i) => {
                                const a = pos.get(e.from);
                                const b = pos.get(e.to);
                                if (!a || !b) return null;
                                return (
                                  <line
                                    key={`${e.from}-${e.to}-${i}`}
                                    x1={a.x}
                                    y1={a.y}
                                    x2={b.x}
                                    y2={b.y}
                                    className="wiki-graph-edge"
                                  />
                                );
                              })}
                              {wikiGraph.nodes.map((node) => {
                                const p = pos.get(node.id)!;
                                const active =
                                  node.id.toLowerCase() === slug.toLowerCase();
                                return (
                                  <g
                                    key={node.id}
                                    className={
                                      active
                                        ? "wiki-graph-node is-active"
                                        : "wiki-graph-node"
                                    }
                                    transform={`translate(${p.x},${p.y})`}
                                    onClick={() => void selectPage(node.id)}
                                    style={{ cursor: "pointer" }}
                                  >
                                    <circle r={10 + Math.min(8, node.links)} />
                                    <text y={22} textAnchor="middle">
                                      {node.id.length > 14
                                        ? `${node.id.slice(0, 12)}…`
                                        : node.id}
                                    </text>
                                  </g>
                                );
                              })}
                            </>
                          );
                        })()}
                      </svg>
                      <p className="muted small pad">
                        {i18n(loc, "wiki.graphHint")
                          .replace("{n}", String(wikiGraph.nodes.length))
                          .replace("{e}", String(wikiGraph.edges.length))}
                      </p>
                    </>
                  )}
                </div>
              ) : (
                <>
                  {viewMode !== "preview" ? (
                    <textarea
                      className="wiki-textarea"
                      value={content}
                      disabled={props.busy || loading}
                      onChange={(e) => {
                        setContent(e.target.value);
                        setDraftDirty(true);
                      }}
                      spellCheck={false}
                    />
                  ) : null}
                  {viewMode !== "edit" ? (
                    <div
                      className="wiki-preview"
                      onClick={(e) => {
                        const t = e.target as HTMLElement | null;
                        const link = t?.closest?.("a.wiki-link") as
                          | HTMLAnchorElement
                          | null;
                        if (!link) return;
                        e.preventDefault();
                        const next = link.getAttribute("data-wiki-slug");
                        if (next) void selectPage(next);
                      }}
                    >
                      {slug.toLowerCase() === "_sidebar" ? (
                        <div className="wiki-preview-chrome is-sidebar">
                          {i18n(loc, "wiki.previewSidebarNote")}
                        </div>
                      ) : null}
                      <div
                        className="wiki-preview-html"
                        dangerouslySetInnerHTML={{ __html: previewHtml }}
                      />
                      {slug.toLowerCase() === "_footer" ? (
                        <div className="wiki-preview-chrome is-footer">
                          {i18n(loc, "wiki.previewFooterNote")}
                        </div>
                      ) : slug.toLowerCase() !== "_sidebar" ? (
                        <div className="wiki-preview-chrome is-footer muted">
                          {i18n(loc, "wiki.previewFooterHint")}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
