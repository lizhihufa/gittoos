import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "../api";
import { confirmAction } from "../confirm";
import { t as i18n } from "../i18n";
import { failureLine } from "../statusMessage";
import type { ReleaseItem } from "../types";

export type ReleasePlatform = "github" | "gitee";

type Props = {
  platform: ReleasePlatform;
  onPlatform: (p: ReleasePlatform) => void;
  owner: string;
  repo: string;
  giteeOwner: string;
  giteeRepo: string;
  defaultTag: string;
  githubLoggedIn: boolean;
  giteeLoggedIn: boolean;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onNotice: (text: string | null) => void;
  onError: (text: string | null) => void;
  onOpenAuth: () => void;
  onConfigureRepo?: () => void;
  progress: { percent: number; label: string } | null;
  locale?: string;
};

/** 去掉标题末尾的版本/Tag，避免「青枝 v1.6.0」这类带回填 */
function stripVersionSuffix(name: string, tag: string): string {
  let text = name.trim();
  const tagName = tag.trim();
  if (tagName) {
    const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(`\\s*${escaped}\\s*$`, "i"), "").trim();
  }
  text = text
    .replace(/\s*v?\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?\s*$/i, "")
    .trim();
  return text;
}

/** 有独立标题时返回标题（不含版本号）；与 Tag 相同或空则视为无标题 */
function releaseTitleOf(rel: ReleaseItem): string | null {
  const name = rel.name.trim();
  const tag = rel.tagName.trim();
  if (!name || name === tag) return null;
  const cleaned = stripVersionSuffix(name, tag);
  if (!cleaned || cleaned === tag) return null;
  return cleaned;
}

function normalizeTag(raw: string, fallback = ""): string {
  const t = (raw.trim() || fallback).replace(/^V/, "v");
  if (!t) return "";
  return t.startsWith("v") ? t : `v${t}`;
}

function fileName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}

export function ReleaseManager(props: Props) {
  const loc = props.locale || "zh-CN";
  const [items, setItems] = useState<ReleaseItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [filePath, setFilePath] = useState("");
  const [tag, setTag] = useState("");
  const [tagTouched, setTagTouched] = useState(false);
  const [title, setTitle] = useState("");
  const [titleTouched, setTitleTouched] = useState(false);
  const [notes, setNotes] = useState("");
  const [showNotes, setShowNotes] = useState(false);

  const isGitee = props.platform === "gitee";
  const owner = isGitee ? props.giteeOwner : props.owner;
  const repo = isGitee ? props.giteeRepo : props.repo;
  const loggedIn = isGitee ? props.giteeLoggedIn : props.githubLoggedIn;
  const hostLabel = isGitee ? "Gitee" : "GitHub";
  const { onError } = props;

  useEffect(() => {
    setTag("");
    setTitle("");
    setTagTouched(false);
    setTitleTouched(false);
    setFilePath("");
    setNotes("");
  }, [owner, repo, props.platform]);

  useEffect(() => {
    if (tagTouched) return;
    if (items.length > 0) {
      setTag(items[0].tagName);
      return;
    }
    if (props.defaultTag) setTag(props.defaultTag);
  }, [items, props.defaultTag, tagTouched]);

  useEffect(() => {
    if (titleTouched) return;
    const tagName = normalizeTag(tag, props.defaultTag);
    if (items.length > 0) {
      const match =
        items.find((rel) => rel.tagName === tagName) ?? items[0] ?? null;
      if (match) {
        setTitle(releaseTitleOf(match) ?? "");
        return;
      }
    }
    if (title.trim()) {
      const cleaned = stripVersionSuffix(title, tagName);
      if (cleaned !== title.trim()) setTitle(cleaned);
    }
  }, [items, tag, props.defaultTag, titleTouched, title]);

  const refresh = useCallback(async () => {
    if (!owner.trim() || !repo.trim()) {
      setItems([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    onError(null);
    try {
      const list = isGitee
        ? await api.listGiteeReleases(owner, repo, 20)
        : await api.listGithubReleases(owner, repo, 20);
      setItems(list);
    } catch (e) {
      onError(failureLine(e));
    } finally {
      setLoading(false);
    }
  }, [owner, repo, isGitee, onError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const hasTarget = Boolean(owner.trim() && repo.trim());

  async function pickFile() {
    const selected = await open({
      multiple: false,
      filters: [
        {
          name: i18n(loc, "release.fileFilter"),
          extensions: ["exe", "zip", "msi", "7z"],
        },
      ],
      title: i18n(loc, "release.pickTitle"),
    });
    if (typeof selected === "string") setFilePath(selected);
  }

  async function upload() {
    if (!hasTarget) {
      props.onError(
        i18n(loc, isGitee ? "release.noGiteeRepo" : "release.noGithubRepo"),
      );
      return;
    }
    if (!filePath.trim()) {
      props.onError(i18n(loc, "release.needFile"));
      return;
    }
    if (!loggedIn) {
      props.onError(i18n(loc, isGitee ? "release.needGitee" : "release.needGithub"));
      props.onOpenAuth();
      return;
    }

    const tagName = normalizeTag(tag, props.defaultTag);
    const releaseTitle =
      stripVersionSuffix(title.trim() || tagName, tagName) || tagName;
    const ok = await confirmAction(
      `${i18n(loc, "release.uploadTo")} ${owner}/${repo}\n${i18n(loc, "release.title")}: ${releaseTitle}\nTag：${tagName}\n${i18n(loc, "release.file")}: ${fileName(filePath)}\n${i18n(loc, "release.autoCreate")}`,
      {
        title: i18n(loc, "release.uploadConfirm"),
        confirmLabel: i18n(loc, "release.upload"),
      },
    );
    if (!ok) return;
    props.onBusy(true);
    props.onError(null);
    props.onNotice(
      isGitee
        ? i18n(loc, "release.uploadingGitee")
        : i18n(loc, "release.uploadingGithub"),
    );
    try {
      const result = isGitee
        ? await api.publishGiteeRelease({
            filePath,
            tag: tagName,
            title: releaseTitle,
            notes: notes.trim() || undefined,
            owner,
            repo,
          })
        : await api.publishGithubRelease({
            filePath,
            tag: tagName,
            title: releaseTitle,
            notes: notes.trim() || undefined,
            owner,
            repo,
          });
      props.onNotice(
        `${i18n(loc, "release.uploaded")} ${result.assetName} → ${result.tagName}`,
      );
      setFilePath("");
      await refresh();
    } catch (e) {
      props.onNotice(null);
      props.onError(failureLine(e));
    } finally {
      props.onBusy(false);
    }
  }

  async function removeAsset(release: ReleaseItem, assetId: number, name: string) {
    if (!loggedIn) {
      props.onOpenAuth();
      return;
    }
    const ok = await confirmAction(
      `${i18n(loc, "release.deleteAssetAsk")} ${release.tagName}「${name}」？`,
      {
        title: i18n(loc, "release.deleteAsset"),
        danger: true,
        confirmLabel: i18n(loc, "release.delete"),
      },
    );
    if (!ok) return;
    props.onBusy(true);
    try {
      if (isGitee) {
        await api.deleteGiteeReleaseAsset(release.id, assetId, owner, repo);
      } else {
        await api.deleteGithubReleaseAsset(assetId, owner, repo);
      }
      props.onNotice(`${i18n(loc, "release.deletedAsset")} ${name}`);
      await refresh();
    } catch (e) {
      props.onError(failureLine(e));
    } finally {
      props.onBusy(false);
    }
  }

  async function removeRelease(release: ReleaseItem) {
    if (!loggedIn) {
      props.onOpenAuth();
      return;
    }
    const ok = await confirmAction(
      `${i18n(loc, "release.deleteReleaseAsk")}「${release.tagName}」？\n${i18n(loc, "release.keepTag")}`,
      {
        title: i18n(loc, "release.deleteRelease"),
        danger: true,
        confirmLabel: i18n(loc, "release.delete"),
      },
    );
    if (!ok) return;
    props.onBusy(true);
    try {
      if (isGitee) {
        await api.deleteGiteeRelease(release.id, owner, repo);
      } else {
        await api.deleteGithubRelease(release.id, owner, repo);
      }
      props.onNotice(`${i18n(loc, "release.deletedRelease")} ${release.tagName}`);
      await refresh();
    } catch (e) {
      props.onError(failureLine(e));
    } finally {
      props.onBusy(false);
    }
  }

  return (
    <div className="panel pad-block release-manager">
      <div className="wallpaper-mode-tabs" role="tablist" style={{ marginBottom: "0.55rem" }}>
        <button
          type="button"
          className={!isGitee ? "is-active" : ""}
          onClick={() => props.onPlatform("github")}
        >
          GitHub
        </button>
        <button
          type="button"
          className={isGitee ? "is-active" : ""}
          onClick={() => props.onPlatform("gitee")}
        >
          Gitee
        </button>
      </div>

      <div className="release-bar">
        <label className="release-field release-field-title">
          <span>{i18n(loc, "release.title")}</span>
          <input
            value={title}
            onChange={(e) => {
              setTitleTouched(true);
              setTitle(e.target.value);
            }}
            placeholder={i18n(loc, "release.titlePh")}
            disabled={props.busy}
          />
        </label>
        <label className="release-field">
          <span>Tag</span>
          <input
            value={tag}
            onChange={(e) => {
              setTagTouched(true);
              setTag(e.target.value);
            }}
            placeholder={items[0]?.tagName || props.defaultTag || "v1.0.0"}
            disabled={props.busy}
          />
        </label>

        <div className="release-actions" role="group" aria-label="Release">
          <button
            type="button"
            className="pane-btn pane-btn--soft"
            disabled={props.busy || !hasTarget}
            onClick={() => void pickFile()}
          >
            {i18n(loc, "release.pick")}
          </button>
          <button
            type="button"
            className="pane-btn pane-btn--primary"
            disabled={props.busy || !hasTarget || !filePath}
            onClick={() => void upload()}
            title={`${i18n(loc, "release.upload")} ${hostLabel}`}
          >
            {i18n(loc, "release.upload")}
          </button>
          <span className="release-actions-split" aria-hidden />
          <button
            type="button"
            className="pane-btn pane-btn--ghost"
            disabled={props.busy || loading || !hasTarget}
            onClick={() => void refresh()}
          >
            {loading ? i18n(loc, "release.refreshing") : i18n(loc, "release.refresh")}
          </button>
          <button
            type="button"
            className={`pane-btn pane-btn--ghost${showNotes ? " is-on" : ""}`}
            disabled={props.busy}
            onClick={() => setShowNotes((v) => !v)}
          >
            {showNotes ? i18n(loc, "release.hideNotes") : i18n(loc, "release.notes")}
          </button>
        </div>
      </div>

      <div className="release-toolbar-meta">
        <span className="muted small" title={filePath || undefined}>
          {!hasTarget
            ? i18n(loc, isGitee ? "release.noGiteeRepo" : "release.noGithubRepo")
            : filePath
              ? fileName(filePath)
              : `${hostLabel} ${owner}/${repo}${
                  loggedIn ? "" : ` · ${i18n(loc, "release.needLoginHint")}`
                }`}
        </span>
        {!hasTarget && props.onConfigureRepo ? (
          <button
            type="button"
            className="pane-btn pane-btn--soft pane-btn--sm"
            onClick={props.onConfigureRepo}
          >
            {i18n(loc, "release.goSettings")}
          </button>
        ) : null}
      </div>

      {showNotes && (
        <textarea
          className="release-notes-input"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder={i18n(loc, "release.notesPh")}
          rows={2}
          disabled={props.busy}
        />
      )}

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

      <ul className="record-list">
        {items.length === 0 && !loading && (
          <li className="muted pad">{i18n(loc, "release.empty")}</li>
        )}
        {items.map((rel) => {
          const relTitle = releaseTitleOf(rel);
          return (
            <li key={rel.id} className="release-group">
              <div className="stash-row release-row">
                <button
                  type="button"
                  className="release-row-main release-row-pick"
                  title={i18n(loc, "release.fillForm")}
                  onClick={() => {
                    setTag(rel.tagName);
                    setTagTouched(true);
                    setTitle(relTitle ?? "");
                    setTitleTouched(true);
                  }}
                >
                  <strong>{relTitle || rel.tagName}</strong>
                  {relTitle ? (
                    <span className="release-row-tag">{rel.tagName}</span>
                  ) : null}
                  {rel.publishedAt ? (
                    <span className="muted small">
                      {rel.publishedAt.replace("T", " ").slice(0, 16)}
                    </span>
                  ) : null}
                </button>
                <span className="row-actions release-row-actions">
                  <button
                    type="button"
                    className="pane-btn pane-btn--soft pane-btn--sm"
                    onClick={() => void openUrl(rel.htmlUrl)}
                  >
                    {i18n(loc, "release.open")}
                  </button>
                  <button
                    type="button"
                    className="pane-btn pane-btn--danger pane-btn--sm"
                    disabled={props.busy || !loggedIn}
                    onClick={() => void removeRelease(rel)}
                  >
                    {i18n(loc, "release.delete")}
                  </button>
                </span>
              </div>
              {rel.assets.length === 0 ? (
                <div className="muted small release-asset-empty">
                  {i18n(loc, "release.noAssets")}
                </div>
              ) : (
                rel.assets.map((asset) => (
                  <div key={asset.id} className="stash-row release-asset-row">
                    <span className="release-asset-name" title={asset.name}>
                      {asset.name}
                      <span className="muted small"> {asset.sizeLabel}</span>
                    </span>
                    <span className="row-actions release-row-actions">
                      <button
                        type="button"
                        className="pane-btn pane-btn--soft pane-btn--sm"
                        onClick={() => void openUrl(asset.downloadUrl)}
                      >
                        {i18n(loc, "release.download")}
                      </button>
                      <button
                        type="button"
                        className="pane-btn pane-btn--danger pane-btn--sm"
                        disabled={props.busy || !loggedIn}
                        onClick={() =>
                          void removeAsset(rel, asset.id, asset.name)
                        }
                      >
                        {i18n(loc, "release.delete")}
                      </button>
                    </span>
                  </div>
                ))
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
