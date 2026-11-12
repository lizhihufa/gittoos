import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "../api";
import { confirmAction } from "../confirm";
import { failureLine } from "../statusMessage";
import type { ReleaseItem } from "../types";

type Props = {
  owner: string;
  repo: string;
  defaultTag: string;
  githubLoggedIn: boolean;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onNotice: (text: string | null) => void;
  onError: (text: string | null) => void;
  onOpenAuth: () => void;
  onConfigureRepo?: () => void;
  progress: { percent: number; label: string } | null;
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
  const [items, setItems] = useState<ReleaseItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [filePath, setFilePath] = useState("");
  const [tag, setTag] = useState("");
  const [tagTouched, setTagTouched] = useState(false);
  const [title, setTitle] = useState("");
  const [titleTouched, setTitleTouched] = useState(false);
  const [notes, setNotes] = useState("");
  const [showNotes, setShowNotes] = useState(false);

  const { owner, repo, onError } = props;

  // 切换仓库时重置，避免沿用上一仓库 / 本软件版本号
  useEffect(() => {
    setTag("");
    setTitle("");
    setTagTouched(false);
    setTitleTouched(false);
    setFilePath("");
    setNotes("");
  }, [owner, repo]);

  // Tag 默认取该仓库最新 Release；没有列表时才用外部 defaultTag
  useEffect(() => {
    if (tagTouched) return;
    if (items.length > 0) {
      setTag(items[0].tagName);
      return;
    }
    if (props.defaultTag) setTag(props.defaultTag);
  }, [items, props.defaultTag, tagTouched]);

  // 标题默认取当前 Tag 对应项（或最新一条），并去掉版本后缀
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
      const list = await api.listGithubReleases(owner, repo, 20);
      setItems(list);
    } catch (e) {
      onError(failureLine(e));
    } finally {
      setLoading(false);
    }
  }, [owner, repo, onError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const hasTarget = Boolean(owner.trim() && repo.trim());

  async function pickFile() {
    const selected = await open({
      multiple: false,
      filters: [{ name: "安装包 / 文件", extensions: ["exe", "zip", "msi", "7z"] }],
      title: "选择要上传的 Release 文件",
    });
    if (typeof selected === "string") setFilePath(selected);
  }

  async function upload() {
    if (!hasTarget) {
      props.onError("未识别到 GitHub 仓库：请配置 origin，或在设置中手动指定 Release 仓库");
      return;
    }
    if (!filePath.trim()) {
      props.onError("请先选择要上传的文件");
      return;
    }
    if (!props.githubLoggedIn) {
      props.onError("请先登录 GitHub（需要仓库写权限）");
      props.onOpenAuth();
      return;
    }

    const tagName = normalizeTag(tag, props.defaultTag);
    const releaseTitle =
      stripVersionSuffix(title.trim() || tagName, tagName) || tagName;
    const ok = await confirmAction(
      `上传到 ${props.owner}/${props.repo}\n标题：${releaseTitle}\nTag：${tagName}\n文件：${fileName(filePath)}\n若 Tag 不存在会自动创建 Release。`,
      { title: "上传到 Release", confirmLabel: "上传" },
    );
    if (!ok) return;
    props.onBusy(true);
    props.onError(null);
    props.onNotice("正在上传到 GitHub Releases…");
    try {
      const result = await api.publishGithubRelease({
        filePath,
        tag: tagName,
        title: releaseTitle,
        notes: notes.trim() || undefined,
        owner: props.owner,
        repo: props.repo,
      });
      props.onNotice(`已上传 ${result.assetName} → ${result.tagName}`);
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
    if (!props.githubLoggedIn) {
      props.onOpenAuth();
      return;
    }
    const ok = await confirmAction(
      `从 ${release.tagName} 删除附件「${name}」？`,
      { title: "删除附件", danger: true, confirmLabel: "删除" },
    );
    if (!ok) return;
    props.onBusy(true);
    try {
      await api.deleteGithubReleaseAsset(assetId, props.owner, props.repo);
      props.onNotice(`已删除附件 ${name}`);
      await refresh();
    } catch (e) {
      props.onError(failureLine(e));
    } finally {
      props.onBusy(false);
    }
  }

  async function removeRelease(release: ReleaseItem) {
    if (!props.githubLoggedIn) {
      props.onOpenAuth();
      return;
    }
    const ok = await confirmAction(
      `删除整个 Release「${release.tagName}」及其全部附件？\n不会删除 Git Tag。`,
      { title: "删除 Release", danger: true, confirmLabel: "删除" },
    );
    if (!ok) return;
    props.onBusy(true);
    try {
      await api.deleteGithubRelease(release.id, props.owner, props.repo);
      props.onNotice(`已删除 Release ${release.tagName}`);
      await refresh();
    } catch (e) {
      props.onError(failureLine(e));
    } finally {
      props.onBusy(false);
    }
  }

  return (
    <div className="panel pad-block release-manager">
      <div className="release-bar">
        <label className="release-field release-field-title">
          <span>标题</span>
          <input
            value={title}
            onChange={(e) => {
              setTitleTouched(true);
              setTitle(e.target.value);
            }}
            placeholder="例如：青枝；留空则用 Tag"
            disabled={props.busy}
            title="Release 显示名称（不要带版本号）；默认取自下方列表，留空则用 Tag"
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
            title="版本 Tag（默认取本仓库最新 Release）"
          />
        </label>

        <div className="release-actions" role="group" aria-label="Release 操作">
          <button
            type="button"
            className="pane-btn pane-btn--soft"
            disabled={props.busy || !hasTarget}
            onClick={() => void pickFile()}
          >
            选择文件
          </button>
          <button
            type="button"
            className="pane-btn pane-btn--primary"
            disabled={props.busy || !hasTarget || !filePath}
            onClick={() => void upload()}
            title="上传到 GitHub Release"
          >
            上传
          </button>
          <span className="release-actions-split" aria-hidden />
          <button
            type="button"
            className="pane-btn pane-btn--ghost"
            disabled={props.busy || loading || !hasTarget}
            onClick={() => void refresh()}
          >
            {loading ? "刷新中" : "刷新"}
          </button>
          <button
            type="button"
            className={`pane-btn pane-btn--ghost${showNotes ? " is-on" : ""}`}
            disabled={props.busy}
            onClick={() => setShowNotes((v) => !v)}
          >
            {showNotes ? "收起说明" : "说明"}
          </button>
        </div>
      </div>

      <div className="release-toolbar-meta">
        <span className="muted small" title={filePath || undefined}>
          {!hasTarget
            ? "未识别到 GitHub 仓库：请配置 origin，或到设置 → 外观 手动指定"
            : filePath
              ? fileName(filePath)
              : `目标 ${props.owner}/${props.repo}${
                  props.githubLoggedIn ? "" : " · 上传/删除需登录"
                }`}
        </span>
        {!hasTarget && props.onConfigureRepo ? (
          <button
            type="button"
            className="pane-btn pane-btn--soft pane-btn--sm"
            onClick={props.onConfigureRepo}
          >
            去设置
          </button>
        ) : null}
      </div>

      {showNotes && (
        <textarea
          className="release-notes-input"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="新建 Release 时的说明（已有 Tag 则忽略）"
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
          <li className="muted pad">还没有 Release。选择文件并上传后会自动创建。</li>
        )}
        {items.map((rel) => {
          const relTitle = releaseTitleOf(rel);
          return (
          <li key={rel.id} className="release-group">
            <div className="stash-row release-row">
              <button
                type="button"
                className="release-row-main release-row-pick"
                title="填入上方标题 / Tag"
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
                  打开
                </button>
                <button
                  type="button"
                  className="pane-btn pane-btn--danger pane-btn--sm"
                  disabled={props.busy || !props.githubLoggedIn}
                  onClick={() => void removeRelease(rel)}
                >
                  删除
                </button>
              </span>
            </div>
            {rel.assets.length === 0 ? (
              <div className="muted small release-asset-empty">无附件</div>
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
                      下载
                    </button>
                    <button
                      type="button"
                      className="pane-btn pane-btn--danger pane-btn--sm"
                      disabled={props.busy || !props.githubLoggedIn}
                      onClick={() =>
                        void removeAsset(rel, asset.id, asset.name)
                      }
                    >
                      删除
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
