import {
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
import { SidebarSection } from "./components/SidebarSection";
import { ExtraPane, type Pane } from "./components/ExtraPane";
import type { OverviewPlatform } from "./components/OverviewPane";
import {
  IdentityRemotePane,
  type IdentityRemoteDraft,
} from "./components/IdentityRemotePane";
import { LoadingScreen } from "./components/LoadingScreen";
import {
  commitsToRebaseRows,
  RebaseInteractiveModal,
  type RebaseTodoRow,
} from "./components/RebaseInteractiveModal";
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
  formatGithubOwnerRepo,
  parseGiteeOwnerRepo,
  parseGithubOwnerRepo,
} from "./githubRepo";
import type { ReleasePlatform } from "./components/ReleaseManager";
import {
  loadMirrorInstalls,
  mirrorInstallId,
  removeMirrorInstall,
  saveMirrorInstalls,
  upsertMirrorInstall,
  type MirrorInstallRecord,
} from "./mirrorInstallStore";
import {
  applyGithubMirror,
  DEFAULT_GITHUB_HOSTS,
} from "./githubNetwork";
import { t as i18n } from "./i18n";
import {
  SettingsAboutPage,
  SettingsLanguagePage,
  SettingsNetworkPage,
  SettingsResetPage,
} from "./components/SettingsExtraPages";
import {
  UPDATE_REPO_NAME,
  UPDATE_REPO_OWNER,
  useAuthBootstrap,
} from "./hooks/useAuthBootstrap";
import { useRepoActions } from "./hooks/useRepoActions";
import {
  FEATURE_PERM_KEYS,
  featurePermLabel,
  type FeaturePermKey,
} from "./permissions";
import {
  applyPrefsToDocument,
  clearAllLocalAppData,
  DEFAULT_PREFS,
  loadCloneUrl,
  loadOpenRepos,
  loadPrefs,
  resolveGithubMirrorPrefix,
  saveCloneUrl,
  saveOpenRepos,
  savePrefs,
  THEME_OPTIONS,
  type AppPrefs,
} from "./settingsStore";

type SettingsPage =
  | "auth"
  | "identity"
  | "appearance"
  | "behavior"
  | "permissions"
  | "platformPerms"
  | "language"
  | "network"
  | "reset"
  | "about";
import {
  failureLine,
  type SyncConflictKind,
} from "./statusMessage";
import type {
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
import "./App.css";

function folderName(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** Human-readable hosting platform for a git remote. */
function labelRemotePlatform(remoteName: string, url = ""): string {
  const u = url.toLowerCase();
  const n = remoteName.toLowerCase();
  if (
    u.includes("github.com") ||
    n === "github" ||
    n.startsWith("github/") ||
    n.startsWith("github-")
  ) {
    return "GitHub";
  }
  if (
    u.includes("gitee.com") ||
    n === "gitee" ||
    n.startsWith("gitee/") ||
    n.startsWith("gitee-")
  ) {
    return "Gitee";
  }
  if (u.includes("gitlab") || n.includes("gitlab")) return "GitLab";
  if (u.includes("bitbucket") || n.includes("bitbucket")) return "Bitbucket";
  if (u.includes("coding.net") || u.includes("tencent.com")) return "CODING";
  return "其他远程";
}

function remoteHostHint(url: string): string {
  const m = url.match(/@([^/:]+)[:/]|:\/\/([^/]+)/);
  return (m?.[1] || m?.[2] || "").replace(/^www\./, "");
}

function platformBadgeClass(platform: string): string {
  const key = platform.toLowerCase();
  if (key === "github") return "is-github";
  if (key === "gitee") return "is-gitee";
  if (key === "gitlab") return "is-gitlab";
  return "is-other";
}

function authProviderFromRemote(
  remoteName: string,
  url = "",
): AuthProvider | null {
  const platform = labelRemotePlatform(remoteName, url);
  if (platform === "GitHub") return "github";
  if (platform === "Gitee") return "gitee";
  return null;
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
  const [settingsPage, setSettingsPage] = useState<SettingsPage>("auth");
  const [loadWpMode, setLoadWpMode] = useState<"static" | "dynamic">("static");
  const [weWallpapers, setWeWallpapers] = useState<
    {
      path: string;
      previewPath: string;
      projectDir: string;
      kind: string;
      label: string;
      source: string;
      weType: string;
    }[]
  >([]);
  const [weWpBusy, setWeWpBusy] = useState(false);
  const [weApplyBusy, setWeApplyBusy] = useState(false);
  /** Wallpaper Engine picker modal target slot. */
  const [wePickerSlot, setWePickerSlot] = useState<"load" | "terminal" | null>(
    null,
  );
  const [appVersion, setAppVersion] = useState(
    typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "…",
  );
  const [showHelp, setShowHelp] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateProgress, setUpdateProgress] = useState<{
    percent: number;
    label: string;
  } | null>(null);
  const [wikiProgress, setWikiProgress] = useState<{
    percent: number;
    label: string;
  } | null>(null);
  const [dismissedUpdateTag, setDismissedUpdateTag] = useState<string | null>(null);
  const [boot, setBoot] = useState<BootState | null>(null);
  const [entering, setEntering] = useState(false);
  const [syncDialog, setSyncDialog] = useState<SyncConflictKind | null>(null);
  /** 推送主按钮模式：直接推送，或同步到另一平台 */
  const [pushMode, setPushMode] = useState<"direct" | "mirror">("direct");
  const [pushMenuOpen, setPushMenuOpen] = useState(false);
  const [pullMode, setPullMode] = useState<"merge" | "rebase">("merge");
  const [pullMenuOpen, setPullMenuOpen] = useState(false);
  const [tagMessage, setTagMessage] = useState("");
  const [stashPreview, setStashPreview] = useState<string | null>(null);
  const [fileHistoryPath, setFileHistoryPath] = useState<string | null>(null);
  const [fileHistoryCommits, setFileHistoryCommits] = useState<CommitInfo[] | null>(
    null,
  );
  const [compareLeft, setCompareLeft] = useState("");
  const [compareRight, setCompareRight] = useState("HEAD");
  const [compareResult, setCompareResult] = useState<string | null>(null);
  const [cloneDialog, setCloneDialog] = useState<{
    url: string;
    branch: string;
    depth: string;
  } | null>(null);
  const [upstreamTarget, setUpstreamTarget] = useState<{
    localBranch: string;
    remote: string;
    remoteBranch: string;
  } | null>(null);
  const [pushRemote, setPushRemote] = useState<string | null>(null);
  const [blameText, setBlameText] = useState<string | null>(null);
  const [showReflog, setShowReflog] = useState(false);
  const [reflogEntries, setReflogEntries] = useState<
    import("./types").ReflogInfo[]
  >([]);
  const [conflictContent, setConflictContent] = useState<string | null>(null);
  const [conflictLoading, setConflictLoading] = useState(false);
  const [rebaseInteractive, setRebaseInteractive] = useState<{
    onto: string;
    rows: RebaseTodoRow[];
  } | null>(null);
  const [publishDialog, setPublishDialog] = useState<{
    path: string;
    name: string;
  } | null>(null);
  const [publishDraft, setPublishDraft] = useState({
    name: "",
    toGithub: true,
    toGitee: true,
    privateRepo: false,
  });
  const pendingPublishRef = useRef<string | null>(null);
  const [resetTarget, setResetTarget] = useState<CommitInfo | null>(null);
  const [renameTarget, setRenameTarget] = useState<{
    oldName: string;
    value: string;
  } | null>(null);
  const [checkoutTarget, setCheckoutTarget] = useState<{
    commit: CommitInfo;
    branchName: string;
  } | null>(null);
  const [largeCommit, setLargeCommit] = useState<{
    mode: "commit" | "amend";
    message: string;
    files: LargeFileInfo[];
    exclude: Record<string, boolean>;
  } | null>(null);
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
  /** When set, error toast shows a clickable「登录」 for this provider. */
  const [authHint, setAuthHint] = useState<AuthProvider | null>(null);
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

  useEffect(() => {
    const unlisten = listen<{ percent: number; label: string }>(
      "actions-mirror-progress",
      (event) => {
        setMirrorProgress({
          percent: Math.max(0, Math.min(100, event.payload.percent)),
          label: event.payload.label,
        });
      },
    );
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  useEffect(() => {
    const unlisten = listen<{ percent: number; label: string }>(
      "wiki-progress",
      (event) => {
        setWikiProgress({
          percent: Math.max(0, Math.min(100, event.payload.percent)),
          label: event.payload.label,
        });
      },
    );
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  const {
    accounts,
    setAccounts,
    refreshAccounts,
    checkForUpdate,
  } = useAuthBootstrap({
    appVersion,
    setGitInfo,
    setTerminal,
    setError,
    setNotice,
    setUpdateInfo,
    setUpdateBusy,
    setSessionWarnings,
    setDrafts,
    setAddingAccount,
  });

  // Hosts auto: refresh GitHub IPs on launch when previously enabled.
  useEffect(() => {
    if (!prefs.hostsAuto) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          let block = "";
          try {
            block = await api.resolveGithubHosts();
          } catch {
            block = (prefs.hostsText || DEFAULT_GITHUB_HOSTS).trim();
          }
          if (!block || cancelled) return;
          await api.applySystemHosts(block);
          if (!cancelled) {
            setPrefs((prev) => {
              const next = { ...prev, hostsText: block, hostsAuto: true };
              savePrefs(next);
              return next;
            });
          }
        } catch {
          /* UAC cancel / offline — keep prior hosts */
        }
      })();
    }, 1800);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once on mount if auto
  }, []);

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

  useEffect(() => {
    if (!error || authHint) return;
    const current = error;
    const timer = window.setTimeout(() => {
      setError((prev) => (prev === current ? null : prev));
    }, 6000);
    return () => window.clearTimeout(timer);
  }, [error, authHint]);

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
    // Ensure remotes referenced by remote-tracking branches still appear
    // even if a stale cache omitted them.
    const mergedRemotes = [...core.remotes];
    const seen = new Set(mergedRemotes.map((r) => r.name));
    for (const rb of core.remoteBranches) {
      const name = (rb.remote || rb.name.split("/")[0] || "").trim();
      if (name && !seen.has(name)) {
        seen.add(name);
        mergedRemotes.push({ name, url: "" });
      }
    }
    setRemotes(mergedRemotes);
    const origin =
      mergedRemotes.find((remote) => remote.name === "origin") ??
      mergedRemotes.find((remote) => /github\.com/i.test(remote.url)) ??
      mergedRemotes[0];
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

  useEffect(() => {
    setFileHistoryPath(null);
    setFileHistoryCommits(null);
    setStashPreview(null);
    setCompareResult(null);
    setBlameText(null);
    setShowReflog(false);
    setReflogEntries([]);
    setConflictContent(null);
    setConflictLoading(false);
  }, [repoPath]);

  const wallpaperUrl = useMemo(() => {
    if (prefs.wallpaperKind === "none" || !prefs.wallpaperPath) return null;
    // Ignore legacy builtin: ids from older versions.
    if (prefs.wallpaperPath.startsWith("builtin:")) return null;
    try {
      const src = convertFileSrc(prefs.wallpaperPath);
      // Path already unique per import; keep query for stubborn webview caches.
      const sep = src.includes("?") ? "&" : "?";
      return `${src}${sep}v=${encodeURIComponent(prefs.wallpaperPath)}`;
    } catch {
      return null;
    }
  }, [prefs.wallpaperKind, prefs.wallpaperPath]);

  const terminalWallpaperUrl = useMemo(() => {
    if (
      prefs.terminalWallpaperKind === "none" ||
      !prefs.terminalWallpaperPath
    ) {
      return null;
    }
    if (prefs.terminalWallpaperPath.startsWith("builtin:")) return null;
    try {
      const src = convertFileSrc(prefs.terminalWallpaperPath);
      const sep = src.includes("?") ? "&" : "?";
      return `${src}${sep}v=${encodeURIComponent(prefs.terminalWallpaperPath)}`;
    } catch {
      return null;
    }
  }, [prefs.terminalWallpaperKind, prefs.terminalWallpaperPath]);

  const releaseTarget = useMemo(() => {
    const fromPrefs = parseGithubOwnerRepo(prefs.releaseRepoOverride);
    if (fromPrefs) {
      return { ...fromPrefs, source: "settings" as const };
    }
    const githubRemote =
      remotes.find((r) => r.name === "github") ??
      remotes.find((r) => /github\.com/i.test(r.url)) ??
      remotes.find((r) => r.name === "origin");
    const fromRemote = parseGithubOwnerRepo(githubRemote?.url);
    if (fromRemote) {
      return { ...fromRemote, source: "remote" as const };
    }
    return { owner: "", repo: "", source: "none" as const };
  }, [prefs.releaseRepoOverride, remotes]);

  const releaseGiteeTarget = useMemo(() => {
    const fromPrefs = parseGiteeOwnerRepo(prefs.releaseGiteeRepoOverride);
    if (fromPrefs && prefs.releaseGiteeRepoOverride.trim()) {
      return { ...fromPrefs, source: "settings" as const };
    }
    const giteeRemote =
      remotes.find((r) => r.name === "gitee") ??
      remotes.find((r) => /gitee\.com/i.test(r.url));
    const fromRemote = parseGiteeOwnerRepo(giteeRemote?.url);
    if (fromRemote) {
      return { ...fromRemote, source: "remote" as const };
    }
    return { owner: "", repo: "", source: "none" as const };
  }, [prefs.releaseGiteeRepoOverride, remotes]);

  const [releasePlatform, setReleasePlatform] =
    useState<ReleasePlatform>("github");
  const [overviewPlatform, setOverviewPlatform] =
    useState<OverviewPlatform>("local");
  const [mirrorInstalls, setMirrorInstalls] = useState<MirrorInstallRecord[]>(
    () => loadMirrorInstalls(),
  );
  const [mirrorProgress, setMirrorProgress] = useState<{
    percent: number;
    label: string;
  } | null>(null);
  const [mirrorListBusy, setMirrorListBusy] = useState(false);

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
          const baseName =
            path.split(/[/\\]/).filter(Boolean).pop()?.trim() || "repo";
          pendingPublishRef.current = baseName;
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
            progress: 42,
            label: "正在从缓存恢复…",
            fromCache: true,
          });
          applyCore(cached.core);
          if (cached.extras) {
            setCommits(cached.extras.commits);
            setStashes(cached.extras.stashes);
            setTags(cached.extras.tags);
          }
          // Enter repo under the loading overlay, then sync before revealing UI.
          repoPathRef.current = path;
          setRepoPath(path);
          setBoot({
            path,
            progress: 58,
            label: "正在同步最新状态…",
            fromCache: true,
          });
          try {
            await refresh(path, { background: true });
            setBoot({
              path,
              progress: 92,
              label: "同步完成，即将进入…",
              fromCache: true,
            });
          } catch {
            setBoot({
              path,
              progress: 88,
              label: "同步未完成，将使用缓存进入…",
              fromCache: true,
            });
          }
          setBoot({
            path,
            progress: 100,
            label: "即将进入…",
            fromCache: true,
          });
          await sleep(280);
          setBoot(null);
          setEntering(true);
          busyRef.current = false;
          setBusy(false);
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
        if (pendingPublishRef.current) {
          const name = pendingPublishRef.current;
          pendingPublishRef.current = null;
          const ghOk = Boolean(accounts?.github.loggedIn);
          const geOk = Boolean(accounts?.gitee.loggedIn);
          if (!ghOk && !geOk) {
            promptPlatformLogin("github", "创建远程仓库");
          } else {
            setPublishDraft({
              name,
              toGithub: ghOk,
              toGitee: geOk,
              privateRepo: false,
            });
            setPublishDialog({ path, name });
          }
        }
      } catch (e) {
        pendingPublishRef.current = null;
        setBoot(null);
        setError(failureLine(e));
        busyRef.current = false;
        setBusy(false);
      }
    },
    [
      accounts?.github.loggedIn,
      accounts?.gitee.loggedIn,
      applyCore,
      prefs.rememberRecent,
      prefs.useRepoCache,
      refresh,
    ],
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

  /** Leave the current repo UI and return to the welcome page; keep open tabs. */
  const goHome = useCallback(() => {
    if (!repoPath) return;
    repoPathRef.current = null;
    setRepoPath(null);
    setStatus(null);
    setSelected(null);
    setDiff("");
    setMessage("");
    setBoot(null);
    setEntering(false);
    busyRef.current = false;
    setBusy(false);
    setError(null);
    setNotice(null);
  }, [repoPath]);

  const renderRepoTabs = () => {
    if (openRepos.length === 0) return null;
    return (
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
        <button
          type="button"
          className="repo-tab-add"
          disabled={busy}
          title="回到首页，打开或克隆仓库"
          aria-label="回到首页，打开或克隆仓库"
          onClick={goHome}
        >
          +
        </button>
      </div>
    );
  };

  const updatePrefs = useCallback((patch: Partial<AppPrefs>) => {
    setPrefs((prev) => {
      const next = {
        ...prev,
        ...patch,
        permissions: patch.permissions
          ? { ...prev.permissions, ...patch.permissions }
          : prev.permissions,
      };
      savePrefs(next);
      applyPrefsToDocument(next);
      if (patch.permissions) {
        void api.saveFeaturePermissions(next.permissions).catch(() => {
          /* backend sync best-effort */
        });
      }
      return next;
    });
  }, []);

  useEffect(() => {
    void api.saveFeaturePermissions(prefs.permissions).catch(() => {
      /* ignore until backend ready */
    });
    // Sync once on mount so Rust gates match localStorage prefs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshWallpaperEngine = useCallback(async () => {
    setWeWpBusy(true);
    try {
      const list = await api.listWallpaperEngineWallpapers();
      setWeWallpapers(list);
      return list;
    } catch (e) {
      setWeWallpapers([]);
      setError(failureLine(e));
      return [];
    } finally {
      setWeWpBusy(false);
    }
  }, []);

  const openWallpaperEnginePicker = useCallback(
    async (slot: "load" | "terminal") => {
      setWePickerSlot(slot);
      const list = await refreshWallpaperEngine();
      if (list.length > 0) {
        setNotice(`已读取 Wallpaper Engine 壁纸 ${list.length} 项`);
      }
    },
    [refreshWallpaperEngine],
  );

  const applyWallpaperEngineItem = useCallback(
    async (
      item: {
        path: string;
        previewPath: string;
        projectDir: string;
        kind: string;
        label: string;
      },
      slot: "load" | "terminal",
    ) => {
      setWeApplyBusy(true);
      try {
        const preferMotion =
          slot === "load" &&
          (loadWpMode === "dynamic" || item.kind === "video");
        // Dynamic → real video only; static → landscape / extracted HD still (not blurry gif).
        const prepared = await api.prepareWallpaperEngineMedia(
          item.projectDir,
          preferMotion,
        );
        if (slot === "terminal") {
          // Terminal is still-only: prefer a still path, else preview.
          const src =
            prepared.kind === "video"
              ? prepared.previewPath || item.previewPath || prepared.path
              : prepared.path;
          const saved = await api.importWallpaper(src, "terminal");
          updatePrefs({
            terminalWallpaperPath: saved,
            terminalWallpaperKind: "image",
          });
          setNotice(`已设置终端壁纸「${prepared.label || item.label}」`);
          setWePickerSlot(null);
          return;
        }
        const saved = await api.importWallpaper(prepared.path, "load");
        // gif stays "image" so <img> can animate; video uses <video>.
        const kind = prepared.kind === "video" ? "video" : "image";
        updatePrefs({ wallpaperPath: saved, wallpaperKind: kind });
        setLoadWpMode(kind === "video" ? "dynamic" : "static");
        setNotice(
          kind === "video"
            ? `已设置动态壁纸「${prepared.label || item.label}」`
            : `已设置壁纸「${prepared.label || item.label}」`,
        );
        setWePickerSlot(null);
      } catch (e) {
        setError(failureLine(e));
      } finally {
        setWeApplyBusy(false);
      }
    },
    [updatePrefs, loadWpMode],
  );

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
    setCloneDialog({ url, branch: "", depth: "" });
  }, [cloneUrl, openSettings]);

  const confirmClone = useCallback(async () => {
    if (!cloneDialog) return;
    const url = cloneDialog.url.trim();
    if (!url) {
      setError("请填写克隆地址");
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
    const branch = cloneDialog.branch.trim() || null;
    const depthRaw = Number(cloneDialog.depth.trim());
    const depth =
      Number.isFinite(depthRaw) && depthRaw > 0 ? Math.floor(depthRaw) : null;
    setCloneDialog(null);
    setBusy(true);
    setError(null);
    setNotice("正在克隆…");
    const mirrorPrefix = resolveGithubMirrorPrefix(prefs);
    const cloneUrlEffective = applyGithubMirror(url, mirrorPrefix);
    if (cloneUrlEffective !== url) {
      setNotice(`正在经镜像克隆…\n${cloneUrlEffective}`);
    }
    const cloneStarted = performance.now();
    try {
      const dest = await api.cloneRepo(cloneUrlEffective, selectedPath, {
        branch,
        depth,
      });
      const { recordTiming } = await import("./viz/networkTiming");
      recordTiming({
        kind: "clone",
        ms: Math.round(performance.now() - cloneStarted),
        at: Date.now(),
        label: "克隆",
      });
      setNotice("克隆完成");
      setShowSettings(false);
      await openFolder(dest);
    } catch (e) {
      setNotice(null);
      setError(failureLine(e));
      setBusy(false);
    }
  }, [cloneDialog, openFolder, prefs]);

  function remoteNameForPlatform(
    platform: "github" | "gitee",
  ): string | null {
    const named = remotes.find((r) => r.name === platform);
    if (named) return named.name;
    const byUrl = remotes.find((r) =>
      platform === "github"
        ? /github\.com/i.test(r.url)
        : /gitee\.com/i.test(r.url),
    );
    return byUrl?.name ?? null;
  }

  async function runMirrorPush() {
    if (!repoPath || !mirrorTarget || !mirrorSource) return;
    if (!ensureFeature("mirror")) return;
    if (!ensureFeature("push")) return;
    if (!ensureLoggedInForMirror()) return;
    const useActions = prefs.mirrorSyncMethod === "actions";
    const sourceRemote =
      remoteNameForPlatform(mirrorSource) ??
      (primaryHost === mirrorSource ? defaultRemoteName : mirrorSource);
    // GitHub → Gitee：只推 GitHub，由 forward workflow 同步
    if (useActions && mirrorDirection === "github-to-gitee") {
      void runAction(async () => {
        const status = await api.getActionsMirrorStatus(repoPath);
        if (!status.workflowExists) {
          throw new Error(
            "尚未安装 Actions 工作流。请到设置 → 行为，点「一键安装双向 Actions 镜像」。",
          );
        }
        const text = await api.push(
          repoPath,
          false,
          null,
          sourceRemote && sourceRemote !== defaultRemoteName
            ? sourceRemote
            : null,
        );
        return `${text}\n——\n已推送到 GitHub；Gitee 将由 Actions 自动同步。`;
      }, "正在推送（Actions 镜像）…");
      return;
    }
    // Gitee → GitHub：先推 Gitee，再触发 reverse workflow 从 Gitee 拉回 GitHub
    if (useActions && mirrorDirection === "gitee-to-github") {
      void runAction(async () => {
        const status = await api.getActionsMirrorStatus(repoPath);
        if (!status.reverseWorkflowExists) {
          throw new Error(
            "尚未安装反向镜像工作流。请到设置 → 行为，点「一键安装双向 Actions 镜像」。",
          );
        }
        const giteeRemote = remoteNameForPlatform("gitee") ?? "gitee";
        const pushText = await api.push(repoPath, false, null, giteeRemote);
        const triggerText = await api.triggerReverseActionsMirror(repoPath);
        return `${pushText}\n——\n${triggerText}`;
      }, "正在同步推送并触发 Actions…");
      return;
    }
    // 应用内：按设置方向先推源平台，再同步到目标平台（后端会确保目标 remote）
    void runAction(
      () =>
        api.push(
          repoPath,
          false,
          mirrorTarget,
          sourceRemote && sourceRemote !== defaultRemoteName
            ? sourceRemote
            : primaryHost === mirrorSource
              ? null
              : mirrorSource,
        ),
      mirrorDirection === "github-to-gitee"
        ? "正在镜像同步：GitHub → Gitee…"
        : "正在镜像同步：Gitee → GitHub…",
    );
  }

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

  const refreshSsh = useCallback(async () => {
    try {
      setSshStatus(await api.authSshStatus());
    } catch {
      /* SSH optional */
    }
  }, []);

  useEffect(() => {
    if (!showSettings) return;
    void refreshAccounts();
    if (settingsPage === "auth") void refreshSsh();
  }, [showSettings, settingsPage, refreshAccounts, refreshSsh]);

  useEffect(() => () => stopDevicePoll(), [stopDevicePoll]);

  function openSettings(page: SettingsPage = "auth") {
    setSettingsPage(page);
    setShowSettings(true);
  }

  function openSettingsAuth(provider?: AuthProvider) {
    if (provider) setAuthTab(provider);
    openSettings("auth");
  }

  /** Toast-only login gate: never auto-open settings or browser OAuth. */
  function promptPlatformLogin(
    provider: AuthProvider,
    action?: string,
  ): void {
    const label = provider === "github" ? "GitHub" : "Gitee";
    setError(action ? `${action}前请先` : `使用 ${label} 前请先`);
    setAuthHint(provider);
  }

  function requirePlatformLogin(
    provider: AuthProvider,
    action?: string,
  ): boolean {
    const loggedIn =
      provider === "github"
        ? Boolean(accounts?.github.loggedIn)
        : Boolean(accounts?.gitee.loggedIn);
    if (loggedIn) return true;
    promptPlatformLogin(provider, action);
    return false;
  }

  /** Block push until the matching GitHub/Gitee account is logged in. */
  function ensureLoggedInForPush(
    remoteName: string | null | undefined,
  ): boolean {
    const name =
      (remoteName && remoteName.trim()) ||
      defaultRemoteName ||
      remotes[0]?.name ||
      "";
    const url = remotes.find((r) => r.name === name)?.url ?? "";
    const provider = authProviderFromRemote(name, url);
    if (!provider) return true;
    return requirePlatformLogin(provider, `推送到 ${provider === "github" ? "GitHub" : "Gitee"}`);
  }

  function ensureLoggedInForMirror(): boolean {
    if (!mirrorTarget || !mirrorSource) return true;
    // Actions GitHub→Gitee：先推 GitHub
    if (
      prefs.mirrorSyncMethod === "actions" &&
      mirrorDirection === "github-to-gitee"
    ) {
      return requirePlatformLogin("github", "镜像同步（GitHub → Gitee）");
    }
    // Actions Gitee→GitHub：推 Gitee + 触发 GitHub workflow
    if (
      prefs.mirrorSyncMethod === "actions" &&
      mirrorDirection === "gitee-to-github"
    ) {
      if (!requirePlatformLogin("gitee", "镜像同步（Gitee → GitHub）")) {
        return false;
      }
      return requirePlatformLogin("github", "触发 Actions 反向镜像");
    }
    // 应用内同步：源与目标都需要登录
    if (!requirePlatformLogin(
      mirrorSource,
      `镜像同步（${mirrorSource === "github" ? "GitHub" : "Gitee"}）`,
    )) {
      return false;
    }
    return requirePlatformLogin(
      mirrorTarget,
      `镜像同步到 ${mirrorTarget === "github" ? "GitHub" : "Gitee"}`,
    );
  }

  /** App feature permission gate (Settings → 权限). */
  function ensureFeature(key: FeaturePermKey): boolean {
    if (prefs.permissions[key]) return true;
    const loc = prefs.locale || "zh-CN";
    const { title } = featurePermLabel(key, loc);
    setError(`${i18n(loc, "perm.denied")}：${title}`);
    setAuthHint(null);
    return false;
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
    setAuthHint(null);
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
      setAuthHint(provider);
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
    setAuthHint(null);
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
      setAuthHint(provider);
    } finally {
      setBusy(false);
    }
  }

  async function loginWithDevice() {
    stopDevicePoll();
    setBusy(true);
    setError(null);
    setAuthHint(null);
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
            setAuthHint("github");
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
      setAuthHint("github");
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
    setAuthHint(null);
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
      setAuthHint(provider);
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
    setBlameText(null);
    setConflictContent(null);
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
  const primaryHost = useMemo((): "github" | "gitee" | null => {
    const origin =
      remotes.find((r) => r.name === "origin") ?? remotes[0] ?? null;
    if (!origin) return null;
    const url = origin.url.toLowerCase();
    if (url.includes("github.com")) return "github";
    if (url.includes("gitee.com")) return "gitee";
    return null;
  }, [remotes]);
  const mirrorDirection = prefs.mirrorDirection;
  const mirrorSource =
    mirrorDirection === "github-to-gitee"
      ? ("github" as const)
      : ("gitee" as const);
  const mirrorTarget =
    mirrorDirection === "github-to-gitee"
      ? ("gitee" as const)
      : ("github" as const);
  const mirrorMenuLabel =
    mirrorDirection === "github-to-gitee"
      ? "镜像同步：GitHub → Gitee"
      : "镜像同步：Gitee → GitHub";
  const mirrorButtonLabel =
    mirrorDirection === "github-to-gitee"
      ? "镜像同步（→Gitee）"
      : "镜像同步（→GitHub）";
  const defaultRemoteName =
    remotes.find((r) => r.name === "origin")?.name ?? remotes[0]?.name ?? null;
  const activePushRemote = pushRemote ?? defaultRemoteName;

  const remotePushLabel = (remoteName: string, url: string) => {
    const platform = labelRemotePlatform(remoteName, url);
    if (platform === "其他远程") return `推送到 ${remoteName}`;
    return `推送到 ${platform}`;
  };

  const remoteBranchGroups = useMemo(() => {
    const urlOf = (remoteName: string) =>
      remotes.find((r) => r.name === remoteName)?.url ?? "";

    const byRemote = new Map<string, RemoteBranchInfo[]>();
    for (const rb of remoteBranches) {
      // Guard: some git versions expose odd short names; prefer explicit remote.
      const remoteName = (rb.remote || rb.name.split("/")[0] || "").trim();
      if (!remoteName) continue;
      const list = byRemote.get(remoteName) ?? [];
      list.push({ ...rb, remote: remoteName });
      byRemote.set(remoteName, list);
    }

    // Always list every configured remote (GitHub origin, Gitee, …),
    // even when its branches have not been fetched yet.
    const names: string[] = [];
    const pushName = (name: string) => {
      if (name && !names.includes(name)) names.push(name);
    };
    for (const r of remotes) pushName(r.name);
    for (const name of byRemote.keys()) pushName(name);

    const rank = (remoteName: string) => {
      const p = labelRemotePlatform(remoteName, urlOf(remoteName));
      if (p === "GitHub") return 0;
      if (p === "Gitee") return 1;
      return 2;
    };
    names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));

    return names.map((remoteName) => {
      const url = urlOf(remoteName);
      const platform = labelRemotePlatform(remoteName, url);
      const items = (byRemote.get(remoteName) ?? [])
        .slice()
        .sort((a, b) => a.branch.localeCompare(b.branch));
      return {
        remoteName,
        url,
        platform,
        host: remoteHostHint(url),
        items,
      };
    });
  }, [remoteBranches, remotes]);

  useEffect(() => {
    if (!status) return;
    if (
      status.operation !== "merge" &&
      status.operation !== "cherry-pick" &&
      status.operation !== "rebase" &&
      status.operation !== "revert"
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
    if (!pushMenuOpen && !pullMenuOpen) return;
    const onPointer = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest(".tool-split")) return;
      setPushMenuOpen(false);
      setPullMenuOpen(false);
    };
    window.addEventListener("mousedown", onPointer);
    return () => window.removeEventListener("mousedown", onPointer);
  }, [pushMenuOpen, pullMenuOpen]);

  useEffect(() => {
    if (!pushRemote) return;
    if (!remotes.some((r) => r.name === pushRemote)) {
      setPushRemote(null);
    }
  }, [remotes, pushRemote]);

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
        void runAction(
          () => api.pull(repoPath, false, pullMode === "rebase"),
          pullMode === "rebase" ? "正在变基拉取…" : "正在拉取…",
        );
      } else if ((e.key === "p" || e.key === "P") && e.shiftKey) {
        e.preventDefault();
        if (pushMode === "mirror" && mirrorTarget) {
          void runMirrorPush();
        } else {
          if (!ensureFeature("push")) return;
          if (!ensureLoggedInForPush(activePushRemote)) return;
          void runAction(
            () => api.push(repoPath, false, null, activePushRemote),
            activePushRemote && activePushRemote !== defaultRemoteName
              ? `正在推送到 ${activePushRemote}…`
              : "正在推送…",
          );
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    repoPath,
    refresh,
    staged.length,
    unstaged,
    identitySaved,
    pushMode,
    pullMode,
    mirrorTarget,
    prefs.mirrorSyncMethod,
    primaryHost,
    activePushRemote,
    defaultRemoteName,
  ]);

  const { runAction } = useRepoActions({
    repoPath,
    repoPathRef,
    busyRef,
    syncProgressActive,
    applyCore,
    refresh,
    setBusy,
    setError,
    setAuthHint: (show) => {
      if (!show) {
        setAuthHint(null);
        return;
      }
      setAuthHint(primaryHost === "gitee" ? "gitee" : "github");
    },
    setNotice,
    setSyncProgress,
    setSyncDialog,
    setCommits,
    setStashes,
    setTags,
  });

  async function loadFileHistory(file: string) {
    if (!repoPath) return;
    await runAction(async () => {
      const list = await api.getFileCommits(repoPath, file, 80);
      setFileHistoryPath(file);
      setFileHistoryCommits(list);
      setPane("history");
      setSelectedHash(list[0]?.hash ?? null);
      return list.length > 0
        ? `已加载「${file}」的 ${list.length} 条历史`
        : `「${file}」没有提交历史`;
    }, "正在加载文件历史…");
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
    setNotice(null);
    // Show the always-on slim progress bar while scanning staged blobs.
    busyRef.current = true;
    setBusy(true);
    setSyncProgress({
      label: "检查大文件",
      percent: 12,
      detail: "扫描暂存区",
    });
    try {
      const files = await api.listStagedLargeFiles(
        repoPath,
        LARGE_FILE_LIMIT_BYTES,
      );
      setSyncProgress({
        label: "检查大文件",
        percent: 100,
        detail: "完成",
      });
      if (files.length > 0) {
        const exclude: Record<string, boolean> = {};
        for (const f of files) exclude[f.path] = true;
        setLargeCommit({ mode, message: msg, files, exclude });
        busyRef.current = false;
        setBusy(false);
        setSyncProgress(null);
        return;
      }
    } catch (e) {
      busyRef.current = false;
      setBusy(false);
      setSyncProgress(null);
      setError(failureLine(e));
      return;
    }

    busyRef.current = false;
    setBusy(false);
    setSyncProgress(null);
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

  function renderRebaseInteractiveDialog() {
    if (!rebaseInteractive || !repoPath) return null;
    const { onto, rows } = rebaseInteractive;
    const path = repoPath;
    return (
      <RebaseInteractiveModal
        onto={onto}
        rows={rows}
        busy={busy}
        onChange={(next) =>
          setRebaseInteractive((prev) =>
            prev ? { ...prev, rows: next } : prev,
          )
        }
        onCancel={() => setRebaseInteractive(null)}
        onConfirm={() => {
          withConfirm(
            `开始交互变基到「${onto}」？\n历史可能被改写；若已推送，之后可能需要强制推送。`,
            () => {
              void runAction(async () => {
                const text = await api.branchRebaseInteractive(
                  path,
                  onto,
                  rows.map((r) => ({
                    action: r.action,
                    hash: r.hash,
                    subject: r.subject,
                  })),
                );
                setRebaseInteractive(null);
                return text || "交互变基完成";
              }, "正在交互变基…");
            },
          );
        }}
      />
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

  function renderUpstreamDialog() {
    if (!upstreamTarget || !repoPath) return null;
    const remoteBranchesForRemote = remoteBranches
      .filter((rb) => rb.remote === upstreamTarget.remote)
      .map((rb) => rb.branch);
    const branchOptions = Array.from(
      new Set([
        upstreamTarget.remoteBranch,
        upstreamTarget.localBranch,
        ...remoteBranchesForRemote,
      ].filter(Boolean)),
    );
    const submit = () => {
      const remote = upstreamTarget.remote.trim();
      const branch = upstreamTarget.remoteBranch.trim();
      if (!remote || !branch) return;
      const local = upstreamTarget.localBranch;
      setUpstreamTarget(null);
      void runAction(
        () => api.branchSetUpstream(repoPath, remote, branch, local),
        "正在设置上游…",
      );
    };
    return (
      <div className="modal-mask" onClick={() => setUpstreamTarget(null)}>
        <div
          className="modal sync-modal"
          onClick={(event) => event.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-labelledby="upstream-dialog-title"
        >
          <h3 id="upstream-dialog-title">设置上游</h3>
          <p className="muted small">
            本地分支「{upstreamTarget.localBranch}」跟踪的远程分支：
          </p>
          <label className="settings-field">
            <span>远程</span>
            <select
              value={upstreamTarget.remote}
              onChange={(e) => {
                const remote = e.target.value;
                const preferred =
                  remoteBranches.find(
                    (rb) =>
                      rb.remote === remote &&
                      rb.branch === upstreamTarget.localBranch,
                  )?.branch ??
                  remoteBranches.find((rb) => rb.remote === remote)?.branch ??
                  upstreamTarget.localBranch;
                setUpstreamTarget((cur) =>
                  cur
                    ? { ...cur, remote, remoteBranch: preferred }
                    : cur,
                );
              }}
              disabled={busy || remotes.length === 0}
            >
              {remotes.map((r) => (
                <option key={r.name} value={r.name}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          <label className="settings-field">
            <span>远程分支</span>
            <input
              list="upstream-branch-options"
              value={upstreamTarget.remoteBranch}
              onChange={(e) =>
                setUpstreamTarget((cur) =>
                  cur ? { ...cur, remoteBranch: e.target.value } : cur,
                )
              }
              placeholder="如 main"
              disabled={busy}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
            <datalist id="upstream-branch-options">
              {branchOptions.map((b) => (
                <option key={b} value={b} />
              ))}
            </datalist>
          </label>
          <div className="modal-actions">
            <button type="button" onClick={() => setUpstreamTarget(null)}>
              取消
            </button>
            <button
              type="button"
              className="primary"
              disabled={
                busy ||
                !upstreamTarget.remote.trim() ||
                !upstreamTarget.remoteBranch.trim()
              }
              onClick={submit}
            >
              确定
            </button>
          </div>
        </div>
      </div>
    );
  }

  function renderCloneDialog() {
    if (!cloneDialog) return null;
    return (
      <div className="modal-mask" onClick={() => setCloneDialog(null)}>
        <div
          className="modal sync-modal"
          onClick={(event) => event.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-labelledby="clone-dialog-title"
        >
          <h3 id="clone-dialog-title">克隆仓库</h3>
          <label className="settings-field">
            <span>地址</span>
            <input
              value={cloneDialog.url}
              onChange={(e) =>
                setCloneDialog((cur) =>
                  cur ? { ...cur, url: e.target.value } : cur,
                )
              }
              placeholder="https://github.com/用户/仓库.git"
              autoFocus
            />
          </label>
          <label className="settings-field">
            <span>分支（可选）</span>
            <input
              value={cloneDialog.branch}
              onChange={(e) =>
                setCloneDialog((cur) =>
                  cur ? { ...cur, branch: e.target.value } : cur,
                )
              }
              placeholder="默认分支可留空"
            />
          </label>
          <label className="settings-field">
            <span>浅克隆深度（可选）</span>
            <input
              value={cloneDialog.depth}
              onChange={(e) =>
                setCloneDialog((cur) =>
                  cur ? { ...cur, depth: e.target.value } : cur,
                )
              }
              placeholder="例如 1；留空为完整历史"
              inputMode="numeric"
            />
          </label>
          <div className="modal-actions">
            <button type="button" onClick={() => setCloneDialog(null)}>
              取消
            </button>
            <button
              type="button"
              className="primary"
              disabled={!cloneDialog.url.trim()}
              onClick={() => void confirmClone()}
            >
              选择文件夹并克隆
            </button>
          </div>
        </div>
      </div>
    );
  }

  function renderRenameDialog() {
    if (!renameTarget || !repoPath) return null;
    const next = renameTarget.value.trim();
    const canSubmit =
      next.length > 0 && next !== renameTarget.oldName && !busy;
    const submit = () => {
      if (!canSubmit) return;
      const oldName = renameTarget.oldName;
      setRenameTarget(null);
      void runAction(
        () => api.branchRename(repoPath, oldName, next),
        "正在重命名分支…",
      );
    };
    return (
      <div className="modal-mask" onClick={() => setRenameTarget(null)}>
        <div
          className="modal sync-modal"
          onClick={(event) => event.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-labelledby="rename-branch-title"
        >
          <h3 id="rename-branch-title">重命名分支</h3>
          <p className="muted small">
            将「{renameTarget.oldName}」重命名为：
          </p>
          <input
            value={renameTarget.value}
            onChange={(e) =>
              setRenameTarget((cur) =>
                cur ? { ...cur, value: e.target.value } : cur,
              )
            }
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setRenameTarget(null);
              }
            }}
            placeholder="新分支名"
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            disabled={busy}
          />
          <div className="modal-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => setRenameTarget(null)}
            >
              取消
            </button>
            <button
              type="button"
              className="primary"
              disabled={!canSubmit}
              onClick={submit}
            >
              重命名
            </button>
          </div>
        </div>
      </div>
    );
  }

  function renderCheckoutDialog() {
    if (!checkoutTarget || !repoPath) return null;
    const { commit, branchName } = checkoutTarget;
    const branch = branchName.trim();
    const submit = () => {
      setCheckoutTarget(null);
      withConfirm(
        branch
          ? `从 ${commit.shortHash} 创建并切换到分支「${branch}」？`
          : `游离检出到 ${commit.shortHash}？当前不在任何分支上。`,
        () => {
          void runAction(
            () =>
              api.checkoutCommit(repoPath, commit.hash, branch || null),
            "正在检出…",
          );
        },
      );
    };
    return (
      <div className="modal-mask" onClick={() => setCheckoutTarget(null)}>
        <div
          className="modal sync-modal"
          onClick={(event) => event.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-labelledby="checkout-commit-title"
        >
          <h3 id="checkout-commit-title">检出提交 {commit.shortHash}</h3>
          <p className="muted">{commit.subject}</p>
          <p className="muted small">
            可选：输入新分支名并创建；留空则游离检出。
          </p>
          <input
            value={branchName}
            onChange={(e) =>
              setCheckoutTarget((cur) =>
                cur ? { ...cur, branchName: e.target.value } : cur,
              )
            }
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setCheckoutTarget(null);
              }
            }}
            placeholder="新分支名（可留空）"
            autoFocus
            disabled={busy}
          />
          <div className="modal-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => setCheckoutTarget(null)}
            >
              取消
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={submit}
            >
              {branch ? "创建并检出" : "游离检出"}
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

  function renderPublishDialog() {
    if (!publishDialog) return null;
    const ghOk = Boolean(accounts?.github.loggedIn);
    const geOk = Boolean(accounts?.gitee.loggedIn);
    return (
      <div className="modal-mask" onClick={() => setPublishDialog(null)}>
        <div
          className="modal sync-modal"
          onClick={(event) => event.stopPropagation()}
          role="dialog"
          aria-modal="true"
        >
          <h3>创建远程仓库</h3>
          <p className="muted">
            本地已初始化。可同时在 GitHub / Gitee 建空仓库并写入远程地址（需已登录）。
          </p>
          <label className="field-block">
            <span>仓库名</span>
            <input
              value={publishDraft.name}
              onChange={(e) =>
                setPublishDraft((d) => ({ ...d, name: e.target.value }))
              }
              disabled={busy}
              spellCheck={false}
            />
          </label>
          <div className="publish-checks">
            <label>
              <input
                type="checkbox"
                checked={publishDraft.toGithub}
                disabled={busy || !ghOk}
                onChange={(e) =>
                  setPublishDraft((d) => ({ ...d, toGithub: e.target.checked }))
                }
              />
              GitHub{ghOk ? "" : "（未登录）"}
            </label>
            <label>
              <input
                type="checkbox"
                checked={publishDraft.toGitee}
                disabled={busy || !geOk}
                onChange={(e) =>
                  setPublishDraft((d) => ({ ...d, toGitee: e.target.checked }))
                }
              />
              Gitee{geOk ? "" : "（未登录）"}
            </label>
            <label>
              <input
                type="checkbox"
                checked={publishDraft.privateRepo}
                disabled={busy}
                onChange={(e) =>
                  setPublishDraft((d) => ({
                    ...d,
                    privateRepo: e.target.checked,
                  }))
                }
              />
              私有仓库
            </label>
          </div>
          <div className="modal-actions">
            <button type="button" disabled={busy} onClick={() => setPublishDialog(null)}>
              稍后
            </button>
            <button
              type="button"
              className="primary"
              disabled={
                busy ||
                !publishDraft.name.trim() ||
                (!(publishDraft.toGithub && ghOk) &&
                  !(publishDraft.toGitee && geOk))
              }
              onClick={() => {
                const target = publishDialog.path;
                const name = publishDraft.name.trim();
                const toGithub = publishDraft.toGithub && ghOk;
                const toGitee = publishDraft.toGitee && geOk;
                if (!ensureFeature("publishRemote")) return;
                if (!toGithub && !toGitee) {
                  if (!ghOk && !geOk) {
                    promptPlatformLogin("github", "创建远程仓库");
                  }
                  return;
                }
                if (toGithub && !requirePlatformLogin("github", "创建 GitHub 仓库"))
                  return;
                if (toGitee && !requirePlatformLogin("gitee", "创建 Gitee 仓库"))
                  return;
                setPublishDialog(null);
                void runAction(
                  () =>
                    api.publishRemotes(target, name, {
                      toGithub,
                      toGitee,
                      privateRepo: publishDraft.privateRepo,
                    }),
                  "正在创建远程仓库…",
                );
              }}
            >
              创建
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
                  onClick={() => {
                    if (!ensureFeature("push") || !ensureFeature("forcePush"))
                      return;
                    withConfirm(
                      "将用本地提交覆盖远程，远程多出来的提交会丢失。确定继续？",
                      () => {
                        setSyncDialog(null);
                        void runAction(
                          () =>
                            api.push(repoPath, true, null, activePushRemote),
                          "正在强制推送…",
                        );
                      },
                    );
                  }}
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
                      return api.push(repoPath, false, null, activePushRemote);
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
                  onClick={() => {
                    if (!ensureFeature("push") || !ensureFeature("forcePush"))
                      return;
                    withConfirm(
                      "将用本地提交覆盖远程，远程多出来的提交会丢失。确定继续？",
                      () => {
                        setSyncDialog(null);
                        void runAction(
                          () =>
                            api.push(repoPath, true, null, activePushRemote),
                          "正在强制推送…",
                        );
                      },
                    );
                  }}
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

  function renderFloatingToasts() {
    if (!notice && !error) return null;
    return (
      <div className="toast-stack" aria-live="polite">
        {notice && (
          <button
            type="button"
            className={`toast toast-notice${noticeSticky ? " is-sticky" : ""}`}
            title={
              noticeSticky
                ? `${notice}（点击关闭，不会自动消失）`
                : `${notice}（点击关闭）`
            }
            onClick={() => setNotice(null)}
          >
            <span className="toast-mark" aria-hidden>
              {noticeSticky ? "!" : "i"}
            </span>
            <span className="toast-body">{notice}</span>
            <span className="toast-dismiss" aria-hidden>
              ×
            </span>
          </button>
        )}
        {error && (
          <div className="toast toast-error">
            <span className="toast-mark" aria-hidden>
              !
            </span>
            <div className="toast-error-text">
              <span className="toast-body">
                {error}
                {authHint ? (
                  <button
                    type="button"
                    className="toast-login-link"
                    onClick={(e) => {
                      e.stopPropagation();
                      openSettingsAuth(authHint);
                    }}
                  >
                    登录
                  </button>
                ) : null}
              </span>
            </div>
            <button
              type="button"
              className="toast-dismiss-btn"
              aria-label="关闭"
              onClick={() => {
                setError(null);
                setAuthHint(null);
              }}
            >
              ×
            </button>
          </div>
        )}
      </div>
    );
  }

  if (!repoPath) {
    return (
      <>
        {renderFloatingToasts()}
        <WindowChrome
          overlay={Boolean(wallpaperUrl) || Boolean(boot)}
          version={appVersion}
          updateAvailable={Boolean(
            updateInfo?.updateAvailable &&
              updateInfo.latestVersion !== dismissedUpdateTag,
          )}
          updateBusy={updateBusy}
          onCheckUpdate={() => void checkForUpdate(false)}
          onUpdateClick={() => openSettings("about")}
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
              {i18n(prefs.locale || "zh-CN", "welcome.open")}
            </button>
            <button type="button" onClick={() => openSettings()} disabled={busy}>
              {i18n(prefs.locale || "zh-CN", "welcome.settings")}
            </button>
            <button type="button" onClick={() => setShowHelp(true)} disabled={busy}>
              {i18n(prefs.locale || "zh-CN", "welcome.help")}
            </button>
            <button type="button" onClick={() => openSettings("about")} disabled={busy}>
              {i18n(prefs.locale || "zh-CN", "nav.about")}
            </button>
            <button type="button" onClick={() => void cloneRepo()} disabled={busy || !gitInfo}>
              {i18n(prefs.locale || "zh-CN", "welcome.clone")}
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
          {((updateInfo?.updateAvailable &&
            updateInfo.tagName !== dismissedUpdateTag) ||
            updateProgress) && (
            <div className="update-banner" role="status">
              <div className="update-banner-text">
                {updateProgress
                  ? updateProgress.label
                  : (
                    <>
                      发现新版本 <strong>v{updateInfo!.latestVersion}</strong>
                    </>
                  )}
              </div>
              <div className="update-banner-actions">
                <button
                  type="button"
                  className="primary"
                  disabled={updateBusy || busy}
                  onClick={() => void downloadAndInstallUpdate()}
                >
                  {updateBusy ? "下载中…" : "下载并安装"}
                </button>
                <button type="button" onClick={() => openSettings("about")}>
                  关于
                </button>
              </div>
              {updateProgress && (
                <div className="about-progress update-banner-progress">
                  <div className="about-progress-head">
                    <span>下载进度</span>
                    <span>{updateProgress.percent}%</span>
                  </div>
                  <div className="about-progress-bar">
                    <i style={{ width: `${updateProgress.percent}%` }} />
                  </div>
                </div>
              )}
            </div>
          )}
          <div className="welcome-terminal">
            <Terminal
              text={terminal}
              onClear={() => setTerminal("")}
              wallpaperUrl={terminalWallpaperUrl}
              wallpaperKind={prefs.terminalWallpaperKind}
              wallpaperScrim={prefs.terminalWallpaperScrim}
            />
          </div>
        </div>
        {showSettings && renderSettings()}
        {showHelp && renderHelp()}
        {/* about moved into settings */}
      </div>
      </>
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
              <li>克隆：填写地址后可选分支 / 浅克隆深度，再选空文件夹克隆并打开。</li>
              <li>最近打开：再开仓库；× 移除单项；可清空 / 清理失效路径。</li>
            </ul>
            <h4>工具栏</h4>
            <ul>
              <li>打开 / 刷新：换项目或重新读取状态（F5、Ctrl+R）。</li>
              <li>关于：在设置 → 关于中查看版本、检查更新、下载安装。</li>
              <li>下方「Release」页：管理 GitHub Release 附件（上传/删除安装包）。</li>
              <li>克隆 · 拉取 · 推送：三个独立按钮，避免挤在一组。</li>
              <li>拉取 ▾：合并 / 变基拉取，以及「仅获取」（不改本地）；Ctrl+Shift+L。</li>
              <li>推送 ▾：推送到指定远程 / 同步另一平台 / 强制推送；Ctrl+Shift+P。</li>
              <li>同步方式：设置里可选「应用内同步」或「GitHub Actions 双向镜像」。</li>
              <li>↑↓ 数字：相对远程超前 / 落后的提交数。</li>
            </ul>
            <h4>改动与提交</h4>
            <ul>
              <li>筛选：按路径、冲突、未跟踪过滤。</li>
              <li>暂存 / 全部暂存（Ctrl+S）：放入暂存区；取消：移出暂存区。</li>
              <li>放弃：丢弃工作区修改或删除未跟踪文件（需确认）。</li>
              <li>忽略：写入 .gitignore；历史：查看单文件提交记录。</li>
              <li>差异页「暂存此块 / 取消此块 / 放弃此块」：按改动块操作。</li>
              <li>提交（Ctrl+Enter）：用已暂存文件创建提交（需名字邮箱）。</li>
              <li>修改上次：改写最近未推送提交；撤销上次：去掉该提交，改动回暂存区。</li>
            </ul>
            <h4>分支</h4>
            <ul>
              <li>点击分支：切换；新建：创建并切过去；重命名；清理未跟踪文件。</li>
              <li>删除：删本地分支；未合并时会询问是否强制删除；当前分支可「设上游」。</li>
              <li>合并：把所选分支并入当前；变基：把当前接到所选分支之后（改写历史）。</li>
              <li>远程检出 / 删除：基于远程建本地分支，或删除远程分支。</li>
              <li>冲突时（合并/拣选/变基/还原）：编辑并暂存 →「继续」；或「放弃」中止。</li>
            </ul>
            <h4>历史 / 储藏 / 标签 / 终端</h4>
            <ul>
              <li>历史：搜索提交；拣选 / 还原 / 检出 / 重置；可比较两个引用。</li>
              <li>储藏：查看、应用、弹出或丢弃；可选含未跟踪文件。</li>
              <li>标签：创建（可填附注）、推送、推送全部、删本地、删远程。</li>
              <li>终端（默认页）：显示界面对应的 git 输出，也可手输命令。</li>
            </ul>
            <h4>设置（全屏）</h4>
            <ul>
              <li>账号登录 / 身份与远程 / 外观 / 行为 / 语言 / 网络 / 重置 / 关于。</li>
              <li>外观：主题、字体、壁纸；行为：最近打开、提交图、缓存、同步方式、Release 仓库。</li>
              <li>网络：GitHub 克隆镜像与 Hosts 片段；语言：中文 / English，可添加自定义语言代码。</li>
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

  function renderWallpaperEnginePicker() {
    if (!wePickerSlot) return null;
    const slot = wePickerSlot;
    // Dynamic = real video only. GIF scene previews are low-res and look muddy fullscreen.
    const isMotionItem = (w: { kind: string }) => w.kind === "video";
    const filtered = weWallpapers.filter((w) => {
      if (slot === "terminal") return true;
      if (loadWpMode === "dynamic") return isMotionItem(w);
      return !isMotionItem(w);
    });
    return (
      <div
        className="we-picker-mask"
        onClick={(e) => {
          e.stopPropagation();
          if (!weApplyBusy) setWePickerSlot(null);
        }}
      >
        <div
          className="modal we-picker-modal"
          role="dialog"
          aria-modal="true"
          aria-label="Wallpaper Engine 图库"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="we-picker-head">
            <div>
              <h3>Wallpaper Engine</h3>
            <p className="muted small">
                {slot === "terminal"
                  ? "选择壁纸用作终端背景"
                  : loadWpMode === "dynamic"
                    ? "动态：仅含真实视频（mp4/webm）。场景 GIF 预览较糊，请用静态高清图"
                    : "静态：高清静图（场景类会尽量解出宽幅图，不用糊的 GIF 预览）"}
              </p>
            </div>
            <div className="row-actions">
              <button
                type="button"
                disabled={weWpBusy || weApplyBusy}
                onClick={() => void refreshWallpaperEngine()}
              >
                {weWpBusy ? "刷新中…" : "刷新"}
              </button>
              <button
                type="button"
                disabled={weApplyBusy}
                onClick={() => setWePickerSlot(null)}
              >
                关闭
              </button>
            </div>
          </div>
          {weApplyBusy && (
            <p className="muted small we-picker-status">正在应用壁纸…</p>
          )}
          {weWpBusy && filtered.length === 0 ? (
            <div className="we-picker-empty">正在读取 Wallpaper Engine 库…</div>
          ) : filtered.length === 0 ? (
            <div className="we-picker-empty">
              {slot === "load" && loadWpMode === "dynamic"
                ? "库中没有可用视频壁纸。场景动图请到「静态壁纸」选高清图，或点「本地文件」选视频。"
                : slot === "load"
                  ? "当前没有静态壁纸。"
                  : "未找到可用壁纸。请确认已安装 Wallpaper Engine 并订阅了创意工坊内容。"}
            </div>
          ) : (
            <div className="we-picker-grid">
              {filtered.map((w) => {
                let preview = "";
                try {
                  preview = convertFileSrc(w.previewPath || w.path);
                } catch {
                  preview = "";
                }
                return (
                  <button
                    key={w.projectDir || w.path}
                    type="button"
                    className="we-picker-item"
                    title={`${w.label} · ${w.weType} · ${w.source}`}
                    disabled={busy || weApplyBusy}
                    onClick={() => void applyWallpaperEngineItem(w, slot)}
                  >
                    <span className="we-picker-thumb">
                      {preview ? (
                        <img
                          src={preview}
                          alt=""
                          onError={(e) => {
                            e.currentTarget.style.display = "none";
                          }}
                        />
                      ) : (
                        <span className="muted small">无预览</span>
                      )}
                    </span>
                    <span className="we-picker-meta">
                      <span className="we-picker-title">{w.label}</span>
                      <span className="we-picker-tag">
                        {w.kind === "video"
                          ? "视频"
                          : w.weType === "web"
                            ? "网页"
                            : w.weType === "scene"
                              ? "场景"
                              : "静态"}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  }

  function renderSettings() {
    const loc = prefs.locale || "zh-CN";
    const navItems: { id: SettingsPage; title: string; desc: string }[] = [
      { id: "auth", title: i18n(loc, "nav.auth"), desc: i18n(loc, "nav.auth.desc") },
      { id: "identity", title: i18n(loc, "nav.identity"), desc: i18n(loc, "nav.identity.desc") },
      { id: "appearance", title: i18n(loc, "nav.appearance"), desc: i18n(loc, "nav.appearance.desc") },
      { id: "behavior", title: i18n(loc, "nav.behavior"), desc: i18n(loc, "nav.behavior.desc") },
      {
        id: "permissions",
        title: i18n(loc, "nav.permissions"),
        desc: i18n(loc, "nav.permissions.desc"),
      },
      {
        id: "platformPerms",
        title: i18n(loc, "nav.platformPerms"),
        desc: i18n(loc, "nav.platformPerms.desc"),
      },
      { id: "language", title: i18n(loc, "nav.language"), desc: i18n(loc, "nav.language.desc") },
      { id: "network", title: i18n(loc, "nav.network"), desc: i18n(loc, "nav.network.desc") },
      { id: "reset", title: i18n(loc, "nav.reset"), desc: i18n(loc, "nav.reset.desc") },
      { id: "about", title: i18n(loc, "nav.about"), desc: i18n(loc, "nav.about.desc") },
    ];
    const authLogged =
      (accounts?.github.loggedIn ? 1 : 0) + (accounts?.gitee.loggedIn ? 1 : 0);

    return (
      <div className="modal-mask settings-mask" onClick={() => setShowSettings(false)}>
        <div
          className="modal settings-modal settings-shell settings-shell-fullscreen"
          onClick={(event) => event.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-label={i18n(loc, "settings.title")}
        >
          <header className="settings-shell-head">
            <div>
              <h3>{i18n(loc, "settings.title")}</h3>
              <p className="muted small">{i18n(loc, "settings.subtitle")}</p>
            </div>
            <button
              type="button"
              className="settings-close"
              onClick={() => setShowSettings(false)}
              aria-label={i18n(loc, "settings.close")}
            >
              {i18n(loc, "settings.close")}
            </button>
          </header>

          <div className="settings-shell-body">
            <nav className="settings-nav" aria-label={i18n(loc, "settings.title")}>
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
                    <h4>外观</h4>
                    <p className="muted small">主题色板、字体与壁纸。</p>
                  </div>

                  <div className="settings-card">
                    <h5>主题</h5>
                    <div className="theme-swatch-grid" role="listbox" aria-label="主题">
                      {THEME_OPTIONS.map((t) => (
                        <button
                          key={t.id}
                          type="button"
                          role="option"
                          aria-selected={prefs.theme === t.id}
                          className={`theme-swatch${prefs.theme === t.id ? " is-active" : ""}`}
                          onClick={() => updatePrefs({ theme: t.id })}
                        >
                          <span
                            className="theme-swatch-chip"
                            style={{ background: t.swatch }}
                          />
                          <span className="theme-swatch-label">{t.label}</span>
                        </button>
                      ))}
                      <button
                        type="button"
                        role="option"
                        aria-selected={prefs.theme === "custom"}
                        className={`theme-swatch${prefs.theme === "custom" ? " is-active" : ""}`}
                        onClick={() => updatePrefs({ theme: "custom" })}
                      >
                        <span
                          className="theme-swatch-chip"
                          style={{
                            background: `linear-gradient(135deg, ${prefs.customAccent}, ${prefs.customBg})`,
                          }}
                        />
                        <span className="theme-swatch-label">自定义</span>
                      </button>
                    </div>
                    {prefs.theme === "custom" && (
                      <div className="theme-custom-row">
          <label className="settings-field">
                          <span>明暗</span>
                          <select
                            value={prefs.customScheme}
                            onChange={(e) =>
                              updatePrefs({
                                customScheme:
                                  e.target.value === "dark" ? "dark" : "light",
                              })
                            }
                          >
                            <option value="light">浅色</option>
                            <option value="dark">深色</option>
                          </select>
                        </label>
                        <label className="settings-field">
                          <span>强调色</span>
            <input
                            type="color"
                            value={prefs.customAccent}
              onChange={(e) =>
                              updatePrefs({ customAccent: e.target.value })
              }
            />
          </label>
          <label className="settings-field">
                          <span>背景色</span>
            <input
                            type="color"
                            value={prefs.customBg}
              onChange={(e) =>
                              updatePrefs({ customBg: e.target.value })
              }
            />
          </label>
                      </div>
                    )}
                    <label className="settings-field" style={{ marginTop: "0.75rem" }}>
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

                  <div className="wallpaper-panel">
                    <div className="wallpaper-panel-head">
                      <h4>加载页壁纸</h4>
                      <p className="muted small">
                        从 Wallpaper Engine 选取壁纸，或自行选择本地文件。
                      </p>
                    </div>
                    <div className="wallpaper-mode-tabs" role="tablist">
                      <button
                        type="button"
                        className={loadWpMode === "static" ? "is-active" : ""}
                        onClick={() => setLoadWpMode("static")}
                      >
                        静态壁纸
                      </button>
                      <button
                        type="button"
                        className={loadWpMode === "dynamic" ? "is-active" : ""}
                        onClick={() => setLoadWpMode("dynamic")}
                      >
                        动态壁纸
                      </button>
                    </div>
                    <div className="wallpaper-preview-frame">
                      {prefs.wallpaperKind === "image" && wallpaperUrl ? (
                        <img
                          className="wallpaper-preview-media"
                          src={wallpaperUrl}
                          alt="加载页壁纸预览"
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
                          <span>暂未设置加载页壁纸</span>
                          <span className="muted small">
                            点「获取 Wallpaper」打开图库，或选本地文件
                          </span>
                        </div>
                      )}
                      {prefs.wallpaperKind !== "none" && (
                        <span className="wallpaper-preview-badge">
                          {prefs.wallpaperKind === "video" ? "动态" : "静态"}
                        </span>
                      )}
                    </div>
                    <div className="row-actions wallpaper-actions">
                      <button
                        type="button"
                        className="primary"
                        disabled={busy || weWpBusy}
                        onClick={() => void openWallpaperEnginePicker("load")}
                      >
                        {weWpBusy && wePickerSlot === "load"
                          ? "读取中…"
                          : "获取 Wallpaper"}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          void (async () => {
                            const selected = await open({
                              multiple: false,
                              title:
                                loadWpMode === "dynamic"
                                  ? "选择动态壁纸（视频）"
                                  : "选择静态壁纸（图片）",
                              filters: [
                                loadWpMode === "dynamic"
                                  ? {
                                      name: "视频",
                                      extensions: ["mp4", "webm", "mov"],
                                    }
                                  : {
                                      name: "图片",
                                      extensions: [
                                        "png",
                                        "jpg",
                                        "jpeg",
                                        "webp",
                                        "gif",
                                        "bmp",
                                      ],
                                    },
                              ],
                            });
                            if (typeof selected !== "string") return;
                            try {
                              const saved = await api.importWallpaper(
                                selected,
                                "load",
                              );
                              const kind =
                                loadWpMode === "dynamic" ? "video" : "image";
                              updatePrefs({
                                wallpaperPath: saved,
                                wallpaperKind: kind,
                              });
                              setNotice(
                                kind === "video"
                                  ? "已设置动态壁纸"
                                  : "已设置静态壁纸",
                              );
                            } catch (e) {
                              setError(failureLine(e));
                            }
                          })();
                        }}
                      >
                        本地文件
                      </button>
                      <button
                        type="button"
                        disabled={busy || prefs.wallpaperKind === "none"}
                        onClick={() => {
                          void (async () => {
                            try {
                              await api.clearWallpaper("load");
                            } catch {
                              /* ignore */
                            }
                            updatePrefs({
                              wallpaperPath: "",
                              wallpaperKind: "none",
                            });
                            setNotice("已清除加载页壁纸");
                          })();
                        }}
                      >
                        清除
                      </button>
                    </div>
                    <div
                      className={`wallpaper-sliders${
                        prefs.wallpaperKind === "none" ? " is-disabled" : ""
                      }`}
                    >
                      <label className="wallpaper-slider-row">
                        <span>
                          <em>加载页蒙层</em>
                          <strong>{prefs.wallpaperLoadScrim}%</strong>
                        </span>
                <input
                          type="range"
                          min={0}
                          max={90}
                          value={prefs.wallpaperLoadScrim}
                          disabled={prefs.wallpaperKind === "none"}
                          onChange={(e) =>
                            updatePrefs({
                              wallpaperLoadScrim: Number(e.target.value),
                            })
                          }
                        />
                        <span className="muted small">
                          数值越大，欢迎页/加载页壁纸越淡
                        </span>
              </label>
                    </div>
                    <div className="wallpaper-sliders">
                      <label className="wallpaper-slider-row">
                        <span>
                          <em>中间面板不透明度</em>
                          <strong>{prefs.welcomePanelOpacity}%</strong>
                        </span>
                        <input
                          type="range"
                          min={20}
                          max={100}
                          value={prefs.welcomePanelOpacity}
                          onChange={(e) =>
                            updatePrefs({
                              welcomePanelOpacity: Number(e.target.value),
                            })
                          }
                        />
                        <span className="muted small">
                          默认 70%。数值越大面板越实，越小越能透出壁纸
                        </span>
                      </label>
                    </div>
                  </div>

                  <div className="wallpaper-panel">
                    <div className="wallpaper-panel-head">
                      <h4>终端背景</h4>
                      <p className="muted small">
                        仅静态图片：可从 Wallpaper Engine 选用，或本地自选。
                      </p>
                    </div>
                    <div className="wallpaper-preview-frame">
                      {prefs.terminalWallpaperKind === "image" &&
                      terminalWallpaperUrl ? (
                        <img
                          className="wallpaper-preview-media"
                          src={terminalWallpaperUrl}
                          alt="终端背景预览"
                        />
                      ) : (
                        <div className="wallpaper-preview-empty">
                          <span>暂未设置终端背景</span>
                          <span className="muted small">
                            点「获取 Wallpaper」打开图库，或选本地图片
                          </span>
                        </div>
                      )}
                      {prefs.terminalWallpaperKind === "image" && (
                        <span className="wallpaper-preview-badge">静态</span>
                      )}
                    </div>
                    <div className="row-actions wallpaper-actions">
                      <button
                        type="button"
                        className="primary"
                        disabled={busy || weWpBusy}
                        onClick={() =>
                          void openWallpaperEnginePicker("terminal")
                        }
                      >
                        {weWpBusy && wePickerSlot === "terminal"
                          ? "读取中…"
                          : "获取 Wallpaper"}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          void (async () => {
                            const selected = await open({
                              multiple: false,
                              title: "选择终端静态壁纸",
                              filters: [
                                {
                                  name: "图片",
                                  extensions: [
                                    "png",
                                    "jpg",
                                    "jpeg",
                                    "webp",
                                    "gif",
                                    "bmp",
                                  ],
                                },
                              ],
                            });
                            if (typeof selected !== "string") return;
                            try {
                              const saved = await api.importWallpaper(
                                selected,
                                "terminal",
                              );
                              updatePrefs({
                                terminalWallpaperPath: saved,
                                terminalWallpaperKind: "image",
                              });
                              setNotice("已设置终端静态壁纸");
                            } catch (e) {
                              setError(failureLine(e));
                            }
                          })();
                        }}
                      >
                        本地图片
                      </button>
              <button
                type="button"
                disabled={
                          busy || prefs.terminalWallpaperKind === "none"
                        }
                        onClick={() => {
                          void (async () => {
                            try {
                              await api.clearWallpaper("terminal");
                            } catch {
                              /* ignore */
                            }
                            updatePrefs({
                              terminalWallpaperPath: "",
                              terminalWallpaperKind: "none",
                            });
                            setNotice("已清除终端背景");
                          })();
                        }}
                      >
                        清除
                      </button>
                    </div>
                    <div
                      className={`wallpaper-sliders${
                        prefs.terminalWallpaperKind === "none"
                          ? " is-disabled"
                          : ""
                      }`}
                    >
                      <label className="wallpaper-slider-row">
                        <span>
                          <em>终端蒙层</em>
                          <strong>{prefs.terminalWallpaperScrim}%</strong>
                        </span>
                        <input
                          type="range"
                          min={0}
                          max={90}
                          value={prefs.terminalWallpaperScrim}
                          disabled={prefs.terminalWallpaperKind === "none"}
                          onChange={(e) =>
                            updatePrefs({
                              terminalWallpaperScrim: Number(e.target.value),
                            })
                          }
                        />
                        <span className="muted small">
                          数值越大，终端背景越淡、文字越清晰
                        </span>
                      </label>
                    </div>
                  </div>
                </section>
              )}

              {settingsPage === "behavior" && (
                <section className="settings-section">
                  <div className="settings-pane-intro">
                    <h4>行为</h4>
                    <p className="muted small">打开习惯、同步方式与 Release 仓库。</p>
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

                  <div className="settings-card mirror-method-card">
                    <h4>镜像同步</h4>
                    <p className="muted small">
                      选择同步方向与方式。推送菜单中的「镜像同步」会按此处设置执行。
                    </p>
                    <p className="muted small" style={{ marginTop: "0.65rem" }}>
                      同步方向
                    </p>
                    <div
                      className="pref-cards"
                      role="radiogroup"
                      aria-label="镜像同步方向"
                    >
                      <label
                        className={`pref-card${
                          prefs.mirrorDirection === "github-to-gitee"
                            ? " is-on"
                            : ""
                        }`}
                      >
                        <input
                          type="radio"
                          name="mirrorDirection"
                          checked={prefs.mirrorDirection === "github-to-gitee"}
                          onChange={() =>
                            updatePrefs({
                              mirrorDirection: "github-to-gitee",
                            })
                          }
                        />
                        <span className="pref-card-text">
                          <strong>GitHub → Gitee</strong>
                          <span>以 GitHub 为源，同步到 Gitee</span>
                        </span>
                        <span className="pref-switch" aria-hidden />
                      </label>
                      <label
                        className={`pref-card${
                          prefs.mirrorDirection === "gitee-to-github"
                            ? " is-on"
                            : ""
                        }`}
                      >
                        <input
                          type="radio"
                          name="mirrorDirection"
                          checked={prefs.mirrorDirection === "gitee-to-github"}
                          onChange={() =>
                            updatePrefs({
                              mirrorDirection: "gitee-to-github",
                            })
                          }
                        />
                        <span className="pref-card-text">
                          <strong>Gitee → GitHub</strong>
                          <span>以 Gitee 为源，同步到 GitHub</span>
                        </span>
                        <span className="pref-switch" aria-hidden />
                      </label>
                    </div>
                    <p className="muted small" style={{ marginTop: "0.75rem" }}>
                      同步方式
                    </p>
                    <div className="pref-cards" role="radiogroup" aria-label="同步推送方式">
                      <label
                        className={`pref-card${
                          prefs.mirrorSyncMethod === "app" ? " is-on" : ""
                        }`}
                      >
                        <input
                          type="radio"
                          name="mirrorSyncMethod"
                          checked={prefs.mirrorSyncMethod === "app"}
                          onChange={() =>
                            updatePrefs({ mirrorSyncMethod: "app" })
                          }
                        />
                        <span className="pref-card-text">
                          <strong>应用内同步推送</strong>
                          <span>本机先推源平台，再推到目标平台</span>
                        </span>
                        <span className="pref-switch" aria-hidden />
                      </label>
                      <label
                        className={`pref-card${
                          prefs.mirrorSyncMethod === "actions" ? " is-on" : ""
                        }`}
                      >
                        <input
                          type="radio"
                          name="mirrorSyncMethod"
                          checked={prefs.mirrorSyncMethod === "actions"}
                          onChange={() =>
                            updatePrefs({ mirrorSyncMethod: "actions" })
                          }
                        />
                        <span className="pref-card-text">
                          <strong>GitHub Actions 镜像</strong>
                          <span>
                            按上方方向：正向自动同步，或推 Gitee 后触发反向
                            Actions（需先一键安装）
                          </span>
                        </span>
                        <span className="pref-switch" aria-hidden />
                      </label>
                    </div>
                    <div className="row-actions" style={{ marginTop: "0.5rem" }}>
                      <button
                        type="button"
                        className="primary"
                        disabled={busy || mirrorListBusy || !repoPath}
                        title="写入双向 workflow、自动配置 Secrets，并尽量提交推送到 GitHub"
                        onClick={() => {
                          if (!repoPath) return;
                          if (!ensureFeature("mirror")) return;
                          if (
                            !requirePlatformLogin(
                              "github",
                              "安装 GitHub Actions 镜像",
                            )
                          )
                            return;
                          if (
                            !requirePlatformLogin(
                              "gitee",
                              "安装 GitHub Actions 镜像",
                            )
                          )
                            return;
                          setMirrorProgress({ percent: 2, label: "准备安装…" });
                  void runAction(async () => {
                            try {
                              const result = await api.setupActionsMirror(
                                repoPath,
                                true,
                              );
                              if (
                                result.secretsUrl &&
                                !result.secretConfigured
                              ) {
                                void openUrl(result.secretsUrl);
                              }
                              updatePrefs({ mirrorSyncMethod: "actions" });
                              const id = mirrorInstallId(
                                result.githubOwner,
                                result.githubRepo,
                              );
                              const record: MirrorInstallRecord = {
                                id,
                                repoPath,
                                githubOwner: result.githubOwner,
                                githubRepo: result.githubRepo,
                                giteeFullName: result.giteeFullName,
                                giteeUrl: result.giteeUrl,
                                installedAt: Date.now(),
                                connection: result.secretConfigured
                                  ? "ok"
                                  : "warn",
                                connectionDetail: result.secretConfigured
                                  ? "已安装（Secrets 已写入）"
                                  : "已安装（Secrets 未自动写入）",
                                lastCheckedAt: Date.now(),
                              };
                              setMirrorInstalls((prev) => {
                                const next = upsertMirrorInstall(prev, record);
                                saveMirrorInstalls(next);
                                return next;
                              });
                              return result.message;
                            } finally {
                              window.setTimeout(
                                () => setMirrorProgress(null),
                                800,
                              );
                            }
                          }, "正在一键安装双向 Actions 镜像…");
                        }}
                      >
                        一键安装双向 Actions 镜像
              </button>
                      <button
                        type="button"
                        disabled={
                          busy ||
                          mirrorListBusy ||
                          !repoPath ||
                          mirrorInstalls.length === 0
                        }
                        onClick={() => {
                          if (!repoPath) return;
                          setMirrorListBusy(true);
                          setMirrorProgress({
                            percent: 5,
                            label: "检查全部安装…",
                          });
                          void (async () => {
                            try {
                              const health =
                                await api.verifyActionsMirror(repoPath);
                              const id = mirrorInstallId(
                                health.githubOwner,
                                health.githubRepo,
                              );
                              setMirrorInstalls((prev) => {
                                const next = prev.map((item) => {
                                  if (item.id !== id && item.repoPath !== repoPath)
                                    return item;
                                  return {
                                    ...item,
                                    giteeFullName:
                                      health.giteeFullName || item.giteeFullName,
                                    connection:
                                      health.level === "ok"
                                        ? ("ok" as const)
                                        : health.level === "warn"
                                          ? ("warn" as const)
                                          : ("error" as const),
                                    connectionDetail: health.detail,
                                    lastCheckedAt: Date.now(),
                                  };
                                });
                                // If current repo not in list but has workflows, add it
                                if (
                                  !next.some((x) => x.id === id) &&
                                  (health.forwardLocal || health.reverseLocal)
                                ) {
                                  next.unshift({
                                    id,
                                    repoPath,
                                    githubOwner: health.githubOwner,
                                    githubRepo: health.githubRepo,
                                    giteeFullName: health.giteeFullName,
                                    giteeUrl: "",
                                    installedAt: Date.now(),
                                    connection:
                                      health.level === "ok"
                                        ? "ok"
                                        : health.level === "warn"
                                          ? "warn"
                                          : "error",
                                    connectionDetail: health.detail,
                                    lastCheckedAt: Date.now(),
                                  });
                                }
                                saveMirrorInstalls(next);
                                return next;
                              });
                              setNotice(
                                health.level === "ok"
                                  ? `连接正常：${health.detail}`
                                  : health.level === "warn"
                                    ? `待完善：${health.detail}`
                                    : `存在异常：${health.detail}`,
                              );
                            } catch (e) {
                              setError(failureLine(e));
                            } finally {
                              setMirrorListBusy(false);
                              setMirrorProgress(null);
                            }
                          })();
                        }}
                      >
                        检查安装状态
                      </button>
                    </div>

                    {mirrorProgress && (
                      <div className="about-progress release-progress" style={{ marginTop: "0.55rem" }}>
                        <div className="about-progress-head">
                          <span>{mirrorProgress.label}</span>
                          <span>{mirrorProgress.percent}%</span>
                        </div>
                        <div className="about-progress-bar">
                          <i style={{ width: `${mirrorProgress.percent}%` }} />
                        </div>
                      </div>
                    )}

                    <div className="mirror-install-list" style={{ marginTop: "0.65rem" }}>
                      <h5 style={{ margin: "0 0 0.35rem" }}>已安装镜像</h5>
                      {mirrorInstalls.length === 0 ? (
                        <p className="muted small">
                          还没有安装记录。点上方「一键安装」后会显示在此列表。
                        </p>
                      ) : (
                        <ul className="record-list mirror-install-ul">
                          {mirrorInstalls.map((item) => {
                            const badge =
                              item.connection === "ok"
                                ? "正常"
                                : item.connection === "warn"
                                  ? "待推送"
                                  : item.connection === "error"
                                    ? "异常"
                                    : "未检";
                            const badgeClass =
                              item.connection === "ok"
                                ? "is-ok"
                                : item.connection === "warn"
                                  ? "is-warn"
                                  : item.connection === "error"
                                    ? "is-err"
                                    : "is-unknown";
                            return (
                              <li key={item.id} className="mirror-install-row">
                                <div className="mirror-install-main">
                                  <div className="mirror-install-hosts">
                                    <span>
                                      <em>GitHub</em>{" "}
                                      <strong>
                                        {item.githubOwner}/{item.githubRepo}
                                      </strong>
                                    </span>
                                    <span className="mirror-host-arrow" aria-hidden>
                                      ↔
                                    </span>
                                    <span>
                                      <em>Gitee</em>{" "}
                                      <strong>
                                        {item.giteeFullName || "未配置"}
                                      </strong>
                                    </span>
                                    <span className={`mirror-badge ${badgeClass}`}>
                                      {badge}
                                    </span>
                                  </div>
                                  {item.connectionDetail ? (
                                    <span
                                      className="muted small mirror-install-detail"
                                      title={item.connectionDetail}
                                    >
                                      {item.connectionDetail}
                                    </span>
                                  ) : null}
                                </div>
                                <span className="row-actions">
                                  <button
                                    type="button"
                                    className="pane-btn pane-btn--soft pane-btn--sm"
                                    disabled={
                                      busy ||
                                      mirrorListBusy ||
                                      !repoPath ||
                                      (item.repoPath !== repoPath &&
                                        !!item.repoPath)
                                    }
                                    title={
                                      item.repoPath &&
                                      item.repoPath !== repoPath
                                        ? `请先打开仓库：${item.repoPath}`
                                        : "检查此安装是否连接正常"
                                    }
                                    onClick={() => {
                                      if (!repoPath) return;
                                      setMirrorListBusy(true);
                                      setMirrorProgress({
                                        percent: 5,
                                        label: `检查 ${item.githubOwner}/${item.githubRepo}…`,
                                      });
                                      void (async () => {
                                        try {
                                          const health =
                                            await api.verifyActionsMirror(
                                              repoPath,
                                            );
                                          setMirrorInstalls((prev) => {
                                            const next = prev.map((x) =>
                                              x.id === item.id
                                                ? {
                                                    ...x,
                                                    giteeFullName:
                                                      health.giteeFullName ||
                                                      x.giteeFullName,
                                                    connection:
                                                      health.level === "ok"
                                                        ? ("ok" as const)
                                                        : health.level === "warn"
                                                          ? ("warn" as const)
                                                          : ("error" as const),
                                                    connectionDetail:
                                                      health.detail,
                                                    lastCheckedAt: Date.now(),
                                                  }
                                                : x,
                                            );
                                            saveMirrorInstalls(next);
                                            return next;
                                          });
                                          setNotice(
                                            health.level === "ok"
                                              ? `连接正常：${health.detail}`
                                              : health.level === "warn"
                                                ? `待完善：${health.detail}`
                                                : `存在异常：${health.detail}`,
                                          );
                                        } catch (e) {
                                          setMirrorInstalls((prev) => {
                                            const next = prev.map((x) =>
                                              x.id === item.id
                                                ? {
                                                    ...x,
                                                    connection: "error" as const,
                                                    connectionDetail:
                                                      failureLine(e),
                                                    lastCheckedAt: Date.now(),
                                                  }
                                                : x,
                                            );
                                            saveMirrorInstalls(next);
                                            return next;
                                          });
                                          setError(failureLine(e));
                                        } finally {
                                          setMirrorListBusy(false);
                                          setMirrorProgress(null);
                                        }
                                      })();
                                    }}
                                  >
                                    检查
                                  </button>
                                  <button
                                    type="button"
                                    className="pane-btn pane-btn--danger pane-btn--sm"
                                    disabled={busy || mirrorListBusy}
                                    title="删除本地工作流并移出列表（会尽量推送到 GitHub）"
                                    onClick={() => {
                                      void (async () => {
                                        const ok = await confirmAction(
                                          `删除「${item.githubOwner}/${item.githubRepo}」的双向 Actions 镜像？\n会删除本地 workflow 并尽量推送到 GitHub；列表记录也会移除。`,
                                          {
                                            title: "删除镜像安装",
                                            danger: true,
                                            confirmLabel: "删除",
                                          },
                                        );
                                        if (!ok) return;
                                        const canRemoveFiles =
                                          Boolean(repoPath) &&
                                          (!item.repoPath ||
                                            item.repoPath === repoPath);
                                        if (
                                          canRemoveFiles &&
                                          !ensureFeature("mirror")
                                        )
                                          return;
                                        if (
                                          canRemoveFiles &&
                                          !requirePlatformLogin(
                                            "github",
                                            "删除 Actions 镜像",
                                          )
                                        )
                                          return;
                                        setMirrorListBusy(true);
                                        setMirrorProgress({
                                          percent: 5,
                                          label: "正在删除…",
                                        });
                                        try {
                                          if (canRemoveFiles && repoPath) {
                                            const msg =
                                              await api.removeActionsMirror(
                                                repoPath,
                                                true,
                                              );
                                            setNotice(msg);
                                          } else {
                                            setNotice(
                                              "已从列表移除（当前未打开对应仓库，未删磁盘文件）",
                                            );
                                          }
                                          setMirrorInstalls((prev) => {
                                            const next = removeMirrorInstall(
                                              prev,
                                              item.id,
                                            );
                                            saveMirrorInstalls(next);
                                            return next;
                                          });
                                        } catch (e) {
                                          setError(failureLine(e));
                                        } finally {
                                          setMirrorListBusy(false);
                                          setMirrorProgress(null);
                                        }
                                      })();
                                    }}
                                  >
                                    删除
                                  </button>
                                </span>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>

                    <p className="muted small" style={{ marginTop: "0.4rem" }}>
                      一键安装会写入双向 workflow、自动写 GitHub Secrets，并尽量提交推送。
                      需已登录 GitHub（含 workflow 权限）与 Gitee。安装后可在列表中检查连接或删除。
                    </p>
                  </div>

                  <div className="settings-card">
                    <h5>Release 仓库</h5>
                    <p className="muted small">
                      Release 页可切换 GitHub / Gitee。留空则从远程自动识别。青枝「检查更新」仍固定为{" "}
                      {UPDATE_REPO_OWNER}/{UPDATE_REPO_NAME}。
                    </p>
          <label className="settings-field">
                      <span>GitHub（owner/repo）</span>
            <input
                        value={prefs.releaseRepoOverride}
                        onChange={(e) =>
                          updatePrefs({ releaseRepoOverride: e.target.value })
                        }
                        placeholder="例如 lizhihufa/huaweiyunapp，留空=自动"
                        spellCheck={false}
            />
          </label>
          <p className="muted small">
                      GitHub 当前：
                      {releaseTarget.owner
                        ? `${formatGithubOwnerRepo(
                            releaseTarget.owner,
                            releaseTarget.repo,
                          )}（${
                            releaseTarget.source === "settings"
                              ? "设置指定"
                              : "远程"
                          }）`
                        : "未识别"}
                    </p>
                    <label className="settings-field" style={{ marginTop: "0.55rem" }}>
                      <span>Gitee（owner/repo）</span>
            <input
                        value={prefs.releaseGiteeRepoOverride}
                        onChange={(e) =>
                          updatePrefs({
                            releaseGiteeRepoOverride: e.target.value,
                          })
                        }
                        placeholder="例如 lizhihufa/huaweiyunapp，留空=自动"
                        spellCheck={false}
            />
          </label>
                    <p className="muted small">
                      Gitee 当前：
                      {releaseGiteeTarget.owner
                        ? `${formatGithubOwnerRepo(
                            releaseGiteeTarget.owner,
                            releaseGiteeTarget.repo,
                          )}（${
                            releaseGiteeTarget.source === "settings"
                              ? "设置指定"
                              : "远程"
                          }）`
                        : "未识别"}
                    </p>
                  </div>
                </section>
              )}

              {settingsPage === "permissions" && (
                <section className="settings-section">
                  <div className="settings-pane-intro">
                    <h4>{i18n(loc, "perm.title")}</h4>
                    <p className="muted small">{i18n(loc, "perm.hint")}</p>
                  </div>
                  <div
                    className="pref-cards"
                    role="group"
                    aria-label={i18n(loc, "perm.title")}
                  >
                    {FEATURE_PERM_KEYS.map((key) => {
                      const { title, desc } = featurePermLabel(key, loc);
                      const on = prefs.permissions[key];
                      return (
                        <label
                          key={key}
                          className={`pref-card${on ? " is-on" : ""}`}
                        >
            <input
                            type="checkbox"
                            checked={on}
                            onChange={(e) =>
                              updatePrefs({
                                permissions: {
                                  ...prefs.permissions,
                                  [key]: e.target.checked,
                                },
                              })
                            }
                          />
                          <span className="pref-card-text">
                            <strong>{title}</strong>
                            <span>{desc}</span>
                          </span>
                          <span className="pref-switch" aria-hidden />
          </label>
                      );
                    })}
                  </div>
                </section>
              )}

              {settingsPage === "platformPerms" && (
                <section className="settings-section">
                  <div className="settings-pane-intro">
                    <h4>{i18n(loc, "perm.platformSection")}</h4>
                    <p className="muted small">{i18n(loc, "perm.platformHint")}</p>
                  </div>

                  <div className="settings-card perm-platform-block">
                    <strong>{i18n(loc, "perm.gh.title")}</strong>
                    <div className="perm-platform-links" style={{ marginTop: "0.55rem" }}>
                      <button
                        type="button"
                        className="pane-btn pane-btn--soft pane-btn--sm"
                        onClick={() =>
                          void openUrl("https://github.com/settings/tokens")
                        }
                      >
                        {i18n(loc, "perm.gh.openTokens")}
            </button>
          </div>
                    <ol className="perm-platform-steps">
                      <li>{i18n(loc, "perm.gh.step1")}</li>
                      <li>{i18n(loc, "perm.gh.step2")}</li>
                      <li>{i18n(loc, "perm.gh.step3")}</li>
                    </ol>
        </div>

                  <div
                    className="settings-card perm-platform-block"
                    style={{ marginTop: "0.85rem" }}
                  >
                    <strong>{i18n(loc, "perm.ge.title")}</strong>
                    <div className="perm-platform-links" style={{ marginTop: "0.55rem" }}>
                      <button
                        type="button"
                        className="pane-btn pane-btn--soft pane-btn--sm"
                        onClick={() =>
                          void openUrl(
                            "https://gitee.com/profile/personal_access_tokens",
                          )
                        }
                      >
                        {i18n(loc, "perm.ge.openTokens")}
                      </button>
                    </div>
                    <ol className="perm-platform-steps">
                      <li>{i18n(loc, "perm.ge.step1")}</li>
                      <li>{i18n(loc, "perm.ge.step2")}</li>
                      <li>{i18n(loc, "perm.ge.step3")}</li>
                    </ol>
                  </div>
                </section>
              )}

              {settingsPage === "language" && (
                <SettingsLanguagePage
                  prefs={prefs}
                  locale={loc}
                  updatePrefs={updatePrefs}
                  setNotice={setNotice}
                />
              )}

              {settingsPage === "network" && (
                <SettingsNetworkPage
                  prefs={prefs}
                  locale={loc}
                  updatePrefs={updatePrefs}
                  setNotice={setNotice}
                  setError={setError}
                  busy={busy}
                />
              )}

              {settingsPage === "reset" && (
                <SettingsResetPage
                  locale={loc}
                  updatePrefs={updatePrefs}
                  setNotice={setNotice}
                  onDeleteData={async () => {
                    try {
                      await api.clearAppWallpaperFiles();
                    } catch {
                      /* ignore */
                    }
                    clearAllLocalAppData();
                    clearRepoCache();
                    setRecent(clearRecent());
                    setOpenRepos([]);
                    setCloneUrl("");
                    const next = {
                      ...DEFAULT_PREFS,
                      enabledLocales: [...DEFAULT_PREFS.enabledLocales],
                      permissions: { ...DEFAULT_PREFS.permissions },
                    };
                    savePrefs(next);
                    setPrefs(next);
                    applyPrefsToDocument(next);
                    void api.saveFeaturePermissions(next.permissions).catch(() => {});
                  }}
                />
              )}

              {settingsPage === "about" && (
                <SettingsAboutPage
                  locale={loc}
                  appVersion={appVersion}
                  updateRepoOwner={UPDATE_REPO_OWNER}
                  updateRepoName={UPDATE_REPO_NAME}
                  updateInfo={updateInfo}
                  updateBusy={updateBusy}
                  updateProgress={updateProgress}
                  busy={busy}
                  checkForUpdate={checkForUpdate}
                  downloadAndInstallUpdate={downloadAndInstallUpdate}
                  setNotice={setNotice}
                />
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
                  remotes={remotes}
                  initialName={identity.name}
                  initialEmail={identity.email}
                  initialRemote={remoteUrl}
                  initialClone={cloneUrl}
                  saveGlobally={saveGlobally}
                  busy={busy}
                  onSaveGloballyChange={setSaveGlobally}
                  onRemoveRemote={(name) => {
                    withConfirm(`删除远程「${name}」？`, () => {
                      void runAction(
                        () => api.removeRemote(repoPath!, name),
                        "正在删除远程…",
                      );
                    });
                  }}
                  onAddRemote={(name, url) => {
                    void runAction(
                      () => api.saveRemote(repoPath!, name, url),
                      "正在添加远程…",
                    );
                  }}
                  onDraftChange={onIdentityDraftChange}
                  onSave={saveIdentityAndRemote}
                />
              )}

        </div>
          </div>
        </div>
        {renderWallpaperEnginePicker()}
      </div>
    );
  }

  return (
    <>
      {renderFloatingToasts()}
      <WindowChrome
        overlay={Boolean(boot && wallpaperUrl)}
        version={appVersion}
        updateAvailable={Boolean(
          updateInfo?.updateAvailable &&
            updateInfo.latestVersion !== dismissedUpdateTag,
        )}
        updateBusy={updateBusy}
        onCheckUpdate={() => void checkForUpdate(false)}
        onUpdateClick={() => openSettings("about")}
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
      <div className={`app${entering ? " app-enter" : ""}`}>
      <header className="toolbar">
        <div className="toolbar-left">
          <button type="button" onClick={pickFolder} disabled={busy} title="打开其他项目文件夹">
            {i18n(prefs.locale || "zh-CN", "toolbar.open")}…
          </button>
          <button
            type="button"
            onClick={() => refresh(repoPath)}
            disabled={busy}
            title="重新读取仓库状态（F5 / Ctrl+R）"
          >
            {i18n(prefs.locale || "zh-CN", "toolbar.refresh")}
          </button>
          <button type="button" onClick={() => openSettings()} disabled={busy}>
            {i18n(prefs.locale || "zh-CN", "welcome.settings")}
          </button>
          <button type="button" onClick={() => setShowHelp(true)} disabled={busy}>
            {i18n(prefs.locale || "zh-CN", "welcome.help")}
          </button>
          <button
            type="button"
            onClick={() => openSettings("about")}
            disabled={busy}
            title={`关于青枝 v${appVersion}`}
          >
            {i18n(prefs.locale || "zh-CN", "nav.about")}
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
          <div className="sync-actions" role="group" aria-label="同步">
            <button
              type="button"
              className="tool-btn"
              disabled={busy}
              onClick={() => void cloneRepo()}
              title="克隆到空文件夹"
            >
            克隆
          </button>

            <div
              className={`tool-split${pullMenuOpen ? " is-open" : ""}${
                behind > 0 ? " is-emphasis" : ""
              }`}
            >
          <button
            type="button"
                className="tool-split-main"
            disabled={busy}
                title={
                  pullMode === "rebase"
                    ? "变基拉取（Ctrl+Shift+L）"
                    : "拉取并合并到当前分支（Ctrl+Shift+L）"
                }
                onClick={() => {
                  setPullMenuOpen(false);
                  void runAction(
                    () => api.pull(repoPath, false, pullMode === "rebase"),
                    pullMode === "rebase" ? "正在变基拉取…" : "正在拉取…",
                  );
                }}
              >
                {busy
                  ? "…"
                  : behind > 0
                    ? `拉取 ↓${behind}`
                    : pullMode === "rebase"
                      ? "变基拉取"
                      : "拉取"}
          </button>
          <button
            type="button"
                className="tool-split-caret"
            disabled={busy}
                title="拉取 / 获取选项"
                aria-expanded={pullMenuOpen}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  setPushMenuOpen(false);
                  setPullMenuOpen((v) => !v);
                }}
              >
                ▾
          </button>
              {pullMenuOpen && (
                <div
                  className="push-menu"
                  role="menu"
                  onMouseDown={(event) => event.stopPropagation()}
                >
          <button
            type="button"
                    role="menuitem"
                    className={pullMode === "merge" ? "is-active" : undefined}
            disabled={busy}
                    onClick={() => {
                      setPullMode("merge");
                      setPullMenuOpen(false);
                      void runAction(
                        () => api.pull(repoPath, false, false),
                        "正在拉取…",
                      );
                    }}
                  >
                    <strong>拉取（合并）</strong>
                    <span>下载并合并进当前分支</span>
          </button>
                  <button
                    type="button"
                    role="menuitem"
                    className={pullMode === "rebase" ? "is-active" : undefined}
                    disabled={busy}
                    onClick={() => {
                      setPullMode("rebase");
                      setPullMenuOpen(false);
                      void runAction(
                        () => api.pull(repoPath, false, true),
                        "正在变基拉取…",
                      );
                    }}
                  >
                    <strong>拉取（变基）</strong>
                    <span>把本地提交接到远程之后</span>
                  </button>
                  <div className="push-menu-sep" role="separator" />
                  <button
                    type="button"
                    role="menuitem"
                    disabled={busy}
                    onClick={() => {
                      setPullMenuOpen(false);
                      void runAction(
                        () => api.fetch(repoPath, defaultRemoteName),
                        defaultRemoteName
                          ? `正在获取 ${defaultRemoteName}…`
                          : "正在获取…",
                      );
                    }}
                  >
                    <strong>仅获取</strong>
                    <span>只更新远程信息，不改本地文件</span>
                  </button>
                  {remotes.length > 1 && (
                    <button
                      type="button"
                      role="menuitem"
                      disabled={busy}
                      onClick={() => {
                        setPullMenuOpen(false);
                        void runAction(
                          () => api.fetch(repoPath, "all"),
                          "正在获取全部远程…",
                        );
                      }}
                    >
                      <strong>获取全部远程</strong>
                      <span>fetch --all --prune</span>
                    </button>
                  )}
                  {remotes.map((r) => (
                    <button
                      key={`fetch-${r.name}`}
                      type="button"
                      role="menuitem"
                      disabled={busy}
                      onClick={() => {
                        setPullMenuOpen(false);
                        void runAction(
                          () => api.fetch(repoPath, r.name),
                          `正在获取 ${r.name}…`,
                        );
                      }}
                    >
                      <strong>获取 {r.name}</strong>
                      <span className="muted small">{r.url}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div
              className={`tool-split${pushMenuOpen ? " is-open" : ""}${
                ahead > 0 && behind === 0 ? " is-emphasis" : ""
              }`}
            >
              <button
                type="button"
                className="tool-split-main"
                disabled={busy}
                title={
                  pushMode === "mirror" && mirrorButtonLabel
                    ? prefs.mirrorSyncMethod === "actions" &&
                      mirrorDirection === "github-to-gitee"
                      ? `${mirrorButtonLabel}：推送 GitHub，由 Actions 同步 Gitee（Ctrl+Shift+P）`
                      : prefs.mirrorSyncMethod === "actions" &&
                          mirrorDirection === "gitee-to-github"
                        ? `${mirrorButtonLabel}：推送 Gitee，再触发 Actions 同步 GitHub（Ctrl+Shift+P）`
                        : `${mirrorButtonLabel}：按设置方向本机依次推送（Ctrl+Shift+P）`
                    : "推送到远程（Ctrl+Shift+P）"
                }
                onClick={() => {
                  setPushMenuOpen(false);
                  if (pushMode === "mirror") {
                    void runMirrorPush();
                    return;
                  }
                  if (!ensureFeature("push")) return;
                  if (!ensureLoggedInForPush(activePushRemote)) return;
                  void runAction(
                    () => api.push(repoPath, false, null, activePushRemote),
                    activePushRemote &&
                      activePushRemote !== defaultRemoteName
                      ? `正在推送到 ${activePushRemote}…`
                      : "正在推送…",
                  );
                }}
              >
                {busy
                  ? "…"
                  : pushMode === "mirror" && mirrorButtonLabel
                    ? ahead > 0
                      ? `${mirrorButtonLabel} ↑${ahead}`
                      : mirrorButtonLabel
                    : ahead > 0
                      ? activePushRemote &&
                        activePushRemote !== defaultRemoteName
                        ? `推送 ${activePushRemote} ↑${ahead}`
                        : `推送 ↑${ahead}`
                      : activePushRemote &&
                          activePushRemote !== defaultRemoteName
                        ? `推送 ${activePushRemote}`
                        : "推送"}
              </button>
              <button
                type="button"
                className="tool-split-caret"
                disabled={busy}
                title="推送选项"
                aria-expanded={pushMenuOpen}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  setPullMenuOpen(false);
                  setPushMenuOpen((v) => !v);
                }}
              >
                ▾
              </button>
              {pushMenuOpen && (
                <div
                  className="push-menu"
                  role="menu"
                  onMouseDown={(event) => event.stopPropagation()}
                >
                  {remotes.map((r) => {
                    const isDefault = r.name === defaultRemoteName;
                    const isActive =
                      pushMode === "direct" &&
                      (pushRemote === r.name ||
                        (!pushRemote && isDefault));
                    return (
                      <button
                        key={`push-remote-${r.name}`}
                        type="button"
                        role="menuitem"
                        className={isActive ? "is-active" : undefined}
                        disabled={busy}
                        onClick={() => {
                          setPushMode("direct");
                          setPushRemote(isDefault ? null : r.name);
                          setPushMenuOpen(false);
                          if (!ensureFeature("push")) return;
                          if (!ensureLoggedInForPush(r.name)) return;
                          void runAction(
                            () =>
                              api.push(
                                repoPath,
                                false,
                                null,
                                isDefault ? null : r.name,
                              ),
                            `正在推送到 ${r.name}…`,
                          );
                        }}
                      >
                        <strong>{remotePushLabel(r.name, r.url)}</strong>
                        <span className="muted small">
                          {r.name}
                          {r.url ? ` · ${r.url}` : ""}
                          {isDefault ? " · 默认" : ""}
                        </span>
                      </button>
                    );
                  })}
                  {mirrorMenuLabel && (
                    <button
                      type="button"
                      role="menuitem"
                      className={
                        pushMode === "mirror" ? "is-active" : undefined
                      }
                      disabled={busy}
                      onClick={() => {
                        setPushMode("mirror");
                        setPushMenuOpen(false);
                        void runMirrorPush();
                      }}
                    >
                      <strong>{mirrorMenuLabel}</strong>
                      <span>
                        {prefs.mirrorSyncMethod === "actions" &&
                        mirrorDirection === "github-to-gitee"
                          ? "先推 GitHub，由 Actions 自动同步到 Gitee"
                          : prefs.mirrorSyncMethod === "actions" &&
                              mirrorDirection === "gitee-to-github"
                            ? "先推 Gitee，再触发 Actions 同步 GitHub"
                            : mirrorDirection === "github-to-gitee"
                              ? "本机：GitHub → Gitee（设置可改方向）"
                              : "本机：Gitee → GitHub（设置可改方向）"}
                      </span>
                    </button>
                  )}
                  <div className="push-menu-sep" role="separator" />
                  <button
                    type="button"
                    role="menuitem"
                    className="is-danger"
                    disabled={busy}
                    onClick={() => {
                      setPushMenuOpen(false);
                      if (!ensureLoggedInForPush(activePushRemote)) return;
                      withConfirm(
                        "强制推送会覆盖远程同名分支上的提交，确定继续？",
                        () => {
                          void runAction(
                            () =>
                              api.push(
                                repoPath,
                                true,
                                null,
                                activePushRemote,
                              ),
                            "正在强制推送…",
                          );
                        },
                        {
                          title: "强制推送",
                          danger: true,
                          confirmLabel: "强制推送",
                        },
                      );
                    }}
                  >
                    <strong>强制推送</strong>
                    <span>
                      覆盖
                      {activePushRemote ? ` ${activePushRemote}` : "远程"}
                    </span>
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      <div
        className={`sync-progress${
          syncProgress
            ? ""
            : busy
              ? " is-indeterminate"
              : " is-idle"
        }`}
        role="status"
        aria-live="polite"
        aria-hidden={!busy && !syncProgress}
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
      </div>

      {sessionWarnings.length > 0 && !error && (
        <div className="hint-box auth-warn-strip">
          {sessionWarnings.join("、")} 登录已失效。
          <button type="button" className="linkish" onClick={() => openSettingsAuth()}>
            重新登录
          </button>
        </div>
      )}
      {((updateInfo?.updateAvailable &&
        updateInfo.tagName !== dismissedUpdateTag) ||
        updateProgress) && (
        <div className="update-banner" role="status">
          <div className="update-banner-text">
            {updateProgress
              ? updateProgress.label
              : (
                <>
                  发现新版本 <strong>v{updateInfo!.latestVersion}</strong>
                  （当前 v{updateInfo!.currentVersion}）
                </>
              )}
          </div>
          <div className="update-banner-actions">
            <button
              type="button"
              className="primary"
              disabled={updateBusy || busy}
              onClick={() => void downloadAndInstallUpdate()}
            >
              {updateBusy ? "下载中…" : "下载并安装"}
            </button>
            <button type="button" onClick={() => openSettings("about")} disabled={busy}>
              详情
            </button>
            {!updateBusy && updateInfo && (
              <button
                type="button"
                className="linkish"
                onClick={() => setDismissedUpdateTag(updateInfo.tagName)}
              >
                稍后
              </button>
            )}
          </div>
          {updateProgress && (
            <div className="about-progress update-banner-progress">
              <div className="about-progress-head">
                <span>下载进度</span>
                <span>{updateProgress.percent}%</span>
              </div>
              <div className="about-progress-bar">
                <i style={{ width: `${updateProgress.percent}%` }} />
              </div>
            </div>
          )}
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
          还没有远程地址。可在设置里填写，或
          <button
            type="button"
            className="linkish"
            onClick={() => {
              if (!ensureFeature("publishRemote")) return;
              const ghOk = Boolean(accounts?.github.loggedIn);
              const geOk = Boolean(accounts?.gitee.loggedIn);
              if (!ghOk && !geOk) {
                promptPlatformLogin("github", "创建远程仓库");
                return;
              }
              const name =
                repoPath?.split(/[/\\]/).filter(Boolean).pop()?.trim() ||
                "repo";
              setPublishDraft({
                name,
                toGithub: ghOk,
                toGitee: geOk,
                privateRepo: false,
              });
              setPublishDialog({ path: repoPath!, name });
            }}
          >
            创建远程仓库
          </button>
          （GitHub / Gitee）。
        </div>
      )}
      {status?.operation === "merge" ||
      status?.operation === "cherry-pick" ||
      status?.operation === "rebase" ||
      status?.operation === "revert" ? (
        <div className="conflict-box">
          <div className="conflict-copy">
            <strong>
              {status.operation === "merge"
                ? "合并冲突"
                : status.operation === "rebase"
                  ? "变基冲突"
                  : status.operation === "revert"
                    ? "还原冲突"
                    : "拣选冲突"}
              {conflictFiles.length > 0
                ? ` · ${conflictFiles.length} 个文件`
                : " · 可继续"}
            </strong>
            <span>
              {conflictFiles.length > 0
                ? "点文件打开差异，再用「打开冲突编辑器」处理；暂存后点「继续」。"
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
                      : status.operation === "revert"
                        ? "正在完成还原…"
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
                      : status.operation === "revert"
                        ? "放弃这次还原？"
                        : "放弃这次拣选？";
                withConfirm(label, () => {
                  void runAction(
                    () => api.abortOperation(repoPath),
                    status.operation === "merge"
                      ? "正在放弃合并…"
                      : status.operation === "rebase"
                        ? "正在放弃变基…"
                        : status.operation === "revert"
                          ? "正在放弃还原…"
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
      {/* about moved into settings */}
      {renderPublishDialog()}
      {renderSyncDialog()}
      {renderResetDialog()}
      {renderRenameDialog()}
      {renderCheckoutDialog()}
      {renderCloneDialog()}
      {renderUpstreamDialog()}
      {renderLargeCommitDialog()}
      {renderRebaseInteractiveDialog()}

      {renderRepoTabs()}

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
            onFileHistory={(path) => void loadFileHistory(path)}
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
            onIgnore={(paths) =>
              void runAction(
                () => api.addGitignore(repoPath, paths),
                "正在写入 .gitignore…",
              )
            }
            onFileHistory={(path) => void loadFileHistory(path)}
          />

          <SidebarSection
            title="分支"
            sectionId="branches"
            count={branches.length}
            stickyTop="0"
            defaultCollapsed
          >
            <ul className="branch-list">
              {branches.map((b) => (
                <li key={b.name} className={b.isCurrent ? "current" : ""}>
                  <button
                    type="button"
                    className="branch-main-btn"
                    disabled={busy || b.isCurrent}
                    onClick={() =>
                      runAction(() => api.branchCheckout(repoPath, b.name))
                    }
                  >
                    <span
                      className={`branch-dot${b.isCurrent ? " is-on" : ""}`}
                      aria-hidden
                    />
                    <span className="branch-name-block">
                      <span className="branch-name">{b.name}</span>
                    {b.upstream ? (
                        <span className="muted small branch-upstream">
                          →{" "}
                          {(() => {
                            const remoteName =
                              b.upstream.split("/")[0] || "";
                            const url =
                              remotes.find((r) => r.name === remoteName)
                                ?.url ?? "";
                            const platform = labelRemotePlatform(
                              remoteName,
                              url,
                            );
                            return `${platform} · ${b.upstream}`;
                          })()}
                        </span>
                    ) : null}
                    </span>
                  </button>
                  <span className="row-actions branch-row-actions">
                    <button
                      type="button"
                      disabled={busy}
                      title="重命名分支"
                      onClick={() =>
                        setRenameTarget({ oldName: b.name, value: b.name })
                      }
                    >
                      重命名
                    </button>
                    {remotes.length > 0 && (
                      <button
                        type="button"
                        disabled={busy}
                        title={
                          b.upstream
                            ? `当前上游：${b.upstream}（点击更改）`
                            : "设置上游跟踪分支"
                        }
                        onClick={() => {
                          const remote =
                            (b.upstream?.includes("/")
                              ? b.upstream.split("/")[0]
                              : null) ||
                            defaultRemoteName ||
                            remotes[0]!.name;
                          const remoteBranch =
                            (b.upstream?.includes("/")
                              ? b.upstream.slice(b.upstream.indexOf("/") + 1)
                              : null) || b.name;
                          setUpstreamTarget({
                            localBranch: b.name,
                            remote,
                            remoteBranch,
                          });
                        }}
                      >
                        {b.upstream ? "上游" : "设上游"}
                      </button>
                    )}
                  {!b.isCurrent && (
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
                                    {
                                      title: "强制删除分支",
                                      danger: true,
                                      confirmLabel: "强制删除",
                                    },
                                  );
                                  if (!force) return "已取消删除";
                                  return api.branchDelete(
                                    repoPath,
                                    b.name,
                                    true,
                                  );
                                }
                                throw e;
                              }
                            }, "正在删除分支…");
                          })
                        }
                      >
                        删除
                      </button>
                  )}
                  </span>
                </li>
              ))}
            </ul>
            <div className="branch-tools">
              <div className="branch-tool-row">
              <input
                value={newBranch}
                onChange={(e) => setNewBranch(e.target.value)}
                placeholder="新分支名"
                  aria-label="新分支名"
              />
              <button
                type="button"
                  className="primary"
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
                <button
                  type="button"
                  className="danger"
                  disabled={busy}
                  title="清理未跟踪文件（先预览）"
                  onClick={() => {
                    void runAction(async () => {
                      const preview = await api.cleanFiles(
                        repoPath,
                        true,
                        false,
                      );
                      const ok = await confirmAction(
                        preview.trim()
                          ? `将删除以下未跟踪文件：\n\n${preview}\n确定清理？`
                          : "没有可清理的未跟踪文件。",
                        {
                          title: "清理未跟踪文件",
                          danger: true,
                          confirmLabel: "清理",
                        },
                      );
                      if (
                        !ok ||
                        !preview.trim() ||
                        preview.includes("没有可清理")
                      ) {
                        return preview.includes("没有可清理")
                          ? preview
                          : "已取消清理";
                      }
                      return api.cleanFiles(repoPath, false, false);
                    }, "正在清理…");
                  }}
                >
                  清理
              </button>
            </div>
              <div className="branch-tool-row">
              <select
                value={mergeTarget}
                onChange={(e) => setMergeTarget(e.target.value)}
                disabled={busy}
                  aria-label="合并分支"
              >
                  <option value="">合并到当前…</option>
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
              <div className="branch-tool-row">
                <select
                  value={rebaseTarget}
                  onChange={(e) => setRebaseTarget(e.target.value)}
                  disabled={busy}
                  aria-label="变基目标"
                >
                  <option value="">变基到…</option>
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
                <button
                  type="button"
                  disabled={busy || !rebaseTarget}
                  title="调整提交顺序，并可 squash / fixup / drop"
                  onClick={() => {
                    void runAction(async () => {
                      const commits = await api.getRebaseTodo(
                        repoPath,
                        rebaseTarget,
                      );
                      if (commits.length === 0) {
                        throw new Error(
                          `相对「${rebaseTarget}」没有可回放的提交`,
                        );
                      }
                      setRebaseInteractive({
                        onto: rebaseTarget,
                        rows: commitsToRebaseRows(commits),
                      });
                      return `已加载 ${commits.length} 个提交`;
                    }, "正在准备交互变基…");
                  }}
                >
                  交互
                </button>
          </div>
            </div>
          </SidebarSection>

          <SidebarSection
            title="远程分支"
            sectionId="remote-branches"
            count={remoteBranches.length}
            stickyTop="0"
            defaultCollapsed
          >
            {remotes.length === 0 && remoteBranches.length === 0 ? null : (
              <div className="remote-branch-groups">
                {remoteBranchGroups.map((group) => (
                  <div
                    key={`remote-group:${group.remoteName}`}
                    className="remote-group"
                    data-remote={group.remoteName}
                    data-platform={group.platform}
                  >
                    <div className="remote-group-header">
                      <span
                        className={`remote-platform-badge ${platformBadgeClass(group.platform)}`}
                      >
                        {group.platform}
                      </span>
                      <span className="remote-group-meta">
                        <strong className="remote-group-name">
                          {group.remoteName}
                        </strong>
                        {group.host ? (
                          <span className="muted small remote-group-host">
                            {group.host}
                          </span>
                        ) : null}
                      </span>
                      <span className="muted small remote-group-count">
                        {group.items.length}
                      </span>
                    </div>
                    {group.items.length === 0 ? null : (
                      <ul className="branch-list remote-branch-list">
                        {group.items.map((rb) => (
                          <li key={`${group.remoteName}:${rb.name}:${rb.tip}`}>
                            <span className="remote-branch-name">
                              <span className="branch-name">
                                <span
                                  className={`remote-platform-badge inline ${platformBadgeClass(group.platform)}`}
                                >
                                  {group.platform}
                                </span>{" "}
                                {rb.branch}
                              </span>
                              <span className="muted small branch-upstream">
                                {rb.name}
                                {rb.tip ? ` · ${rb.tip}` : ""}
                              </span>
                            </span>
                            <span className="row-actions branch-row-actions">
                              <button
                                type="button"
                                disabled={busy}
                                title={
                                  rb.hasLocal
                                    ? `切换到本地分支「${rb.branch}」（已跟踪 ${group.platform} 的 ${rb.name}）`
                                    : `创建本地分支「${rb.branch}」，并跟踪 ${group.platform} 上的 ${rb.name}`
                                }
                                onClick={() =>
                                  void runAction(
                                    () =>
                                      api.remoteBranchCheckout(
                                        repoPath,
                                        rb.name,
                                      ),
                                    rb.hasLocal
                                      ? "正在切换到本地跟踪分支…"
                                      : "正在创建本地跟踪分支…",
                                  )
                                }
                              >
                                {rb.hasLocal ? "切到本地" : "拉到本地"}
                              </button>
                              <button
                                type="button"
                                className="danger"
                                disabled={busy}
                                title={`从 ${group.platform}（${group.remoteName}）删除远程分支`}
                                onClick={() =>
                                  withConfirm(
                                    `从 ${group.platform}（远程名 ${group.remoteName}）删除分支「${rb.branch}」？\n完整名：${rb.name}\n本地同名分支不会被删。`,
                                    () => {
                                      void runAction(
                                        () =>
                                          api.remoteBranchDelete(
                                            repoPath,
                                            rb.name,
                                          ),
                                        `正在从 ${group.platform} 删除远程分支…`,
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
                ))}
              </div>
            )}
          </SidebarSection>
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
          overviewStatus={status}
          overviewBranches={branches}
          overviewPlatform={overviewPlatform}
          onOverviewPlatform={setOverviewPlatform}
          overviewGithubOwner={releaseTarget.owner}
          overviewGithubRepo={releaseTarget.repo}
          overviewGiteeOwner={releaseGiteeTarget.owner}
          overviewGiteeRepo={releaseGiteeTarget.repo}
          overviewRepoPath={repoPath}
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
          onDiscardHunk={(patch) =>
            withConfirm(
              "放弃工作区中这一块改动？不可恢复。",
              () => {
                void runAction(
                  () => api.applyWorkdirHunk(repoPath, patch, true),
                  "正在放弃此块…",
                );
              },
              { title: "放弃此块", danger: true, confirmLabel: "放弃" },
            )
          }
          onBlame={
            selected
              ? () => {
                  void runAction(async () => {
                    const text = await api.getFileBlame(
                      repoPath,
                      selected.path,
                    );
                    setBlameText(text);
                    setPane("diff");
                    return "已加载文件追溯";
                  }, "正在追溯…");
                }
              : undefined
          }
          blameText={blameText}
          onClearBlame={() => setBlameText(null)}
          fileConflicted={Boolean(
            selected &&
              status?.changes.find((c) => c.path === selected.path)?.conflicted,
          )}
          conflictContent={conflictContent}
          conflictLoading={conflictLoading}
          onOpenConflict={
            selected
              ? () => {
                  void (async () => {
                    setConflictLoading(true);
                    setBlameText(null);
                    setPane("diff");
                    try {
                      const text = await api.readRepoFile(
                        repoPath,
                        selected.path,
                      );
                      setConflictContent(text);
                    } catch (e) {
                      setConflictContent(null);
                      setError(failureLine(e));
                    } finally {
                      setConflictLoading(false);
                    }
                  })();
                }
              : undefined
          }
          onCloseConflict={() => setConflictContent(null)}
          onSaveConflict={(content, stage) => {
            if (!selected) return;
            void runAction(async () => {
              await api.writeRepoFile(repoPath, selected.path, content);
              if (stage) {
                await api.stageFiles(repoPath, [selected.path]);
              }
              setConflictContent(null);
              return stage ? "已保存并暂存冲突文件" : "已保存冲突文件";
            }, stage ? "正在保存并暂存…" : "正在保存…");
          }}
          showReflog={showReflog}
          reflogEntries={reflogEntries}
          onToggleReflog={() => {
            if (showReflog) {
              setShowReflog(false);
              return;
            }
            void runAction(async () => {
              const entries = await api.getReflog(repoPath);
              setReflogEntries(entries);
              setShowReflog(true);
              setPane("history");
              return "已加载操作记录";
            }, "正在加载操作记录…");
          }}
          onSelectReflog={(entry) => {
            setSelectedHash(entry.hash);
            setShowReflog(false);
          }}
          showCommitGraph={prefs.showCommitGraph}
          diffViewMode={prefs.diffViewMode}
          onDiffViewMode={(mode) => updatePrefs({ diffViewMode: mode })}
          commits={fileHistoryCommits ?? commits}
          historyScope={fileHistoryPath}
          onClearHistoryScope={() => {
            setFileHistoryPath(null);
            setFileHistoryCommits(null);
          }}
          selectedHash={selectedHash}
          commitPatch={commitPatch}
          patchLoading={patchLoading}
          onSelectCommit={setSelectedHash}
          onCherryPick={(hash) => {
            withConfirm(`把提交 ${hash.slice(0, 7)} 拣选到当前分支？`, () => {
              void runAction(() => api.cherryPick(repoPath, hash), "正在拣选…");
            });
          }}
          onRevert={(hash) => {
            withConfirm(
              `还原提交 ${hash.slice(0, 7)}？会生成一个反向提交。`,
              () => {
                void runAction(
                  () => api.revertCommit(repoPath, hash),
                  "正在还原…",
                );
              },
            );
          }}
          onCheckoutCommit={(commit) =>
            setCheckoutTarget({ commit, branchName: "" })
          }
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
          onApplyStash={(index) =>
            runAction(() => api.applyStash(repoPath, index), "正在应用储藏…")
          }
          onShowStash={(index) => {
            void runAction(async () => {
              const text = await api.showStash(repoPath, index);
              setStashPreview(text);
              setPane("stash");
              return "已加载储藏内容";
            }, "正在查看储藏…");
          }}
          onDropStash={(index) => {
            withConfirm(`丢弃 stash@{${index}}？`, () => {
              void runAction(() => api.dropStash(repoPath, index));
            });
          }}
          stashPreview={stashPreview}
          onClearStashPreview={() => setStashPreview(null)}
          tags={tags}
          tagName={tagName}
          onTagName={setTagName}
          tagMessage={tagMessage}
          onTagMessage={setTagMessage}
          onCreateTag={() =>
            runAction(async () => {
              await api.tagCreate(
                repoPath,
                tagName.trim(),
                tagMessage.trim() || null,
              );
              setTagName("");
              setTagMessage("");
            })
          }
          compareLeft={compareLeft}
          compareRight={compareRight}
          onCompareLeft={setCompareLeft}
          onCompareRight={setCompareRight}
          onCompare={() => {
            void runAction(async () => {
              const text = await api.compareRefs(
                repoPath,
                compareLeft.trim(),
                compareRight.trim(),
              );
              setCompareResult(text);
              return "比较完成";
            }, "正在比较…");
          }}
          compareResult={compareResult}
          onPushTag={(name) => {
            if (!ensureFeature("push")) return;
            void runAction(() => api.tagPush(repoPath, name), "正在推送标签…");
          }}
          onPushAllTags={() => {
            if (!ensureFeature("push")) return;
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
            if (!ensureFeature("push")) return;
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
          terminalWallpaperUrl={terminalWallpaperUrl}
          terminalWallpaperKind={prefs.terminalWallpaperKind}
          terminalWallpaperScrim={prefs.terminalWallpaperScrim}
          locale={prefs.locale || "zh-CN"}
          releaseOwner={releaseTarget.owner}
          releaseRepo={releaseTarget.repo}
          releaseGiteeOwner={releaseGiteeTarget.owner}
          releaseGiteeRepo={releaseGiteeTarget.repo}
          releasePlatform={releasePlatform}
          onReleasePlatform={setReleasePlatform}
          giteeLoggedIn={Boolean(accounts?.gitee.loggedIn)}
          releaseDefaultTag=""
          githubLoggedIn={Boolean(accounts?.github.loggedIn)}
          updateBusy={updateBusy}
          onUpdateBusy={(busy) => {
            setUpdateBusy(busy);
            if (!busy) setWikiProgress(null);
          }}
          wikiProgress={wikiProgress}
          onNotice={setNotice}
          onError={setError}
          onOpenAuth={(provider) =>
            promptPlatformLogin(
              provider,
              provider === "gitee" ? "使用 Gitee" : "使用 GitHub",
            )
          }
          releaseAllowed={prefs.permissions.release}
          wikiAllowed={prefs.permissions.wiki}
          onFeatureDenied={(feature) => {
            void ensureFeature(feature);
          }}
          onConfigureReleaseRepo={() => openSettings("behavior")}
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
