/** Compress git / app messages into one short status line for the banner. */
export function successLine(label: string | undefined, result: unknown): string {
  const raw = typeof result === "string" ? result.trim() : "";
  const done = label
    ? `${label.replace(/^正在/, "").replace(/…$/, "").trim()}完成`
    : "完成";

  if (!raw) return done;
  if (raw.startsWith("已取消")) return raw;

  const lower = raw.toLowerCase();
  if (lower.includes("already up to date") || raw.includes("已经是最新")) {
    return "已是最新，无需更新";
  }
  if (lower.includes("fast-forward")) {
    const files = raw.match(/(\d+)\s+files? changed/i);
    return files ? `拉取完成，更新了 ${files[1]} 个文件` : "拉取完成（快进）";
  }
  if (raw.includes("本地与远程有分叉") || raw.includes("已合并拉取")) {
    return "拉取完成（已合并远程改动）";
  }
  if (raw.includes("已从 ") && raw.includes(" 拉取")) {
    return "拉取完成";
  }
  if (raw.includes("合并已完成") || raw.includes("拣选已完成")) {
    return raw.includes("拣选") ? "拣选已完成" : "合并已完成";
  }
  if (raw.includes("已撤销最近一次提交")) {
    return "已撤销上次提交，改动在暂存区";
  }
  if (raw.includes("已创建并切换") || raw.includes("已切换到本地分支")) {
    return "分支已切换";
  }
  if (lower.includes("create mode") || /create mode/i.test(raw)) {
    return done;
  }
  if (/^\[[^\]]+\]/.test(raw) || raw.includes("files changed") || raw.includes("file changed")) {
    return done;
  }

  // Prefer a short Chinese sentence if the backend already returned one.
  const first = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("$") && !line.startsWith("#"));
  if (first && first.length <= 60 && /[\u4e00-\u9fff]/.test(first)) {
    return first;
  }
  return done;
}

export type SyncConflictKind = "unrelated" | "needs_pull";

/** Detect sync conflicts that should open a choice dialog. */
export function syncConflictKind(error: unknown): SyncConflictKind | null {
  const raw = String(error ?? "");
  if (raw.includes("SYNC_UNRELATED:") || /unrelated histories/i.test(raw) || raw.includes("互不相关")) {
    return "unrelated";
  }
  if (
    raw.includes("SYNC_NEEDS_PULL:") ||
    /non-fast-forward/i.test(raw) ||
    ( /rejected/i.test(raw) && /behind/i.test(raw))
  ) {
    return "needs_pull";
  }
  return null;
}

export function failureLine(error: unknown): string {
  const raw = String(error ?? "未知错误").trim();
  const cleaned = raw
    .replace(/^git 执行失败 \(exit \d+\):\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .replace(/^SYNC_UNRELATED:/, "")
    .replace(/^SYNC_NEEDS_PULL:/, "")
    .trim();

  const kind = syncConflictKind(raw);
  if (kind === "unrelated") {
    return "本地与远程历史互不相关，请在弹窗中选择处理方式。";
  }
  if (kind === "needs_pull") {
    return "推送被拒绝：远程有新提交。请在弹窗中选择处理方式。";
  }
  if (cleaned.startsWith("BRANCH_NOT_MERGED:") || /not fully merged/i.test(cleaned)) {
    return "分支尚未完全合并。可在确认后强制删除。";
  }

  const lower = cleaned.toLowerCase();
  if (
    lower.includes("not possible to fast-forward") ||
    lower.includes("diverging branches")
  ) {
    return "本地与远程已分叉。请再点一次「拉取」（会自动合并），完成后再推送。";
  }

  const lines = cleaned
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const preferred =
    lines.find((line) => /[\u4e00-\u9fff]/.test(line)) ||
    lines.find((line) => /^(fatal|error):/i.test(line)) ||
    lines[0] ||
    "操作失败";

  const one = preferred.replace(/^(fatal|error):\s*/i, "").trim();
  return one.length > 120 ? `${one.slice(0, 117)}…` : one;
}
