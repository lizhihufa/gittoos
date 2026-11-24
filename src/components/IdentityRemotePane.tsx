import { useEffect, useState } from "react";
import type { RemoteInfo } from "../types";

export type IdentityRemoteDraft = {
  name: string;
  email: string;
  remote: string;
  clone: string;
  saveGlobally: boolean;
};

type Props = {
  repoPath: string | null;
  remotesCount: number;
  remotes?: RemoteInfo[];
  initialName: string;
  initialEmail: string;
  initialRemote: string;
  initialClone: string;
  saveGlobally: boolean;
  busy: boolean;
  onSaveGloballyChange: (value: boolean) => void;
  onDraftChange?: (draft: IdentityRemoteDraft) => void;
  onSave: (draft: IdentityRemoteDraft) => void;
  onRemoveRemote?: (name: string) => void;
  onAddRemote?: (name: string, url: string) => void;
};

/**
 * Local drafts so typing does not re-render the whole App (was very laggy).
 */
export function IdentityRemotePane({
  repoPath,
  remotesCount,
  remotes = [],
  initialName,
  initialEmail,
  initialRemote,
  initialClone,
  saveGlobally,
  busy,
  onSaveGloballyChange,
  onDraftChange,
  onSave,
  onRemoveRemote,
  onAddRemote,
}: Props) {
  const [name, setName] = useState(initialName);
  const [email, setEmail] = useState(initialEmail);
  const [remote, setRemote] = useState(initialRemote);
  const [clone, setClone] = useState(initialClone);
  const [extraName, setExtraName] = useState("");
  const [extraUrl, setExtraUrl] = useState("");

  useEffect(() => {
    setName(initialName);
    setEmail(initialEmail);
    setRemote(initialRemote);
    setClone(initialClone);
  }, [repoPath, initialName, initialEmail, initialRemote, initialClone]);

  useEffect(() => {
    onDraftChange?.({
      name,
      email,
      remote,
      clone,
      saveGlobally,
    });
  }, [name, email, remote, clone, saveGlobally, onDraftChange]);

  const canSaveIdentity =
    Boolean(repoPath) && name.trim().length > 0 && email.includes("@");
  const canSaveRemote = Boolean(repoPath) && remote.trim().length > 0;
  const canSave = canSaveIdentity || canSaveRemote || clone.trim().length > 0;
  const canAddExtra =
    Boolean(repoPath) &&
    Boolean(onAddRemote) &&
    extraName.trim().length > 0 &&
    extraUrl.trim().length > 0;

  return (
    <section className="settings-section">
      <div className="settings-pane-intro">
        <h4>身份与远程</h4>
        <p className="muted small">提交署名、远程 origin 与克隆地址。</p>
      </div>

      <div className="settings-card">
        <label className="settings-field">
          <span>名称</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="你的名字"
            disabled={!repoPath}
          />
        </label>
        <label className="settings-field">
          <span>邮箱</span>
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            disabled={!repoPath}
          />
        </label>
        {repoPath ? (
          <label
            className={`pref-card identity-global-pref${saveGlobally ? " is-on" : ""}`}
          >
            <input
              type="checkbox"
              checked={saveGlobally}
              onChange={(e) => onSaveGloballyChange(e.target.checked)}
            />
            <span className="pref-card-text">
              <strong>应用到本机其他仓库</strong>
              <span>勾选后名称和邮箱写入全局 Git 配置</span>
            </span>
            <span className="pref-switch" aria-hidden />
          </label>
        ) : (
          <p className="muted small">打开仓库后可保存名称和邮箱。</p>
        )}
      </div>

      <div className="settings-card">
        <label className="settings-field">
          <span>远程地址（origin）</span>
          <input
            value={remote}
            onChange={(e) => setRemote(e.target.value)}
            placeholder="https://github.com/用户/仓库.git"
            disabled={!repoPath}
          />
        </label>
        <p className="muted small">
          {repoPath
            ? remotesCount === 0
              ? "填写后点下方「保存」写入 origin。"
              : "修改后点下方「保存」覆盖保存 origin。"
            : "打开仓库后可设置远程地址。"}
        </p>
        {repoPath && remotes.length > 0 && (
          <ul className="remote-list">
            {remotes.map((r) => (
              <li key={r.name} className="stash-row">
                <span>
                  <strong>{r.name}</strong>{" "}
                  <span className="muted small">{r.url}</span>
                </span>
                {onRemoveRemote && (
                  <span className="row-actions">
                    <button
                      type="button"
                      className="danger"
                      disabled={busy}
                      onClick={() => onRemoveRemote(r.name)}
                    >
                      删除
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {repoPath && onAddRemote && (
          <div className="remote-add-row">
            <input
              value={extraName}
              onChange={(e) => setExtraName(e.target.value)}
              placeholder="远程名（如 upstream）"
              disabled={busy}
            />
            <input
              value={extraUrl}
              onChange={(e) => setExtraUrl(e.target.value)}
              placeholder="https://… 或 git@…"
              disabled={busy}
            />
            <button
              type="button"
              disabled={busy || !canAddExtra}
              onClick={() => {
                onAddRemote(extraName.trim(), extraUrl.trim());
                setExtraName("");
                setExtraUrl("");
              }}
            >
              添加远程
            </button>
          </div>
        )}
        <label className="settings-field">
          <span>克隆地址</span>
          <input
            value={clone}
            onChange={(e) => setClone(e.target.value)}
            placeholder="https://github.com/用户/仓库.git"
          />
        </label>
        <p className="muted small">
          填写后点「保存」写入；也可直接点工具栏「克隆」选择空文件夹克隆。
        </p>
        <button
          type="button"
          className="primary"
          disabled={busy || !canSave}
          onClick={() =>
            onSave({
              name,
              email,
              remote,
              clone,
              saveGlobally,
            })
          }
        >
          保存
        </button>
      </div>
    </section>
  );
}
