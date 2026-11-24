import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "../api";
import { confirmAction } from "../confirm";
import {
  DEFAULT_GITHUB_HOSTS,
  GITHUB_MIRROR_PRESETS,
} from "../githubNetwork";
import {
  LOCALE_CATALOG,
  localeLabel,
  t as i18n,
} from "../i18n";
import {
  DEFAULT_PREFS,
  type AppPrefs,
} from "../settingsStore";
import type { UpdateInfo } from "../types";

type Props = {
  prefs: AppPrefs;
  locale: string;
  updatePrefs: (patch: Partial<AppPrefs>) => void;
  setNotice: (text: string | null, sticky?: boolean) => void;
  setError: (text: string | null) => void;
  busy: boolean;
  appVersion: string;
  updateRepoOwner: string;
  updateRepoName: string;
  updateInfo: UpdateInfo | null;
  updateBusy: boolean;
  updateProgress: { percent: number; label: string } | null;
  checkForUpdate: (quiet?: boolean) => unknown;
  downloadAndInstallUpdate: () => void | Promise<void>;
  onDeleteData?: () => void | Promise<void>;
};

export function SettingsLanguagePage({
  prefs,
  locale,
  updatePrefs,
  setNotice,
}: Pick<Props, "prefs" | "locale" | "updatePrefs" | "setNotice">) {
  const enabled = prefs.enabledLocales.length
    ? prefs.enabledLocales
    : ["zh-CN", "en"];
  const available = LOCALE_CATALOG.filter(
    (l) => !enabled.some((c) => c.toLowerCase() === l.code.toLowerCase()),
  );
  const [pick, setPick] = useState(available[0]?.code ?? "");

  const enabledOptions = enabled.map((code) => ({
    code,
    label: localeLabel(code),
  }));

  return (
    <section className="settings-section">
      <div className="settings-pane-intro">
        <h4>{i18n(locale, "lang.title")}</h4>
        <p className="muted small">{i18n(locale, "lang.hint")}</p>
      </div>

      <div className="settings-card">
        <h5>{i18n(locale, "lang.current")}</h5>
        <div
          className="pref-cards"
          role="radiogroup"
          aria-label={i18n(locale, "lang.current")}
        >
          {enabledOptions.map((opt) => (
            <label
              key={opt.code}
              className={`pref-card${prefs.locale === opt.code ? " is-on" : ""}`}
            >
              <input
                type="radio"
                name="uiLocale"
                checked={prefs.locale === opt.code}
                onChange={() => updatePrefs({ locale: opt.code })}
              />
              <span className="pref-card-text">
                <strong>{opt.label}</strong>
                <span>{opt.code}</span>
              </span>
              <span className="pref-switch" aria-hidden />
            </label>
          ))}
        </div>
      </div>

      <div className="settings-card" style={{ marginTop: "0.75rem" }}>
        <h5>{i18n(locale, "lang.add")}</h5>
        {available.length === 0 ? (
          <p className="muted small">已添加全部内置语言。</p>
        ) : (
          <div className="row-actions" style={{ alignItems: "center" }}>
            <label className="settings-field" style={{ flex: 1 }}>
              <span>{i18n(locale, "lang.pick")}</span>
              <select
                value={pick || available[0]!.code}
                onChange={(e) => setPick(e.target.value)}
              >
                {available.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label} ({l.code})
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="primary"
              onClick={() => {
                const code = (pick || available[0]?.code || "").trim();
                const item = LOCALE_CATALOG.find((l) => l.code === code);
                if (!item) return;
                if (
                  enabled.some((c) => c.toLowerCase() === code.toLowerCase())
                ) {
                  setNotice("该语言已添加");
                  return;
                }
                const next = [...enabled, code];
                updatePrefs({ enabledLocales: next, locale: code });
                const rest = available.filter((l) => l.code !== code);
                setPick(rest[0]?.code ?? "");
                setNotice(`已添加 ${item.label}`);
              }}
            >
              {i18n(locale, "lang.add")}
            </button>
          </div>
        )}
      </div>

      <div className="settings-card" style={{ marginTop: "0.75rem" }}>
        <h5>已启用语言</h5>
        <ul className="settings-locale-list">
          {enabledOptions.map((c) => (
            <li key={c.code}>
              <span>
                {c.label} <code>{c.code}</code>
                {prefs.locale === c.code ? " · 当前" : ""}
              </span>
              <button
                type="button"
                className="linkish"
                disabled={enabled.length <= 1}
                onClick={() => {
                  if (enabled.length <= 1) {
                    setNotice("至少保留一种语言");
                    return;
                  }
                  const next = enabled.filter((x) => x !== c.code);
                  updatePrefs({
                    enabledLocales: next,
                    locale:
                      prefs.locale === c.code
                        ? next[0] ?? "zh-CN"
                        : prefs.locale,
                  });
                  setNotice(`已删除 ${c.label}`);
                }}
              >
                {i18n(locale, "lang.remove")}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

export function SettingsNetworkPage({
  prefs,
  locale,
  updatePrefs,
  setNotice,
  setError,
  busy,
}: Pick<
  Props,
  "prefs" | "locale" | "updatePrefs" | "setNotice" | "setError" | "busy"
>) {
  const hostsValue = prefs.hostsText.trim()
    ? prefs.hostsText
    : DEFAULT_GITHUB_HOSTS;
  const [hostsBusy, setHostsBusy] = useState(false);
  const [hostsManaged, setHostsManaged] = useState<boolean | null>(null);
  const [showHostsAdvanced, setShowHostsAdvanced] = useState(false);

  const refreshHostsStatus = async () => {
    try {
      const st = await api.getHostsStatus();
      setHostsManaged(st.managed);
    } catch {
      setHostsManaged(null);
    }
  };

  useEffect(() => {
    void refreshHostsStatus();
  }, []);

  const resolveAndApply = async (): Promise<string> => {
    let block = "";
    try {
      block = await api.resolveGithubHosts();
    } catch {
      block = hostsValue.trim() || DEFAULT_GITHUB_HOSTS;
      setNotice("在线解析失败，已改用本地片段写入");
    }
    updatePrefs({ hostsText: block, hostsAuto: true });
    const path = await api.applySystemHosts(block);
    await refreshHostsStatus();
    return path;
  };

  const clearHosts = async (): Promise<string> => {
    const path = await api.applySystemHosts("");
    updatePrefs({ hostsAuto: false });
    await refreshHostsStatus();
    return path;
  };

  return (
    <section className="settings-section">
      <div className="settings-pane-intro">
        <h4>{i18n(locale, "net.title")}</h4>
      </div>

      <div className="settings-card">
        <h5>{i18n(locale, "net.mirror.title")}</h5>
        <p className="muted small">{i18n(locale, "net.mirror.hint")}</p>
        <div className="pref-cards" role="radiogroup">
          {GITHUB_MIRROR_PRESETS.map((m) => (
            <label
              key={m.id}
              className={`pref-card${
                prefs.githubMirrorId === m.id ? " is-on" : ""
              }`}
            >
              <input
                type="radio"
                name="githubMirror"
                checked={prefs.githubMirrorId === m.id}
                onChange={() => updatePrefs({ githubMirrorId: m.id })}
              />
              <span className="pref-card-text">
                <strong>
                  {m.id === "off" ? i18n(locale, "net.mirror.off") : m.label}
                </strong>
                {m.prefix ? <span>{m.prefix}</span> : null}
              </span>
              <span className="pref-switch" aria-hidden />
            </label>
          ))}
          <label
            className={`pref-card${
              prefs.githubMirrorId === "custom" ? " is-on" : ""
            }`}
          >
            <input
              type="radio"
              name="githubMirror"
              checked={prefs.githubMirrorId === "custom"}
              onChange={() => updatePrefs({ githubMirrorId: "custom" })}
            />
            <span className="pref-card-text">
              <strong>{i18n(locale, "net.mirror.custom")}</strong>
              <span>例如 https://ghproxy.net/</span>
            </span>
            <span className="pref-switch" aria-hidden />
          </label>
        </div>
        {prefs.githubMirrorId === "custom" && (
          <label className="settings-field" style={{ marginTop: "0.5rem" }}>
            <span>{i18n(locale, "net.mirror.custom")}</span>
            <input
              value={prefs.githubMirrorCustom}
              onChange={(e) =>
                updatePrefs({ githubMirrorCustom: e.target.value })
              }
              placeholder="https://ghproxy.net/"
              spellCheck={false}
            />
          </label>
        )}
      </div>

      <div className="settings-card" style={{ marginTop: "0.75rem" }}>
        <h5>{i18n(locale, "net.hosts.title")}</h5>
        <p className="muted small">{i18n(locale, "net.hosts.hint")}</p>
        <p className="muted small">
          {hostsManaged === true
            ? i18n(locale, "net.hosts.status.on")
            : hostsManaged === false
              ? i18n(locale, "net.hosts.status.off")
              : null}
        </p>

        <div className="pref-cards" role="group">
          <label
            className={`pref-card${prefs.hostsAuto ? " is-on" : ""}`}
          >
            <input
              type="checkbox"
              checked={prefs.hostsAuto}
              disabled={busy || hostsBusy}
              onChange={(e) => {
                const on = e.target.checked;
                void (async () => {
                  setHostsBusy(true);
                  setError(null);
                  try {
                    if (on) {
                      const path = await resolveAndApply();
                      setNotice(`已自动写入 Hosts：${path}`);
                    } else {
                      const path = await clearHosts();
                      setNotice(`已清除青枝 Hosts 片段：${path}`);
                    }
                  } catch (err) {
                    setError(String(err));
                    // Revert toggle on failure
                    updatePrefs({ hostsAuto: !on ? true : false });
                  } finally {
                    setHostsBusy(false);
                  }
                })();
              }}
            />
            <span className="pref-card-text">
              <strong>{i18n(locale, "net.hosts.auto")}</strong>
              <span>{i18n(locale, "net.hosts.auto.desc")}</span>
            </span>
            <span className="pref-switch" aria-hidden />
          </label>
        </div>

        <div className="row-actions" style={{ marginTop: "0.55rem" }}>
          <button
            type="button"
            className="primary"
            disabled={busy || hostsBusy}
            onClick={() => {
              void (async () => {
                setHostsBusy(true);
                setError(null);
                try {
                  const path = await resolveAndApply();
                  setNotice(`已刷新并写入 Hosts：${path}`);
                } catch (err) {
                  setError(String(err));
                } finally {
                  setHostsBusy(false);
                }
              })();
            }}
          >
            {hostsBusy
              ? "处理中…"
              : i18n(locale, "net.hosts.refresh")}
          </button>
          <button
            type="button"
            disabled={busy || hostsBusy || hostsManaged === false}
            onClick={() => {
              void (async () => {
                setHostsBusy(true);
                setError(null);
                try {
                  const path = await clearHosts();
                  setNotice(`已清除：${path}`);
                } catch (err) {
                  setError(String(err));
                } finally {
                  setHostsBusy(false);
                }
              })();
            }}
          >
            {i18n(locale, "net.hosts.remove")}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              void (async () => {
                try {
                  await api.revealSystemHosts();
                  setNotice("已打开 Hosts 所在目录");
                } catch (e) {
                  setError(String(e));
                }
              })();
            }}
          >
            {i18n(locale, "net.hosts.open")}
          </button>
        </div>

        <button
          type="button"
          className="linkish"
          style={{ marginTop: "0.65rem", justifySelf: "start" }}
          onClick={() => setShowHostsAdvanced((v) => !v)}
        >
          {i18n(locale, "net.hosts.advanced")}
          {showHostsAdvanced ? " ▲" : " ▼"}
        </button>

        {showHostsAdvanced && (
          <>
            <textarea
              className="settings-hosts-editor"
              rows={8}
              value={hostsValue}
              onChange={(e) => updatePrefs({ hostsText: e.target.value })}
              spellCheck={false}
            />
            <div className="row-actions" style={{ marginTop: "0.5rem" }}>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(hostsValue);
                  setNotice("已复制 Hosts 片段");
                }}
              >
                {i18n(locale, "net.hosts.copy")}
              </button>
              <button
                type="button"
                className="primary"
                disabled={busy || hostsBusy}
                onClick={() => {
                  void (async () => {
                    setHostsBusy(true);
                    setError(null);
                    try {
                      const path = await api.applySystemHosts(hostsValue);
                      updatePrefs({ hostsAuto: true, hostsText: hostsValue });
                      await refreshHostsStatus();
                      setNotice(`已写入 Hosts：${path}`);
                    } catch (e) {
                      setError(String(e));
                    } finally {
                      setHostsBusy(false);
                    }
                  })();
                }}
              >
                {i18n(locale, "net.hosts.apply")}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  updatePrefs({ hostsText: DEFAULT_GITHUB_HOSTS });
                  setNotice("已恢复默认 Hosts 片段");
                }}
              >
                恢复默认片段
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

export function SettingsResetPage({
  locale,
  updatePrefs,
  setNotice,
  onDeleteData,
}: Pick<Props, "locale" | "updatePrefs" | "setNotice" | "onDeleteData">) {
  return (
    <section className="settings-section">
      <div className="settings-pane-intro">
        <h4>{i18n(locale, "reset.title")}</h4>
        <p className="muted small">{i18n(locale, "reset.hint")}</p>
      </div>

      <div className="settings-card">
        <h5>{i18n(locale, "reset.settings")}</h5>
        <p className="muted small">{i18n(locale, "reset.settings.desc")}</p>
        <button
          type="button"
          className="primary"
          onClick={() => {
            void (async () => {
              const phrase = i18n(locale, "reset.settings");
              const ok = await confirmAction(
                `将恢复主题、语言、网络、壁纸等偏好为默认值。\n请输入「${phrase}」后确认。`,
                {
                  title: phrase,
                  danger: true,
                  confirmLabel: phrase,
                  requirePhrase: phrase,
                  phraseHint: `请输入「${phrase}」`,
                },
              );
              if (!ok) return;
              updatePrefs({
                ...DEFAULT_PREFS,
                enabledLocales: [...DEFAULT_PREFS.enabledLocales],
              });
              setNotice("已重置设置");
            })();
          }}
        >
          {i18n(locale, "reset.settings")}
        </button>
      </div>

      <div className="settings-card" style={{ marginTop: "0.75rem" }}>
        <h5>{i18n(locale, "reset.data")}</h5>
        <p className="muted small">{i18n(locale, "reset.data.desc")}</p>
        <button
          type="button"
          className="danger"
          onClick={() => {
            void (async () => {
              const phrase = i18n(locale, "reset.data");
              const ok = await confirmAction(
                `将清空最近打开、仓库缓存、壁纸副本与本地偏好等数据。\n请输入「${phrase}」后确认。`,
                {
                  title: phrase,
                  danger: true,
                  confirmLabel: phrase,
                  requirePhrase: phrase,
                  phraseHint: `请输入「${phrase}」`,
                },
              );
              if (!ok) return;
              await onDeleteData?.();
              setNotice("已删除本地数据");
            })();
          }}
        >
          {i18n(locale, "reset.data")}
        </button>
      </div>
    </section>
  );
}

export function SettingsAboutPage({
  locale,
  appVersion,
  updateRepoOwner,
  updateRepoName,
  updateInfo,
  updateBusy,
  updateProgress,
  busy,
  checkForUpdate,
  downloadAndInstallUpdate,
  setNotice,
}: Pick<
  Props,
  | "locale"
  | "appVersion"
  | "updateRepoOwner"
  | "updateRepoName"
  | "updateInfo"
  | "updateBusy"
  | "updateProgress"
  | "busy"
  | "checkForUpdate"
  | "downloadAndInstallUpdate"
  | "setNotice"
>) {
  const hasUpdate = Boolean(updateInfo?.updateAvailable);
  return (
    <section className="settings-section">
      <div className="settings-pane-intro">
        <h4>{i18n(locale, "about.title")}</h4>
        <p className="muted small">本地 Git 桌面工具 · 开源，禁止商用</p>
      </div>
      <div className="settings-card about-card">
        <div className="about-brand">青枝</div>
        <p className="about-line">
          <span>当前版本</span>
          <strong>v{appVersion}</strong>
        </p>
        <p className="about-line">
          <span>作者</span>
          <strong>理智护发</strong>
        </p>
        <p className="about-line">
          <span>邮箱</span>
          <button
            type="button"
            className="linkish about-mail"
            onClick={() => void openUrl("mailto:lizhihufa@163.com")}
          >
            lizhihufa@163.com
          </button>
        </p>
      </div>

      <div className="settings-card about-feedback" style={{ marginTop: "0.75rem" }}>
        <h5>软件更新</h5>
        <p className="muted small">
          从 GitHub（{updateRepoOwner}/{updateRepoName}）检测最新 Release。
        </p>
        {hasUpdate ? (
          <p className="about-update-tip">
            发现新版本 <strong>v{updateInfo!.latestVersion}</strong>
            {updateInfo!.name ? ` · ${updateInfo!.name}` : ""}
          </p>
        ) : updateInfo ? (
          <p className="muted small">当前已是最新版本。</p>
        ) : null}
        {updateInfo?.body ? (
          <pre className="about-release-notes">{updateInfo.body}</pre>
        ) : null}
        {updateProgress && (
          <div className="about-progress">
            <div className="about-progress-head">
              <span>{updateProgress.label}</span>
              <span>{updateProgress.percent}%</span>
            </div>
            <div className="about-progress-bar">
              <i style={{ width: `${updateProgress.percent}%` }} />
            </div>
          </div>
        )}
        <div className="about-actions">
          <button
            type="button"
            disabled={updateBusy || busy}
            onClick={() => void checkForUpdate(false)}
          >
            检查更新
          </button>
          {hasUpdate && (
            <button
              type="button"
              className="primary"
              disabled={updateBusy || busy}
              onClick={() => void downloadAndInstallUpdate()}
            >
              下载并安装
            </button>
          )}
          {updateInfo?.htmlUrl && (
            <button
              type="button"
              className="linkish"
              disabled={updateBusy}
              onClick={() => void openUrl(updateInfo.htmlUrl)}
            >
              打开 Release 页面
            </button>
          )}
        </div>
      </div>

      <div className="settings-card about-feedback" style={{ marginTop: "0.75rem" }}>
        <h5>遇到问题？</h5>
        <p className="muted small">
          请截图界面，并简要说明操作步骤与报错内容，发送到作者邮箱。收到后会尽快回复。
        </p>
        <button
          type="button"
          className="primary about-feedback-btn"
          onClick={() =>
            void openUrl(
              "mailto:lizhihufa@163.com?subject=%E9%9D%92%E6%9E%9D%E9%97%AE%E9%A2%98%E5%8F%8D%E9%A6%88&body=%E8%AF%B7%E9%99%84%E4%B8%8A%E6%88%AA%E5%9B%BE%EF%BC%8C%E5%B9%B6%E8%AF%B4%E6%98%8E%EF%BC%9A%0A1.%20%E5%81%9A%E4%BA%86%E4%BB%80%E4%B9%88%0A2.%20%E5%87%BA%E7%8E%B0%E4%BA%86%E4%BB%80%E4%B9%88%0A3.%20%E6%9C%9F%E6%9C%9B%E7%BB%93%E6%9E%9C%0A",
            )
          }
        >
          写邮件反馈
        </button>
        <button
          type="button"
          className="about-copy-mail"
          onClick={() => {
            void navigator.clipboard.writeText("lizhihufa@163.com");
            setNotice("已复制邮箱");
          }}
        >
          复制邮箱
        </button>
      </div>
    </section>
  );
}
