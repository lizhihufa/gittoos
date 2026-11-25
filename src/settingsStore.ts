const CLONE_KEY = "gittool.cloneUrl";
const PREFS_KEY = "gittool.prefs";
const TABS_KEY = "gittool.openRepos";

/** Six curated themes + custom. */
export type ThemeId =
  | "ink"
  | "night"
  | "bamboo"
  | "ember"
  | "mist"
  | "tide"
  | "custom";

export type FontSizeId = "normal" | "large";
export type WallpaperKind = "none" | "image" | "video";
export type ColorScheme = "light" | "dark";

export const THEME_OPTIONS: {
  id: Exclude<ThemeId, "custom">;
  label: string;
  scheme: ColorScheme;
  /** Swatch accent for picker. */
  swatch: string;
}[] = [
  { id: "ink", label: "青砚", scheme: "light", swatch: "#1a7a62" },
  { id: "night", label: "夜航", scheme: "dark", swatch: "#5eb0ff" },
  { id: "bamboo", label: "竹雾", scheme: "light", swatch: "#3d8b5a" },
  { id: "ember", label: "朱砂", scheme: "dark", swatch: "#e07a5f" },
  { id: "mist", label: "云灰", scheme: "light", swatch: "#5b6b7c" },
  { id: "tide", label: "海礁", scheme: "dark", swatch: "#3db8a0" },
];

const THEME_IDS = new Set<string>([
  ...THEME_OPTIONS.map((t) => t.id),
  "custom",
]);

/** Map legacy theme ids → new ones. */
const LEGACY_THEME: Record<string, ThemeId> = {
  light: "ink",
  dark: "night",
  forest: "bamboo",
  nord: "tide",
  solar: "mist",
  tokyo: "night",
  mocha: "ember",
};

export function themeScheme(
  theme: ThemeId,
  customScheme: ColorScheme = "light",
): ColorScheme {
  if (theme === "custom") return customScheme;
  return THEME_OPTIONS.find((t) => t.id === theme)?.scheme ?? "light";
}

export interface AppPrefs {
  theme: ThemeId;
  /** Used when theme === "custom". */
  customScheme: ColorScheme;
  customAccent: string;
  customBg: string;
  fontSize: FontSizeId;
  rememberRecent: boolean;
  showCommitGraph: boolean;
  useRepoCache: boolean;
  wallpaperPath: string;
  wallpaperKind: WallpaperKind;
  wallpaperLoadScrim: number;
  terminalWallpaperPath: string;
  /** Terminal only supports static image (or none). */
  terminalWallpaperKind: "none" | "image";
  terminalWallpaperScrim: number;
  releaseRepoOverride: string;
  /** Manual Gitee owner/repo for Release pane; empty = detect from remotes. */
  releaseGiteeRepoOverride: string;
  mirrorSyncMethod: "app" | "actions";
  locale: string;
  /** Enabled locale codes chosen from the built-in catalog. */
  enabledLocales: string[];
  githubMirrorId: string;
  githubMirrorCustom: string;
  hostsText: string;
  /** When true, Hosts are managed automatically (resolve + write). */
  hostsAuto: boolean;
}

export const DEFAULT_PREFS: AppPrefs = {
  theme: "ink",
  customScheme: "light",
  customAccent: "#1a7a62",
  customBg: "#f2f5f3",
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
  releaseGiteeRepoOverride: "",
  mirrorSyncMethod: "app",
  locale: "zh-CN",
  enabledLocales: ["zh-CN", "en"],
  githubMirrorId: "off",
  githubMirrorCustom: "",
  hostsText: "",
  hostsAuto: false,
};

function clampPercent(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function parseWallpaperKind(value: unknown): WallpaperKind {
  return value === "image" || value === "video" ? value : "none";
}

function parseHexColor(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const v = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(v)) {
    const r = v[1]!;
    const g = v[2]!;
    const b = v[3]!;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return fallback;
}

function parseEnabledLocales(_value: unknown, _locale: string): string[] {
  // Only zh-CN / en are supported; always keep both available.
  return ["zh-CN", "en"];
}

function parseLocale(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "zh-CN";
  if (raw.toLowerCase() === "en" || raw.toLowerCase().startsWith("en-")) {
    return "en";
  }
  return "zh-CN";
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
    // ignore
  }
}

function parseTheme(value: unknown): ThemeId {
  if (typeof value !== "string") return "ink";
  if (THEME_IDS.has(value)) return value as ThemeId;
  return LEGACY_THEME[value] ?? "ink";
}

export function loadPrefs(): AppPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFS, enabledLocales: [...DEFAULT_PREFS.enabledLocales] };
    const parsed = JSON.parse(raw) as Partial<AppPrefs> & {
      customLocales?: unknown;
    };
    const locale = parseLocale(parsed.locale);
    const termKindRaw = parseWallpaperKind(parsed.terminalWallpaperKind);
    const terminalWallpaperKind: "none" | "image" =
      termKindRaw === "image" ? "image" : "none";
    return {
      theme: parseTheme(parsed.theme),
      customScheme: parsed.customScheme === "dark" ? "dark" : "light",
      customAccent: parseHexColor(
        parsed.customAccent,
        DEFAULT_PREFS.customAccent,
      ),
      customBg: parseHexColor(parsed.customBg, DEFAULT_PREFS.customBg),
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
      terminalWallpaperKind,
      terminalWallpaperScrim: clampPercent(
        parsed.terminalWallpaperScrim,
        DEFAULT_PREFS.terminalWallpaperScrim,
      ),
      releaseRepoOverride:
        typeof parsed.releaseRepoOverride === "string"
          ? parsed.releaseRepoOverride.trim()
          : "",
      releaseGiteeRepoOverride:
        typeof parsed.releaseGiteeRepoOverride === "string"
          ? parsed.releaseGiteeRepoOverride.trim()
          : "",
      mirrorSyncMethod:
        parsed.mirrorSyncMethod === "actions" ? "actions" : "app",
      locale,
      enabledLocales: parseEnabledLocales(
        parsed.enabledLocales ?? parsed.customLocales,
        locale,
      ),
      githubMirrorId:
        typeof parsed.githubMirrorId === "string" && parsed.githubMirrorId.trim()
          ? parsed.githubMirrorId.trim()
          : "off",
      githubMirrorCustom:
        typeof parsed.githubMirrorCustom === "string"
          ? parsed.githubMirrorCustom.trim()
          : "",
      hostsText: typeof parsed.hostsText === "string" ? parsed.hostsText : "",
      hostsAuto: parsed.hostsAuto === true,
    };
  } catch {
    return {
      ...DEFAULT_PREFS,
      enabledLocales: [...DEFAULT_PREFS.enabledLocales],
    };
  }
}

export function savePrefs(prefs: AppPrefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // ignore
  }
}

function shade(hex: string, amount: number): string {
  const n = hex.replace("#", "");
  if (n.length !== 6) return hex;
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const r = clamp(parseInt(n.slice(0, 2), 16) + amount);
  const g = clamp(parseInt(n.slice(2, 4), 16) + amount);
  const b = clamp(parseInt(n.slice(4, 6), 16) + amount);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

export function applyPrefsToDocument(prefs: AppPrefs) {
  const root = document.documentElement;
  root.dataset.theme = prefs.theme;
  root.dataset.scheme = themeScheme(prefs.theme, prefs.customScheme);
  root.dataset.fontSize = prefs.fontSize;
  root.lang = prefs.locale || "zh-CN";
  root.style.setProperty(
    "--wallpaper-load-scrim",
    String(clampPercent(prefs.wallpaperLoadScrim, 42) / 100),
  );
  root.style.setProperty(
    "--terminal-wallpaper-scrim",
    String(clampPercent(prefs.terminalWallpaperScrim, 55) / 100),
  );

  if (prefs.theme === "custom") {
    const accent = prefs.customAccent || DEFAULT_PREFS.customAccent;
    const bg = prefs.customBg || DEFAULT_PREFS.customBg;
    const dark = prefs.customScheme === "dark";
    root.style.setProperty("--accent", accent);
    root.style.setProperty("--accent-hover", shade(accent, dark ? 18 : -18));
    root.style.setProperty("--bg", bg);
    root.style.setProperty("--panel", shade(bg, dark ? 14 : 10));
    root.style.setProperty("--surface", shade(bg, dark ? 8 : 6));
    root.style.setProperty("--header-bg", shade(bg, dark ? 18 : -6));
    root.style.setProperty("--tab-bg", shade(bg, dark ? 18 : -6));
    root.style.setProperty("--control-bg", shade(bg, dark ? -8 : 14));
    root.style.setProperty("--btn-bg", shade(bg, dark ? 18 : 14));
    root.style.setProperty("--line", shade(bg, dark ? 36 : -28));
    root.style.setProperty("--text", dark ? "#e8eef4" : "#1a1f24");
    root.style.setProperty("--muted", dark ? "#8b97a8" : "#5c6570");
    root.style.setProperty("--add", accent);
    root.style.setProperty("--hunk", accent);
  } else {
    for (const key of [
      "--accent",
      "--accent-hover",
      "--bg",
      "--panel",
      "--surface",
      "--header-bg",
      "--tab-bg",
      "--control-bg",
      "--btn-bg",
      "--line",
      "--text",
      "--muted",
      "--add",
      "--hunk",
    ]) {
      root.style.removeProperty(key);
    }
  }
}

export function resolveGithubMirrorPrefix(prefs: AppPrefs): string {
  if (prefs.githubMirrorId === "custom") {
    return prefs.githubMirrorCustom.trim();
  }
  if (prefs.githubMirrorId === "ghproxy") return "https://ghproxy.net/";
  if (prefs.githubMirrorId === "ghproxy-mirror")
    return "https://mirror.ghproxy.com/";
  if (prefs.githubMirrorId === "gitclone") return "https://gitclone.com/";
  return "";
}

/** Clear all gittool.* keys in localStorage (prefs, recent, cache, …). */
export function clearAllLocalAppData() {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith("gittool.")) keys.push(k);
  }
  for (const k of keys) localStorage.removeItem(k);
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
