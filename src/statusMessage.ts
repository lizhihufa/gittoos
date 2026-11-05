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
  if (
    /^\[[^\]]+\]/.test(raw) ||
    raw.includes("files changed") ||
    raw.includes("file changed")
  ) {
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
  if (
    raw.includes("SYNC_UNRELATED:") ||
    /unrelated histories/i.test(raw) ||
    raw.includes("互不相关")
  ) {
    return "unrelated";
  }
  if (
    raw.includes("SYNC_NEEDS_PULL:") ||
    /non-fast-forward/i.test(raw) ||
    (/rejected/i.test(raw) && /behind/i.test(raw))
  ) {
    return "needs_pull";
  }
  return null;
}

/** Collect likely file paths listed after an overwrite/conflict English message. */
function extractListedFiles(text: string): string[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const files: string[] = [];
  let collecting = false;
  for (const line of lines) {
    if (
      /would be overwritten/i.test(line) ||
      /Please move or remove them/i.test(line) ||
      /untracked working tree files/i.test(line)
    ) {
      collecting = true;
      continue;
    }
    if (collecting) {
      if (
        /^(please|aborting|error|fatal|hint):/i.test(line) ||
        /commit your changes|stash them|before you/i.test(line)
      ) {
        break;
      }
      // Git lists files indented or as plain relative paths.
      if (/^[\w./\\_\-@+]+$/.test(line) || /\.[a-z0-9]+$/i.test(line)) {
        files.push(line.replace(/\\/g, "/"));
      } else if (files.length > 0) {
        break;
      }
    }
  }
  return files.slice(0, 8);
}

function withFiles(message: string, files: string[]): string {
  if (files.length === 0) return message;
  const more = files.length >= 8 ? " 等" : "";
  return `${message} 涉及：${files.join("、")}${more}`;
}

/** Translate common Git English stderr into concise Chinese. */
export function translateGitMessage(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  const lower = text.toLowerCase();
  const files = extractListedFiles(text);

  if (
    /local changes.*would be overwritten by (checkout|merge|reset)/i.test(text) ||
    /your local changes to the following files would be overwritten/i.test(text)
  ) {
    return withFiles(
      "本地有未提交的修改，继续操作会覆盖这些文件。请先提交、储藏或放弃改动后再试。",
      files,
    );
  }
  if (
    /untracked working tree files would be overwritten/i.test(text) ||
    /the following untracked working tree files would be overwritten/i.test(text)
  ) {
    return withFiles(
      "工作区有未跟踪的同名文件，继续会覆盖它们。请先移走、改名或删除这些文件。",
      files,
    );
  }
  if (
    /please commit your changes or stash them before/i.test(text) ||
    /commit your changes or stash them before you/i.test(text)
  ) {
    return "本地有未提交改动。请先提交或储藏后再拉取/合并/切换分支。";
  }
  if (/you have not concluded your merge/i.test(text)) {
    return "上次合并尚未结束。请先解决冲突并点「继续」，或点「放弃」取消合并。";
  }
  if (/you must edit all merge conflicts/i.test(text) || /fix conflict/i.test(text)) {
    return "仍有未解决的冲突。请编辑冲突文件并暂存后，再点「继续」。";
  }
  if (/conflict|自动合并失败|合并冲突/i.test(text) && /merge|pull|rebase|cherry/i.test(lower)) {
    return "出现冲突。请按顶部提示解决冲突后点「继续」，或「放弃」取消本次操作。";
  }
  if (/not possible to fast-forward|diverging branches/i.test(text)) {
    return "本地与远程已分叉。请再点一次「拉取」（会自动合并），完成后再推送。";
  }
  if (/unrelated histories/i.test(text) || text.includes("互不相关")) {
    return "本地与远程历史互不相关，请在弹窗中选择处理方式。";
  }
  if (
    /non-fast-forward/i.test(text) ||
    (/rejected/i.test(text) && (/fetch first|behind|tip of your current branch is behind/i.test(text)))
  ) {
    return "推送被拒绝：远程有新提交。请先拉取，或在弹窗中选择处理方式。";
  }
  if (/updates were rejected/i.test(text)) {
    return "推送被拒绝。请先拉取远程更新后再推送。";
  }
  if (/protected branch|cannot force-push|force.?push.*denied/i.test(text)) {
    return "远程分支受保护，无法强制推送。请联系仓库管理员或改用普通推送。";
  }
  if (
    /authentication failed|access denied|invalid username or password|could not read username|auth fail/i.test(
      text,
    ) ||
    /http basic:\s*access denied/i.test(text) ||
    /登录无效|凭据|AUTH_NEEDED/i.test(text)
  ) {
    return "身份验证失败。请点「去登录」重新登录，或检查 Token / 凭据是否有效。";
  }
  if (/permission denied \(publickey\)|could not open a connection to your authentication agent/i.test(text)) {
    return "SSH 公钥认证失败。请检查本机 SSH 密钥是否已添加到远程平台。";
  }
  if (/repository not found|remote repository not found/i.test(text)) {
    return "找不到远程仓库。请确认地址是否正确，以及账号是否有权限。";
  }
  if (
    /could not resolve host|failed to connect|connection refused|network is unreachable|timed out|timeout|remote hung up/i.test(
      text,
    )
  ) {
    return "网络连接失败。请检查网络、代理设置后重试。";
  }
  if (/ssl certificate|certificate verify failed/i.test(text)) {
    return "SSL 证书校验失败。请检查系统时间或网络代理。";
  }
  if (/index\.lock|unable to create '.*\.git\/index\.lock'/i.test(text)) {
    return "Git 正忙或上次操作异常退出。请稍后再试；若持续出现，可关闭其他 Git 程序后重试。";
  }
  if (/already exists/i.test(text) && /branch|tag|ref/i.test(lower)) {
    return "同名分支或标签已存在，请换一个名称。";
  }
  if (/pathspec .* did not match/i.test(text)) {
    return "找不到指定的文件或分支，请刷新后重试。";
  }
  if (/not a git repository/i.test(text)) {
    return "当前目录不是 Git 仓库。";
  }
  if (/does not have any commits yet|no commits yet/i.test(text)) {
    return "仓库还没有任何提交。请先提交一次后再操作。";
  }
  if (/cannot lock ref|reference is ambiguous/i.test(text)) {
    return "分支引用冲突或无法锁定。请刷新后重试，或检查是否有同名引用。";
  }
  if (/insufficient permission|write access to repository not granted/i.test(text)) {
    return "没有写入该远程仓库的权限。请确认登录账号是否正确。";
  }
  if (/not fully merged|BRANCH_NOT_MERGED/i.test(text)) {
    return "分支尚未完全合并。可在确认后强制删除。";
  }
  if (/detached head/i.test(text)) {
    return "当前处于「分离 HEAD」状态。请先切换到某个分支再提交。";
  }
  if (/cannot rebase|you are already mid.?rebase|no rebase in progress/i.test(text)) {
    if (/no rebase in progress/i.test(text)) {
      return "当前没有进行中的变基。";
    }
    return "变基无法继续。请先处理冲突或放弃变基。";
  }
  if (/empty commit message|aborting commit due to empty/i.test(text)) {
    return "提交说明不能为空。";
  }
  if (/nothing to commit|no changes added to commit/i.test(text)) {
    return "没有可提交的内容。请先暂存文件。";
  }
  if (/refusing to merge unrelated histories/i.test(text)) {
    return "拒绝合并互不相关的历史。请在弹窗中选择是否允许。";
  }
  if (
    /GH001|file size limit|exceeds GitHub's file size|large files detected/i.test(
      text,
    )
  ) {
    const sizeHit = text.match(/([\w./\\-]+\.(?:exe|zip|msi|dmg|iso|7z|rar))\s+is\s+([\d.]+)\s*MB/i);
    const tip = sizeHit
      ? `「${sizeHit[1].replace(/\\/g, "/")}」约 ${sizeHit[2]} MB，超过 GitHub 单文件 100 MB 限制。`
      : "提交里包含超过 GitHub 单文件 100 MB 限制的大文件。";
    return `${tip}请从仓库中移除安装包等大文件后再推送（勿把安装包提交进 Git）。`;
  }
  if (/pre-receive hook declined/i.test(text)) {
    return "远程拒绝了推送（服务器钩子未通过）。常见原因是提交了过大文件或违反了仓库规则。请查看终端详情。";
  }

  return null;
}

/** Whether this error looks like a credentials / auth failure. */
export function isAuthFailure(error: unknown): boolean {
  const raw = String(error ?? "");
  if (/protected branch|file size|GH001|pre-receive|unrelated histories|non-fast-forward/i.test(raw)) {
    return false;
  }
  return /authentication failed|access denied|invalid username or password|could not read username|auth fail|http basic:\s*access denied|登录无效|身份验证失败|AUTH_NEEDED|could not access|Permission denied \(password\)|terminal prompts disabled/i.test(
    raw,
  );
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

  const translated = translateGitMessage(cleaned);
  if (translated) return translated;

  const lines = cleaned
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const preferred =
    lines.find((line) => /[\u4e00-\u9fff]/.test(line)) ||
    lines.find((line) => /^(fatal|error):/i.test(line)) ||
    lines[0] ||
    "操作失败";

  const one = preferred.replace(/^(fatal|error|hint):\s*/i, "").trim();
  // If still English-looking, give a generic Chinese fallback with a short clip.
  if (/^[A-Za-z]/.test(one) && !/[\u4e00-\u9fff]/.test(one)) {
    const clip = one.length > 80 ? `${one.slice(0, 77)}…` : one;
    return `操作失败：${clip}`;
  }
  return one.length > 120 ? `${one.slice(0, 117)}…` : one;
}
