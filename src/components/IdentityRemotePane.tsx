import { useEffect, useState } from "react";

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
  initialName: string;
  initialEmail: string;
  initialRemote: string;
  initialClone: string;
  saveGlobally: boolean;
  busy: boolean;
  onSaveGloballyChange: (value: boolean) => void;
  onDraftChange?: (draft: IdentityRemoteDraft) => void;
  onSave: (draft: IdentityRemoteDraft) => void;
};

/**
 * Local drafts so typing does not re-render the whole App (was very laggy).
 */
export function IdentityRemotePane({
  repoPath,
  remotesCount,
  initialName,
  initialEmail,
  initialRemote,
  initialClone,
  saveGlobally,
  busy,
  onSaveGloballyChange,
  onDraftChange,
  onSave,
}: Props) {
  const [name, setName] = useState(initialName);
  const [email, setEmail] = useState(initialEmail);
  const [remote, setRemote] = useState(initialRemote);
  const [clone, setClone] = useState(initialClone);

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
          <label className="check">
            <input
              type="checkbox"
              checked={saveGlobally}
              onChange={(e) => onSaveGloballyChange(e.target.checked)}
            />
            这台电脑上的其他仓库也使用
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
              : "修改后点下方「保存」覆盖保存。"
            : "打开仓库后可设置远程地址。"}
        </p>
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
