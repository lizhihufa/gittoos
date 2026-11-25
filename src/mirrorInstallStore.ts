/** Persisted list of Actions mirror installations. */

export type MirrorConnection = "ok" | "warn" | "error" | "unknown";

export type MirrorInstallRecord = {
  id: string;
  repoPath: string;
  githubOwner: string;
  githubRepo: string;
  giteeFullName: string;
  giteeUrl: string;
  installedAt: number;
  connection: MirrorConnection;
  connectionDetail: string;
  lastCheckedAt: number | null;
};

const KEY = "qingzhi.actionsMirrorInstalls";

export function loadMirrorInstalls(): MirrorInstallRecord[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x) => x && typeof x === "object" && typeof x.id === "string")
      .map((x) => ({
        id: String(x.id),
        repoPath: String(x.repoPath ?? ""),
        githubOwner: String(x.githubOwner ?? ""),
        githubRepo: String(x.githubRepo ?? ""),
        giteeFullName: String(x.giteeFullName ?? ""),
        giteeUrl: String(x.giteeUrl ?? ""),
        installedAt: Number(x.installedAt) || Date.now(),
        connection:
          x.connection === "ok" ||
          x.connection === "warn" ||
          x.connection === "error"
            ? x.connection
            : ("unknown" as MirrorConnection),
        connectionDetail: String(x.connectionDetail ?? ""),
        lastCheckedAt:
          typeof x.lastCheckedAt === "number" ? x.lastCheckedAt : null,
      }));
  } catch {
    return [];
  }
}

export function saveMirrorInstalls(list: MirrorInstallRecord[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

export function upsertMirrorInstall(
  list: MirrorInstallRecord[],
  next: MirrorInstallRecord,
): MirrorInstallRecord[] {
  const i = list.findIndex((x) => x.id === next.id);
  if (i >= 0) {
    const copy = [...list];
    copy[i] = { ...copy[i], ...next };
    return copy;
  }
  return [next, ...list];
}

export function removeMirrorInstall(
  list: MirrorInstallRecord[],
  id: string,
): MirrorInstallRecord[] {
  return list.filter((x) => x.id !== id);
}

export function mirrorInstallId(owner: string, repo: string): string {
  return `${owner.trim()}/${repo.trim()}`.toLowerCase();
}
