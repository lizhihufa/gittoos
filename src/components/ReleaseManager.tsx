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

function releaseLabel(rel: ReleaseItem): string {
  const tag = rel.tagName;
  const name = rel.name.trim();
  if (
    !name ||
    name === tag ||
    name === `青枝 ${tag}` ||
    name === `青枝${tag}` ||
    name.replace(/\s+/g, "") === `青枝${tag}`
  ) {
    return tag;
  }
  return `${tag} · ${name}`;
}

function fileName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}

export function ReleaseManager(props: Props) {
  const [items, setItems] = useState<ReleaseItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [filePath, setFilePath] = useState("");
  const [tag, setTag] = useState(props.defaultTag);
  const [notes, setNotes] = useState("");
  const [showNotes, setShowNotes] = useState(false);

  useEffect(() => {
    if (props.defaultTag && !tag) setTag(props.defaultTag);
  }, [props.defaultTag, tag]);

  const { owner, repo, onError } = props;

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

    const rawTag = (tag.trim() || props.defaultTag).replace(/^V/, "v");
    const tagName = rawTag.startsWith("v") ? rawTag : `v${rawTag}`;
    const ok = await confirmAction(
      `上传到 ${props.owner}/${props.repo}\nTag：${tagName}\n文件：${fileName(filePath)}\n若 Tag 不存在会自动创建 Release。`,
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
        title: `青枝 ${tagName}`,
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
        <label className="release-field">
          <span>Tag</span>
          <input
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            placeholder={props.defaultTag || "v1.0.0"}
            disabled={props.busy}
            title="版本 Tag"
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
        {items.map((rel) => (
          <li key={rel.id} className="release-group">
            <div className="stash-row release-row">
              <span className="release-row-main">
                <strong>{releaseLabel(rel)}</strong>
                {rel.publishedAt ? (
                  <span className="muted small">
                    {rel.publishedAt.replace("T", " ").slice(0, 16)}
                  </span>
                ) : null}
              </span>
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
        ))}
      </ul>
    </div>
  );
}
