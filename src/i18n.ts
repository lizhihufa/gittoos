export type LocaleOption = {
  code: string;
  label: string;
};

/** Supported UI languages (Chinese + English only). */
export const LOCALE_CATALOG: LocaleOption[] = [
  { code: "zh-CN", label: "中文（简体）" },
  { code: "en", label: "English" },
];

/** @deprecated use LOCALE_CATALOG */
export const BUILTIN_LOCALES = LOCALE_CATALOG.map((l) => ({
  ...l,
  builtin: true as const,
}));

export function localeLabel(code: string): string {
  return LOCALE_CATALOG.find((l) => l.code === code)?.label ?? code;
}

export function normalizeLocale(code: string): string {
  const c = (code || "").trim();
  if (c.toLowerCase() === "en" || c.toLowerCase().startsWith("en-")) return "en";
  return "zh-CN";
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
  "lang.hint": "界面支持中文与英文，切换后立即生效。",
  "lang.current": "当前界面语言",
  "net.title": "网络",
  "net.mirror.title": "GitHub 加速镜像",
  "net.mirror.hint":
    "克隆 GitHub 仓库时，把地址经镜像转发（适合国内网络）。登录 API 仍建议使用 VPN/代理。",
  "net.mirror.off": "不使用镜像（直连）",
  "net.mirror.custom": "自定义镜像前缀",
  "net.hosts.title": "Hosts 自动改 IP",
  "net.hosts.hint":
    "开启后自动解析 GitHub IP 并写入系统 Hosts（Windows 可能弹出 UAC）。开启期间会定期刷新 IP；长期更推荐代理/镜像。",
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
  "pane.diff": "差异",
  "pane.history": "历史",
  "pane.stash": "储藏",
  "pane.tags": "标签",
  "pane.terminal": "终端",
  "pane.releases": "Release",
  "welcome.open": "打开文件夹",
  "welcome.clone": "克隆",
  "welcome.settings": "设置",
  "welcome.help": "说明书",
  "toolbar.open": "打开",
  "toolbar.refresh": "刷新",
  "toolbar.fetch": "获取",
  "toolbar.pull": "拉取",
  "toolbar.push": "推送",
  "release.title": "标题",
  "release.titlePh": "例如：青枝；留空则用 Tag",
  "release.pick": "选择文件",
  "release.upload": "上传",
  "release.refresh": "刷新",
  "release.refreshing": "刷新中",
  "release.notes": "说明",
  "release.hideNotes": "收起说明",
  "release.notesPh": "新建 Release 时的说明（已有 Tag 则忽略）",
  "release.empty": "还没有 Release。选择文件并上传后会自动创建。",
  "release.open": "打开",
  "release.delete": "删除",
  "release.download": "下载",
  "release.noAssets": "无附件",
  "release.goSettings": "去设置",
  "release.fileFilter": "安装包 / 文件",
  "release.pickTitle": "选择要上传的 Release 文件",
  "release.noGithubRepo": "未识别到 GitHub 仓库：请配置 origin，或在设置中手动指定",
  "release.noGiteeRepo": "未识别到 Gitee 仓库：请配置 gitee 远程，或在设置中手动指定",
  "release.needFile": "请先选择要上传的文件",
  "release.needGithub": "请先登录 GitHub（需要仓库写权限）",
  "release.needGitee": "请先登录 Gitee（需要仓库写权限）",
  "release.needLoginHint": "上传/删除需登录",
  "release.uploadTo": "上传到",
  "release.file": "文件",
  "release.autoCreate": "若 Tag 不存在会自动创建 Release。",
  "release.uploadConfirm": "上传到 Release",
  "release.uploadingGithub": "正在上传到 GitHub Releases…",
  "release.uploadingGitee": "正在上传到 Gitee Releases…",
  "release.uploaded": "已上传",
  "release.deleteAssetAsk": "从",
  "release.deleteAsset": "删除附件",
  "release.deletedAsset": "已删除附件",
  "release.deleteReleaseAsk": "删除整个 Release",
  "release.deleteRelease": "删除 Release",
  "release.keepTag": "不会删除 Git Tag。",
  "release.deletedRelease": "已删除 Release",
  "release.fillForm": "填入上方标题 / Tag",
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
  "lang.hint": "Chinese and English are supported. Changes apply immediately.",
  "lang.current": "Current UI language",
  "net.title": "Network",
  "net.mirror.title": "GitHub download mirror",
  "net.mirror.hint":
    "When cloning GitHub repos, rewrite the URL via a mirror. Login APIs still work best with a VPN/proxy.",
  "net.mirror.off": "No mirror (direct)",
  "net.mirror.custom": "Custom mirror prefix",
  "net.hosts.title": "Hosts auto IP",
  "net.hosts.hint":
    "When enabled, resolve GitHub IPs and write system hosts (may prompt UAC on Windows). IPs refresh periodically while enabled; prefer proxy/mirror long-term.",
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
  "pane.diff": "Diff",
  "pane.history": "History",
  "pane.stash": "Stash",
  "pane.tags": "Tags",
  "pane.terminal": "Terminal",
  "pane.releases": "Release",
  "welcome.open": "Open folder",
  "welcome.clone": "Clone",
  "welcome.settings": "Settings",
  "welcome.help": "Guide",
  "toolbar.open": "Open",
  "toolbar.refresh": "Refresh",
  "toolbar.fetch": "Fetch",
  "toolbar.pull": "Pull",
  "toolbar.push": "Push",
  "release.title": "Title",
  "release.titlePh": "e.g. Qingzhi; leave blank to use Tag",
  "release.pick": "Choose file",
  "release.upload": "Upload",
  "release.refresh": "Refresh",
  "release.refreshing": "Refreshing",
  "release.notes": "Notes",
  "release.hideNotes": "Hide notes",
  "release.notesPh": "Notes for a new Release (ignored if Tag exists)",
  "release.empty": "No releases yet. Choose a file and upload to create one.",
  "release.open": "Open",
  "release.delete": "Delete",
  "release.download": "Download",
  "release.noAssets": "No assets",
  "release.goSettings": "Settings",
  "release.fileFilter": "Installer / file",
  "release.pickTitle": "Choose a Release asset to upload",
  "release.noGithubRepo": "No GitHub repo detected — set origin or override in Settings",
  "release.noGiteeRepo": "No Gitee repo detected — set a gitee remote or override in Settings",
  "release.needFile": "Choose a file to upload first",
  "release.needGithub": "Sign in to GitHub first (write access required)",
  "release.needGitee": "Sign in to Gitee first (write access required)",
  "release.needLoginHint": "sign in to upload/delete",
  "release.uploadTo": "Upload to",
  "release.file": "File",
  "release.autoCreate": "A Release will be created if the Tag does not exist.",
  "release.uploadConfirm": "Upload to Release",
  "release.uploadingGithub": "Uploading to GitHub Releases…",
  "release.uploadingGitee": "Uploading to Gitee Releases…",
  "release.uploaded": "Uploaded",
  "release.deleteAssetAsk": "Delete asset from",
  "release.deleteAsset": "Delete asset",
  "release.deletedAsset": "Deleted asset",
  "release.deleteReleaseAsk": "Delete entire Release",
  "release.deleteRelease": "Delete Release",
  "release.keepTag": "The Git tag will not be deleted.",
  "release.deletedRelease": "Deleted Release",
  "release.fillForm": "Fill title / Tag above",
};

const TABLES: Record<string, Dict> = {
  "zh-CN": ZH,
  en: EN,
};

export function t(locale: string, key: string): string {
  const loc = normalizeLocale(locale);
  const primary = TABLES[loc] ?? TABLES["zh-CN"]!;
  return primary[key] ?? TABLES.en?.[key] ?? ZH[key] ?? key;
}

export function applyDocumentLocale(locale: string) {
  document.documentElement.lang = normalizeLocale(locale);
}
