import {
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { api } from "../api";
import { failureLine } from "../statusMessage";
import type {
  AuthAccounts,
  AuthProvider,
  GitInfo,
  UpdateInfo,
} from "../types";

type ProviderDraft = {
  token: string;
  clientId: string;
  clientSecret: string;
  showToken: boolean;
  showOauth: boolean;
};

type SetNotice = (text: string | null, sticky?: boolean) => void;

export const UPDATE_REPO_OWNER = "lizhihufa";
export const UPDATE_REPO_NAME = "gittoos";

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/**
 * Serial boot: Git info → ensure creds → accounts → silent update check.
 * Avoids parallel IPC that races with HMR / custom protocol.
 */
export function useAuthBootstrap(opts: {
  appVersion: string;
  setGitInfo: (info: GitInfo) => void;
  setTerminal: Dispatch<SetStateAction<string>>;
  setError: (text: string | null) => void;
  setNotice: SetNotice;
  setUpdateInfo: (info: UpdateInfo | null) => void;
  setUpdateBusy: (busy: boolean) => void;
  setSessionWarnings: (v: string[]) => void;
  setDrafts: Dispatch<SetStateAction<Record<AuthProvider, ProviderDraft>>>;
  setAddingAccount: (v: boolean) => void;
}) {
  const {
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
  } = opts;

  const [accounts, setAccounts] = useState<AuthAccounts | null>(null);
  const [bootReady, setBootReady] = useState(false);

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
      const msg = String(e);
      if (/Failed to fetch|IPC custom protocol|Couldn't find callback/i.test(msg)) {
        return;
      }
      setError(failureLine(e));
    }
  }, [setAddingAccount, setDrafts, setError, setSessionWarnings]);

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
        setUpdateInfo(info);
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
    [appVersion, setError, setNotice, setUpdateBusy, setUpdateInfo],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setTerminal((prev) => `${prev}# 正在准备 Git…\n`);
      try {
        const info = await api.getGitInfo();
        if (cancelled) return;
        setGitInfo(info);
        setTerminal((prev) => `${prev}# ${info.version}\n# ${info.path}\n`);
      } catch (e) {
        if (!cancelled) setError(failureLine(e));
      }

      // Let first paint / IPC settle before auth traffic.
      await sleep(400);
      if (cancelled) return;

      try {
        await api.authEnsureCredentials();
      } catch {
        /* ignore transient IPC */
      }
      if (cancelled) return;
      await refreshAccounts();
      if (cancelled) return;
      setBootReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshAccounts, setError, setGitInfo, setTerminal]);

  useEffect(() => {
    if (!bootReady || !appVersion || appVersion === "…") return;
    const timer = window.setTimeout(() => {
      void checkForUpdate(true);
    }, 800);
    return () => window.clearTimeout(timer);
  }, [bootReady, appVersion, checkForUpdate]);

  return {
    accounts,
    setAccounts,
    refreshAccounts,
    checkForUpdate,
  };
}
