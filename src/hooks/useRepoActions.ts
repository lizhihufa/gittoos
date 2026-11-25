import {
  startTransition,
  useCallback,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { api } from "../api";
import { saveRepoCache } from "../repoCache";
import {
  failureLine,
  isAuthFailure,
  successLine,
  syncConflictKind,
  type SyncConflictKind,
} from "../statusMessage";
import type { CommitInfo, RepoCore, StashInfo, TagInfo } from "../types";

const ACTION_WATCHDOG_MS = 90_000;

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      window.setTimeout(resolve, 0);
    });
  });
}

function isNetworkLabel(label?: string) {
  return /拉取|推送|获取|克隆|同步/.test(label ?? "");
}

type SetNotice = (text: string | null, sticky?: boolean) => void;

export function useRepoActions(opts: {
  repoPath: string | null;
  repoPathRef: MutableRefObject<string | null>;
  busyRef: MutableRefObject<boolean>;
  syncProgressActive: MutableRefObject<boolean>;
  applyCore: (core: RepoCore) => void;
  refresh: (path: string, opts?: { background?: boolean }) => Promise<void>;
  setBusy: (busy: boolean) => void;
  setError: (text: string | null) => void;
  setAuthHint: (v: boolean) => void;
  setNotice: SetNotice;
  setSyncProgress: Dispatch<
    SetStateAction<{
      label: string;
      percent: number;
      detail: string;
    } | null>
  >;
  setSyncDialog: (kind: SyncConflictKind | null) => void;
  setCommits: Dispatch<SetStateAction<CommitInfo[]>>;
  setStashes: Dispatch<SetStateAction<StashInfo[]>>;
  setTags: Dispatch<SetStateAction<TagInfo[]>>;
}) {
  const {
    repoPath,
    repoPathRef,
    busyRef,
    syncProgressActive,
    applyCore,
    refresh,
    setBusy,
    setError,
    setAuthHint,
    setNotice,
    setSyncProgress,
    setSyncDialog,
    setCommits,
    setStashes,
    setTags,
  } = opts;

  const runAction = useCallback(
    async (
      action: () => Promise<unknown>,
      label?: string,
    ): Promise<boolean> => {
      if (!repoPath || busyRef.current) return false;
      const path = repoPath;
      const network = isNetworkLabel(label);
      busyRef.current = true;
      setBusy(true);
      setError(null);
      setAuthHint(false);
      // Network ops: progress bar only (no toast spam). Local ops: short toast.
      if (network) {
        setNotice(null);
        syncProgressActive.current = true;
        setSyncProgress({
          label: label ?? "同步中",
          percent: 3,
          detail: "准备中",
        });
      } else {
        setNotice(label ?? "正在执行…");
        syncProgressActive.current = false;
        setSyncProgress(null);
      }
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
          return false;
        }
        setSyncDialog(null);
        {
          const text = successLine(label, result);
          const stickyPush =
            Boolean(label && /推送/.test(label)) ||
            /推送完成|已强制推送|已推送/.test(text);
          setNotice(text, stickyPush);
        }
        if (network) {
          setSyncProgress((prev) =>
            prev ? { ...prev, percent: 100, detail: "完成" } : prev,
          );
        }
        let coreForCache: RepoCore | null = null;
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
        return true;
      } catch (e) {
        window.clearTimeout(watchdog);
        if (timedOut) {
          void refresh(path, { background: true }).catch(() => {});
          return false;
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
            /* keep dialog */
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
        return false;
      }
    },
    [
      applyCore,
      busyRef,
      refresh,
      repoPath,
      repoPathRef,
      setAuthHint,
      setBusy,
      setCommits,
      setError,
      setNotice,
      setStashes,
      setSyncDialog,
      setSyncProgress,
      setTags,
      syncProgressActive,
    ],
  );

  return { runAction };
}
