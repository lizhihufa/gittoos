import type { RepoCore, RepoExtras } from "./types";

const PREFIX = "gittool.repoCache:";
const INDEX_KEY = "gittool.repoCacheIndex";
const MAX_ENTRIES = 8;
const MAX_COMMITS = 40;

export interface RepoCacheEntry {
  path: string;
  savedAt: number;
  core: RepoCore;
  extras?: RepoExtras;
}

function cacheKey(path: string): string {
  return `${PREFIX}${path}`;
}

function loadIndex(): string[] {
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

function saveIndex(paths: string[]) {
  localStorage.setItem(INDEX_KEY, JSON.stringify(paths.slice(0, MAX_ENTRIES)));
}

export function loadRepoCache(path: string): RepoCacheEntry | null {
  try {
    const raw = localStorage.getItem(cacheKey(path));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RepoCacheEntry;
    if (!parsed?.core?.status || parsed.path !== path) return null;
    // Treat cache older than 7 days as missing.
    if (Date.now() - parsed.savedAt > 7 * 24 * 60 * 60 * 1000) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveRepoCache(
  path: string,
  core: RepoCore,
  extras?: RepoExtras,
): void {
  try {
    const entry: RepoCacheEntry = {
      path,
      savedAt: Date.now(),
      core,
      extras: extras
        ? {
            ...extras,
            commits: extras.commits.slice(0, MAX_COMMITS),
          }
        : undefined,
    };
    const text = JSON.stringify(entry);
    // Skip oversized payloads (localStorage quota).
    if (text.length > 1_800_000) {
      const slim: RepoCacheEntry = {
        path,
        savedAt: entry.savedAt,
        core,
      };
      localStorage.setItem(cacheKey(path), JSON.stringify(slim));
    } else {
      localStorage.setItem(cacheKey(path), text);
    }
    const index = [path, ...loadIndex().filter((p) => p !== path)].slice(
      0,
      MAX_ENTRIES,
    );
    // Drop overflow entries.
    const prev = loadIndex();
    for (const old of prev) {
      if (!index.includes(old)) {
        localStorage.removeItem(cacheKey(old));
      }
    }
    saveIndex(index);
  } catch {
    // Quota or private mode — ignore.
  }
}

export function clearRepoCache(path?: string) {
  try {
    if (path) {
      localStorage.removeItem(cacheKey(path));
      saveIndex(loadIndex().filter((p) => p !== path));
      return;
    }
    for (const p of loadIndex()) {
      localStorage.removeItem(cacheKey(p));
    }
    localStorage.removeItem(INDEX_KEY);
  } catch {
    // ignore
  }
}
