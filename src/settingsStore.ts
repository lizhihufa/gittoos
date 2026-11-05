const CLONE_KEY = "gittool.cloneUrl";
const PREFS_KEY = "gittool.prefs";
const TABS_KEY = "gittool.openRepos";

export type ThemeId = "light" | "dark" | "forest";
export type FontSizeId = "normal" | "large";
export type WallpaperKind = "none" | "image" | "video";

export interface AppPrefs {
  theme: ThemeId;
  fontSize: FontSizeId;
  rememberRecent: boolean;
  showCommitGraph: boolean;
  /** Use last-open cache to enter the repo UI faster. */
  useRepoCache: boolean;
  /** Absolute path to imported wallpaper file in app data. */
  wallpaperPath: string;
  wallpaperKind: WallpaperKind;
}

const DEFAULT_PREFS: AppPrefs = {
  theme: "light",
  fontSize: "normal",
  rememberRecent: true,
  showCommitGraph: true,
  useRepoCache: true,
  wallpaperPath: "",
  wallpaperKind: "none",
};

export function loadCloneUrl(): string {
  try {
    return localStorage.getItem(CLONE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveCloneUrl(url: string) {
  try {
    localStorage.setItem(CLONE_KEY, url);
  } catch {
    // ignore quota / private mode
  }
}

export function loadPrefs(): AppPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw) as Partial<AppPrefs>;
    const kind =
      parsed.wallpaperKind === "image" || parsed.wallpaperKind === "video"
        ? parsed.wallpaperKind
        : "none";
    return {
      theme:
        parsed.theme === "dark" || parsed.theme === "forest"
          ? parsed.theme
          : "light",
      fontSize: parsed.fontSize === "large" ? "large" : "normal",
      rememberRecent: parsed.rememberRecent !== false,
      showCommitGraph: parsed.showCommitGraph !== false,
      useRepoCache: parsed.useRepoCache !== false,
      wallpaperPath:
        typeof parsed.wallpaperPath === "string" ? parsed.wallpaperPath : "",
      wallpaperKind: kind,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(prefs: AppPrefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // ignore
  }
}

export function applyPrefsToDocument(prefs: AppPrefs) {
  document.documentElement.dataset.theme = prefs.theme;
  document.documentElement.dataset.fontSize = prefs.fontSize;
}

export function loadOpenRepos(): string[] {
  try {
    const raw = localStorage.getItem(TABS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string").slice(0, 12);
  } catch {
    return [];
  }
}

export function saveOpenRepos(paths: string[]) {
  try {
    localStorage.setItem(TABS_KEY, JSON.stringify(paths.slice(0, 12)));
  } catch {
    // ignore
  }
}
