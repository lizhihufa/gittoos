const KEY = "gittool.recentRepos";

export function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string").slice(0, 12);
  } catch {
    return [];
  }
}

function save(paths: string[]): string[] {
  const next = paths.slice(0, 12);
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}

export function rememberRecent(path: string): string[] {
  return save([path, ...loadRecent().filter((p) => p !== path)]);
}

export function removeRecent(path: string): string[] {
  return save(loadRecent().filter((p) => p !== path));
}

export function clearRecent(): string[] {
  return save([]);
}

export function pruneRecent(keep: string[]): string[] {
  const allow = new Set(keep);
  return save(loadRecent().filter((p) => allow.has(p)));
}
