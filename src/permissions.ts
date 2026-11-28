/** App-level feature permissions — toggled in Settings, enforced in UI + Rust. */

export type FeaturePermKey =
  | "push"
  | "forcePush"
  | "publishRemote"
  | "release"
  | "wiki"
  | "mirror";

export type FeaturePermissions = Record<FeaturePermKey, boolean>;

export const FEATURE_PERM_KEYS: FeaturePermKey[] = [
  "push",
  "forcePush",
  "publishRemote",
  "release",
  "wiki",
  "mirror",
];

export const DEFAULT_FEATURE_PERMISSIONS: FeaturePermissions = {
  push: true,
  forcePush: true,
  publishRemote: true,
  release: true,
  wiki: true,
  mirror: true,
};

export const FEATURE_PERM_META: Record<
  FeaturePermKey,
  { titleZh: string; descZh: string; titleEn: string; descEn: string }
> = {
  push: {
    titleZh: "推送到远程",
    descZh: "推送提交、标签到 GitHub / Gitee 等远程",
    titleEn: "Push to remote",
    descEn: "Push commits and tags to GitHub / Gitee remotes",
  },
  forcePush: {
    titleZh: "强制推送",
    descZh: "允许 force push（覆盖远程历史，风险较高）",
    titleEn: "Force push",
    descEn: "Allow force push (overwrites remote history)",
  },
  publishRemote: {
    titleZh: "创建远程仓库",
    descZh: "在 GitHub / Gitee 上新建仓库并写入远程地址",
    titleEn: "Create remote repo",
    descEn: "Create GitHub / Gitee repos and add remotes",
  },
  release: {
    titleZh: "Release 发布",
    descZh: "上传、刷新与删除 GitHub / Gitee Release",
    titleEn: "Releases",
    descEn: "Upload, refresh, and delete GitHub / Gitee releases",
  },
  wiki: {
    titleZh: "Wiki 编辑",
    descZh: "同步、初始化、保存与推送仓库 Wiki",
    titleEn: "Wiki editing",
    descEn: "Sync, init, save, and push repository wiki",
  },
  mirror: {
    titleZh: "镜像同步",
    descZh: "安装 / 删除 Actions 镜像，以及镜像推送",
    titleEn: "Mirror sync",
    descEn: "Install / remove Actions mirror and mirror pushes",
  },
};

export function parseFeaturePermissions(
  value: unknown,
): FeaturePermissions {
  const src =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const next = { ...DEFAULT_FEATURE_PERMISSIONS };
  for (const key of FEATURE_PERM_KEYS) {
    if (typeof src[key] === "boolean") next[key] = src[key] as boolean;
  }
  return next;
}

export function featurePermLabel(
  key: FeaturePermKey,
  locale: string,
): { title: string; desc: string } {
  const meta = FEATURE_PERM_META[key];
  const en = locale.toLowerCase().startsWith("en");
  return en
    ? { title: meta.titleEn, desc: meta.descEn }
    : { title: meta.titleZh, desc: meta.descZh };
}
