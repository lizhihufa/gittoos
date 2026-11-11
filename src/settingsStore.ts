const CLONE_KEY = "gittool.cloneUrl";
const PREFS_KEY = "gittool.prefs";
const TABS_KEY = "gittool.openRepos";

export type ThemeId =
  | "light"
  | "dark"
  | "forest"
  | "nord"
  | "solar"
  | "tokyo"
  | "mocha";
export type FontSizeId = "normal" | "large";
export type WallpaperKind = "none" | "image" | "video";
export type ColorScheme = "light" | "dark";

export const THEME_OPTIONS: {
  id: ThemeId;
  label: string;
  scheme: ColorScheme;
}[] = [
  { id: "light", label: "暖纸浅色", scheme: "light" },
  { id: "dark", label: "墨蓝深色", scheme: "dark" },
  { id: "forest", label: "青枝绿", scheme: "light" },
  { id: "nord", label: "Nord 极光", scheme: "dark" },
  { id: "solar", label: "Solarized 日光", scheme: "light" },
  { id: "tokyo", label: "Tokyo Night", scheme: "dark" },
  { id: "mocha", label: "Catppuccin 摩卡", scheme: "dark" },
];

const THEME_IDS = new Set<string>(THEME_OPTIONS.map((t) => t.id));

export function themeScheme(theme: ThemeId): ColorScheme {
  return THEME_OPTIONS.find((t) => t.id === theme)?.scheme ?? "light";
}

export interface AppPrefs {
  theme: ThemeId;
  fontSize: FontSizeId;
  rememberRecent: boolean;
  showCommitGraph: boolean;
  /** Use last-open cache to enter the repo UI faster. */
  useRepoCache: boolean;
  /** Welcome / loading wallpaper. */
  wallpaperPath: string;
  wallpaperKind: WallpaperKind;
  /** Loading/welcome scrim strength 0–100 (higher = less wallpaper). */
  wallpaperLoadScrim: number;
  /** Terminal wallpaper (separate from load wallpaper). */
  terminalWallpaperPath: string;
  terminalWallpaperKind: WallpaperKind;
  /** Terminal overlay opacity 0–100 (higher = less wallpaper). */
  terminalWallpaperScrim: number;
  /**
   * Manual Release 仓库，格式 owner/repo。
   * 留空则用当前打开仓库的 GitHub origin。
   */
  releaseRepoOverride: string;
}

const DEFAULT_PREFS: AppPrefs = {
  theme: "light",
  fontSize: "normal",
  rememberRecent: true,
  showCommitGraph: true,
  useRepoCache: true,
  wallpaperPath: "",
  wallpaperKind: "none",
  wallpaperLoadScrim: 42,
  terminalWallpaperPath: "",
  terminalWallpaperKind: "none",
  terminalWallpaperScrim: 55,
  releaseRepoOverride: "",
};

function clampPercent(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function parseWallpaperKind(value: unknown): WallpaperKind {
  return value === "image" || value === "video" ? value : "none";
}

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

function parseTheme(value: unknown): ThemeId {
  return typeof value === "string" && THEME_IDS.has(value)
    ? (value as ThemeId)
    : "light";
}

export function loadPrefs(): AppPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw) as Partial<AppPrefs>;
    return {
      theme: parseTheme(parsed.theme),
      fontSize: parsed.fontSize === "large" ? "large" : "normal",
      rememberRecent: parsed.rememberRecent !== false,
      showCommitGraph: parsed.showCommitGraph !== false,
      useRepoCache: parsed.useRepoCache !== false,
      wallpaperPath:
        typeof parsed.wallpaperPath === "string" ? parsed.wallpaperPath : "",
      wallpaperKind: parseWallpaperKind(parsed.wallpaperKind),
      wallpaperLoadScrim: clampPercent(
        parsed.wallpaperLoadScrim,
        DEFAULT_PREFS.wallpaperLoadScrim,
      ),
      terminalWallpaperPath:
        typeof parsed.terminalWallpaperPath === "string"
          ? parsed.terminalWallpaperPath
          : "",
      terminalWallpaperKind: parseWallpaperKind(parsed.terminalWallpaperKind),
      terminalWallpaperScrim: clampPercent(
        parsed.terminalWallpaperScrim,
        DEFAULT_PREFS.terminalWallpaperScrim,
      ),
      releaseRepoOverride:
        typeof parsed.releaseRepoOverride === "string"
          ? parsed.releaseRepoOverride.trim()
          : "",
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
  const root = document.documentElement;
  root.dataset.theme = prefs.theme;
  root.dataset.scheme = themeScheme(prefs.theme);
  root.dataset.fontSize = prefs.fontSize;
  root.style.setProperty(
    "--wallpaper-load-scrim",
    String(clampPercent(prefs.wallpaperLoadScrim, 42) / 100),
  );
  root.style.setProperty(
    "--terminal-wallpaper-scrim",
    String(clampPercent(prefs.terminalWallpaperScrim, 55) / 100),
  );
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
