import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { getVersion } from "@tauri-apps/api/app";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "./api";
import { confirmAction, withConfirm } from "./confirm";
import { ChangeList } from "./components/ChangeList";
import { ExtraPane, type Pane } from "./components/ExtraPane";
import {
  IdentityRemotePane,
  type IdentityRemoteDraft,
} from "./components/IdentityRemotePane";
import { LoadingScreen } from "./components/LoadingScreen";
import { Terminal } from "./components/Terminal";
import { WindowChrome } from "./components/WindowChrome";
import {
  clearRecent,
  loadRecent,
  pruneRecent,
  rememberRecent,
  removeRecent,
} from "./recent";
import { clearRepoCache, loadRepoCache, saveRepoCache } from "./repoCache";
import {
  applyPrefsToDocument,
  loadCloneUrl,
  loadOpenRepos,
  loadPrefs,
  saveCloneUrl,
  saveOpenRepos,
  savePrefs,
  type AppPrefs,
} from "./settingsStore";
import {
  failureLine,
  isAuthFailure,
  successLine,
  syncConflictKind,
  type SyncConflictKind,
} from "./statusMessage";
import type {
  AuthAccounts,
  AuthProvider,
  BranchInfo,
  CommitInfo,
  FileChange,
  GithubDeviceStart,
  GitInfo,
  Identity,
  LargeFileInfo,
  ProviderStatus,
  RemoteBranchInfo,
  RemoteInfo,
  RepoStatus,
  SshStatus,
  StashInfo,
  TagInfo,
  UpdateInfo,
} from "./types";

const LARGE_FILE_LIMIT_BYTES = 100 * 1024 * 1024;
const UPDATE_REPO_OWNER = "lizhihufa";
const UPDATE_REPO_NAME = "gittoos";
import "./App.css";

function folderName(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function statusFingerprint(s: RepoStatus): string {
  return JSON.stringify({
    branch: s.branch,
    ahead: s.ahead,
    behind: s.behind,
    operation: s.operation,
    changes: s.changes,
  });
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  );
}

type FileFilter = "all" | "conflict" | "untracked";

type ProviderDraft = {
  token: string;
  clientId: string;
  clientSecret: string;
  showToken: boolean;
  showOauth: boolean;
};

type BootState = {
  path: string;
  progress: number;
  label: string;
  fromCache: boolean;
};

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** Let the browser paint / handle input between heavy steps. */
function yieldToUi(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      window.setTimeout(resolve, 0);
    });
  });
}

const ACTION_WATCHDOG_MS = 90_000;

export default function App() {
  const [gitInfo, setGitInfo] = useState<GitInfo | null>(null);
  const [repoPath, setRepoPath] = useState<string | null>(null);
  const [openRepos, setOpenRepos] = useState<string[]>(() => loadOpenRepos());
  const [status, setStatus] = useState<RepoStatus | null>(null);
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [remoteBranches, setRemoteBranches] = useState<RemoteBranchInfo[]>([]);
  const [recent, setRecent] = useState<string[]>(() => loadRecent());
  const [prefs, setPrefs] = useState<AppPrefs>(() => {
    const initial = loadPrefs();
    applyPrefsToDocument(initial);
    return initial;
  });
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNoticeState] = useState<string | null>(null);
  /** When true, notice does not auto-dismiss (e.g. push completed). */
  const [noticeSticky, setNoticeSticky] = useState(false);
  const setNotice = useCallback((text: string | null, sticky = false) => {
    setNoticeSticky(Boolean(text && sticky));
    setNoticeState(text);
  }, []);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [selected, setSelected] = useState<{ path: string; staged: boolean } | null>(
    null,
  );
  const [diff, setDiff] = useState("");
  const [diffLoading, setDiffLoading] = useState(false);
  const [newBranch, setNewBranch] = useState("");
  const [pane, setPane] = useState<Pane>("terminal");
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [commitPatch, setCommitPatch] = useState("");
  const [patchLoading, setPatchLoading] = useState(false);
  const [stashes, setStashes] = useState<StashInfo[]>([]);
  const [stashMessage, setStashMessage] = useState("");
  const [stashIncludeUntracked, setStashIncludeUntracked] = useState(true);
  const [tags, setTags] = useState<TagInfo[]>([]);
  const [tagName, setTagName] = useState("");
  const [identity, setIdentity] = useState<Identity>({ name: "", email: "" });
  const [identitySaved, setIdentitySaved] = useState(false);
  const [saveGlobally, setSaveGlobally] = useState(true);
  const [remotes, setRemotes] = useState<RemoteInfo[]>([]);
  const [remoteUrl, setRemoteUrl] = useState("");
  const [cloneUrl, setCloneUrl] = useState(() => loadCloneUrl());
  const [mergeTarget, setMergeTarget] = useState("");
  const [rebaseTarget, setRebaseTarget] = useState("");
  const [terminal, setTerminal] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [settingsPage, setSettingsPage] = useState<
    "appearance" | "auth" | "identity"
  >("appearance");
  const [appVersion, setAppVersion] = useState(
    typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "…",
  );
  const [showHelp, setShowHelp] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateProgress, setUpdateProgress] = useState<{
    percent: number;
    label: string;
  } | null>(null);
  const [dismissedUpdateTag, setDismissedUpdateTag] = useState<string | null>(null);
  const [boot, setBoot] = useState<BootState | null>(null);
  const [entering, setEntering] = useState(false);
  const [syncingCache, setSyncingCache] = useState(false);
  const [syncDialog, setSyncDialog] = useState<SyncConflictKind | null>(null);
  const [resetTarget, setResetTarget] = useState<CommitInfo | null>(null);
  const [largeCommit, setLargeCommit] = useState<{
    mode: "commit" | "amend";
    message: string;
    files: LargeFileInfo[];
    exclude: Record<string, boolean>;
  } | null>(null);
  const [accounts, setAccounts] = useState<AuthAccounts | null>(null);
  const [authTab, setAuthTab] = useState<AuthProvider>("github");
  const [drafts, setDrafts] = useState<Record<AuthProvider, ProviderDraft>>({
    github: {
      token: "",
      clientId: "",
      clientSecret: "",
      showToken: false,
      showOauth: false,
    },
    gitee: {
      token: "",
      clientId: "",
      clientSecret: "",
      showToken: false,
      showOauth: false,
    },
  });
  const [authHint, setAuthHint] = useState(false);
  const [sessionWarnings, setSessionWarnings] = useState<string[]>([]);
  const [addingAccount, setAddingAccount] = useState(false);
  const [deviceFlow, setDeviceFlow] = useState<GithubDeviceStart | null>(null);
  const [deviceStatus, setDeviceStatus] = useState("");
  const devicePollRef = useRef<number | null>(null);
  const [sshStatus, setSshStatus] = useState<SshStatus | null>(null);
  const [sshFeedback, setSshFeedback] = useState<{
    ok: boolean | null;
    text: string;
  } | null>(null);
  const authSectionRef = useRef<HTMLElement | null>(null);
  const [recentExists, setRecentExists] = useState<Record<string, boolean>>({});
  const [fileQuery, setFileQuery] = useState("");
  const [fileFilter, setFileFilter] = useState<FileFilter>("all");
  const [syncProgress, setSyncProgress] = useState<{
    label: string;
    percent: number;
    detail: string;
  } | null>(null);
  const syncProgressActive = useRef(false);
  const messageRef = useRef(message);
  messageRef.current = message;
  /** Live identity/remote drafts (no App re-render while typing). */
  const identityDraftRef = useRef<IdentityRemoteDraft | null>(null);
  const onIdentityDraftChange = useCallback((draft: IdentityRemoteDraft) => {
    identityDraftRef.current = draft;
  }, []);

  useEffect(() => {
    void getVersion()
      .then(setAppVersion)
      .catch(() => {
        if (typeof __APP_VERSION__ === "string") setAppVersion(__APP_VERSION__);
      });
  }, []);

  useEffect(() => {
    const unlisten = listen<{ percent: number; label: string }>(
      "update-progress",
      (event) => {
        setUpdateProgress({
          percent: Math.max(0, Math.min(100, event.payload.percent)),
          label: event.payload.label,
        });
      },
    );
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  const checkForUpdate = useCallback(
    async (silent = false) => {
      const ver = appVersion === "…" ? "" : appVersion;
      if (!ver) return null;
      try {
        if (!silent) {
          setUpdateBusy(true);
          setNotice("正在检查更新…");
        }
        const info = await api.checkAppUpdate(
          ver,
          UPDATE_REPO_OWNER,
          UPDATE_REPO_NAME,
        );
        setUpdateInfo(info.updateAvailable ? info : info);
        if (!silent) {
          setNotice(
            info.updateAvailable
              ? `发现新版本 v${info.latestVersion}`
              : `已是最新版本 v${info.currentVersion}`,
          );
        }
        return info;
      } catch (e) {
        if (!silent) setError(failureLine(e));
        return null;
      } finally {
        if (!silent) setUpdateBusy(false);
      }
    },
    [appVersion],
  );

  useEffect(() => {
    if (!appVersion || appVersion === "…") return;
    const timer = window.setTimeout(() => {
      void checkForUpdate(true);
    }, 2500);
    return () => window.clearTimeout(timer);
  }, [appVersion, checkForUpdate]);

  async function downloadAndInstallUpdate() {
    if (!updateInfo?.updateAvailable) return;
    const ok = await confirmAction(
      `将下载 v${updateInfo.latestVersion} 安装包并启动安装程序。\n安装时请先关闭青枝。是否继续？`,
      { title: "安装更新", confirmLabel: "下载并安装" },
    );
    if (!ok) return;
    setUpdateBusy(true);
    setUpdateProgress({ percent: 1, label: "准备下载…" });
    setError(null);
    setNotice(`正在下载 v${updateInfo.latestVersion}…`);
    try {
      const path = await api.downloadAppUpdate(
        updateInfo.assetUrl,
        updateInfo.assetName,
      );
      setNotice("下载完成，正在打开安装程序…");
      await api.launchAppInstaller(path, true);
    } catch (e) {
      setNotice(null);
      setError(failureLine(e));
    } finally {
      setUpdateBusy(false);
      setUpdateProgress(null);
    }
  }

  useEffect(() => {
    let pending = "";
    let flushTimer: number | undefined;
    const flush = () => {
      flushTimer = undefined;
      if (!pending) return;
      const chunk = pending;
      pending = "";
      setTerminal((prev) => {
        const next = `${prev}${chunk}`;
        // Keep terminal from growing forever and slowing the UI.
        return next.length > 120_000 ? next.slice(-80_000) : next;
      });
    };
    const unlisten = listen<{ kind: string; text: string }>("git-terminal", (event) => {
      const prefix =
        event.payload.kind === "cmd"
          ? ""
          : event.payload.kind === "err"
            ? ""
            : event.payload.kind === "info"
              ? "# "
              : "";
      pending += `${prefix}${event.payload.text}\n`;
      if (flushTimer === undefined) {
        flushTimer = window.setTimeout(flush, 80);
      }
    });
    const unlistenProgress = listen<{ percent: number; label: string }>(
      "git-progress",
      (event) => {
        if (!syncProgressActive.current) return;
        const percent = Math.max(0, Math.min(100, event.payload.percent));
        setSyncProgress((prev) =>
          prev
            ? {
                ...prev,
                percent: Math.max(prev.percent, percent),
                detail: event.payload.label || prev.detail,
              }
            : {
                label: "同步中",
                percent,
                detail: event.payload.label,
              },
        );
      },
    );
    return () => {
      if (flushTimer !== undefined) window.clearTimeout(flushTimer);
      void unlisten.then((fn) => fn());
      void unlistenProgress.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    setTerminal((prev) => `${prev}# 正在准备 Git…\n`);
    api
      .getGitInfo()
      .then((info) => {
        setGitInfo(info);
        setTerminal((prev) => `${prev}# ${info.version}\n# ${info.path}\n`);
      })
      .catch((e) => setError(failureLine(e)));
  }, []);

  useEffect(() => {
    const title = repoPath
      ? `${folderName(repoPath)} — 青枝`
      : "青枝";
    void getCurrentWindow().setTitle(title);
  }, [repoPath]);

  useEffect(() => {
    if (!notice || noticeSticky) return;
    const current = notice;
    const timer = window.setTimeout(() => {
      setNoticeState((prev) => (prev === current ? null : prev));
      setNoticeSticky(false);
    }, 4500);
    return () => window.clearTimeout(timer);
  }, [notice, noticeSticky]);

  const repoPathRef = useRef<string | null>(null);
  repoPathRef.current = repoPath;

  const applyCore = useCallback((core: Awaited<ReturnType<typeof api.getRepoCore>>) => {
    setStatus(core.status);
    setBranches(core.branches);
    setRemoteBranches(core.remoteBranches);
    setIdentity(core.identity);
    setIdentitySaved(
      Boolean(core.identity.name.trim() && core.identity.email.includes("@")),
    );
    setRemotes(core.remotes);
    const origin =
      core.remotes.find((remote) => remote.name === "origin") ?? core.remotes[0];
    setRemoteUrl(origin?.url ?? "");
  }, []);

  const refresh = useCallback(
    async (path: string, opts?: { background?: boolean }) => {
      const background = opts?.background === true;
      if (!background) {
        busyRef.current = true;
        setBusy(true);
      }
      setError(null);
      try {
        const core = await api.getRepoCore(path);
        if (repoPathRef.current === path || !background) {
          applyCore(core);
        }
        if (!background) {
          busyRef.current = false;
          setBusy(false);
        }
        try {
          const extras = await api.getRepoExtras(path);
          if (repoPathRef.current === path) {
            setCommits(extras.commits);
            setStashes(extras.stashes);
            setTags(extras.tags);
            saveRepoCache(path, core, extras);
          }
        } catch (e) {
          if (repoPathRef.current === path) {
            saveRepoCache(path, core);
            if (!background) setError(failureLine(e));
          }
        }
      } catch (e) {
        if (!background) {
          setError(failureLine(e));
          busyRef.current = false;
          setBusy(false);
        }
        throw e;
      }
    },
    [applyCore],
  );

  const wallpaperUrl = useMemo(() => {
    if (prefs.wallpaperKind === "none" || !prefs.wallpaperPath) return null;
    try {
      const src = convertFileSrc(prefs.wallpaperPath);
      // Bust webview cache after re-importing the same filename.
      const sep = src.includes("?") ? "&" : "?";
      return `${src}${sep}t=${encodeURIComponent(prefs.wallpaperPath)}`;
    } catch {
      return null;
    }
  }, [prefs.wallpaperKind, prefs.wallpaperPath]);

  const refreshStatusQuiet = useCallback(async (path: string) => {
    if (busyRef.current) return;
    try {
      // Light poll skips untracked scan; backend skips if git lock is busy.
      const next = await api.getStatusLight(path);
      setStatus((prev) => {
        if (!prev) return next;
        // Keep previously known untracked entries so the list doesn't flicker away.
        const lightPaths = new Set(next.changes.map((c) => c.path));
        const keptUntracked = prev.changes.filter(
          (c) => c.untracked && !lightPaths.has(c.path),
        );
        const merged = {
          ...next,
          changes: keptUntracked.length
            ? [...next.changes, ...keptUntracked]
            : next.changes,
        };
        if (statusFingerprint(prev) === statusFingerprint(merged)) {
          return prev;
        }
        return merged;
      });
    } catch (e) {
      // GIT_BUSY or transient errors — keep previous UI, never block.
      const msg = String(e);
      if (!msg.includes("GIT_BUSY")) {
        /* ignore */
      }
    }
  }, []);

  useEffect(() => {
    if (!repoPath) return;
    const tick = () => {
      if (document.visibilityState === "visible" && !busyRef.current) {
        void refreshStatusQuiet(repoPath);
      }
    };
    const timer = window.setInterval(tick, 8000);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [repoPath, refreshStatusQuiet]);

  useEffect(() => {
    if (recent.length === 0) {
      setRecentExists({});
      return;
    }
    let cancelled = false;
    void Promise.all(
      recent.map(async (path) => {
        try {
          return [path, await api.pathExists(path)] as const;
        } catch {
          return [path, false] as const;
        }
      }),
    ).then((pairs) => {
      if (!cancelled) setRecentExists(Object.fromEntries(pairs));
    });
    return () => {
      cancelled = true;
    };
  }, [recent]);

  const openFolder = useCallback(
    async (path: string) => {
      setError(null);
      setEntering(false);
      setBoot({
        path,
        progress: 6,
        label: "正在准备打开仓库…",
        fromCache: false,
      });
      busyRef.current = true;
      setBusy(true);
      try {
        setBoot({
          path,
          progress: 14,
          label: "正在检查是否为 Git 仓库…",
          fromCache: false,
        });
        const isRepo = await api.checkRepository(path);
        if (!isRepo) {
          const ok = await confirmAction(
            `「${path}」还不是 Git 仓库。\n是否在此目录初始化？默认分支为 main。`,
          );
          if (!ok) {
            setBoot(null);
            busyRef.current = false;
            setBusy(false);
            return;
          }
          setBoot({
            path,
            progress: 22,
            label: "正在初始化仓库…",
            fromCache: false,
          });
          await api.initRepo(path);
        }

        setSelected(null);
        setDiff("");
        setMessage("");
        setOpenRepos((prev) => {
          const next = prev.includes(path) ? prev : [...prev, path].slice(-12);
          saveOpenRepos(next);
          return next;
        });
        if (prefs.rememberRecent) {
          setRecent(rememberRecent(path));
        }

        const cached =
          prefs.useRepoCache ? loadRepoCache(path) : null;
        if (cached) {
          setBoot({
            path,
            progress: 62,
            label: "正在从缓存恢复界面…",
            fromCache: true,
          });
          applyCore(cached.core);
          if (cached.extras) {
            setCommits(cached.extras.commits);
            setStashes(cached.extras.stashes);
            setTags(cached.extras.tags);
          }
          setRepoPath(path);
          setBoot({
            path,
            progress: 100,
            label: "即将进入…",
            fromCache: true,
          });
          await sleep(320);
          setBoot(null);
          setEntering(true);
          busyRef.current = false;
          setBusy(false);
          setSyncingCache(true);
          try {
            await refresh(path, { background: true });
          } catch {
            /* keep cached view; quiet errors */
          } finally {
            setSyncingCache(false);
          }
          return;
        }

        setBoot({
          path,
          progress: 38,
          label: "正在读取工作区与分支…",
          fromCache: false,
        });
        const core = await api.getRepoCore(path);
        applyCore(core);
        setBoot({
          path,
          progress: 68,
          label: "正在加载历史与标签…",
          fromCache: false,
        });
        let extras = undefined;
        try {
          extras = await api.getRepoExtras(path);
          setCommits(extras.commits);
          setStashes(extras.stashes);
          setTags(extras.tags);
          saveRepoCache(path, core, extras);
        } catch {
          saveRepoCache(path, core);
        }
        setBoot({
          path,
          progress: 92,
          label: "正在整理界面…",
          fromCache: false,
        });
        setRepoPath(path);
        setBoot({
          path,
          progress: 100,
          label: "完成",
          fromCache: false,
        });
        await sleep(280);
        setBoot(null);
        setEntering(true);
        busyRef.current = false;
        setBusy(false);
      } catch (e) {
        setBoot(null);
        setError(failureLine(e));
        busyRef.current = false;
        setBusy(false);
      }
    },
    [applyCore, prefs.rememberRecent, prefs.useRepoCache, refresh],
  );

  const closeRepoTab = useCallback(
    (path: string) => {
      const next = openRepos.filter((p) => p !== path);
      saveOpenRepos(next);
      setOpenRepos(next);
      if (repoPath !== path) return;
      const fallback = next[next.length - 1] ?? null;
      if (fallback) {
        void openFolder(fallback);
      } else {
        setRepoPath(null);
        setStatus(null);
      }
    },
    [openFolder, openRepos, repoPath],
  );

  const updatePrefs = useCallback((patch: Partial<AppPrefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      savePrefs(next);
      applyPrefsToDocument(next);
      return next;
    });
  }, []);

  const pickFolder = useCallback(async () => {
    const selectedPath = await open({
      directory: true,
      multiple: false,
      title: "选择项目文件夹",
    });
    if (typeof selectedPath === "string") {
      await openFolder(selectedPath);
    }
  }, [openFolder]);

  const cloneRepo = useCallback(async () => {
    const draftClone = identityDraftRef.current?.clone?.trim() ?? "";
    const url = draftClone || cloneUrl.trim() || loadCloneUrl().trim();
    if (!url) {
      setError("请先在设置里填写克隆地址");
      openSettings("identity");
      return;
    }
    saveCloneUrl(url);
    setCloneUrl(url);
    const selectedPath = await open({
      directory: true,
      multiple: false,
      title: "选择空文件夹作为克隆目标",
    });
    if (typeof selectedPath !== "string") return;
    setBusy(true);
    setError(null);
    setNotice("正在克隆…");
    try {
      const dest = await api.cloneRepo(url, selectedPath);
      setNotice("克隆完成");
      setShowSettings(false);
      await openFolder(dest);
    } catch (e) {
      setNotice(null);
      setError(failureLine(e));
      setBusy(false);
    }
  }, [cloneUrl, openFolder]);

  function saveIdentityAndRemote(draft: IdentityRemoteDraft) {
    const name = draft.name.trim();
    const email = draft.email.trim();
    const remote = draft.remote.trim();
    const clone = draft.clone.trim();

    saveCloneUrl(clone);
    setCloneUrl(clone);

    if (!repoPath) {
      setNotice(clone ? "已保存克隆地址" : null);
      return;
    }

    const wantIdentity = Boolean(name && email.includes("@"));
    const wantRemote = Boolean(remote);
    if (!wantIdentity && !wantRemote) {
      setNotice(clone ? "已保存克隆地址" : null);
      return;
    }

    void runAction(async () => {
      if (wantIdentity) {
        await api.setIdentity(repoPath, name, email, draft.saveGlobally);
        setIdentity({ name, email });
        setIdentitySaved(true);
      }
      if (wantRemote) {
        await api.saveRemote(repoPath, "origin", remote);
        setRemoteUrl(remote);
      }
    }, "正在保存身份与远程…");
  }

  function applyAccount(status: ProviderStatus) {
    const key = (status.provider === "gitee" ? "gitee" : "github") as AuthProvider;
    setAccounts((prev) =>
      prev
        ? { ...prev, [key]: status }
        : {
            github: key === "github" ? status : emptyProvider("github"),
            gitee: key === "gitee" ? status : emptyProvider("gitee"),
          },
    );
    setDrafts((prev) => ({
      ...prev,
      [key]: { ...prev[key], token: "" },
    }));
  }

  function emptyProvider(provider: AuthProvider): ProviderStatus {
    return {
      provider,
      loggedIn: false,
      login: "",
      name: "",
      avatarUrl: "",
      clientId: "",
      hasClientId: false,
      hasClientSecret: false,
      sessionExpired: false,
      accounts: [],
      oauthReady: false,
      usingBuiltinOauth: false,
    };
  }

  const stopDevicePoll = useCallback(() => {
    if (devicePollRef.current !== null) {
      window.clearTimeout(devicePollRef.current);
      devicePollRef.current = null;
    }
  }, []);

  const refreshAccounts = useCallback(async () => {
    try {
      const next = await api.authAccounts();
      setAccounts(next);
      const expired: string[] = [];
      if (next.github.sessionExpired) expired.push("GitHub");
      if (next.gitee.sessionExpired) expired.push("Gitee");
      setSessionWarnings(expired);
      setDrafts((prev) => ({
        github: {
          ...prev.github,
          clientId: next.github.clientId || prev.github.clientId,
        },
        gitee: {
          ...prev.gitee,
          clientId: next.gitee.clientId || prev.gitee.clientId,
        },
      }));
      if (next.github.loggedIn || next.gitee.loggedIn) {
        setAddingAccount(false);
      }
    } catch (e) {
      setError(failureLine(e));
    }
  }, []);

  const refreshSsh = useCallback(async () => {
    try {
      setSshStatus(await api.authSshStatus());
    } catch {
      /* SSH optional */
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        await api.authEnsureCredentials();
      } catch {
        /* ignore */
      }
      await refreshAccounts();
    })();
  }, [refreshAccounts]);

  useEffect(() => {
    if (!showSettings) return;
    void refreshAccounts();
    if (settingsPage === "auth") void refreshSsh();
  }, [showSettings, settingsPage, refreshAccounts, refreshSsh]);

  useEffect(() => () => stopDevicePoll(), [stopDevicePoll]);

  function openSettings(page: "appearance" | "auth" | "identity" = "appearance") {
    setSettingsPage(page);
    setShowSettings(true);
  }

  function openSettingsAuth(provider?: AuthProvider) {
    if (provider) setAuthTab(provider);
    openSettings("auth");
  }

  function updateDraft(
    provider: AuthProvider,
    patch: Partial<ProviderDraft>,
  ) {
    setDrafts((prev) => ({
      ...prev,
      [provider]: { ...prev[provider], ...patch },
    }));
  }

  async function loginWithGitManager(provider: AuthProvider) {
    setBusy(true);
    setError(null);
    setAuthHint(false);
    setNotice(
      provider === "github"
        ? "正在打开 Git 凭据管理器…"
        : "正在读取 Gitee 凭据（可能弹出输入框）…",
    );
    try {
      const status = await api.authManagerLogin(provider);
      applyAccount(status);
      setAddingAccount(false);
      setSessionWarnings((prev) =>
        prev.filter((p) => p !== (provider === "github" ? "GitHub" : "Gitee")),
      );
      setNotice(`已通过 Git 登录：${status.login}`);
    } catch (e) {
      setNotice(null);
      setError(failureLine(e));
      setAuthHint(true);
    } finally {
      setBusy(false);
    }
  }

  async function loginWithBrowser(provider: AuthProvider) {
    const draft = drafts[provider];
    const clientId = draft.clientId.trim();
    const clientSecret = draft.clientSecret.trim();
    const ready =
      accounts?.[provider]?.oauthReady &&
      accounts[provider].hasClientSecret;
    if ((!clientId || !clientSecret) && !ready) {
      setError(
        "浏览器登录需要 Client ID 和 Client Secret（可在下方配置一次并保存）。设备码登录只需 Client ID。",
      );
      updateDraft(provider, { showOauth: true });
      return;
    }
    setBusy(true);
    setError(null);
    setAuthHint(false);
    setNotice("正在打开浏览器，请完成授权…");
    try {
      if (clientId && clientSecret) {
        await api.authSaveOauthConfig(provider, clientId, clientSecret);
      }
      const begin = await api.authStartBrowser(provider);
      await openUrl(begin.authUrl);
      setNotice("请在浏览器完成授权，返回本窗口等待…");
      const status = await api.authFinishBrowser(provider);
      applyAccount(status);
      setAddingAccount(false);
      setSessionWarnings((prev) =>
        prev.filter((p) => p !== (provider === "github" ? "GitHub" : "Gitee")),
      );
      setNotice(`已通过浏览器登录：${status.login}`);
    } catch (e) {
      setNotice(null);
      setError(failureLine(e));
      setAuthHint(true);
    } finally {
      setBusy(false);
    }
  }

  async function loginWithDevice() {
    stopDevicePoll();
    setBusy(true);
    setError(null);
    setAuthHint(false);
    setDeviceStatus("");
    setNotice("正在申请 GitHub 设备码…");
    try {
      const draft = drafts.github;
      if (draft.clientId.trim()) {
        await api.authSaveOauthConfig(
          "github",
          draft.clientId.trim(),
          draft.clientSecret.trim(),
        );
      }
      const start = await api.authStartDevice();
      setDeviceFlow(start);
      setNotice(`请在浏览器打开 ${start.verificationUri}，输入代码 ${start.userCode}`);
      setDeviceStatus("等待授权…");
      setBusy(false);
      const poll = async (intervalSec: number) => {
        devicePollRef.current = window.setTimeout(async () => {
          try {
            const result = await api.authPollDevice(start.deviceCode);
            if (result.status === "success" && result.account) {
              stopDevicePoll();
              setDeviceFlow(null);
              setDeviceStatus("");
              applyAccount(result.account);
              setAddingAccount(false);
              setSessionWarnings((prev) => prev.filter((p) => p !== "GitHub"));
              setNotice(`已通过设备码登录：${result.account.login}`);
              return;
            }
            const nextInterval =
              result.status === "slow_down"
                ? intervalSec + 5
                : Math.max(intervalSec, start.interval);
            setDeviceStatus(result.message || "等待授权…");
            void poll(nextInterval);
          } catch (e) {
            stopDevicePoll();
            setDeviceFlow(null);
            setDeviceStatus("");
            setError(failureLine(e));
            setAuthHint(true);
          }
        }, intervalSec * 1000);
      };
      void poll(start.interval);
    } catch (e) {
      setNotice(null);
      setDeviceFlow(null);
      setError(failureLine(e));
      if (/Client ID/i.test(String(e))) {
        updateDraft("github", { showOauth: true });
      }
      setAuthHint(true);
      setBusy(false);
    }
  }

  async function switchAccount(provider: AuthProvider, accountId: string) {
    setBusy(true);
    setError(null);
    try {
      const status = await api.authSwitchAccount(provider, accountId);
      applyAccount(status);
      setAddingAccount(false);
      setNotice(`已切换到 ${status.login}`);
    } catch (e) {
      setError(failureLine(e));
    } finally {
      setBusy(false);
    }
  }

  async function loginWithToken(provider: AuthProvider, tokenOverride?: string) {
    const token = (tokenOverride ?? drafts[provider].token).trim();
    if (!token) return;
    setBusy(true);
    setError(null);
    setAuthHint(false);
    try {
      const status = await api.authLoginToken(provider, token);
      applyAccount(status);
      updateDraft(provider, { token: "" });
      setAddingAccount(false);
      setSessionWarnings((prev) =>
        prev.filter((p) => p !== (provider === "github" ? "GitHub" : "Gitee")),
      );
      setNotice(`已登录 ${status.login}`);
    } catch (e) {
      setError(failureLine(e));
      setAuthHint(true);
    } finally {
      setBusy(false);
    }
  }

  async function logoutProvider(provider: AuthProvider) {
    const label = provider === "github" ? "GitHub" : "Gitee";
    const ok = await confirmAction(
      `退出 ${label}${accounts?.[provider]?.login ? `（${accounts[provider].login}）` : ""}？\n将清除本工具保存的全部 ${label} 登录信息，并尽量删除系统 Git / 凭据管理器中的对应条目。`,
      { title: "退出登录", danger: true, confirmLabel: "退出" },
    );
    if (!ok) return;
    setBusy(true);
    setError(null);
    setNotice(`正在退出 ${label}…`);
    try {
      const status = await api.authLogout(provider);
      applyAccount(status);
      setAccounts((prev) =>
        prev
          ? {
              ...prev,
              [provider]: status.loggedIn ? status : emptyProvider(provider),
            }
          : prev,
      );
      setAddingAccount(false);
      setSessionWarnings((prev) => prev.filter((p) => p !== label));
      setNotice(status.loggedIn ? `已切换，当前：${status.login}` : `已退出 ${label}`);
    } catch (e) {
      setNotice(null);
      setError(failureLine(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!repoPath || !selected) {
      setDiff("");
      return;
    }
    let cancelled = false;
    setDiffLoading(true);
    api
      .getDiff(repoPath, selected.path, selected.staged)
      .then((text) => {
        if (!cancelled) setDiff(text);
      })
      .catch((e) => {
        if (!cancelled) {
          setDiff("");
          setError(failureLine(e));
        }
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [repoPath, selected]);

  useEffect(() => {
    if (!repoPath || !selectedHash || pane !== "history") {
      return;
    }
    let cancelled = false;
    setPatchLoading(true);
    api
      .getCommitPatch(repoPath, selectedHash)
      .then((text) => {
        if (!cancelled) setCommitPatch(text);
      })
      .catch((e) => {
        if (!cancelled) {
          setCommitPatch("");
          setError(failureLine(e));
        }
      })
      .finally(() => {
        if (!cancelled) setPatchLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [repoPath, selectedHash, pane]);

  const staged = useMemo(
    () => status?.changes.filter((c) => c.staged && !c.untracked) ?? [],
    [status],
  );
  const unstaged = useMemo(
    () =>
      status?.changes.filter((c) => c.unstaged || c.untracked || c.conflicted) ??
      [],
    [status],
  );
  const conflictFiles = useMemo(
    () => status?.changes.filter((c) => c.conflicted) ?? [],
    [status],
  );
  const filterChanges = useCallback(
    (files: FileChange[]) => {
      let list = files;
      if (fileFilter === "conflict") {
        list = list.filter((f) => f.conflicted);
      } else if (fileFilter === "untracked") {
        list = list.filter((f) => f.untracked);
      }
      const q = fileQuery.trim().toLowerCase();
      if (q) {
        list = list.filter((f) => f.path.toLowerCase().includes(q));
      }
      return list;
    },
    [fileFilter, fileQuery],
  );
  const filteredUnstaged = useMemo(
    () => filterChanges(unstaged),
    [filterChanges, unstaged],
  );
  const filteredStaged = useMemo(
    () => filterChanges(staged),
    [filterChanges, staged],
  );
  const hasChanges = staged.length + unstaged.length > 0;
  const ahead = status?.ahead ?? 0;
  const behind = status?.behind ?? 0;

  useEffect(() => {
    if (!status) return;
    if (
      status.operation !== "merge" &&
      status.operation !== "cherry-pick" &&
      status.operation !== "rebase"
    ) {
      return;
    }
    if (conflictFiles.length === 0) return;
    setPane("diff");
    setSelected((cur) => {
      if (cur && conflictFiles.some((f) => f.path === cur.path)) return cur;
      return { path: conflictFiles[0].path, staged: false };
    });
  }, [status?.operation, conflictFiles]);

  useEffect(() => {
    if (!repoPath) return;
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const typing = isEditableTarget(e.target);

      if (e.key === "F5") {
        e.preventDefault();
        void refresh(repoPath);
        return;
      }

      if (!mod) return;

      if (e.key === "Enter" && !e.shiftKey) {
        const msg = messageRef.current.trim();
        if (
          busyRef.current ||
          !msg ||
          staged.length === 0 ||
          !identitySaved
        ) {
          return;
        }
        e.preventDefault();
        void requestCommit("commit");
        return;
      }

      if (typing) return;

      if ((e.key === "r" || e.key === "R") && !e.shiftKey) {
        e.preventDefault();
        void refresh(repoPath);
      } else if ((e.key === "s" || e.key === "S") && !e.shiftKey) {
        if (unstaged.length === 0 || busyRef.current) return;
        e.preventDefault();
        void runAction(
          () => api.stageFiles(
            repoPath,
            unstaged.map((f) => f.path),
          ),
          "正在暂存…",
        );
      } else if ((e.key === "l" || e.key === "L") && e.shiftKey) {
        e.preventDefault();
        void runAction(() => api.pull(repoPath), "正在拉取…");
      } else if ((e.key === "p" || e.key === "P") && e.shiftKey) {
        e.preventDefault();
        void runAction(() => api.push(repoPath), "正在推送…");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [repoPath, refresh, staged.length, unstaged, identitySaved]);

  function isNetworkLabel(label?: string) {
    return /拉取|推送|获取|克隆|同步/.test(label ?? "");
  }

  async function runAction(action: () => Promise<unknown>, label?: string) {
    if (!repoPath || busyRef.current) return;
    const path = repoPath;
    const network = isNetworkLabel(label);
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setAuthHint(false);
    setNotice(label ?? "正在执行…");
    if (network) {
      syncProgressActive.current = true;
      setSyncProgress({
        label: label ?? "同步中",
        percent: 3,
        detail: "准备中",
      });
    } else {
      syncProgressActive.current = false;
      setSyncProgress(null);
    }
    // If a git/network call hangs, unlock the UI so Windows never shows "未响应".
    let timedOut = false;
    const watchdog = window.setTimeout(() => {
      if (!busyRef.current) return;
      timedOut = true;
      busyRef.current = false;
      setBusy(false);
      syncProgressActive.current = false;
      setSyncProgress(null);
      setNotice(null);
      setError(
        "操作时间过长，界面已恢复可操作。后台命令可能仍在运行，请查看终端；必要时点「刷新」。",
      );
    }, ACTION_WATCHDOG_MS);
    try {
      await yieldToUi();
      let result: unknown;
      try {
        result = await action();
      } catch (firstErr) {
        if (!isAuthFailure(firstErr)) throw firstErr;
        setNotice("认证失败，正在同步本地凭据并重试…");
        try {
          await api.authEnsureCredentials();
        } catch {
          /* still retry once */
        }
        await yieldToUi();
        result = await action();
      }
      await yieldToUi();
      window.clearTimeout(watchdog);
      if (timedOut) {
        void refresh(path, { background: true }).catch(() => {});
        return;
      }
      setSyncDialog(null);
      {
        const text = successLine(label, result);
        const stickyPush =
          Boolean(label && /推送/.test(label)) ||
          /推送完成|已强制推送|已推送/.test(text);
        // 推送完成提示需手动点掉，或被后续操作覆盖。
        setNotice(text, stickyPush);
      }
      if (network) {
        setSyncProgress((prev) =>
          prev ? { ...prev, percent: 100, detail: "完成" } : prev,
        );
      }
      // Fast path: unlock UI after a light refresh; history loads in background.
      let coreForCache: Awaited<ReturnType<typeof api.getRepoCore>> | null = null;
      try {
        const core = await api.getRepoCore(path);
        coreForCache = core;
        if (repoPathRef.current === path) applyCore(core);
      } finally {
        busyRef.current = false;
        setBusy(false);
        syncProgressActive.current = false;
        setSyncProgress(null);
      }
      await yieldToUi();
      void api
        .getRepoExtras(path)
        .then((extras) => {
          if (repoPathRef.current !== path) return;
          startTransition(() => {
            setCommits(extras.commits);
            setStashes(extras.stashes);
            setTags(extras.tags);
          });
          if (coreForCache) saveRepoCache(path, coreForCache, extras);
        })
        .catch(() => {
          if (coreForCache) saveRepoCache(path, coreForCache);
        });
    } catch (e) {
      window.clearTimeout(watchdog);
      if (timedOut) {
        void refresh(path, { background: true }).catch(() => {});
        return;
      }
      setNotice(null);
      const kind = syncConflictKind(e);
      if (kind) {
        setError(null);
        setSyncDialog(kind);
        busyRef.current = false;
        setBusy(false);
        syncProgressActive.current = false;
        setSyncProgress(null);
        try {
          await refresh(path, { background: true });
        } catch {
          /* keep dialog error state */
        }
      } else {
        setError(failureLine(e));
        setAuthHint(isAuthFailure(e));
        try {
          const core = await api.getRepoCore(path);
          if (repoPathRef.current === path) applyCore(core);
        } catch {
          /* keep original error */
        } finally {
          busyRef.current = false;
          setBusy(false);
          syncProgressActive.current = false;
          setSyncProgress(null);
        }
        void api
          .getRepoExtras(path)
          .then((extras) => {
            if (repoPathRef.current !== path) return;
            startTransition(() => {
              setCommits(extras.commits);
              setStashes(extras.stashes);
              setTags(extras.tags);
            });
          })
          .catch(() => {});
      }
    }
  }

  async function requestCommit(mode: "commit" | "amend") {
    if (!repoPath || busyRef.current) return;
    if (!identitySaved) {
      openSettings("identity");
      return;
    }
    const msg = messageRef.current.trim();
    if (mode === "commit") {
      if (!msg || staged.length === 0) return;
    }

    setError(null);
    setNotice("正在检查大文件…");
    try {
      const files = await api.listStagedLargeFiles(
        repoPath,
        LARGE_FILE_LIMIT_BYTES,
      );
      setNotice(null);
      if (files.length > 0) {
        const exclude: Record<string, boolean> = {};
        for (const f of files) exclude[f.path] = true;
        setLargeCommit({ mode, message: msg, files, exclude });
        return;
      }
    } catch (e) {
      setNotice(null);
      setError(failureLine(e));
      return;
    }

    void runAction(
      async () => {
        if (mode === "amend") {
          await api.amendCommit(repoPath, messageRef.current);
        } else {
          await api.createCommit(repoPath, msg);
        }
        setMessage("");
        setSelected(null);
      },
      mode === "amend" ? "正在修改上次提交…" : "正在提交…",
    );
  }

  async function confirmLargeCommit() {
    if (!largeCommit || !repoPath) return;
    const { mode, message: msg, files, exclude } = largeCommit;
    const toExclude = files.filter((f) => exclude[f.path]).map((f) => f.path);
    setLargeCommit(null);

    void runAction(
      async () => {
        if (toExclude.length > 0) {
          await api.unstageFiles(repoPath, toExclude);
        }
        if (mode === "commit") {
          const core = await api.getRepoCore(repoPath);
          const left = core.status.changes.filter(
            (c) => c.staged && !c.untracked,
          );
          if (left.length === 0) {
            throw new Error(
              "排除大文件后没有可提交的改动了。请暂存其他文件，或取消排除部分大文件。",
            );
          }
        }
        if (mode === "amend") {
          await api.amendCommit(repoPath, msg);
        } else {
          await api.createCommit(repoPath, msg);
        }
        setMessage("");
        setSelected(null);
      },
      mode === "amend" ? "正在修改上次提交…" : "正在提交…",
    );
  }

  function renderLargeCommitDialog() {
    if (!largeCommit) return null;
    const { files, exclude, mode } = largeCommit;
    const excludeCount = files.filter((f) => exclude[f.path]).length;
    const keepCount = files.length - excludeCount;
    return (
      <div className="modal-mask" onClick={() => setLargeCommit(null)}>
        <div
          className="modal sync-modal"
          onClick={(event) => event.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-label="大文件检测"
        >
          <h3>发现超过 100MB 的文件</h3>
          <p className="muted">
            GitHub 等平台通常拒绝单个超过 100MB 的文件。默认会排除它们；取消勾选表示仍要提交该文件。
          </p>
          <ul className="large-file-list">
            {files.map((f) => (
              <li key={f.path}>
                <label className="large-file-item">
                  <input
                    type="checkbox"
                    checked={!!exclude[f.path]}
                    onChange={(e) =>
                      setLargeCommit((prev) =>
                        prev
                          ? {
                              ...prev,
                              exclude: {
                                ...prev.exclude,
                                [f.path]: e.target.checked,
                              },
                            }
                          : prev,
                      )
                    }
                  />
                  <span className="large-file-meta">
                    <strong title={f.path}>{f.path}</strong>
                    <span className="muted small">{f.sizeLabel}</span>
                  </span>
                  <span className="large-file-tag">
                    {exclude[f.path] ? "排除" : "仍提交"}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <p className="muted small">
            将排除 {excludeCount} 个，保留提交 {keepCount} 个大文件
            {mode === "amend" ? "（修改上次提交）" : ""}。
          </p>
          <div className="modal-actions">
            <button type="button" onClick={() => setLargeCommit(null)}>
              取消
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => void confirmLargeCommit()}
            >
              {excludeCount === files.length
                ? "排除后继续"
                : keepCount > 0
                  ? "按选择继续"
                  : "继续提交"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  function renderResetDialog() {
    if (!resetTarget || !repoPath) return null;
    const short = resetTarget.shortHash;
    const subject = resetTarget.subject;
    const runReset = (mode: "soft" | "mixed" | "hard") => {
      void (async () => {
        if (mode === "hard") {
          const ok = await confirmAction(
            `硬重置到 ${short}？\n工作区和暂存区都会回到该提交，未提交改动将丢失，且无法用本工具恢复。`,
            { title: "硬重置", danger: true, confirmLabel: "硬重置" },
          );
          if (!ok) return;
        }
        setResetTarget(null);
        void runAction(
          () => api.resetCommit(repoPath, resetTarget.hash, mode),
          mode === "hard"
            ? "正在硬重置…"
            : mode === "soft"
              ? "正在软重置…"
              : "正在混合重置…",
        );
      })();
    };
    return (
      <div className="modal-mask" onClick={() => setResetTarget(null)}>
        <div
          className="modal sync-modal"
          onClick={(event) => event.stopPropagation()}
          role="dialog"
          aria-modal="true"
        >
          <h3>重置到提交 {short}</h3>
          <p className="muted">{subject}</p>
          <p className="muted small">当前分支会指到该提交。请选择重置方式：</p>
          <div className="sync-choices">
            <button
              type="button"
              className="primary sync-choice"
              disabled={busy}
              onClick={() => runReset("soft")}
            >
              <strong>软重置</strong>
              <span className="muted small">提交回退，改动仍在暂存区（最安全）</span>
            </button>
            <button
              type="button"
              className="sync-choice"
              disabled={busy}
              onClick={() => runReset("mixed")}
            >
              <strong>混合重置</strong>
              <span className="muted small">提交回退，改动回到未暂存（默认 git reset）</span>
            </button>
            <button
              type="button"
              className="danger sync-choice"
              disabled={busy}
              onClick={() => runReset("hard")}
            >
              <strong>硬重置</strong>
              <span className="muted small">提交与文件都回到该版本，未提交改动会丢弃</span>
            </button>
          </div>
          <div className="modal-actions">
            <button type="button" disabled={busy} onClick={() => setResetTarget(null)}>
              取消
            </button>
          </div>
        </div>
      </div>
    );
  }

  function renderSyncDialog() {
    if (!syncDialog || !repoPath) return null;
    const unrelated = syncDialog === "unrelated";
    return (
      <div className="modal-mask" onClick={() => setSyncDialog(null)}>
        <div
          className="modal sync-modal"
          onClick={(event) => event.stopPropagation()}
          role="dialog"
          aria-modal="true"
        >
          <h3>{unrelated ? "本地与远程历史不一致" : "推送被拒绝"}</h3>
          <p className="muted">
            {unrelated
              ? "两边没有共同祖先（常见于本地 init 过，GitHub 上也单独建过仓库）。请选择如何处理："
              : "远程有本地还没有的提交。请选择如何处理："}
          </p>
          <div className="sync-choices">
            {unrelated ? (
              <>
                <button
                  type="button"
                  className="primary sync-choice"
                  disabled={busy}
                  onClick={() => {
                    setSyncDialog(null);
                    void runAction(async () => {
                      const merged = await api.pull(repoPath, true);
                      try {
                        const pushed = await api.push(repoPath, false);
                        return `${merged}\n${pushed}`;
                      } catch {
                        return `${merged}\n合并完成。若有冲突请先处理，然后再点「推送」。`;
                      }
                    }, "正在合并两边历史…");
                  }}
                >
                  <strong>保留两边内容</strong>
                  <span className="muted small">
                    合并互不相关的历史并尝试推送；若有冲突，可在界面里继续或放弃
                  </span>
                </button>
                <button
                  type="button"
                  className="danger sync-choice"
                  disabled={busy}
                  onClick={() =>
                    withConfirm(
                      "将用本地提交覆盖远程，远程多出来的提交会丢失。确定继续？",
                      () => {
                        setSyncDialog(null);
                        void runAction(
                          () => api.push(repoPath, true),
                          "正在强制推送…",
                        );
                      },
                    )
                  }
                >
                  <strong>只用本地，覆盖远程</strong>
                  <span className="muted small">强制推送，远程旧内容会被替换</span>
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="primary sync-choice"
                  disabled={busy}
                  onClick={() => {
                    setSyncDialog(null);
                    void runAction(async () => {
                      await api.pull(repoPath);
                      return api.push(repoPath, false);
                    }, "正在拉取并推送…");
                  }}
                >
                  <strong>先拉取再推送</strong>
                  <span className="muted small">把远程改动合进来，然后再推送（推荐）</span>
                </button>
                <button
                  type="button"
                  className="danger sync-choice"
                  disabled={busy}
                  onClick={() =>
                    withConfirm(
                      "将用本地提交覆盖远程，远程多出来的提交会丢失。确定继续？",
                      () => {
                        setSyncDialog(null);
                        void runAction(
                          () => api.push(repoPath, true),
                          "正在强制推送…",
                        );
                      },
                    )
                  }
                >
                  <strong>强制推送，覆盖远程</strong>
                  <span className="muted small">仅在确定不需要远程提交时使用</span>
                </button>
              </>
            )}
          </div>
          <div className="modal-actions">
            <button type="button" disabled={busy} onClick={() => setSyncDialog(null)}>
              取消
            </button>
          </div>
        </div>
      </div>
    );
  }

  function renderSshPanel(provider: AuthProvider) {
    if (provider !== "github" && provider !== "gitee") return null;
    const label = provider === "github" ? "GitHub" : "Gitee";
    const keysUrl =
      provider === "github"
        ? "https://github.com/settings/keys"
        : "https://gitee.com/profile/sshkeys";
    return (
      <div className="auth-ssh-block">
        <div className="auth-token-head">
          <span>SSH 密钥（设一次即可）</span>
          <button
            type="button"
            className="linkish"
            disabled={busy}
            onClick={() => void refreshSsh()}
          >
            刷新
          </button>
        </div>
        <p className="muted small">
          {sshStatus?.tip ??
            "检测本机 ~/.ssh 公钥；添加到平台后可用 git@ 地址推拉。"}
        </p>
        {sshStatus?.keys?.length ? (
          <ul className="auth-ssh-keys">
            {sshStatus.keys.map((k) => (
              <li key={k.path}>
                <code className="auth-ssh-path">{k.path}</code>
                <span className="muted small">{k.fingerprint}</span>
                <div className="auth-method-row">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      void navigator.clipboard.writeText(k.publicKey);
                      setNotice("已复制公钥");
                    }}
                  >
                    复制公钥
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">未找到 id_ed25519 / id_rsa 公钥。</p>
        )}
        <div className="auth-method-row">
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void (async () => {
                setBusy(true);
                setError(null);
                try {
                  const next = await api.authSshGenerate();
                  setSshStatus(next);
                  setNotice("已生成 ed25519 密钥，请复制公钥添加到平台");
                } catch (e) {
                  setError(failureLine(e));
                } finally {
                  setBusy(false);
                }
              })()
            }
          >
            生成 ed25519 密钥
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void openUrl(keysUrl)}
          >
            打开 {label} SSH 设置
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void (async () => {
                setBusy(true);
                setError(null);
                setSshFeedback({
                  ok: null,
                  text: `正在测试 ${label} SSH（最多约 20 秒）…`,
                });
                try {
                  const result = await api.authSshTest(provider);
                  const text =
                    result.message.trim() ||
                    (result.ok ? "SSH 认证成功" : "SSH 未通过");
                  setSshFeedback({ ok: result.ok, text });
                  if (result.ok) setNotice(text);
                  else setError(text);
                } catch (e) {
                  const text = failureLine(e);
                  setSshFeedback({ ok: false, text });
                  setError(text);
                } finally {
                  setBusy(false);
                }
              })()
            }
          >
            测试 SSH
          </button>
        </div>
        {sshFeedback && (
          <p
            className={
              sshFeedback.ok === null
                ? "auth-ssh-feedback is-pending"
                : sshFeedback.ok
                  ? "auth-ssh-feedback is-ok"
                  : "auth-ssh-feedback is-bad"
            }
            role="status"
          >
            {sshFeedback.text}
          </p>
        )}
      </div>
    );
  }

  function renderProviderAuth(provider: AuthProvider) {
    const account = accounts?.[provider];
    const draft = drafts[provider];
    const label = provider === "github" ? "GitHub" : "Gitee";
    const tokenDocUrl =
      provider === "github"
        ? "https://github.com/settings/tokens"
        : "https://gitee.com/profile/personal_access_tokens";
    const oauthDocUrl =
      provider === "github"
        ? "https://github.com/settings/developers"
        : "https://gitee.com/oauth/applications";
    const scopeHint =
      provider === "github"
        ? "权限：经典 Token 勾选 repo；细粒度 Token 需对应仓库的 Contents 读写。"
        : "权限：私人令牌勾选 projects（以及需要的仓库权限）。";
    const showLogin = !account?.loggedIn || addingAccount;
    const savedAccounts = account?.accounts ?? [];

    return (
      <div className="auth-login-panel">
        {account?.loggedIn && !addingAccount && (
          <div className="auth-logged-in">
            <div className="github-user auth-user-card">
              {account.avatarUrl ? (
                <img src={account.avatarUrl} alt="" className="github-avatar" />
              ) : (
                <div className="github-avatar placeholder" />
              )}
              <div className="github-user-meta">
                <strong>{account.login}</strong>
                {account.name && (
                  <span className="muted small">{account.name}</span>
                )}
                <span className="muted small">凭据已写入系统 Git Credential</span>
              </div>
              <button
                type="button"
                className="auth-logout-btn"
                disabled={busy}
                onClick={() => void logoutProvider(provider)}
              >
                退出
              </button>
            </div>
            {savedAccounts.length > 1 && (
              <div className="auth-account-list">
                <span className="muted small">已保存账号</span>
                {savedAccounts.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    className={a.active ? "auth-account-item active" : "auth-account-item"}
                    disabled={busy || a.active}
                    onClick={() => void switchAccount(provider, a.id)}
                  >
                    {a.avatarUrl ? (
                      <img src={a.avatarUrl} alt="" />
                    ) : (
                      <span className="auth-account-dot" />
                    )}
                    <span>{a.login}</span>
                    {a.active && <em>当前</em>}
                  </button>
                ))}
              </div>
            )}
            <button
              type="button"
              className="auth-add-account"
              disabled={busy}
              onClick={() => {
                setAddingAccount(true);
                setError(null);
              }}
            >
              添加账号
            </button>
            {renderSshPanel(provider)}
          </div>
        )}

        {showLogin && (
          <>
            {addingAccount && account?.loggedIn && (
              <button
                type="button"
                className="linkish auth-cancel-add"
                disabled={busy}
                onClick={() => {
                  stopDevicePoll();
                  setDeviceFlow(null);
                  setAddingAccount(false);
                }}
              >
                取消添加，返回当前账号
              </button>
            )}
            {account?.sessionExpired && (
              <p className="auth-expired">{label} 登录已失效，请重新登录。</p>
            )}
            <p className="muted small auth-storage-hint">
              登录成功后会写入本机 Git 凭据；启动时与推拉失败时会自动同步。OAuth Client
              配置保存一次即可复用
              {account?.usingBuiltinOauth ? "（当前可用内置 Client）" : ""}。
            </p>

            <div className="auth-method-list" role="group" aria-label="登录方式">
              <button
                type="button"
                className="auth-method-card is-recommend"
                disabled={busy}
                onClick={() => void loginWithGitManager(provider)}
              >
                <span className="auth-method-mark" aria-hidden>
                  Git
                </span>
                <span className="auth-method-text">
                  <strong>
                    用 Git 登录
                    <em>推荐</em>
                  </strong>
                  <span>
                    {provider === "github"
                      ? "打开系统凭据管理器，用浏览器完成授权"
                      : "读取或填写 Gitee 凭据（密码处填私人令牌）"}
                  </span>
                </span>
              </button>
              <button
                type="button"
                className="auth-method-card"
                disabled={busy}
                onClick={() => void loginWithBrowser(provider)}
              >
                <span className="auth-method-mark" aria-hidden>
                  Web
                </span>
                <span className="auth-method-text">
                  <strong>浏览器登录</strong>
                  <span>需 Client ID + Secret（可配置一次）</span>
                </span>
              </button>
              {provider === "github" && (
                <button
                  type="button"
                  className="auth-method-card"
                  disabled={busy || !!deviceFlow}
                  onClick={() => void loginWithDevice()}
                >
                  <span className="auth-method-mark" aria-hidden>
                    码
                  </span>
                  <span className="auth-method-text">
                    <strong>设备码登录</strong>
                    <span>只需 Client ID，在另一设备浏览器输入代码</span>
                  </span>
                </button>
              )}
            </div>

            {provider === "github" && deviceFlow && (
              <div className="auth-device-panel">
                <p className="muted small">
                  打开{" "}
                  <button
                    type="button"
                    className="linkish"
                    onClick={() => void openUrl(deviceFlow.verificationUri)}
                  >
                    {deviceFlow.verificationUri}
                  </button>
                  ，输入下方代码完成授权。
                </p>
                <p className="device-code">{deviceFlow.userCode}</p>
                <div className="auth-method-row">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      void navigator.clipboard.writeText(deviceFlow.userCode);
                      setNotice("已复制设备码");
                    }}
                  >
                    复制代码
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      stopDevicePoll();
                      setDeviceFlow(null);
                      setDeviceStatus("");
                      setNotice(null);
                    }}
                  >
                    取消
                  </button>
                </div>
                {deviceStatus && (
                  <p className="muted small">{deviceStatus}</p>
                )}
              </div>
            )}

            <div className="auth-token-block">
              <div className="auth-token-head">
                <span>Access Token</span>
                <button
                  type="button"
                  className="linkish"
                  disabled={busy}
                  onClick={() => void openUrl(tokenDocUrl)}
                >
                  如何获取
                </button>
              </div>
              <p className="muted small">{scopeHint}</p>
              <div className="auth-token-row">
                <input
                  type={draft.showToken ? "text" : "password"}
                  value={draft.token}
                  onChange={(e) =>
                    updateDraft(provider, { token: e.target.value })
                  }
                  onPaste={(e) => {
                    const text = e.clipboardData.getData("text").trim();
                    if (!text) return;
                    e.preventDefault();
                    updateDraft(provider, { token: text });
                    void loginWithToken(provider, text);
                  }}
                  placeholder={
                    provider === "github"
                      ? "ghp_… / github_pat_…"
                      : "Gitee 私人令牌"
                  }
                  disabled={busy}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void loginWithToken(provider);
                  }}
                />
                <button
                  type="button"
                  className="auth-toggle-vis"
                  disabled={busy}
                  onClick={() =>
                    updateDraft(provider, { showToken: !draft.showToken })
                  }
                >
                  {draft.showToken ? "隐藏" : "显示"}
                </button>
                <button
                  type="button"
                  className="primary auth-token-login"
                  disabled={busy || !draft.token.trim()}
                  onClick={() => void loginWithToken(provider)}
                >
                  用 Token 登录
                </button>
              </div>
            </div>

            <button
              type="button"
              className="linkish auth-oauth-toggle"
              disabled={busy}
              onClick={() =>
                updateDraft(provider, { showOauth: !draft.showOauth })
              }
            >
              {draft.showOauth
                ? "收起 OAuth 应用配置"
                : account?.oauthReady
                  ? "OAuth 已就绪（可改配置）"
                  : "配置 OAuth（设备码只需 Client ID，浏览器还需 Secret）"}
            </button>
            {draft.showOauth && (
              <div className="auth-oauth-fields">
                <p className="muted small">
                  在 {label} 创建 OAuth 应用并保存一次即可。设备码登录只需 Client
                  ID；浏览器登录还需 Secret。回调地址在点「浏览器登录」时由本机端口自动生成。
                  <button
                    type="button"
                    className="linkish"
                    disabled={busy}
                    onClick={() => void openUrl(oauthDocUrl)}
                  >
                    打开开发者设置
                  </button>
                </p>
                <label className="settings-field">
                  <span>Client ID</span>
                  <input
                    value={draft.clientId}
                    onChange={(e) =>
                      updateDraft(provider, { clientId: e.target.value })
                    }
                    disabled={busy}
                    placeholder="OAuth Client ID"
                  />
                </label>
                <label className="settings-field">
                  <span>Client Secret</span>
                  <input
                    type="password"
                    value={draft.clientSecret}
                    onChange={(e) =>
                      updateDraft(provider, { clientSecret: e.target.value })
                    }
                    disabled={busy}
                    placeholder="浏览器登录需要；设备码可留空"
                  />
                </label>
                <button
                  type="button"
                  disabled={busy || !draft.clientId.trim()}
                  onClick={() =>
                    void (async () => {
                      try {
                        const status = await api.authSaveOauthConfig(
                          provider,
                          draft.clientId.trim(),
                          draft.clientSecret.trim(),
                        );
                        applyAccount(status);
                        setNotice(`已保存 ${label} OAuth 配置`);
                      } catch (e) {
                        setError(failureLine(e));
                      }
                    })()
                  }
                >
                  保存 OAuth 配置
                </button>
              </div>
            )}

            {!account?.loggedIn && renderSshPanel(provider)}
          </>
        )}
      </div>
    );
  }

  if (!repoPath) {
    return (
      <>
        <WindowChrome overlay={Boolean(wallpaperUrl) || Boolean(boot)} />
        {boot && (
          <LoadingScreen
            folderName={folderName(boot.path)}
            progress={boot.progress}
            label={boot.label}
            fromCache={boot.fromCache}
            wallpaperUrl={wallpaperUrl}
            wallpaperKind={prefs.wallpaperKind}
          />
        )}
        <div className={`welcome ${wallpaperUrl ? "has-wallpaper" : ""}`}>
          {wallpaperUrl && (
            <div className="welcome-wallpaper" aria-hidden>
              {prefs.wallpaperKind === "video" ? (
                <video
                  className="welcome-media"
                  src={wallpaperUrl}
                  autoPlay
                  muted
                  loop
                  playsInline
                />
              ) : (
                <img className="welcome-media" src={wallpaperUrl} alt="" />
              )}
              <div className="welcome-scrim" />
            </div>
          )}
          <div className="welcome-card">
          <img className="brand-mark" src="/app-icon.png" alt="" width={72} height={72} />
          <h1>青枝</h1>
          <p className="muted">
            打开本地项目，用图形界面完成日常 Git：改动、提交、分支与推拉。
          </p>
          {gitInfo ? (
            <p className="git-meta">
              {gitInfo.version}
              <br />
              <span className="muted small">{gitInfo.path}</span>
            </p>
          ) : (
            <p className="muted">正在检测 Git。如果没有安装，会自动安装完整版 Git for Windows。</p>
          )}
          <div className="welcome-actions">
            <button type="button" className="primary" onClick={pickFolder} disabled={busy || !gitInfo}>
              打开文件夹
            </button>
            <button type="button" onClick={() => openSettings()} disabled={busy}>
              设置
            </button>
            <button type="button" onClick={() => setShowHelp(true)} disabled={busy}>
              说明书
            </button>
            <button type="button" onClick={() => setShowAbout(true)} disabled={busy}>
              关于
            </button>
            <button type="button" onClick={() => void cloneRepo()} disabled={busy || !gitInfo}>
              克隆
            </button>
          </div>
          {recent.length > 0 && (
            <div className="recent">
              <div className="recent-header">
                <h2>最近打开</h2>
                <div className="row-actions">
                  {Object.values(recentExists).some((ok) => ok === false) && (
                    <button
                      type="button"
                      className="linkish"
                      disabled={busy}
                      onClick={() => {
                        const keep = recent.filter((p) => recentExists[p] !== false);
                        setRecent(pruneRecent(keep));
                      }}
                    >
                      清理失效
                    </button>
                  )}
                  <button
                    type="button"
                    className="linkish"
                    disabled={busy}
                    onClick={() =>
                      withConfirm("清空全部最近打开记录？", () => {
                        setRecent(clearRecent());
                      })
                    }
                  >
                    清空
                  </button>
                </div>
              </div>
              <ul>
                {recent.map((p) => {
                  const missing = recentExists[p] === false;
                  return (
                    <li key={p} className={missing ? "missing" : undefined}>
                      <button
                        type="button"
                        className="recent-open"
                        onClick={() => {
                          if (missing) {
                            setError(`路径不存在：${p}`);
                            return;
                          }
                          void openFolder(p);
                        }}
                        disabled={busy}
                        title={missing ? "路径已失效" : p}
                      >
                        <span className="recent-path">{p}</span>
                        {missing ? (
                          <span className="recent-badge">失效</span>
                        ) : null}
                      </button>
                      <button
                        type="button"
                        className="recent-remove"
                        disabled={busy}
                        title="从列表移除"
                        aria-label="从列表移除"
                        onClick={() => setRecent(removeRecent(p))}
                      >
                        ×
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {error && <div className="error-box" title={error}>{error}</div>}
          {updateInfo?.updateAvailable &&
            updateInfo.tagName !== dismissedUpdateTag && (
            <div className="update-banner" role="status">
              <div className="update-banner-text">
                发现新版本 <strong>v{updateInfo.latestVersion}</strong>
              </div>
              <div className="update-banner-actions">
                <button
                  type="button"
                  className="primary"
                  disabled={updateBusy || busy}
                  onClick={() => void downloadAndInstallUpdate()}
                >
                  下载并安装
                </button>
                <button type="button" onClick={() => setShowAbout(true)}>
                  关于
                </button>
              </div>
            </div>
          )}
          <div className="welcome-terminal">
            <Terminal text={terminal} onClear={() => setTerminal("")} />
          </div>
        </div>
        {showSettings && renderSettings()}
        {showHelp && renderHelp()}
        {showAbout && renderAbout()}
      </div>
      </>
    );
  }

  function renderAbout() {
    const hasUpdate = Boolean(updateInfo?.updateAvailable);
    return (
      <div className="modal-mask" onClick={() => setShowAbout(false)}>
        <div
          className="modal about-modal"
          onClick={(event) => event.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-label="关于青枝"
        >
          <header className="about-modal-head">
            <div>
              <h3>关于青枝</h3>
              <p className="muted small">本地 Git 桌面工具 · 开源，禁止商用</p>
            </div>
            <button
              type="button"
              className="settings-close"
              onClick={() => setShowAbout(false)}
              aria-label="关闭"
            >
              关闭
            </button>
          </header>
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

          <div className="settings-card about-feedback">
            <h5>软件更新</h5>
            <p className="muted small">
              从 GitHub（{UPDATE_REPO_OWNER}/{UPDATE_REPO_NAME}）检测最新 Release。
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

          <div className="settings-card about-feedback">
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
        </div>
      </div>
    );
  }

  function renderHelp() {
    return (
      <div className="modal-mask" onClick={() => setShowHelp(false)}>
        <div
          className="modal help-modal"
          onClick={(event) => event.stopPropagation()}
          role="dialog"
          aria-modal="true"
        >
          <h3>青枝 · 全部操作说明</h3>
          <div className="help-body">
            <h4>欢迎页</h4>
            <ul>
              <li>打开文件夹：打开本地项目；非仓库时可初始化（默认分支 main）。</li>
              <li>克隆：用设置中的克隆地址，选空文件夹克隆并打开。</li>
              <li>最近打开：再开仓库；× 移除单项；可清空 / 清理失效路径。</li>
            </ul>
            <h4>工具栏</h4>
            <ul>
              <li>打开 / 刷新：换项目或重新读取状态（F5、Ctrl+R）。</li>
              <li>关于：当前版本、检查更新、下载安装。</li>
              <li>下方「Release」页：管理 GitHub Release 附件（上传/删除安装包）。</li>
              <li>获取：只下载远程，不改本地文件。</li>
              <li>拉取：下载并合并到当前分支（Ctrl+Shift+L）。</li>
              <li>推送：上传本地提交（Ctrl+Shift+P）。</li>
              <li>↑↓ 数字：相对远程超前 / 落后的提交数。</li>
            </ul>
            <h4>改动与提交</h4>
            <ul>
              <li>筛选：按路径、冲突、未跟踪过滤。</li>
              <li>暂存 / 全部暂存（Ctrl+S）：放入暂存区；取消：移出暂存区。</li>
              <li>放弃：丢弃工作区修改或删除未跟踪文件（需确认）。</li>
              <li>差异页「暂存此块 / 取消此块」：按改动块局部暂存。</li>
              <li>提交（Ctrl+Enter）：用已暂存文件创建提交（需名字邮箱）。</li>
              <li>修改上次：改写最近未推送提交；撤销上次：去掉该提交，改动回暂存区。</li>
            </ul>
            <h4>分支</h4>
            <ul>
              <li>点击分支：切换；新建：创建并切过去。</li>
              <li>删除：删本地分支；未合并时会询问是否强制删除。</li>
              <li>合并：把所选分支并入当前；变基：把当前接到所选分支之后（改写历史）。</li>
              <li>远程检出 / 删除：基于远程建本地分支，或删除远程分支。</li>
              <li>冲突时：编辑并暂存冲突文件 →「继续」；或「放弃」中止。</li>
            </ul>
            <h4>历史 / 储藏 / 标签 / 终端</h4>
            <ul>
              <li>历史：点提交看补丁；拣选到当前分支；重置（软/混合/硬）。</li>
              <li>储藏：收起未完成改动；可选含未跟踪文件；弹出或丢弃。</li>
              <li>标签：创建、推送、推送全部、删本地、删远程。</li>
              <li>终端（默认页）：显示界面对应的 git 输出，也可手输命令。</li>
            </ul>
            <h4>设置</h4>
            <ul>
              <li>主题、字体、最近打开、提交图、仓库缓存加速。</li>
              <li>壁纸：加载页/欢迎页图片或视频背景；可清除缓存。</li>
              <li>GitHub / Gitee：Git 登录、浏览器 OAuth、Token；工具栏可看登录状态。</li>
              <li>身份与远程：名字邮箱、origin、克隆地址；点「保存」一并写入。</li>
            </ul>
            <h4>多仓库与安全</h4>
            <ul>
              <li>顶部标签切换多个仓库；× 关闭标签（不删磁盘）。</li>
              <li>硬重置、强制推送、删远程分支/标签会有确认，请谨慎。</li>
              <li>操作过久时界面会自动恢复，可看终端或点刷新。</li>
            </ul>
            <p className="muted small">
              更完整的表格说明见安装目录中的《使用说明书.md》。
            </p>
          </div>
          <div className="modal-actions">
            <button type="button" className="primary" onClick={() => setShowHelp(false)}>
              关闭
            </button>
          </div>
        </div>
      </div>
    );
  }

  function renderSettings() {
    const navItems: {
      id: "appearance" | "auth" | "identity";
      title: string;
      desc: string;
    }[] = [
      { id: "appearance", title: "外观与行为", desc: "主题、壁纸与习惯" },
      { id: "auth", title: "账号登录", desc: "GitHub / Gitee" },
      { id: "identity", title: "身份与远程", desc: "名字、邮箱、地址" },
    ];
    const authLogged =
      (accounts?.github.loggedIn ? 1 : 0) + (accounts?.gitee.loggedIn ? 1 : 0);

    return (
      <div className="modal-mask" onClick={() => setShowSettings(false)}>
        <div
          className="modal settings-modal settings-shell"
          onClick={(event) => event.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-label="设置"
        >
          <header className="settings-shell-head">
            <div>
              <h3>设置</h3>
              <p className="muted small">按分类管理外观、登录与仓库身份</p>
            </div>
            <button
              type="button"
              className="settings-close"
              onClick={() => setShowSettings(false)}
              aria-label="关闭设置"
            >
              关闭
            </button>
          </header>

          <div className="settings-shell-body">
            <nav className="settings-nav" aria-label="设置分类">
              {navItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`settings-nav-item${
                    settingsPage === item.id ? " is-active" : ""
                  }`}
                  onClick={() => setSettingsPage(item.id)}
                >
                  <span className="settings-nav-title">
                    {item.title}
                    {item.id === "auth" && authLogged > 0 && (
                      <span className="settings-nav-badge">{authLogged}</span>
                    )}
                    {item.id === "auth" && sessionWarnings.length > 0 && (
                      <span className="settings-nav-badge is-warn">!</span>
                    )}
                  </span>
                  <span className="settings-nav-desc">{item.desc}</span>
                </button>
              ))}
            </nav>

            <div className="settings-pane">
              {settingsPage === "appearance" && (
                <section className="settings-section">
                  <div className="settings-pane-intro">
                    <h4>外观与行为</h4>
                    <p className="muted small">调整界面观感与打开仓库时的习惯。</p>
                  </div>
                  <div className="settings-grid-2">
                    <label className="settings-field">
                      <span>主题</span>
                      <select
                        value={prefs.theme}
                        onChange={(e) =>
                          updatePrefs({
                            theme: e.target.value as AppPrefs["theme"],
                          })
                        }
                      >
                        <option value="light">浅色</option>
                        <option value="dark">墨蓝深色</option>
                        <option value="forest">青枝绿</option>
                      </select>
                    </label>
                    <label className="settings-field">
                      <span>字体大小</span>
                      <select
                        value={prefs.fontSize}
                        onChange={(e) =>
                          updatePrefs({
                            fontSize: e.target.value as AppPrefs["fontSize"],
                          })
                        }
                      >
                        <option value="normal">标准</option>
                        <option value="large">较大</option>
                      </select>
                    </label>
                  </div>

                  <div className="pref-cards" role="group" aria-label="行为选项">
                    <label
                      className={`pref-card${prefs.rememberRecent ? " is-on" : ""}`}
                    >
                      <input
                        type="checkbox"
                        checked={prefs.rememberRecent}
                        onChange={(e) =>
                          updatePrefs({ rememberRecent: e.target.checked })
                        }
                      />
                      <span className="pref-card-text">
                        <strong>记住最近打开</strong>
                        <span>欢迎页保留最近打开过的仓库路径</span>
                      </span>
                      <span className="pref-switch" aria-hidden />
                    </label>
                    <label
                      className={`pref-card${prefs.showCommitGraph ? " is-on" : ""}`}
                    >
                      <input
                        type="checkbox"
                        checked={prefs.showCommitGraph}
                        onChange={(e) =>
                          updatePrefs({ showCommitGraph: e.target.checked })
                        }
                      />
                      <span className="pref-card-text">
                        <strong>历史页提交图</strong>
                        <span>在历史列表左侧显示分支车道图</span>
                      </span>
                      <span className="pref-switch" aria-hidden />
                    </label>
                    <label
                      className={`pref-card${prefs.useRepoCache ? " is-on" : ""}`}
                    >
                      <input
                        type="checkbox"
                        checked={prefs.useRepoCache}
                        onChange={(e) =>
                          updatePrefs({ useRepoCache: e.target.checked })
                        }
                      />
                      <span className="pref-card-text">
                        <strong>打开缓存加速</strong>
                        <span>再次打开同一仓库时先用本地快照</span>
                      </span>
                      <span className="pref-switch" aria-hidden />
                    </label>
                    <button
                      type="button"
                      className="pref-cache-clear"
                      disabled={busy}
                      onClick={() => {
                        clearRepoCache();
                        setNotice("已清空仓库缓存");
                      }}
                    >
                      清空仓库缓存
                    </button>
                  </div>

                  <div className="wallpaper-panel">
                    <div className="wallpaper-panel-head">
                      <h4>欢迎页 / 加载页壁纸</h4>
                      <p className="muted small">
                        支持图片或视频；打开仓库时的加载页也会使用。
                      </p>
                    </div>
                    <div className="wallpaper-preview-frame">
                      {prefs.wallpaperKind === "image" && wallpaperUrl ? (
                        <img
                          className="wallpaper-preview-media"
                          src={wallpaperUrl}
                          alt="当前壁纸预览"
                        />
                      ) : prefs.wallpaperKind === "video" && wallpaperUrl ? (
                        <video
                          className="wallpaper-preview-media"
                          src={wallpaperUrl}
                          muted
                          autoPlay
                          loop
                          playsInline
                        />
                      ) : (
                        <div className="wallpaper-preview-empty">
                          <span>暂未设置壁纸</span>
                          <span className="muted small">选择图片或视频作为背景</span>
                        </div>
                      )}
                      {prefs.wallpaperKind !== "none" && (
                        <span className="wallpaper-preview-badge">
                          {prefs.wallpaperKind === "video" ? "视频" : "图片"}
                        </span>
                      )}
                    </div>
                    <div className="row-actions wallpaper-actions">
                      <button
                        type="button"
                        className="primary"
                        disabled={busy}
                        onClick={() => {
                          void (async () => {
                            const selected = await open({
                              multiple: false,
                              title: "选择壁纸图片或视频",
                              filters: [
                                {
                                  name: "媒体",
                                  extensions: [
                                    "png",
                                    "jpg",
                                    "jpeg",
                                    "webp",
                                    "gif",
                                    "mp4",
                                    "webm",
                                    "mov",
                                  ],
                                },
                              ],
                            });
                            if (typeof selected !== "string") return;
                            try {
                              const saved = await api.importWallpaper(selected);
                              const lower = saved.toLowerCase();
                              const kind =
                                lower.endsWith(".mp4") ||
                                lower.endsWith(".webm") ||
                                lower.endsWith(".mov")
                                  ? ("video" as const)
                                  : ("image" as const);
                              updatePrefs({
                                wallpaperPath: saved,
                                wallpaperKind: kind,
                              });
                              setNotice(
                                kind === "video"
                                  ? "已设置动态视频壁纸"
                                  : "已设置图片壁纸",
                              );
                            } catch (e) {
                              setError(failureLine(e));
                            }
                          })();
                        }}
                      >
                        选择壁纸
                      </button>
                      <button
                        type="button"
                        disabled={busy || prefs.wallpaperKind === "none"}
                        onClick={() => {
                          void (async () => {
                            try {
                              await api.clearWallpaper();
                            } catch {
                              /* ignore */
                            }
                            updatePrefs({
                              wallpaperPath: "",
                              wallpaperKind: "none",
                            });
                            setNotice("已清除壁纸");
                          })();
                        }}
                      >
                        清除壁纸
                      </button>
                    </div>
                  </div>
                </section>
              )}

              {settingsPage === "auth" && (
                <section className="settings-section" ref={authSectionRef}>
                  <div className="settings-pane-intro">
                    <h4>账号登录</h4>
                    <p className="muted small">
                      推荐「用 Git 登录」或粘贴 Token。浏览器登录需先配置 OAuth。
                      登录写入系统 Git 凭据，退出时会尽量清除。
                    </p>
                  </div>
                  {sessionWarnings.length > 0 && (
                    <p className="auth-expired">
                      {sessionWarnings.join("、")} 登录已失效，请重新登录。
                    </p>
                  )}
                  <div className="auth-tabs" role="tablist" aria-label="登录平台">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={authTab === "github"}
                      className={authTab === "github" ? "active" : ""}
                      onClick={() => setAuthTab("github")}
                    >
                      <span className="auth-tab-label">GitHub</span>
                      {accounts?.github.loggedIn ? (
                        <span className="auth-tab-badge is-ok">已登录</span>
                      ) : accounts?.github.sessionExpired ? (
                        <span className="auth-tab-badge is-warn">已失效</span>
                      ) : null}
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={authTab === "gitee"}
                      className={authTab === "gitee" ? "active" : ""}
                      onClick={() => setAuthTab("gitee")}
                    >
                      <span className="auth-tab-label">Gitee</span>
                      {accounts?.gitee.loggedIn ? (
                        <span className="auth-tab-badge is-ok">已登录</span>
                      ) : accounts?.gitee.sessionExpired ? (
                        <span className="auth-tab-badge is-warn">已失效</span>
                      ) : null}
                    </button>
                  </div>
                  {renderProviderAuth(authTab)}
                </section>
              )}

              {settingsPage === "identity" && (
                <IdentityRemotePane
                  key={repoPath ?? "no-repo"}
                  repoPath={repoPath}
                  remotesCount={remotes.length}
                  initialName={identity.name}
                  initialEmail={identity.email}
                  initialRemote={remoteUrl}
                  initialClone={cloneUrl}
                  saveGlobally={saveGlobally}
                  busy={busy}
                  onSaveGloballyChange={setSaveGlobally}
                  onDraftChange={onIdentityDraftChange}
                  onSave={saveIdentityAndRemote}
                />
              )}

            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <WindowChrome
        overlay={Boolean(boot && wallpaperUrl)}
        title={repoPath ? `${folderName(repoPath)} — 青枝` : "青枝"}
      />
      {boot && (
        <LoadingScreen
          folderName={folderName(boot.path)}
          progress={boot.progress}
          label={boot.label}
          fromCache={boot.fromCache}
          wallpaperUrl={wallpaperUrl}
          wallpaperKind={prefs.wallpaperKind}
        />
      )}
      <div className={`app ${entering ? "app-enter" : ""}`}>
      {syncingCache && (
        <div className="sync-strip" role="status">
          <div className="sync-strip-bar" />
          <span>正在后台同步最新状态…</span>
        </div>
      )}
      <header className="toolbar">
        <div className="toolbar-left">
          <button type="button" onClick={pickFolder} disabled={busy} title="打开其他项目文件夹">
            打开…
          </button>
          <button
            type="button"
            onClick={() => refresh(repoPath)}
            disabled={busy}
            title="重新读取仓库状态（F5 / Ctrl+R）"
          >
            刷新
          </button>
          <button type="button" onClick={() => openSettings()} disabled={busy}>
            设置
          </button>
          <button type="button" onClick={() => setShowHelp(true)} disabled={busy}>
            说明书
          </button>
          <button
            type="button"
            onClick={() => setShowAbout(true)}
            disabled={busy}
            title={`关于青枝 v${appVersion}`}
          >
            关于
          </button>
          <div className="repo-title">
            <strong title={repoPath ?? undefined}>{status?.branch ?? "…"}</strong>
            <span className="muted small repo-path" title={repoPath ?? undefined}>
              {folderName(repoPath)}
            </span>
            {status && (ahead > 0 || behind > 0) && (
              <span className="sync-badge" title="相对远程：本地超前 / 落后">
                {ahead > 0 ? `↑${ahead}` : ""}
                {ahead > 0 && behind > 0 ? " " : ""}
                {behind > 0 ? `↓${behind}` : ""}
              </span>
            )}
          </div>
        </div>
        <div className="toolbar-right">
          <button
            type="button"
            className={`auth-chip${
              accounts?.github.loggedIn || accounts?.gitee.loggedIn
                ? " is-in"
                : sessionWarnings.length > 0
                  ? " is-warn"
                  : ""
            }`}
            disabled={busy}
            title="远程账号登录"
            onClick={() => openSettingsAuth()}
          >
            {accounts?.github.loggedIn || accounts?.gitee.loggedIn
              ? [
                  accounts?.github.loggedIn ? `GH:${accounts.github.login}` : null,
                  accounts?.gitee.loggedIn ? `码云:${accounts.gitee.login}` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")
              : sessionWarnings.length > 0
                ? "登录已失效"
                : "未登录"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void cloneRepo()}
            title="克隆到空文件夹"
          >
            克隆
          </button>
          <div className="sync-group" role="group" aria-label="同步">
            <button
              type="button"
              disabled={busy}
              title="只下载远程更新，不改本地文件"
              onClick={() => runAction(() => api.fetch(repoPath), "正在获取…")}
            >
              获取
            </button>
            <button
              type="button"
              className={behind > 0 ? "primary" : undefined}
              disabled={busy}
              title="下载并合并到当前分支（Ctrl+Shift+L）"
              onClick={() => runAction(() => api.pull(repoPath), "正在拉取…")}
            >
              {busy ? "…" : behind > 0 ? `拉取 ↓${behind}` : "拉取"}
            </button>
            <button
              type="button"
              className={ahead > 0 && behind === 0 ? "primary" : undefined}
              disabled={busy}
              title="把本地提交上传到远程（Ctrl+Shift+P）"
              onClick={() => runAction(() => api.push(repoPath), "正在推送…")}
            >
              {busy ? "…" : ahead > 0 ? `推送 ↑${ahead}` : "推送"}
            </button>
          </div>
        </div>
      </header>

      {(busy || syncProgress) && (
        <div
          className={`sync-progress${syncProgress ? "" : " is-indeterminate"}`}
          role="status"
          aria-live="polite"
        >
          <div className="sync-progress-track">
            <div
              className="sync-progress-fill"
              style={
                syncProgress
                  ? { width: `${Math.max(2, syncProgress.percent)}%` }
                  : undefined
              }
            />
          </div>
          {syncProgress && (
            <div className="sync-progress-meta">
              <span>
                {syncProgress.label}
                {syncProgress.detail ? ` · ${syncProgress.detail}` : ""}
              </span>
              <span>{syncProgress.percent}%</span>
            </div>
          )}
        </div>
      )}

      {notice && (
        <button
          type="button"
          className={`notice-box status-dismiss${noticeSticky ? " is-sticky" : ""}`}
          title={noticeSticky ? `${notice}（点击关闭，不会自动消失）` : `${notice}（点击关闭）`}
          onClick={() => setNotice(null)}
        >
          {notice}
        </button>
      )}
      {error && (
        <div className="error-box error-banner-row">
          <button
            type="button"
            className="status-dismiss error-banner-text"
            title={`${error}（点击关闭）`}
            onClick={() => {
              setError(null);
              setAuthHint(false);
            }}
          >
            {error}
          </button>
          {authHint && (
            <button
              type="button"
              className="primary error-login-btn"
              onClick={() => openSettingsAuth()}
            >
              去登录
            </button>
          )}
        </div>
      )}
      {sessionWarnings.length > 0 && !error && (
        <div className="hint-box auth-warn-strip">
          {sessionWarnings.join("、")} 登录已失效。
          <button type="button" className="linkish" onClick={() => openSettingsAuth()}>
            重新登录
          </button>
        </div>
      )}
      {updateInfo?.updateAvailable &&
        updateInfo.tagName !== dismissedUpdateTag && (
        <div className="update-banner" role="status">
          <div className="update-banner-text">
            发现新版本 <strong>v{updateInfo.latestVersion}</strong>
            （当前 v{updateInfo.currentVersion}）
          </div>
          <div className="update-banner-actions">
            <button
              type="button"
              className="primary"
              disabled={updateBusy || busy}
              onClick={() => void downloadAndInstallUpdate()}
            >
              下载并安装
            </button>
            <button type="button" onClick={() => setShowAbout(true)} disabled={busy}>
              详情
            </button>
            <button
              type="button"
              className="linkish"
              onClick={() => setDismissedUpdateTag(updateInfo.tagName)}
            >
              稍后
            </button>
          </div>
        </div>
      )}
      {!identitySaved && (
        <div className="hint-box">
          提交前请先在
          <button type="button" className="linkish" onClick={() => openSettings("identity")}>
            设置
          </button>
          里填写名字和邮箱。
        </div>
      )}
      {identitySaved && remotes.length === 0 && (
        <div className="hint-box">
          还没有远程地址。可在设置里填写后点「保存」，然后才能拉取/推送。
        </div>
      )}
      {status?.operation === "merge" ||
      status?.operation === "cherry-pick" ||
      status?.operation === "rebase" ? (
        <div className="conflict-box">
          <div className="conflict-copy">
            <strong>
              {status.operation === "merge"
                ? "合并冲突"
                : status.operation === "rebase"
                  ? "变基冲突"
                  : "拣选冲突"}
              {conflictFiles.length > 0
                ? ` · ${conflictFiles.length} 个文件`
                : " · 可继续"}
            </strong>
            <span>
              {conflictFiles.length > 0
                ? "请打开冲突文件手动解决，暂存后再点「继续」。"
                : "冲突已全部暂存，可以继续完成操作。"}
            </span>
            {conflictFiles.length > 0 && (
              <div className="conflict-files">
                {conflictFiles.slice(0, 6).map((f) => (
                  <button
                    key={f.path}
                    type="button"
                    className="conflict-jump"
                    disabled={busy}
                    title={f.path}
                    onClick={() => {
                      setFileFilter("conflict");
                      setPane("diff");
                      setSelected({ path: f.path, staged: false });
                    }}
                  >
                    {f.path}
                  </button>
                ))}
                {conflictFiles.length > 6 ? (
                  <span className="muted small">等 {conflictFiles.length} 个</span>
                ) : null}
              </div>
            )}
          </div>
          <span className="row-actions conflict-actions">
            {conflictFiles.length > 0 && (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setFileFilter("conflict");
                  setPane("diff");
                  const curIdx = conflictFiles.findIndex(
                    (f) => f.path === selected?.path,
                  );
                  const next =
                    conflictFiles[(curIdx + 1) % conflictFiles.length] ??
                    conflictFiles[0];
                  setSelected({ path: next.path, staged: false });
                }}
              >
                下一处冲突
              </button>
            )}
            <button
              type="button"
              className="primary"
              disabled={busy || conflictFiles.length > 0}
              title={
                conflictFiles.length > 0
                  ? "还有未解决冲突，暂存全部冲突文件后可继续"
                  : undefined
              }
              onClick={() =>
                void runAction(
                  () => api.continueOperation(repoPath),
                  status.operation === "merge"
                    ? "正在完成合并…"
                    : status.operation === "rebase"
                      ? "正在继续变基…"
                      : "正在完成拣选…",
                )
              }
            >
              继续
            </button>
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => {
                const label =
                  status.operation === "merge"
                    ? "放弃这次合并？"
                    : status.operation === "rebase"
                      ? "放弃这次变基？"
                      : "放弃这次拣选？";
                withConfirm(label, () => {
                  void runAction(
                    () => api.abortOperation(repoPath),
                    status.operation === "merge"
                      ? "正在放弃合并…"
                      : status.operation === "rebase"
                        ? "正在放弃变基…"
                        : "正在放弃拣选…",
                  );
                });
              }}
            >
              放弃
            </button>
          </span>
        </div>
      ) : null}
      {showSettings && renderSettings()}
      {showHelp && renderHelp()}
      {showAbout && renderAbout()}
      {renderSyncDialog()}
      {renderResetDialog()}
      {renderLargeCommitDialog()}

      {openRepos.length > 0 && (
        <div className="repo-tabs" role="tablist" aria-label="已打开仓库">
          {openRepos.map((path) => (
            <div
              key={path}
              className={`repo-tab ${path === repoPath ? "active" : ""}`}
              role="tab"
              aria-selected={path === repoPath}
            >
              <button
                type="button"
                className="repo-tab-open"
                disabled={busy}
                title={path}
                onClick={() => {
                  if (path !== repoPath) void openFolder(path);
                }}
              >
                {folderName(path)}
              </button>
              <button
                type="button"
                className="repo-tab-close"
                disabled={busy}
                title="关闭标签"
                aria-label={`关闭 ${folderName(path)}`}
                onClick={() => closeRepoTab(path)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="main">
        <aside className="sidebar">
          <div className="changes-filter">
            <input
              value={fileQuery}
              onChange={(e) => setFileQuery(e.target.value)}
              placeholder="筛选文件路径…"
              aria-label="筛选文件路径"
            />
            <div className="filter-chips" role="group" aria-label="改动筛选">
              {(
                [
                  ["all", "全部"],
                  ["conflict", "冲突"],
                  ["untracked", "未跟踪"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={fileFilter === id ? "active" : undefined}
                  onClick={() => setFileFilter(id)}
                >
                  {label}
                  {id === "conflict" && conflictFiles.length > 0
                    ? ` ${conflictFiles.length}`
                    : ""}
                </button>
              ))}
            </div>
          </div>
          <div className="sidebar-scroll">
          <ChangeList
            title="已暂存"
            sectionId="staged"
            stickyTop="0"
            files={filteredStaged}
            selected={selected && selected.staged ? selected.path : null}
            stagedSection
            busy={busy}
            onSelect={(path) => setSelected({ path, staged: true })}
            onUnstage={(paths) => runAction(() => api.unstageFiles(repoPath, paths))}
          />
          <ChangeList
            title="未暂存"
            sectionId="unstaged"
            stickyTop="0"
            files={filteredUnstaged}
            selected={selected && !selected.staged ? selected.path : null}
            stagedSection={false}
            busy={busy}
            onSelect={(path) => setSelected({ path, staged: false })}
            onStage={(paths) => runAction(() => api.stageFiles(repoPath, paths))}
            onDiscard={(paths) => runAction(() => api.discardFiles(repoPath, paths))}
          />

          <div className="panel branch-panel">
            <div className="panel-header">
              <strong>分支</strong>
            </div>
            <ul className="branch-list">
              {branches.map((b) => (
                <li key={b.name} className={b.isCurrent ? "current" : ""}>
                  <button
                    type="button"
                    disabled={busy || b.isCurrent}
                    onClick={() =>
                      runAction(() => api.branchCheckout(repoPath, b.name))
                    }
                  >
                    {b.isCurrent ? "● " : "○ "}
                    {b.name}
                    {b.upstream ? (
                      <span className="muted small"> → {b.upstream}</span>
                    ) : null}
                  </button>
                  {!b.isCurrent && (
                    <span className="row-actions">
                      <button
                        type="button"
                        className="danger"
                        disabled={busy}
                        onClick={() =>
                          withConfirm(`删除本地分支「${b.name}」？`, () => {
                            void runAction(async () => {
                              try {
                                return await api.branchDelete(
                                  repoPath,
                                  b.name,
                                  false,
                                );
                              } catch (e) {
                                const raw = String(e);
                                if (
                                  raw.includes("BRANCH_NOT_MERGED:") ||
                                  /not fully merged/i.test(raw)
                                ) {
                                  const force = await confirmAction(
                                    `分支「${b.name}」尚未完全合并到当前分支。强制删除？未合并的提交可能丢失。`,
                                    { title: "强制删除分支", danger: true, confirmLabel: "强制删除" },
                                  );
                                  if (!force) return "已取消删除";
                                  return api.branchDelete(repoPath, b.name, true);
                                }
                                throw e;
                              }
                            }, "正在删除分支…");
                          })
                        }
                      >
                        删除
                      </button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
            <div className="new-branch">
              <input
                value={newBranch}
                onChange={(e) => setNewBranch(e.target.value)}
                placeholder="新分支名"
              />
              <button
                type="button"
                disabled={busy || !newBranch.trim()}
                onClick={() =>
                  runAction(async () => {
                    await api.branchCreate(repoPath, newBranch.trim());
                    setNewBranch("");
                  })
                }
              >
                新建
              </button>
            </div>
            <div className="new-branch">
              <select
                value={mergeTarget}
                onChange={(e) => setMergeTarget(e.target.value)}
                disabled={busy}
              >
                <option value="">合并其他分支到当前…</option>
                {branches
                  .filter((b) => !b.isCurrent)
                  .map((b) => (
                    <option key={b.name} value={b.name}>
                      {b.name}
                    </option>
                  ))}
              </select>
              <button
                type="button"
                disabled={busy || !mergeTarget}
                onClick={() =>
                  withConfirm(`把「${mergeTarget}」合并进当前分支？`, () => {
                    void runAction(
                      () => api.branchMerge(repoPath, mergeTarget),
                      "正在合并…",
                    );
                  })
                }
              >
                合并
              </button>
            </div>
            <div className="new-branch">
              <select
                value={rebaseTarget}
                onChange={(e) => setRebaseTarget(e.target.value)}
                disabled={busy}
              >
                <option value="">把当前分支变基到…</option>
                {branches
                  .filter((b) => !b.isCurrent)
                  .map((b) => (
                    <option key={`rebase-${b.name}`} value={b.name}>
                      {b.name}
                    </option>
                  ))}
              </select>
              <button
                type="button"
                disabled={busy || !rebaseTarget}
                title="把当前分支的提交接到所选分支最新提交之后"
                onClick={() =>
                  withConfirm(
                    `把当前分支变基到「${rebaseTarget}」？\n历史可能被改写；若已推送，之后可能需要强制推送。`,
                    () => {
                      void runAction(
                        () => api.branchRebase(repoPath, rebaseTarget),
                        "正在变基…",
                      );
                    },
                  )
                }
              >
                变基
              </button>
            </div>
            <div className="panel-header remote-branch-header">
              <strong>远程分支</strong>
              <span className="muted small">
                {remoteBranches.length === 0
                  ? "先点「获取」下载远程分支列表"
                  : "检出可创建/切换本地跟踪分支"}
              </span>
            </div>
            {remoteBranches.length === 0 ? (
              <p className="muted small pad">暂无远程分支记录</p>
            ) : (
              <ul className="branch-list remote-branch-list">
                {remoteBranches.map((rb) => (
                  <li key={rb.name}>
                    <span className="remote-branch-name">
                      {rb.name}
                      <span className="muted small"> {rb.tip}</span>
                      {rb.hasLocal ? (
                        <span className="muted small"> · 已有本地</span>
                      ) : null}
                    </span>
                    <span className="row-actions">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void runAction(
                            () => api.remoteBranchCheckout(repoPath, rb.name),
                            "正在检出远程分支…",
                          )
                        }
                      >
                        检出
                      </button>
                      <button
                        type="button"
                        className="danger"
                        disabled={busy}
                        onClick={() =>
                          withConfirm(
                            `删除远程分支「${rb.name}」？\n这会从 GitHub/Gitee 上删掉该分支，本地同名分支仍保留。`,
                            () => {
                              void runAction(
                                () => api.remoteBranchDelete(repoPath, rb.name),
                                "正在删除远程分支…",
                              );
                            },
                          )
                        }
                      >
                        删除
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          </div>

          <div className="panel commit-panel">
            <div className="panel-header">
              <strong>提交</strong>
              {identitySaved ? (
                <button
                  type="button"
                  className="linkish muted small"
                  onClick={() => openSettings("identity")}
                >
                  {identity.name} · {identity.email}
                </button>
              ) : (
                <button
                  type="button"
                  className="linkish muted small"
                  onClick={() => openSettings("identity")}
                >
                  去设置里填写名字和邮箱
                </button>
              )}
            </div>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="提交说明"
              rows={3}
            />
            <div className="commit-actions">
              <button
                type="button"
                className="primary"
                disabled={
                  busy ||
                  !message.trim() ||
                  staged.length === 0 ||
                  !identitySaved
                }
                title="提交（Ctrl+Enter）；超过 100MB 的文件会先提示"
                onClick={() => void requestCommit("commit")}
              >
                提交 {staged.length > 0 ? `(${staged.length})` : ""}
              </button>
              <button
                type="button"
                disabled={busy || !identitySaved || commits.length === 0}
                title="修改最近一次未推送的提交"
                onClick={() =>
                  withConfirm(
                    message.trim()
                      ? "用当前说明修改最近一次提交？"
                      : "保留原说明，把已暂存改动并入最近一次提交？",
                    () => {
                      void requestCommit("amend");
                    },
                  )
                }
              >
                修改上次
              </button>
              <button
                type="button"
                disabled={busy || commits.length === 0}
                title="撤销最近一次未推送的提交，改动回到暂存区"
                onClick={() =>
                  withConfirm(
                    "撤销最近一次提交？说明会去掉，文件改动仍留在暂存区。已推送的提交不能撤销。",
                    () => {
                      void runAction(
                        () => api.undoCommit(repoPath),
                        "正在撤销上次提交…",
                      );
                    },
                  )
                }
              >
                撤销上次
              </button>
            </div>
          </div>
        </aside>

        <ExtraPane
          pane={pane}
          onPane={setPane}
          diffPath={selected?.path ?? null}
          diffStaged={selected?.staged ?? false}
          diffText={diff}
          diffLoading={diffLoading}
          hasChanges={hasChanges}
          allowHunks={
            Boolean(selected) &&
            !status?.changes.find((c) => c.path === selected?.path)?.untracked
          }
          onApplyHunk={(patch, reverse) =>
            void runAction(
              () => api.applyPatch(repoPath, patch, reverse),
              reverse ? "正在取消暂存此块…" : "正在暂存此块…",
            )
          }
          showCommitGraph={prefs.showCommitGraph}
          commits={commits}
          selectedHash={selectedHash}
          commitPatch={commitPatch}
          patchLoading={patchLoading}
          onSelectCommit={setSelectedHash}
          onCherryPick={(hash) => {
            withConfirm(`把提交 ${hash.slice(0, 7)} 拣选到当前分支？`, () => {
              void runAction(() => api.cherryPick(repoPath, hash), "正在拣选…");
            });
          }}
          onResetCommit={(commit) => setResetTarget(commit)}
          stashes={stashes}
          stashMessage={stashMessage}
          onStashMessage={setStashMessage}
          stashIncludeUntracked={stashIncludeUntracked}
          onStashIncludeUntracked={setStashIncludeUntracked}
          onStash={() =>
            runAction(async () => {
              await api.createStash(
                repoPath,
                stashMessage,
                stashIncludeUntracked,
              );
              setStashMessage("");
            })
          }
          onPopStash={(index) => runAction(() => api.popStash(repoPath, index))}
          onDropStash={(index) => {
            withConfirm(`丢弃 stash@{${index}}？`, () => {
              void runAction(() => api.dropStash(repoPath, index));
            });
          }}
          tags={tags}
          tagName={tagName}
          onTagName={setTagName}
          onCreateTag={() =>
            runAction(async () => {
              await api.tagCreate(repoPath, tagName.trim());
              setTagName("");
            })
          }
          onPushTag={(name) =>
            void runAction(() => api.tagPush(repoPath, name), "正在推送标签…")
          }
          onPushAllTags={() => {
            withConfirm("把全部本地标签推送到远程？", () => {
              void runAction(() => api.tagPushAll(repoPath), "正在推送全部标签…");
            });
          }}
          onDeleteTag={(name) => {
            withConfirm(`删除本地标签「${name}」？`, () => {
              void runAction(() => api.tagDelete(repoPath, name), "正在删除标签…");
            });
          }}
          onDeleteRemoteTag={(name) => {
            withConfirm(
              `删除远程标签「${name}」？\n会从 GitHub/Gitee 上移除该标签，本地标签仍保留。`,
              () => {
                void runAction(
                  () => api.tagDeleteRemote(repoPath, name),
                  "正在删除远程标签…",
                );
              },
            );
          }}
          terminalText={terminal}
          onClearTerminal={() => setTerminal("")}
          releaseOwner={UPDATE_REPO_OWNER}
          releaseRepo={UPDATE_REPO_NAME}
          releaseDefaultTag={appVersion === "…" ? "" : `v${appVersion}`}
          githubLoggedIn={Boolean(accounts?.github.loggedIn)}
          updateBusy={updateBusy}
          onUpdateBusy={setUpdateBusy}
          onNotice={setNotice}
          onError={setError}
          onOpenAuth={() => openSettingsAuth("github")}
          updateProgress={updateProgress}
          onRunCommand={(line) => {
            if (busyRef.current) return;
            setTerminal((prev) => `${prev}$ ${line}\n`);
            busyRef.current = true;
            setBusy(true);
            setNotice("正在执行命令…");
            setError(null);
            void api
              .runCommand(repoPath, line)
              .then(async (output) => {
                if (output.trim()) {
                  setTerminal((prev) => `${prev}${output.trimEnd()}\n`);
                }
                setNotice("命令已执行");
                await refresh(repoPath);
              })
              .catch((e) => {
                const message = String(e);
                setTerminal((prev) => `${prev}${message}\n`);
                setNotice(null);
                setError(failureLine(e));
                busyRef.current = false;
                setBusy(false);
              });
          }}
          busy={busy}
        />
      </div>
    </div>
    </>
  );
}
