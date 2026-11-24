export type LocaleOption = {
  code: string;
  label: string;
};

/** Full built-in language catalog (add from this list only). */
export const LOCALE_CATALOG: LocaleOption[] = [
  { code: "zh-CN", label: "中文（简体）" },
  { code: "zh-TW", label: "中文（繁體）" },
  { code: "en", label: "English" },
  { code: "ja", label: "日本語" },
  { code: "ko", label: "한국어" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
  { code: "es", label: "Español" },
  { code: "pt", label: "Português" },
  { code: "ru", label: "Русский" },
  { code: "it", label: "Italiano" },
  { code: "vi", label: "Tiếng Việt" },
  { code: "th", label: "ไทย" },
  { code: "id", label: "Bahasa Indonesia" },
  { code: "ar", label: "العربية" },
  { code: "hi", label: "हिन्दी" },
  { code: "tr", label: "Türkçe" },
  { code: "pl", label: "Polski" },
  { code: "nl", label: "Nederlands" },
  { code: "sv", label: "Svenska" },
];

/** @deprecated use LOCALE_CATALOG — kept for any old imports */
export const BUILTIN_LOCALES = LOCALE_CATALOG.filter((l) =>
  ["zh-CN", "en"].includes(l.code),
).map((l) => ({ ...l, builtin: true as const }));

export function localeLabel(code: string): string {
  return LOCALE_CATALOG.find((l) => l.code === code)?.label ?? code;
}

type Dict = Record<string, string>;

const ZH: Dict = {
  "settings.title": "设置",
  "settings.subtitle": "账号、外观、语言与网络",
  "settings.close": "关闭",
  "nav.auth": "账号登录",
  "nav.auth.desc": "GitHub / Gitee",
  "nav.identity": "身份与远程",
  "nav.identity.desc": "名字、邮箱、地址",
  "nav.appearance": "外观",
  "nav.appearance.desc": "主题、壁纸",
  "nav.behavior": "行为",
  "nav.behavior.desc": "习惯与同步方式",
  "nav.language": "语言",
  "nav.language.desc": "界面语言",
  "nav.network": "网络",
  "nav.network.desc": "镜像与 Hosts",
  "nav.reset": "重置",
  "nav.reset.desc": "设置与数据",
  "nav.about": "关于",
  "nav.about.desc": "版本与更新",
  "lang.title": "语言",
  "lang.hint":
    "从内置语言中添加并切换。可删除不需要的语言（至少保留一种）。",
  "lang.add": "添加语言",
  "lang.pick": "选择要添加的语言",
  "lang.remove": "删除",
  "lang.current": "当前界面语言",
  "net.title": "网络",
  "net.mirror.title": "GitHub 加速镜像",
  "net.mirror.hint":
    "克隆 GitHub 仓库时，把地址经镜像转发（适合国内网络）。登录 API 仍建议使用 VPN/代理。",
  "net.mirror.off": "不使用镜像（直连）",
  "net.mirror.custom": "自定义镜像前缀",
  "net.hosts.title": "Hosts 自动改 IP",
  "net.hosts.hint":
    "开启后自动解析 GitHub IP 并写入系统 Hosts（Windows 可能弹出 UAC）。IP 会变化，可随时刷新；长期更推荐代理/镜像。",
  "net.hosts.auto": "自动写入 GitHub Hosts",
  "net.hosts.auto.desc": "解析 IP 并写入；关闭时清除青枝写入的片段",
  "net.hosts.refresh": "刷新 IP 并写入",
  "net.hosts.remove": "清除已写入",
  "net.hosts.copy": "复制 Hosts 片段",
  "net.hosts.open": "打开 Hosts 所在目录",
  "net.hosts.apply": "写入系统 Hosts",
  "net.hosts.advanced": "高级：手动编辑",
  "net.hosts.status.on": "系统 Hosts 中已有青枝片段",
  "net.hosts.status.off": "系统 Hosts 中尚未写入",
  "reset.title": "重置",
  "reset.hint":
    "可恢复偏好默认值，或清空本地数据。执行前需输入对应操作名称确认。",
  "reset.settings": "重置设置",
  "reset.settings.desc":
    "主题、语言、网络、壁纸等偏好恢复默认（不退出登录、不删仓库）。",
  "reset.data": "删除数据",
  "reset.data.desc":
    "清空最近打开、仓库缓存、壁纸副本与本地偏好等应用数据（系统 Git 凭据需另行退出登录）。",
  "about.title": "关于青枝",
};

const EN: Dict = {
  "settings.title": "Settings",
  "settings.subtitle": "Accounts, appearance, language & network",
  "settings.close": "Close",
  "nav.auth": "Accounts",
  "nav.auth.desc": "GitHub / Gitee",
  "nav.identity": "Identity & remote",
  "nav.identity.desc": "Name, email, URLs",
  "nav.appearance": "Appearance",
  "nav.appearance.desc": "Theme & wallpaper",
  "nav.behavior": "Behavior",
  "nav.behavior.desc": "Habits & sync",
  "nav.language": "Language",
  "nav.language.desc": "UI language",
  "nav.network": "Network",
  "nav.network.desc": "Mirrors & hosts",
  "nav.reset": "Reset",
  "nav.reset.desc": "Prefs & data",
  "nav.about": "About",
  "nav.about.desc": "Version & updates",
  "lang.title": "Language",
  "lang.hint":
    "Enable languages from the built-in catalog. You can remove unused ones (keep at least one).",
  "lang.add": "Add language",
  "lang.pick": "Choose a language to add",
  "lang.remove": "Remove",
  "lang.current": "Current UI language",
  "net.title": "Network",
  "net.mirror.title": "GitHub download mirror",
  "net.mirror.hint":
    "When cloning GitHub repos, rewrite the URL via a mirror. Login APIs still work best with a VPN/proxy.",
  "net.mirror.off": "No mirror (direct)",
  "net.mirror.custom": "Custom mirror prefix",
  "net.hosts.title": "Hosts auto IP",
  "net.hosts.hint":
    "When enabled, resolve GitHub IPs and write system hosts (may prompt UAC on Windows). IPs change — refresh anytime; prefer proxy/mirror long-term.",
  "net.hosts.auto": "Auto-write GitHub hosts",
  "net.hosts.auto.desc": "Resolve IPs and write; turning off removes Qingzhi’s block",
  "net.hosts.refresh": "Refresh IPs & write",
  "net.hosts.remove": "Remove written block",
  "net.hosts.copy": "Copy hosts snippet",
  "net.hosts.open": "Open hosts folder",
  "net.hosts.apply": "Write system hosts",
  "net.hosts.advanced": "Advanced: edit manually",
  "net.hosts.status.on": "Qingzhi block is present in system hosts",
  "net.hosts.status.off": "Not written to system hosts yet",
  "reset.title": "Reset",
  "reset.hint":
    "Restore preference defaults or wipe local data. Type the action name to confirm.",
  "reset.settings": "Reset settings",
  "reset.settings.desc":
    "Restore theme, language, network, wallpaper prefs (does not log out or delete repos).",
  "reset.data": "Delete data",
  "reset.data.desc":
    "Clear recent repos, cache, wallpaper copies and local prefs (sign out separately for Git credentials).",
  "about.title": "About Qingzhi",
};

const TABLES: Record<string, Dict> = {
  "zh-CN": ZH,
  en: EN,
};

export function t(locale: string, key: string): string {
  const primary = TABLES[locale] ?? TABLES["zh-CN"]!;
  const fallback = ZH;
  return primary[key] ?? TABLES.en?.[key] ?? fallback[key] ?? key;
}

export function applyDocumentLocale(locale: string) {
  document.documentElement.lang = locale || "zh-CN";
}
