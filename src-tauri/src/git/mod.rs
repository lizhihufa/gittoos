mod actions_mirror;
mod auth;
mod runner;
mod status;
mod types;

pub use actions_mirror::{
    actions_mirror_status, setup_actions_mirror, ActionsMirrorSetup, ActionsMirrorStatus,
};
pub use auth::{
    auth_accounts, auth_browser_begin, auth_browser_finish, auth_device_poll, auth_device_start,
    auth_ensure_credentials, auth_login_token, auth_logout, auth_manager_login, auth_save_config,
    auth_ssh_generate, auth_ssh_status, auth_ssh_test, auth_switch_account,
    create_or_get_hosting_repo, github_access_token, AuthAccounts, GithubDevicePollResult,
    GithubDeviceStart, HostingRepo, OauthBegin, ProviderStatus, SshStatus, SshTestResult,
};
pub use runner::{
    ensure_git, git_info, local_proxy, run_shell, set_app_handle, with_git_quiet, GitBinary,
};
pub use status::{repo_status, repo_status_light_nonblocking};
pub use types::*;

use runner::{run_git, run_git_timeout, run_git_with_env};
use std::path::Path;

pub fn is_repository(git: &GitBinary, repo: &Path) -> Result<bool, GitError> {
    match run_git(git, repo, &["rev-parse", "--is-inside-work-tree"]) {
        Ok(output) => Ok(output.stdout.trim() == "true"),
        Err(GitError::CommandFailed { stderr, stdout, .. })
            if format!("{stderr}{stdout}").contains("not a git repository") =>
        {
            Ok(false)
        }
        Err(err) => Err(err),
    }
}

pub fn init_repository(git: &GitBinary, repo: &Path) -> Result<(), GitError> {
    // Match GitHub default: new repos start on `main` (not `master`).
    run_git(git, repo, &["init", "-b", "main"])?;
    Ok(())
}

pub fn stage_paths(git: &GitBinary, repo: &Path, paths: &[String]) -> Result<(), GitError> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut args = vec!["add".to_string(), "--".to_string()];
    args.extend(paths.iter().cloned());
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_git(git, repo, &arg_refs)?;
    Ok(())
}

pub fn unstage_paths(git: &GitBinary, repo: &Path, paths: &[String]) -> Result<(), GitError> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut args = vec![
        "restore".to_string(),
        "--staged".to_string(),
        "--".to_string(),
    ];
    args.extend(paths.iter().cloned());
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_git(git, repo, &arg_refs)?;
    Ok(())
}

/// Default GitHub soft limit for a single blob.
pub const LARGE_FILE_LIMIT_BYTES: u64 = 100 * 1024 * 1024;

fn format_byte_size(bytes: u64) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = 1024.0 * 1024.0;
    const GB: f64 = 1024.0 * 1024.0 * 1024.0;
    let n = bytes as f64;
    if n >= GB {
        format!("{:.2} GB", n / GB)
    } else if n >= MB {
        format!("{:.1} MB", n / MB)
    } else if n >= KB {
        format!("{:.0} KB", n / KB)
    } else {
        format!("{bytes} B")
    }
}

/// List staged files whose index blob exceeds `limit_bytes` (default 100MB).
pub fn staged_large_files(
    git: &GitBinary,
    repo: &Path,
    limit_bytes: u64,
) -> Result<Vec<LargeFileInfo>, GitError> {
    let limit = if limit_bytes == 0 {
        LARGE_FILE_LIMIT_BYTES
    } else {
        limit_bytes
    };
    // Exclude deletions — no blob to measure.
    let listed = run_git(
        git,
        repo,
        &[
            "-c",
            "core.quotepath=false",
            "diff",
            "--cached",
            "--name-only",
            "--diff-filter=d",
        ],
    )?;
    let mut large = Vec::new();
    for path in listed.stdout.lines() {
        let path = path.trim();
        if path.is_empty() {
            continue;
        }
        let rev = format!(":{path}");
        let blob = match run_git(git, repo, &["rev-parse", "--verify", &rev]) {
            Ok(out) => out.stdout.trim().to_string(),
            Err(_) => continue,
        };
        if blob.is_empty() {
            continue;
        }
        let size_out = match run_git(git, repo, &["cat-file", "-s", &blob]) {
            Ok(out) => out,
            Err(_) => continue,
        };
        let size: u64 = size_out.stdout.trim().parse().unwrap_or(0);
        if size >= limit {
            large.push(LargeFileInfo {
                path: path.to_string(),
                size,
                size_label: format_byte_size(size),
            });
        }
    }
    large.sort_by(|a, b| b.size.cmp(&a.size).then_with(|| a.path.cmp(&b.path)));
    Ok(large)
}

pub fn discard_paths(git: &GitBinary, repo: &Path, paths: &[String]) -> Result<(), GitError> {
    if paths.is_empty() {
        return Ok(());
    }

    let mut tracked = Vec::new();
    let mut untracked = Vec::new();
    for path in paths {
        let check = run_git(git, repo, &["ls-files", "--", path]);
        match check {
            Ok(out) if !out.stdout.trim().is_empty() => tracked.push(path.clone()),
            _ => untracked.push(path.clone()),
        }
    }

    if !tracked.is_empty() {
        let mut args = vec!["restore".to_string(), "--worktree".to_string(), "--".to_string()];
        args.extend(tracked);
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        run_git(git, repo, &arg_refs)?;
    }

    for path in untracked {
        let full = confined_child(repo, &path)?;
        if full.is_dir() {
            std::fs::remove_dir_all(&full).map_err(|e| GitError::Io {
                path: full.display().to_string(),
                message: e.to_string(),
            })?;
        } else if full.exists() {
            std::fs::remove_file(&full).map_err(|e| GitError::Io {
                path: full.display().to_string(),
                message: e.to_string(),
            })?;
        }
    }

    Ok(())
}

pub fn file_diff(
    git: &GitBinary,
    repo: &Path,
    path: &str,
    staged: bool,
) -> Result<String, GitError> {
    let mut args = vec![
        "-c".to_string(),
        "core.quotepath=false".to_string(),
        "diff".to_string(),
    ];
    if staged {
        args.push("--cached".to_string());
    }
    args.push("--".to_string());
    args.push(path.to_string());
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let output = run_git(git, repo, &arg_refs)?;
    Ok(output.stdout)
}

pub fn read_identity(git: &GitBinary, repo: &Path) -> Result<Identity, GitError> {
    Ok(Identity {
        name: read_config(git, repo, "user.name")?,
        email: read_config(git, repo, "user.email")?,
    })
}

pub fn write_identity(
    git: &GitBinary,
    repo: &Path,
    name: &str,
    email: &str,
    global: bool,
) -> Result<(), GitError> {
    let name = name.trim();
    let email = email.trim();
    if name.is_empty() || email.is_empty() || !email.contains('@') || email.contains(char::is_whitespace)
    {
        return Err(GitError::InvalidInput(
            "请填写名字，以及包含 @ 的邮箱".to_string(),
        ));
    }
    let scope = if global { "--global" } else { "--local" };
    run_git(git, repo, &["config", scope, "user.name", name])?;
    run_git(git, repo, &["config", scope, "user.email", email])?;
    Ok(())
}

fn read_config(git: &GitBinary, repo: &Path, key: &str) -> Result<String, GitError> {
    match run_git(git, repo, &["config", "--get", key]) {
        Ok(output) => Ok(output.stdout.trim().to_string()),
        Err(GitError::CommandFailed { code: 1, .. }) => Ok(String::new()),
        Err(err) => Err(err),
    }
}

pub fn commit(git: &GitBinary, repo: &Path, message: &str) -> Result<String, GitError> {
    let message = message.trim();
    if message.is_empty() {
        return Err(GitError::InvalidInput(
            "提交说明不能为空".to_string(),
        ));
    }
    let output = run_git(git, repo, &["commit", "-m", message])?;
    Ok(output.stdout)
}

pub fn amend_commit(git: &GitBinary, repo: &Path, message: &str) -> Result<String, GitError> {
    if !has_commits(git, repo)? {
        return Err(GitError::InvalidInput("还没有提交可以修改。".to_string()));
    }
    if let Some(upstream) = upstream_of_head(git, repo)? {
        // Already pushed tip: refuse rewrite.
        match run_git(git, repo, &["rev-list", "--count", &format!("{upstream}..HEAD")]) {
            Ok(out) if out.stdout.trim() == "0" => {
                return Err(GitError::InvalidInput(
                    "最近一次提交已经推送到远程，不能在这里修改。".to_string(),
                ));
            }
            Ok(_) => {}
            Err(GitError::CommandFailed { .. }) => {}
            Err(err) => return Err(err),
        }
    }

    let message = message.trim();
    let output = if message.is_empty() {
        run_git(git, repo, &["commit", "--amend", "--no-edit"])?
    } else {
        run_git(git, repo, &["commit", "--amend", "-m", message])?
    };
    Ok(output.stdout)
}

pub fn clone_repository(
    git: &GitBinary,
    url: &str,
    destination: &Path,
    branch: Option<&str>,
    depth: Option<u32>,
) -> Result<String, GitError> {
    let url = url.trim();
    if !(url.starts_with("https://")
        || url.starts_with("http://")
        || url.starts_with("git@")
        || url.starts_with("ssh://"))
    {
        return Err(GitError::InvalidInput(
            "请填写有效的仓库地址（https:// 或 git@）".to_string(),
        ));
    }

    let branch = branch.map(str::trim).filter(|s| !s.is_empty());
    let depth = depth.filter(|d| *d > 0);
    let depth_str = depth.map(|d| d.to_string());

    let mut args: Vec<&str> = vec!["clone", "--progress"];
    if let Some(b) = branch {
        args.push("--branch");
        args.push(b);
    }
    if let Some(ref d) = depth_str {
        args.push("--depth");
        args.push(d.as_str());
    }

    if destination.exists() {
        let is_empty = std::fs::read_dir(destination)
            .map_err(|e| GitError::Io {
                path: destination.display().to_string(),
                message: e.to_string(),
            })?
            .next()
            .is_none();
        if !is_empty {
            return Err(GitError::InvalidInput(
                "目标文件夹不是空的，请换一个空目录。".to_string(),
            ));
        }
        args.push(url);
        args.push(".");
        let output = run_git_timeout(git, destination, &args, 300)?;
        return Ok(combine_output(&output));
    }

    let parent = destination.parent().ok_or_else(|| {
        GitError::InvalidPath(destination.display().to_string())
    })?;
    if !parent.exists() {
        std::fs::create_dir_all(parent).map_err(|e| GitError::Io {
            path: parent.display().to_string(),
            message: e.to_string(),
        })?;
    }
    let folder_name = destination
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| GitError::InvalidPath(destination.display().to_string()))?;
    args.push(url);
    args.push(folder_name);
    let output = run_git_timeout(git, parent, &args, 300)?;
    Ok(combine_output(&output))
}

pub fn delete_branch(
    git: &GitBinary,
    repo: &Path,
    name: &str,
    force: bool,
) -> Result<String, GitError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(GitError::InvalidInput("分支名不能为空".to_string()));
    }
    if current_branch(git, repo)?.as_deref() == Some(name) {
        return Err(GitError::InvalidInput(
            "不能删除当前所在分支，请先切换到其他分支。".to_string(),
        ));
    }
    let flag = if force { "-D" } else { "-d" };
    match run_git(git, repo, &["branch", flag, name]) {
        Ok(output) => Ok(combine_output(&output)),
        Err(GitError::CommandFailed { stderr, stdout, code }) if !force => {
            let text = format!("{stderr}\n{stdout}");
            let lower = text.to_ascii_lowercase();
            if lower.contains("not fully merged") || lower.contains("isn't fully merged") {
                Err(GitError::InvalidInput(format!(
                    "BRANCH_NOT_MERGED:{name}"
                )))
            } else {
                Err(GitError::CommandFailed { code, stderr, stdout })
            }
        }
        Err(err) => Err(err),
    }
}

pub fn merge_branch(git: &GitBinary, repo: &Path, name: &str) -> Result<String, GitError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(GitError::InvalidInput("请选择要合并的分支".to_string()));
    }
    if current_branch(git, repo)?.as_deref() == Some(name) {
        return Err(GitError::InvalidInput("不能把当前分支合并到自己。".to_string()));
    }
    match run_git(git, repo, &["merge", "--no-edit", name]) {
        Ok(output) => Ok(combine_output(&output)),
        Err(GitError::CommandFailed { stderr, stdout, code }) => {
            let text = format!("{stderr}\n{stdout}");
            if text.contains("CONFLICT") || text.contains("fix conflict") {
                Err(GitError::InvalidInput(format!(
                    "合并产生冲突。请在左侧处理冲突文件并暂存，然后点「继续」，或点「放弃」。\n{text}"
                )))
            } else {
                Err(GitError::CommandFailed { code, stderr, stdout })
            }
        }
        Err(err) => Err(err),
    }
}

pub fn cherry_pick(git: &GitBinary, repo: &Path, hash: &str) -> Result<String, GitError> {
    if !is_hex_hash(hash) {
        return Err(GitError::InvalidInput("提交哈希无效".to_string()));
    }
    match run_git(git, repo, &["cherry-pick", hash]) {
        Ok(output) => Ok(combine_output(&output)),
        Err(GitError::CommandFailed { stderr, stdout, code }) => {
            let text = format!("{stderr}\n{stdout}");
            if text.contains("CONFLICT") || text.contains("conflict") {
                Err(GitError::InvalidInput(format!(
                    "拣选产生冲突。请在左侧处理冲突文件并暂存，然后点「继续」，或点「放弃」。\n{text}"
                )))
            } else {
                Err(GitError::CommandFailed { code, stderr, stdout })
            }
        }
        Err(err) => Err(err),
    }
}

pub fn revert_commit(git: &GitBinary, repo: &Path, hash: &str) -> Result<String, GitError> {
    if !is_hex_hash(hash) {
        return Err(GitError::InvalidInput("提交哈希无效".to_string()));
    }
    match run_git(git, repo, &["revert", "--no-edit", hash]) {
        Ok(output) => {
            let text = combine_output(&output);
            if text.trim().is_empty() {
                Ok(format!("已还原提交 {}", short_hash(hash)))
            } else {
                Ok(text)
            }
        }
        Err(GitError::CommandFailed { stderr, stdout, code }) => {
            let text = format!("{stderr}\n{stdout}");
            if text.contains("CONFLICT") || text.contains("conflict") {
                Err(GitError::InvalidInput(format!(
                    "还原产生冲突。请在左侧处理冲突文件并暂存，然后点「继续」，或点「放弃」。\n{text}"
                )))
            } else {
                Err(GitError::CommandFailed { code, stderr, stdout })
            }
        }
        Err(err) => Err(err),
    }
}

fn short_hash(hash: &str) -> &str {
    let h = hash.trim();
    if h.len() > 7 {
        &h[..7]
    } else {
        h
    }
}

pub fn rename_branch(
    git: &GitBinary,
    repo: &Path,
    old_name: &str,
    new_name: &str,
) -> Result<String, GitError> {
    let old_name = old_name.trim();
    let new_name = new_name.trim();
    if old_name.is_empty() || new_name.is_empty() {
        return Err(GitError::InvalidInput("请填写原分支名和新分支名".to_string()));
    }
    if old_name == new_name {
        return Err(GitError::InvalidInput("新分支名与原名相同".to_string()));
    }
    run_git(git, repo, &["branch", "-m", old_name, new_name])?;
    Ok(format!("已将分支「{old_name}」重命名为「{new_name}」"))
}

pub fn checkout_commit(
    git: &GitBinary,
    repo: &Path,
    hash: &str,
    new_branch: Option<&str>,
) -> Result<String, GitError> {
    if !is_hex_hash(hash) {
        return Err(GitError::InvalidInput("提交哈希无效".to_string()));
    }
    let branch = new_branch.map(str::trim).filter(|s| !s.is_empty());
    if let Some(name) = branch {
        run_git(git, repo, &["checkout", "-b", name, hash])?;
        Ok(format!("已从 {} 创建并切换到分支「{name}」", short_hash(hash)))
    } else {
        run_git(git, repo, &["checkout", "--detach", hash])?;
        Ok(format!(
            "已检出到 {}（游离 HEAD）。可再从此点新建分支。",
            short_hash(hash)
        ))
    }
}

pub fn add_to_gitignore(git: &GitBinary, repo: &Path, paths: &[String]) -> Result<String, GitError> {
    let _ = git;
    let mut entries: Vec<String> = Vec::new();
    for raw in paths {
        let p = raw.trim().replace('\\', "/");
        if p.is_empty() || p.contains('\0') {
            continue;
        }
        entries.push(p);
    }
    if entries.is_empty() {
        return Err(GitError::InvalidInput("请选择要忽略的路径".to_string()));
    }
    let ignore_path = repo.join(".gitignore");
    let existing = if ignore_path.is_file() {
        std::fs::read_to_string(&ignore_path).unwrap_or_default()
    } else {
        String::new()
    };
    let existing_set: std::collections::HashSet<&str> = existing
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .collect();
    let mut added = Vec::new();
    let mut block = String::new();
    for entry in &entries {
        if existing_set.contains(entry.as_str()) {
            continue;
        }
        block.push_str(entry);
        block.push('\n');
        added.push(entry.clone());
    }
    if added.is_empty() {
        return Ok("所选路径已在 .gitignore 中".to_string());
    }
    let mut out = existing;
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    out.push_str(&block);
    std::fs::write(&ignore_path, out).map_err(|e| {
        GitError::Io {
            path: ignore_path.display().to_string(),
            message: e.to_string(),
        }
    })?;
    Ok(format!("已写入 .gitignore：{}", added.join("、")))
}

pub fn list_file_commits(
    git: &GitBinary,
    repo: &Path,
    file: &str,
    limit: u32,
) -> Result<Vec<CommitInfo>, GitError> {
    let file = file.trim().replace('\\', "/");
    if file.is_empty() {
        return Err(GitError::InvalidInput("请指定文件路径".to_string()));
    }
    let limit = limit.clamp(1, 200).to_string();
    let output = run_git(
        git,
        repo,
        &[
            "log",
            "-n",
            &limit,
            "--follow",
            "--decorate=short",
            "--date=short",
            "--pretty=format:%H%x1f%h%x1f%an%x1f%ad%x1f%s%x1f%P%x1f%d%x1e",
            "--",
            &file,
        ],
    )?;
    Ok(parse_commits(&output.stdout))
}

fn rebase_in_progress(git: &GitBinary, repo: &Path) -> Result<bool, GitError> {
    let git_dir = match run_git(git, repo, &["rev-parse", "--git-dir"]) {
        Ok(out) => {
            let raw = out.stdout.trim();
            let p = Path::new(raw);
            if p.is_absolute() {
                p.to_path_buf()
            } else {
                repo.join(p)
            }
        }
        Err(GitError::CommandFailed { .. }) => return Ok(false),
        Err(err) => return Err(err),
    };
    Ok(git_dir.join("rebase-merge").is_dir() || git_dir.join("rebase-apply").is_dir())
}

fn ongoing_operation(git: &GitBinary, repo: &Path) -> Result<Option<&'static str>, GitError> {
    if rebase_in_progress(git, repo)? {
        return Ok(Some("rebase"));
    }
    match run_git(git, repo, &["rev-parse", "--verify", "--quiet", "CHERRY_PICK_HEAD"]) {
        Ok(_) => return Ok(Some("cherry-pick")),
        Err(GitError::CommandFailed { .. }) => {}
        Err(err) => return Err(err),
    }
    match run_git(git, repo, &["rev-parse", "--verify", "--quiet", "REVERT_HEAD"]) {
        Ok(_) => return Ok(Some("revert")),
        Err(GitError::CommandFailed { .. }) => {}
        Err(err) => return Err(err),
    }
    match run_git(git, repo, &["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]) {
        Ok(_) => Ok(Some("merge")),
        Err(GitError::CommandFailed { .. }) => Ok(None),
        Err(err) => Err(err),
    }
}

pub fn abort_operation(git: &GitBinary, repo: &Path) -> Result<String, GitError> {
    match ongoing_operation(git, repo)? {
        Some("rebase") => {
            let output = run_git(git, repo, &["rebase", "--abort"])?;
            Ok(combine_output(&output))
        }
        Some("cherry-pick") => {
            let output = run_git(git, repo, &["cherry-pick", "--abort"])?;
            Ok(combine_output(&output))
        }
        Some("revert") => {
            let output = run_git(git, repo, &["revert", "--abort"])?;
            Ok(combine_output(&output))
        }
        Some("merge") => {
            let output = run_git(git, repo, &["merge", "--abort"])?;
            Ok(combine_output(&output))
        }
        _ => Err(GitError::InvalidInput(
            "当前没有进行中的合并、拣选、还原或变基。".to_string(),
        )),
    }
}

pub fn continue_operation(git: &GitBinary, repo: &Path) -> Result<String, GitError> {
    let op = ongoing_operation(git, repo)?.ok_or_else(|| {
        GitError::InvalidInput("当前没有进行中的合并、拣选、还原或变基。".to_string())
    })?;

    let status = repo_status(git, repo)?;
    if status.changes.iter().any(|c| c.conflicted) {
        return Err(GitError::InvalidInput(
            "还有未解决的冲突文件。请先改完并暂存，再点「继续」。".to_string(),
        ));
    }

    let output = match op {
        "rebase" => run_git(git, repo, &["rebase", "--continue"])?,
        "cherry-pick" => run_git(git, repo, &["cherry-pick", "--continue"])?,
        "revert" => run_git(git, repo, &["revert", "--continue"])?,
        // Merge: finish with the prepared merge message, no editor.
        _ => run_git(git, repo, &["commit", "--no-edit"])?,
    };
    let text = combine_output(&output);
    Ok(if text.trim().is_empty() {
        match op {
            "rebase" => "变基已完成。".to_string(),
            "cherry-pick" => "拣选已完成。".to_string(),
            "revert" => "还原已完成。".to_string(),
            _ => "合并已完成。".to_string(),
        }
    } else {
        text
    })
}

/// Skip the current commit during an in-progress rebase (`git rebase --skip`).
pub fn skip_rebase(git: &GitBinary, repo: &Path) -> Result<String, GitError> {
    let op = ongoing_operation(git, repo)?;
    if op != Some("rebase") {
        return Err(GitError::InvalidInput(
            "当前没有进行中的变基，无法跳过。".to_string(),
        ));
    }
    match run_git(git, repo, &["rebase", "--skip"]) {
        Ok(output) => {
            let text = combine_output(&output);
            Ok(if text.trim().is_empty() {
                "已跳过当前提交，变基继续。".to_string()
            } else {
                text
            })
        }
        Err(GitError::CommandFailed { code, stderr, stdout }) => {
            let text = format!("{stderr}\n{stdout}");
            if text.to_ascii_lowercase().contains("conflict")
                || repo_status(git, repo)
                    .map(|s| s.changes.iter().any(|c| c.conflicted))
                    .unwrap_or(false)
            {
                Err(GitError::InvalidInput(format!(
                    "跳过后仍有冲突，请解决并暂存后点「继续」。\n{text}"
                )))
            } else {
                Err(GitError::CommandFailed { code, stderr, stdout })
            }
        }
        Err(err) => Err(err),
    }
}

pub fn rebase_branch(git: &GitBinary, repo: &Path, onto: &str) -> Result<String, GitError> {
    let onto = onto.trim();
    if onto.is_empty() {
        return Err(GitError::InvalidInput("请选择要变基到的分支".to_string()));
    }
    if ongoing_operation(git, repo)?.is_some() {
        return Err(GitError::InvalidInput(
            "已有进行中的合并/拣选/变基，请先继续或放弃。".to_string(),
        ));
    }
    match run_git(git, repo, &["rebase", onto]) {
        Ok(output) => Ok(combine_output(&output)),
        Err(GitError::CommandFailed { code, stderr, stdout }) => {
            let text = format!("{stderr}\n{stdout}");
            if text.to_ascii_lowercase().contains("conflict")
                || repo_status(git, repo)
                    .map(|s| s.changes.iter().any(|c| c.conflicted))
                    .unwrap_or(false)
            {
                Err(GitError::InvalidInput(format!(
                    "变基出现冲突，请在左侧解决并暂存后点「继续」。\n{text}"
                )))
            } else {
                Err(GitError::CommandFailed { code, stderr, stdout })
            }
        }
        Err(err) => Err(err),
    }
}

/// Commits that would be replayed by `git rebase <onto>` (oldest first).
pub fn list_rebase_todo(
    git: &GitBinary,
    repo: &Path,
    onto: &str,
) -> Result<Vec<CommitInfo>, GitError> {
    let onto = onto.trim();
    if onto.is_empty() {
        return Err(GitError::InvalidInput("请选择变基目标分支".to_string()));
    }
    let range = format!("{onto}..HEAD");
    match run_git(
        git,
        repo,
        &[
            "log",
            "--reverse",
            "--date=short",
            "--pretty=format:%H%x1f%h%x1f%an%x1f%ad%x1f%s%x1f%P%x1f%d%x1e",
            &range,
        ],
    ) {
        Ok(output) => Ok(parse_commits(&output.stdout)),
        Err(GitError::CommandFailed { stderr, stdout, .. })
            if format!("{stderr}{stdout}").contains("unknown revision")
                || format!("{stderr}{stdout}").contains("Invalid revision") =>
        {
            Err(GitError::InvalidInput(format!(
                "找不到分支或提交「{onto}」"
            )))
        }
        Err(err) => Err(err),
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseTodoItem {
    pub action: String,
    pub hash: String,
    pub subject: String,
}

/// Interactive rebase driven by a UI-planned todo (pick/squash/fixup/drop + order).
pub fn rebase_interactive(
    git: &GitBinary,
    repo: &Path,
    onto: &str,
    items: &[RebaseTodoItem],
) -> Result<String, GitError> {
    let onto = onto.trim();
    if onto.is_empty() {
        return Err(GitError::InvalidInput("请选择要变基到的分支".to_string()));
    }
    if items.is_empty() {
        return Err(GitError::InvalidInput("没有可回放的提交".to_string()));
    }
    if ongoing_operation(git, repo)?.is_some() {
        return Err(GitError::InvalidInput(
            "已有进行中的合并/拣选/变基，请先继续或放弃。".to_string(),
        ));
    }

    let mut todo_body = String::new();
    let mut kept = 0u32;
    for item in items {
        let action = item.action.trim().to_ascii_lowercase();
        let action = match action.as_str() {
            "pick" | "p" => "pick",
            "squash" | "s" => "squash",
            "fixup" | "f" => "fixup",
            "drop" | "d" => "drop",
            other => {
                return Err(GitError::InvalidInput(format!(
                    "不支持的变基动作：{other}（可用 pick / squash / fixup / drop）"
                )));
            }
        };
        let hash = item.hash.trim();
        if hash.is_empty() {
            return Err(GitError::InvalidInput("提交哈希无效".to_string()));
        }
        if action != "drop" {
            kept += 1;
        }
        let subject = item.subject.replace(['\r', '\n'], " ");
        todo_body.push_str(&format!("{action} {hash} {subject}\n"));
    }
    if kept == 0 {
        return Err(GitError::InvalidInput(
            "全部提交都被丢弃了，请至少保留一个 pick/squash/fixup".to_string(),
        ));
    }
    // First non-drop must be pick (squash/fixup need a previous commit).
    for item in items {
        let a = item.action.trim().to_ascii_lowercase();
        if a == "drop" || a == "d" {
            continue;
        }
        if a != "pick" && a != "p" {
            return Err(GitError::InvalidInput(
                "第一条有效提交必须是 pick（不能以 squash/fixup 开头）".to_string(),
            ));
        }
        break;
    }

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let planned = std::env::temp_dir().join(format!(
        "qingzhi-rebase-todo-{}-{}.txt",
        std::process::id(),
        stamp
    ));
    let editor_script = std::env::temp_dir().join(format!(
        "qingzhi-rebase-editor-{}-{}.cmd",
        std::process::id(),
        stamp
    ));
    std::fs::write(&planned, todo_body.as_bytes()).map_err(|e| GitError::Io {
        path: planned.display().to_string(),
        message: e.to_string(),
    })?;
    // Windows: overwrite Git's todo path with our planned file.
    let script = format!(
        "@echo off\r\ncopy /Y \"{}\" \"%~1\" >nul\r\nexit /B %ERRORLEVEL%\r\n",
        planned.display()
    );
    std::fs::write(&editor_script, script.as_bytes()).map_err(|e| GitError::Io {
        path: editor_script.display().to_string(),
        message: e.to_string(),
    })?;

    // Prefer Git-for-Windows `true.exe` next to git; fall back to cmd exit 0.
    let true_editor = git
        .path
        .parent()
        .and_then(|p| p.parent())
        .map(|root| root.join("usr").join("bin").join("true.exe"))
        .filter(|p| p.is_file())
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| "cmd /C exit 0".to_string());

    let seq_editor = editor_script.display().to_string();
    let result = run_git_with_env(
        git,
        repo,
        &["rebase", "-i", onto],
        &[
            ("GIT_SEQUENCE_EDITOR", seq_editor.as_str()),
            ("GIT_EDITOR", true_editor.as_str()),
            ("EDITOR", true_editor.as_str()),
        ],
        180,
    );
    let _ = std::fs::remove_file(&planned);
    let _ = std::fs::remove_file(&editor_script);

    match result {
        Ok(output) => Ok(combine_output(&output)),
        Err(GitError::CommandFailed { code, stderr, stdout }) => {
            let text = format!("{stderr}\n{stdout}");
            if text.to_ascii_lowercase().contains("conflict")
                || repo_status(git, repo)
                    .map(|s| s.changes.iter().any(|c| c.conflicted))
                    .unwrap_or(false)
            {
                Err(GitError::InvalidInput(format!(
                    "交互变基出现冲突，请解决并暂存后点「继续」。\n{text}"
                )))
            } else {
                Err(GitError::CommandFailed { code, stderr, stdout })
            }
        }
        Err(err) => Err(err),
    }
}

pub fn apply_cached_patch(
    git: &GitBinary,
    repo: &Path,
    patch: &str,
    reverse: bool,
) -> Result<String, GitError> {
    apply_patch_internal(git, repo, patch, reverse, true)
}

/// Apply / reverse a hunk against the working tree (discard unstaged hunk).
pub fn apply_workdir_patch(
    git: &GitBinary,
    repo: &Path,
    patch: &str,
    reverse: bool,
) -> Result<String, GitError> {
    apply_patch_internal(git, repo, patch, reverse, false)
}

/// Resolve a repo-relative path and ensure it stays inside the work tree.
fn resolve_workdir_path(repo: &Path, relative: &str) -> Result<std::path::PathBuf, GitError> {
    let relative = relative.trim().replace('\\', "/");
    if relative.is_empty()
        || relative.starts_with('/')
        || relative.starts_with("../")
        || relative.contains("/../")
        || relative == ".."
    {
        return Err(GitError::InvalidInput("文件路径无效".to_string()));
    }
    let repo = repo
        .canonicalize()
        .map_err(|e| GitError::Io {
            path: repo.display().to_string(),
            message: e.to_string(),
        })?;
    let full = repo.join(&relative);
    let parent = full.parent().unwrap_or(repo.as_path());
    // Canonicalize parent when the file may not exist yet (write).
    let canon_parent = if parent.exists() {
        parent.canonicalize().map_err(|e| GitError::Io {
            path: parent.display().to_string(),
            message: e.to_string(),
        })?
    } else {
        return Err(GitError::InvalidInput("文件目录不存在".to_string()));
    };
    if !canon_parent.starts_with(&repo) {
        return Err(GitError::InvalidInput("文件路径越界".to_string()));
    }
    Ok(canon_parent.join(full.file_name().unwrap_or_default()))
}

/// Read a UTF-8 (lossy) worktree file for conflict editing etc.
pub fn read_workdir_file(repo: &Path, relative: &str) -> Result<String, GitError> {
    let path = resolve_workdir_path(repo, relative)?;
    let bytes = std::fs::read(&path).map_err(|e| GitError::Io {
        path: path.display().to_string(),
        message: e.to_string(),
    })?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Write text into a worktree file (conflict resolution).
pub fn write_workdir_file(repo: &Path, relative: &str, content: &str) -> Result<(), GitError> {
    let path = resolve_workdir_path(repo, relative)?;
    std::fs::write(&path, content.as_bytes()).map_err(|e| GitError::Io {
        path: path.display().to_string(),
        message: e.to_string(),
    })?;
    Ok(())
}

fn apply_patch_internal(
    git: &GitBinary,
    repo: &Path,
    patch: &str,
    reverse: bool,
    cached: bool,
) -> Result<String, GitError> {
    let patch = patch.trim_start_matches('\u{feff}');
    if patch.trim().is_empty() {
        return Err(GitError::InvalidInput("补丁内容为空".to_string()));
    }
    let file = std::env::temp_dir().join(format!(
        "qingzhi-hunk-{}-{}.patch",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    ));
    std::fs::write(&file, patch).map_err(|e| GitError::Io {
        path: file.display().to_string(),
        message: e.to_string(),
    })?;
    let path_arg = file.to_string_lossy().to_string();
    let mut args = vec!["apply", "--whitespace=nowarn"];
    if cached {
        args.push("--cached");
    }
    if reverse {
        args.push("--reverse");
    }
    args.push(&path_arg);
    let result = run_git(git, repo, &args);
    let _ = std::fs::remove_file(&file);
    match result {
        Ok(output) => Ok(combine_output(&output)),
        Err(err) => Err(err),
    }
}

pub fn delete_tag(git: &GitBinary, repo: &Path, name: &str) -> Result<String, GitError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(GitError::InvalidInput("标签名不能为空".to_string()));
    }
    let output = run_git(git, repo, &["tag", "-d", name])?;
    Ok(combine_output(&output))
}

pub fn list_branches(git: &GitBinary, repo: &Path) -> Result<Vec<BranchInfo>, GitError> {
    let output = run_git(
        git,
        repo,
        &[
            "for-each-ref",
            "--format=%(refname:short)%00%(HEAD)%00%(upstream:short)%00%(objectname:short)",
            "refs/heads",
        ],
    )?;

    let mut branches = Vec::new();
    for line in output.stdout.lines() {
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split('\0').collect();
        if parts.len() < 4 {
            continue;
        }
        branches.push(BranchInfo {
            name: parts[0].to_string(),
            is_current: parts[1] == "*",
            upstream: if parts[2].is_empty() {
                None
            } else {
                Some(parts[2].to_string())
            },
            tip: parts[3].to_string(),
        });
    }
    Ok(branches)
}

pub fn create_branch(git: &GitBinary, repo: &Path, name: &str) -> Result<(), GitError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(GitError::InvalidInput("分支名不能为空".to_string()));
    }
    run_git(git, repo, &["branch", name])?;
    Ok(())
}

pub fn set_upstream(
    git: &GitBinary,
    repo: &Path,
    remote: &str,
    branch: &str,
    local_branch: Option<&str>,
) -> Result<String, GitError> {
    let remote = remote.trim();
    let branch = branch.trim();
    if remote.is_empty() || branch.is_empty() {
        return Err(GitError::InvalidInput("请填写远程名和分支名".to_string()));
    }
    let upstream = format!("{remote}/{branch}");
    let local = local_branch.map(str::trim).filter(|s| !s.is_empty());
    if let Some(local) = local {
        run_git(
            git,
            repo,
            &["branch", "--set-upstream-to", &upstream, local],
        )?;
        Ok(format!("已将「{local}」的上游设为 {upstream}"))
    } else {
        run_git(
            git,
            repo,
            &["branch", "--set-upstream-to", &upstream],
        )?;
        Ok(format!("已设置上游为 {upstream}"))
    }
}

pub fn checkout_branch(git: &GitBinary, repo: &Path, name: &str) -> Result<(), GitError> {
    run_git(git, repo, &["checkout", name])?;
    Ok(())
}

pub fn list_remote_branches(
    git: &GitBinary,
    repo: &Path,
) -> Result<Vec<RemoteBranchInfo>, GitError> {
    let locals: std::collections::HashSet<String> = list_branches(git, repo)?
        .into_iter()
        .map(|b| b.name)
        .collect();

    let output = run_git(
        git,
        repo,
        &[
            "for-each-ref",
            "--format=%(refname:short)%00%(objectname:short)",
            "refs/remotes",
        ],
    )?;

    let mut branches = Vec::new();
    for line in output.stdout.lines() {
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split('\0').collect();
        if parts.len() < 2 {
            continue;
        }
        let full = parts[0];
        // Skip origin/HEAD
        if full.ends_with("/HEAD") || full == "HEAD" {
            continue;
        }
        let Some((remote, branch)) = full.split_once('/') else {
            continue;
        };
        if remote.is_empty() || branch.is_empty() {
            continue;
        }
        branches.push(RemoteBranchInfo {
            name: full.to_string(),
            remote: remote.to_string(),
            branch: branch.to_string(),
            tip: parts[1].to_string(),
            has_local: locals.contains(branch),
        });
    }
    Ok(branches)
}

pub fn checkout_remote_branch(
    git: &GitBinary,
    repo: &Path,
    remote_ref: &str,
) -> Result<String, GitError> {
    let remote_ref = remote_ref.trim();
    // origin/feature/foo -> remote=origin, branch=feature/foo
    let mut parts = remote_ref.splitn(2, '/');
    let remote = parts.next().unwrap_or("");
    let branch = parts.next().unwrap_or("");
    if remote.is_empty() || branch.is_empty() {
        return Err(GitError::InvalidInput(
            "远程分支格式无效，应为 origin/分支名".to_string(),
        ));
    }

    let locals = list_branches(git, repo)?;
    if let Some(existing) = locals.iter().find(|b| b.name == branch) {
        if existing.is_current {
            return Ok(format!("已在本地分支「{branch}」上。"));
        }
        run_git(git, repo, &["checkout", branch])?;
        return Ok(format!("已切换到本地分支「{branch}」。"));
    }

    let track = format!("{remote}/{branch}");
    let output = run_git(
        git,
        repo,
        &["checkout", "-b", branch, "--track", &track],
    )?;
    Ok(format!(
        "已创建并切换到「{branch}」，跟踪 {track}。\n{}",
        combine_output(&output)
    ))
}

pub fn undo_last_commit(git: &GitBinary, repo: &Path) -> Result<String, GitError> {
    if !has_commits(git, repo)? {
        return Err(GitError::InvalidInput("还没有提交可以撤销。".to_string()));
    }

    // Refuse rewriting a tip that is already on the remote.
    if let Some(upstream) = upstream_of_head(git, repo)? {
        match run_git(
            git,
            repo,
            &["rev-list", "--count", &format!("{upstream}..HEAD")],
        ) {
            Ok(out) if out.stdout.trim() == "0" => {
                return Err(GitError::InvalidInput(
                    "最近一次提交已经推送到远程，不能在这里撤销。".to_string(),
                ));
            }
            Ok(_) => {}
            Err(GitError::CommandFailed { .. }) => {}
            Err(err) => return Err(err),
        }
    }

    // Root commit: HEAD~1 does not exist.
    match run_git(git, repo, &["rev-parse", "--verify", "HEAD~1"]) {
        Ok(_) => {}
        Err(GitError::CommandFailed { .. }) => {
            return Err(GitError::InvalidInput(
                "这是仓库的第一次提交，无法用撤销保留历史。可放弃文件改动或继续在此基础上修改。".to_string(),
            ));
        }
        Err(err) => return Err(err),
    }

    run_git(git, repo, &["reset", "--soft", "HEAD~1"])?;
    Ok("已撤销最近一次提交，改动仍保留在暂存区。".to_string())
}

pub fn reset_to_commit(
    git: &GitBinary,
    repo: &Path,
    hash: &str,
    mode: &str,
) -> Result<String, GitError> {
    if !is_hex_hash(hash) {
        return Err(GitError::InvalidInput("提交哈希无效".to_string()));
    }
    if ongoing_operation(git, repo)?.is_some() {
        return Err(GitError::InvalidInput(
            "当前有未完成的合并或拣选，请先继续或放弃，再重置。".to_string(),
        ));
    }
    let flag = match mode.trim().to_ascii_lowercase().as_str() {
        "soft" => "--soft",
        "mixed" | "" => "--mixed",
        "hard" => "--hard",
        _ => {
            return Err(GitError::InvalidInput(
                "重置模式无效，请使用 soft / mixed / hard。".to_string(),
            ));
        }
    };

    // Ensure the commit exists.
    run_git(git, repo, &["rev-parse", "--verify", hash])?;

    // Refuse resets that would drop commits already on the upstream tip.
    if let Some(upstream) = upstream_of_head(git, repo)? {
        match run_git(
            git,
            repo,
            &["merge-base", "--is-ancestor", &upstream, hash],
        ) {
            Ok(_) => {}
            Err(GitError::CommandFailed { .. }) => {
                return Err(GitError::InvalidInput(
                    "该重置会丢掉已经推送到远程的提交。请先确认，或改用「撤销上次」仅撤销未推送的提交。"
                        .to_string(),
                ));
            }
            Err(err) => return Err(err),
        }
    }

    let output = run_git(git, repo, &["reset", flag, hash])?;
    let label = match flag {
        "--soft" => "软重置完成：提交已回退，改动仍在暂存区。",
        "--hard" => "硬重置完成：提交与工作区都已回到该版本，未提交改动已丢弃。",
        _ => "混合重置完成：提交已回退，改动留在未暂存区。",
    };
    let text = combine_output(&output);
    if text.trim().is_empty() {
        Ok(format!("{label}\n目标：{hash}"))
    } else {
        Ok(format!("{label}\n{text}"))
    }
}

pub fn delete_remote_branch(
    git: &GitBinary,
    repo: &Path,
    remote_ref: &str,
) -> Result<String, GitError> {
    let remote_ref = remote_ref.trim();
    let mut parts = remote_ref.splitn(2, '/');
    let remote = parts.next().unwrap_or("");
    let branch = parts.next().unwrap_or("");
    if remote.is_empty() || branch.is_empty() {
        return Err(GitError::InvalidInput(
            "远程分支格式无效，应为 origin/分支名".to_string(),
        ));
    }
    let output = run_git_timeout(
        git,
        repo,
        &["push", remote, "--delete", branch],
        180,
    )?;
    // Drop stale remote-tracking ref.
    let _ = run_git(git, repo, &["fetch", "--prune", remote]);
    let text = combine_output(&output);
    if text.trim().is_empty() {
        Ok(format!("已删除远程分支 {remote}/{branch}"))
    } else {
        Ok(text)
    }
}

pub fn list_remotes(git: &GitBinary, repo: &Path) -> Result<Vec<RemoteInfo>, GitError> {
    let output = run_git(git, repo, &["remote", "-v"])?;
    let mut remotes = Vec::new();
    for line in output.stdout.lines() {
        let mut parts = line.split_whitespace();
        let Some(name) = parts.next() else { continue };
        let Some(url) = parts.next() else { continue };
        let Some(kind) = parts.next() else { continue };
        if kind != "(fetch)" {
            continue;
        }
        remotes.push(RemoteInfo {
            name: name.to_string(),
            url: url.to_string(),
        });
    }
    Ok(remotes)
}

pub fn set_remote_url(git: &GitBinary, repo: &Path, name: &str, url: &str) -> Result<(), GitError> {
    let name = name.trim();
    let url = url.trim();
    if name.is_empty() || url.is_empty() {
        return Err(GitError::InvalidInput("请填写远程名称和地址".to_string()));
    }
    let existing = list_remotes(git, repo)?;
    if existing.iter().any(|remote| remote.name == name) {
        run_git(git, repo, &["remote", "set-url", name, url])?;
    } else {
        run_git(git, repo, &["remote", "add", name, url])?;
    }
    Ok(())
}

fn current_branch(git: &GitBinary, repo: &Path) -> Result<Option<String>, GitError> {
    match run_git(git, repo, &["symbolic-ref", "--short", "HEAD"]) {
        Ok(output) => {
            let name = output.stdout.trim();
            if name.is_empty() {
                Ok(None)
            } else {
                Ok(Some(name.to_string()))
            }
        }
        Err(GitError::CommandFailed { .. }) => Ok(None),
        Err(err) => Err(err),
    }
}

fn upstream_of_head(git: &GitBinary, repo: &Path) -> Result<Option<String>, GitError> {
    match run_git(
        git,
        repo,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    ) {
        Ok(output) => {
            let name = output.stdout.trim();
            if name.is_empty() {
                Ok(None)
            } else {
                Ok(Some(name.to_string()))
            }
        }
        Err(GitError::CommandFailed { .. }) => Ok(None),
        Err(err) => Err(err),
    }
}

fn default_remote(git: &GitBinary, repo: &Path) -> Result<String, GitError> {
    let remotes = list_remotes(git, repo)?;
    if remotes.is_empty() {
        return Err(GitError::InvalidInput(
            "还没有远程仓库。请先填写 GitHub / Gitee 等地址并保存。".to_string(),
        ));
    }
    if let Some(origin) = remotes.iter().find(|remote| remote.name == "origin") {
        return Ok(origin.name.clone());
    }
    Ok(remotes[0].name.clone())
}

pub fn fetch(git: &GitBinary, repo: &Path, remote: Option<&str>) -> Result<String, GitError> {
    let remote = remote.map(str::trim).filter(|s| !s.is_empty());
    let output = if remote.map(|r| r.eq_ignore_ascii_case("all")).unwrap_or(false) {
        run_git_timeout(
            git,
            repo,
            &["fetch", "--all", "--prune", "--progress"],
            180,
        )?
    } else {
        let name = match remote {
            Some(r) => r.to_string(),
            None => default_remote(git, repo)?,
        };
        run_git_timeout(
            git,
            repo,
            &["fetch", "--prune", "--progress", &name],
            180,
        )?
    };
    let text = combine_output(&output);
    if text.trim().is_empty() {
        Ok("获取完成。".to_string())
    } else {
        Ok(text)
    }
}

fn remote_branch_exists(git: &GitBinary, repo: &Path, remote: &str, branch: &str) -> Result<bool, GitError> {
    let refname = format!("refs/remotes/{remote}/{branch}");
    match run_git(git, repo, &["show-ref", "--verify", "--quiet", &refname]) {
        Ok(_) => Ok(true),
        Err(GitError::CommandFailed { .. }) => Ok(false),
        Err(err) => Err(err),
    }
}

fn remote_default_branch(git: &GitBinary, repo: &Path, remote: &str) -> Result<Option<String>, GitError> {
    // After fetch: refs/remotes/<remote>/HEAD -> refs/remotes/<remote>/<branch>
    match run_git(
        git,
        repo,
        &["symbolic-ref", "--quiet", &format!("refs/remotes/{remote}/HEAD")],
    ) {
        Ok(output) => {
            let value = output.stdout.trim();
            let prefix = format!("refs/remotes/{remote}/");
            if let Some(name) = value.strip_prefix(&prefix) {
                if !name.is_empty() {
                    return Ok(Some(name.to_string()));
                }
            }
        }
        Err(GitError::CommandFailed { .. }) => {}
        Err(err) => return Err(err),
    }

    // Fallback: ls-remote --symref
    match run_git(git, repo, &["ls-remote", "--symref", remote, "HEAD"]) {
        Ok(output) => {
            for line in output.stdout.lines() {
                // ref: refs/heads/main\tHEAD
                if let Some(rest) = line.strip_prefix("ref: refs/heads/") {
                    let name = rest.split('\t').next().unwrap_or("").trim();
                    if !name.is_empty() {
                        return Ok(Some(name.to_string()));
                    }
                }
            }
            Ok(None)
        }
        Err(GitError::CommandFailed { .. }) => Ok(None),
        Err(err) => Err(err),
    }
}

fn resolve_pull_branch(git: &GitBinary, repo: &Path, remote: &str) -> Result<String, GitError> {
    let local = current_branch(git, repo)?;
    if let Some(name) = &local {
        if remote_branch_exists(git, repo, remote, name)? {
            return Ok(name.clone());
        }
    }
    if let Some(default) = remote_default_branch(git, repo, remote)? {
        return Ok(default);
    }
    for candidate in ["main", "master"] {
        if remote_branch_exists(git, repo, remote, candidate)? {
            return Ok(candidate.to_string());
        }
    }
    Err(GitError::InvalidInput(format!(
        "远程「{remote}」上找不到可拉取的分支。本地当前是「{}」。常见情况是远程叫 main，本地叫 master。可先点「推送」把本地分支推上去，或把本地改到与远程同名的分支。",
        local.unwrap_or_else(|| "（无分支）".to_string())
    )))
}

pub fn pull(
    git: &GitBinary,
    repo: &Path,
    allow_unrelated: bool,
    rebase: bool,
) -> Result<String, GitError> {
    let remote = default_remote(git, repo)?;
    let fetch_out = run_git_timeout(
        git,
        repo,
        &["fetch", "--prune", "--progress", &remote],
        180,
    )?;
    // Populate refs/remotes/<remote>/HEAD so we know default branch (often main).
    let _ = run_git(git, repo, &["remote", "set-head", &remote, "-a"]);

    // Empty local repo: check out the remote default (or same-named) branch once.
    if !has_commits(git, repo)? {
        let target = resolve_pull_branch(git, repo, &remote)?;
        let output = run_git(
            git,
            repo,
            &[
                "checkout",
                "-B",
                &target,
                "--track",
                &format!("{remote}/{target}"),
            ],
        )?;
        return Ok(format!(
            "{}\n{}",
            combine_output(&fetch_out),
            combine_output(&output)
        ));
    }

    if allow_unrelated {
        return pull_allow_unrelated(git, repo, &remote, &fetch_out);
    }

    if rebase {
        return pull_with_rebase(git, repo, &remote, &fetch_out);
    }

    if upstream_of_head(git, repo)?.is_some() {
        return finalize_pull(git, repo, &fetch_out, &["pull", "--ff-only"], &["pull", "--no-rebase"]);
    }

    let local = current_branch(git, repo)?.ok_or_else(|| {
        GitError::InvalidInput("当前不在分支上，无法拉取。".to_string())
    })?;

    if !remote_branch_exists(git, repo, &remote, &local)? {
        let hint = match remote_default_branch(git, repo, &remote)? {
            Some(default) if default != local => format!(
                "远程默认分支是「{default}」。请先切换到「{default}」再拉取，或点「推送」创建远程「{local}」。"
            ),
            _ => format!("可先点「推送」创建远程「{local}」，或切换到与远程同名的分支后再拉取。"),
        };
        return Err(GitError::InvalidInput(format!(
            "远程「{remote}」上没有与当前分支同名的「{local}」。{hint}"
        )));
    }

    let ff_args = [
        "pull",
        "--ff-only",
        "--set-upstream",
        remote.as_str(),
        local.as_str(),
    ];
    let merge_args = [
        "pull",
        "--no-rebase",
        "--set-upstream",
        remote.as_str(),
        local.as_str(),
    ];
    match finalize_pull(git, repo, &fetch_out, &ff_args, &merge_args) {
        Ok(text) => Ok(format!("已从 {remote}/{local} 拉取\n{text}")),
        Err(err) => Err(err),
    }
}

fn pull_with_rebase(
    git: &GitBinary,
    repo: &Path,
    remote: &str,
    fetch_out: &runner::GitOutput,
) -> Result<String, GitError> {
    let mut args = vec!["pull", "--rebase", "--progress"];
    let local;
    let upstream = upstream_of_head(git, repo)?;
    if upstream.is_none() {
        local = current_branch(git, repo)?.ok_or_else(|| {
            GitError::InvalidInput("当前不在分支上，无法拉取。".to_string())
        })?;
        if !remote_branch_exists(git, repo, remote, &local)? {
            return Err(GitError::InvalidInput(format!(
                "远程「{remote}」上没有与当前分支同名的「{local}」，无法变基拉取。"
            )));
        }
        args.push("--set-upstream");
        args.push(remote);
        args.push(local.as_str());
    }
    match run_git_timeout(git, repo, &args, 180) {
        Ok(output) => Ok(format!(
            "{}\n已变基拉取。\n{}",
            combine_output(fetch_out),
            combine_output(&output)
        )),
        Err(GitError::CommandFailed { stderr, stdout, code }) => {
            let text = format!("{stderr}\n{stdout}");
            if text.contains("CONFLICT")
                || text.contains("conflict")
                || text.contains("could not apply")
            {
                Err(GitError::InvalidInput(format!(
                    "变基拉取产生冲突。请在左侧处理冲突文件并暂存，然后点「继续」，或点「放弃」。\n{text}"
                )))
            } else {
                Err(GitError::CommandFailed { code, stderr, stdout })
            }
        }
        Err(err) => Err(err),
    }
}

fn pull_allow_unrelated(
    git: &GitBinary,
    repo: &Path,
    remote: &str,
    fetch_out: &runner::GitOutput,
) -> Result<String, GitError> {
    let local = current_branch(git, repo)?.ok_or_else(|| {
        GitError::InvalidInput("当前不在分支上，无法拉取。".to_string())
    })?;
    match run_git(
        git,
        repo,
        &[
            "pull",
            "--no-rebase",
            "--allow-unrelated-histories",
            remote,
            &local,
        ],
    ) {
        Ok(output) => Ok(format!(
            "{}\n已合并互不相关的历史。\n{}",
            combine_output(fetch_out),
            combine_output(&output)
        )),
        Err(GitError::CommandFailed { stderr, stdout, .. }) => {
            let merge_text = format!("{stderr}\n{stdout}");
            if merge_text.contains("CONFLICT")
                || merge_text.contains("conflict")
                || merge_text.contains("Automatic merge failed")
            {
                Err(GitError::InvalidInput(format!(
                    "合并无关历史时产生冲突。请在左侧处理冲突文件并暂存，然后点「继续」，或点「放弃」。\n{merge_text}"
                )))
            } else {
                Err(GitError::InvalidInput(format!(
                    "合并无关历史失败。\n{merge_text}"
                )))
            }
        }
        Err(err) => Err(err),
    }
}

fn finalize_pull(
    git: &GitBinary,
    repo: &Path,
    fetch_out: &runner::GitOutput,
    ff_args: &[&str],
    merge_args: &[&str],
) -> Result<String, GitError> {
    match run_git(git, repo, ff_args) {
        Ok(output) => {
            let text = combine_output(&output);
            let summary = if text.trim().is_empty() {
                "已经是最新，没有新文件。".to_string()
            } else {
                text
            };
            Ok(format!("{}\n{summary}", combine_output(fetch_out)))
        }
        Err(GitError::CommandFailed { stderr, stdout, code }) => {
            let ff_text = format!("{stderr}\n{stdout}");
            // Only fall back to merge when histories diverged — not on auth/network errors.
            if !is_not_possible_fast_forward(&ff_text) {
                return Err(GitError::CommandFailed { code, stderr, stdout });
            }
            match run_git(git, repo, merge_args) {
                Ok(output) => Ok(format!(
                    "{}\n本地与远程有分叉，已合并拉取。\n{}",
                    combine_output(fetch_out),
                    combine_output(&output)
                )),
                Err(GitError::CommandFailed {
                    stderr: m_err,
                    stdout: m_out,
                    code: m_code,
                }) => {
                    let merge_text = format!("{m_err}\n{m_out}");
                    if merge_text.contains("unrelated histories") {
                        Err(GitError::InvalidInput(
                            "SYNC_UNRELATED:本地和远程是两套互不相关的历史（常见于一边本地 init，一边在网站上另建过仓库）。"
                                .to_string(),
                        ))
                    } else if merge_text.contains("CONFLICT")
                        || merge_text.contains("conflict")
                        || merge_text.contains("Automatic merge failed")
                    {
                        Err(GitError::InvalidInput(format!(
                            "拉取时产生冲突。请在左侧处理冲突文件并暂存，然后点「继续」，或点「放弃」。\n{merge_text}"
                        )))
                    } else {
                        Err(GitError::CommandFailed {
                            code: m_code,
                            stderr: m_err,
                            stdout: m_out,
                        })
                    }
                }
                Err(err) => Err(err),
            }
        }
        Err(err) => Err(err),
    }
}

fn is_not_possible_fast_forward(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("not possible to fast-forward")
        || lower.contains("diverging")
        || lower.contains("diverged")
        || (lower.contains("rejecting") && lower.contains("non-fast-forward"))
}

fn has_commits(git: &GitBinary, repo: &Path) -> Result<bool, GitError> {
    match run_git(git, repo, &["rev-parse", "--verify", "HEAD"]) {
        Ok(_) => Ok(true),
        Err(GitError::CommandFailed { .. }) => Ok(false),
        Err(err) => Err(err),
    }
}

/// remote: 指定推送远程；空则用默认。
/// sync_mirror: "gitee" | "github" — 先推默认/指定远程，再同步到另一平台。
pub fn push_with_options(
    git: &GitBinary,
    repo: &Path,
    force: bool,
    sync_mirror: Option<&str>,
    remote: Option<&str>,
) -> Result<String, GitError> {
    if !has_commits(git, repo)? {
        return Err(GitError::InvalidInput(
            "还没有任何提交。请先在左侧写说明并点「提交」，再推送。".to_string(),
        ));
    }
    let remote = match remote.map(str::trim).filter(|s| !s.is_empty()) {
        Some(r) => r.to_string(),
        None => default_remote(git, repo)?,
    };
    let branch = current_branch(git, repo)?.ok_or_else(|| {
        GitError::InvalidInput("当前不在分支上，无法推送。请先提交一次。".to_string())
    })?;

    let primary = push_one_remote(git, repo, &remote, &branch, force)?;
    let Some(target) = sync_mirror.map(|s| s.trim().to_ascii_lowercase()) else {
        return Ok(primary);
    };
    let (mirror_remote, label) = match target.as_str() {
        "gitee" => ("gitee", "Gitee"),
        "github" => ("github", "GitHub"),
        _ => {
            return Err(GitError::InvalidInput(format!(
                "未知同步目标：{target}"
            )));
        }
    };

    let remotes = list_remotes(git, repo)?;
    let primary_url = remotes
        .iter()
        .find(|r| r.name == remote)
        .map(|r| r.url.to_ascii_lowercase())
        .unwrap_or_default();
    let primary_already = match mirror_remote {
        "gitee" => primary_url.contains("gitee.com"),
        "github" => primary_url.contains("github.com"),
        _ => false,
    };
    if primary_already {
        return Ok(format!(
            "{primary}\n默认远程已是 {label}，无需再同步。"
        ));
    }

    let mirror_url = match ensure_mirror_remote(git, repo, mirror_remote) {
        Ok(url) => url,
        Err(err) => {
            return Err(GitError::InvalidInput(format!(
                "默认远程已推送成功，但准备 {label} 远程失败：{err}"
            )));
        }
    };

    match push_one_remote(git, repo, mirror_remote, &branch, force) {
        Ok(secondary) => Ok(format!(
            "{primary}\n——\n已同步推送到 {label}（{mirror_remote}）\n{mirror_url}\n{secondary}"
        )),
        Err(err) => Err(GitError::InvalidInput(format!(
            "默认远程已推送成功，但同步 {label} 失败：{err}"
        ))),
    }
}

fn push_one_remote(
    git: &GitBinary,
    repo: &Path,
    remote: &str,
    branch: &str,
    force: bool,
) -> Result<String, GitError> {
    let result = if force {
        run_git_timeout(
            git,
            repo,
            &[
                "push",
                "--progress",
                "--force-with-lease",
                "-u",
                remote,
                branch,
            ],
            180,
        )
    } else if remote == "origin" && upstream_of_head(git, repo)?.is_some() {
        // 仅默认推送可省略远端名；指定 gitee 时必须带远端
        run_git_timeout(git, repo, &["push", "--progress"], 180)
    } else {
        run_git_timeout(
            git,
            repo,
            &["push", "--progress", "-u", remote, branch],
            180,
        )
    };

    match result {
        Ok(output) => {
            let text = combine_output(&output);
            if force && text.trim().is_empty() {
                Ok("已强制推送，远程已与本地对齐。".to_string())
            } else {
                Ok(text)
            }
        }
        Err(GitError::CommandFailed { stderr, stdout, code }) => {
            let text = format!("{stderr}\n{stdout}");
            if !force && is_non_fast_forward_push(&text) {
                Err(GitError::InvalidInput(
                    "SYNC_NEEDS_PULL:推送被拒绝：远程有本地还没有的提交。"
                        .to_string(),
                ))
            } else if text.to_ascii_lowercase().contains("rejected")
                || text.contains("failed to push")
            {
                Err(GitError::InvalidInput(format!("推送失败。\n{text}")))
            } else {
                Err(GitError::CommandFailed {
                    code,
                    stderr,
                    stdout,
                })
            }
        }
        Err(err) => Err(err),
    }
}

/// 确保存在名为 gitee / github 的镜像远程；没有则按仓库名在对应平台建仓并添加。
fn ensure_mirror_remote(
    git: &GitBinary,
    repo: &Path,
    remote_name: &str,
) -> Result<String, GitError> {
    let remotes = list_remotes(git, repo)?;
    if let Some(existing) = remotes.iter().find(|r| r.name == remote_name) {
        return Ok(existing.url.clone());
    }
    let provider = match remote_name {
        "gitee" => "gitee",
        "github" => "github",
        other => {
            return Err(GitError::InvalidInput(format!(
                "不支持的镜像远程：{other}"
            )));
        }
    };
    let repo_name = infer_repo_name(git, repo)?;
    let created = create_or_get_hosting_repo(provider, &repo_name, false, "")?;
    set_remote_url(git, repo, remote_name, &created.clone_url)?;
    Ok(created.clone_url)
}

fn infer_repo_name(git: &GitBinary, repo: &Path) -> Result<String, GitError> {
    if let Ok(remotes) = list_remotes(git, repo) {
        if let Some(origin) = remotes.iter().find(|r| r.name == "origin").or(remotes.first())
        {
            if let Some(name) = repo_name_from_url(&origin.url) {
                if is_valid_hosting_repo_name(&name) {
                    return Ok(name);
                }
            }
        }
    }
    let folder = repo
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .trim();
    let sanitized = sanitize_hosting_repo_name(folder);
    if sanitized.is_empty() {
        return Err(GitError::InvalidInput(
            "无法推断合法仓库名（需字母/数字/-/_/.）。请先设置远程地址，或手动创建 Gitee 仓库。"
                .to_string(),
        ));
    }
    Ok(sanitized)
}

fn is_valid_hosting_repo_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

fn sanitize_hosting_repo_name(raw: &str) -> String {
    let mut out = String::new();
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.' {
            out.push(ch);
        } else if ch == ' ' || ch == '　' {
            out.push('-');
        }
    }
    out.trim_matches(|c| c == '-' || c == '.' || c == '_').to_string()
}

fn repo_name_from_url(url: &str) -> Option<String> {
    let trimmed = url.trim().trim_end_matches('/').trim_end_matches(".git");
    let name = trimmed.rsplit(['/', ':']).next()?;
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

/// 在 GitHub / Gitee 创建远程空仓，并写入本地 remote（origin / gitee）。
pub fn publish_hosting_remotes(
    git: &GitBinary,
    repo: &Path,
    name: &str,
    to_github: bool,
    to_gitee: bool,
    private: bool,
) -> Result<String, GitError> {
    if !to_github && !to_gitee {
        return Err(GitError::InvalidInput(
            "请至少选择 GitHub 或 Gitee 之一".to_string(),
        ));
    }
    let name = name.trim();
    if name.is_empty() {
        return Err(GitError::InvalidInput("请填写仓库名称".to_string()));
    }
    let folder = repo
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(name);
    let desc = format!("{folder}（由青枝创建）");

    let mut lines: Vec<String> = Vec::new();
    let mut github_url = None;
    let mut gitee_url = None;

    if to_github {
        let created = create_or_get_hosting_repo("github", name, private, &desc)?;
        set_remote_url(git, repo, "origin", &created.clone_url)?;
        github_url = Some(created.clone_url.clone());
        lines.push(format!(
            "GitHub：{}（{}）",
            created.full_name,
            if created.created { "已创建" } else { "已存在" }
        ));
    }
    if to_gitee {
        let created = create_or_get_hosting_repo("gitee", name, private, &desc)?;
        let remote_name = if to_github { "gitee" } else { "origin" };
        set_remote_url(git, repo, remote_name, &created.clone_url)?;
        gitee_url = Some(created.clone_url.clone());
        lines.push(format!(
            "Gitee：{} → 远程「{remote_name}」（{}）",
            created.full_name,
            if created.created { "已创建" } else { "已存在" }
        ));
    }

    let _ = (github_url, gitee_url);
    Ok(lines.join("\n"))
}

fn is_non_fast_forward_push(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("non-fast-forward")
        || lower.contains("fetch first")
        || (lower.contains("rejected")
            && (lower.contains("behind") || lower.contains("tip of your current branch")))
}

pub fn blame_file(git: &GitBinary, repo: &Path, file: &str) -> Result<String, GitError> {
    let file = file.trim().replace('\\', "/");
    if file.is_empty() {
        return Err(GitError::InvalidInput("请指定文件路径".to_string()));
    }
    let output = run_git(
        git,
        repo,
        &[
            "blame",
            "--date=short",
            "--",
            &file,
        ],
    )?;
    let text = combine_output(&output);
    if text.trim().is_empty() {
        Ok("（该文件没有可追溯内容）".to_string())
    } else {
        Ok(text)
    }
}

pub fn list_reflog(git: &GitBinary, repo: &Path, limit: u32) -> Result<Vec<ReflogInfo>, GitError> {
    let limit = limit.clamp(1, 200).to_string();
    let output = run_git(
        git,
        repo,
        &[
            "reflog",
            "-n",
            &limit,
            "--date=short",
            "--pretty=format:%H%x1f%h%x1f%gd%x1f%ad%x1f%s%x1e",
        ],
    )?;
    let mut items = Vec::new();
    for (index, chunk) in output.stdout.split('\u{1e}').enumerate() {
        let chunk = chunk.trim();
        if chunk.is_empty() {
            continue;
        }
        let parts: Vec<&str> = chunk.split('\u{1f}').collect();
        if parts.len() < 5 {
            continue;
        }
        items.push(ReflogInfo {
            index: index as u32,
            hash: parts[0].to_string(),
            short_hash: parts[1].to_string(),
            selector: parts[2].to_string(),
            date: parts[3].to_string(),
            subject: parts[4].to_string(),
        });
    }
    Ok(items)
}

pub fn list_commits(git: &GitBinary, repo: &Path, limit: u32) -> Result<Vec<CommitInfo>, GitError> {
    let limit = limit.clamp(1, 200).to_string();
    match run_git(
        git,
        repo,
        &[
            "log",
            "-n",
            &limit,
            "--decorate=short",
            "--date=short",
            "--pretty=format:%H%x1f%h%x1f%an%x1f%ad%x1f%s%x1f%P%x1f%d%x1e",
        ],
    ) {
        Ok(output) => Ok(parse_commits(&output.stdout)),
        Err(GitError::CommandFailed { stderr, stdout, .. })
            if format!("{stderr}{stdout}").contains("does not have any commits") =>
        {
            Ok(Vec::new())
        }
        Err(err) => Err(err),
    }
}

pub fn commit_patch(git: &GitBinary, repo: &Path, hash: &str) -> Result<String, GitError> {
    if !is_hex_hash(hash) {
        return Err(GitError::InvalidInput("提交哈希无效".to_string()));
    }
    let output = run_git(git, repo, &["show", "--format=medium", "--patch", hash])?;
    Ok(output.stdout)
}

pub fn list_stashes(git: &GitBinary, repo: &Path) -> Result<Vec<StashInfo>, GitError> {
    let output = run_git(
        git,
        repo,
        &["stash", "list", "--pretty=format:%gd%x1f%gs%x1e"],
    )?;
    Ok(parse_stashes(&output.stdout))
}

pub fn stash_push(
    git: &GitBinary,
    repo: &Path,
    message: &str,
    include_untracked: bool,
) -> Result<String, GitError> {
    let message = message.trim();
    let mut args = vec!["stash".to_string(), "push".to_string()];
    if include_untracked {
        args.push("-u".to_string());
    }
    if !message.is_empty() {
        args.push("-m".to_string());
        args.push(message.to_string());
    }
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let output = run_git(git, repo, &arg_refs)?;
    Ok(combine_output(&output))
}

pub fn stash_pop(git: &GitBinary, repo: &Path, index: u32) -> Result<String, GitError> {
    let reference = stash_ref(index);
    let output = run_git(git, repo, &["stash", "pop", &reference])?;
    Ok(combine_output(&output))
}

pub fn stash_apply(git: &GitBinary, repo: &Path, index: u32) -> Result<String, GitError> {
    let reference = stash_ref(index);
    let output = run_git(git, repo, &["stash", "apply", &reference])?;
    Ok(combine_output(&output))
}

pub fn stash_show(git: &GitBinary, repo: &Path, index: u32) -> Result<String, GitError> {
    let reference = stash_ref(index);
    let output = run_git(git, repo, &["stash", "show", "-p", "--stat", &reference])?;
    let text = combine_output(&output);
    if text.trim().is_empty() {
        Ok("（该储藏没有可显示的差异）".to_string())
    } else {
        Ok(text)
    }
}

pub fn stash_drop(git: &GitBinary, repo: &Path, index: u32) -> Result<String, GitError> {
    let reference = stash_ref(index);
    let output = run_git(git, repo, &["stash", "drop", &reference])?;
    Ok(combine_output(&output))
}

pub fn list_tags(git: &GitBinary, repo: &Path) -> Result<Vec<TagInfo>, GitError> {
    let output = run_git(
        git,
        repo,
        &[
            "tag",
            "--list",
            "--format=%(refname:short)%x1f%(objectname:short)%x1e",
        ],
    )?;
    Ok(parse_tags(&output.stdout))
}

pub fn create_tag(
    git: &GitBinary,
    repo: &Path,
    name: &str,
    message: Option<&str>,
) -> Result<(), GitError> {
    let name = name.trim();
    if name.is_empty() || name.contains([' ', '\t', '\n', '~', '^', ':', '?', '*', '[']) {
        return Err(GitError::InvalidInput("标签名无效".to_string()));
    }
    let msg = message.map(str::trim).filter(|s| !s.is_empty());
    if let Some(m) = msg {
        run_git(git, repo, &["tag", "-a", name, "-m", m])?;
    } else {
        run_git(git, repo, &["tag", name])?;
    }
    Ok(())
}

pub fn clean_files(
    git: &GitBinary,
    repo: &Path,
    dry_run: bool,
    include_ignored: bool,
) -> Result<String, GitError> {
    let mut args = vec!["clean".to_string(), "-fd".to_string()];
    if dry_run {
        args.push("-n".to_string());
    }
    if include_ignored {
        args.push("-x".to_string());
    }
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let output = run_git(git, repo, &arg_refs)?;
    let text = combine_output(&output);
    if text.trim().is_empty() {
        Ok(if dry_run {
            "没有可清理的未跟踪文件".to_string()
        } else {
            "已清理未跟踪文件".to_string()
        })
    } else {
        Ok(text)
    }
}

pub fn remove_remote(git: &GitBinary, repo: &Path, name: &str) -> Result<String, GitError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(GitError::InvalidInput("远程名不能为空".to_string()));
    }
    run_git(git, repo, &["remote", "remove", name])?;
    Ok(format!("已删除远程「{name}」"))
}

pub fn compare_refs(
    git: &GitBinary,
    repo: &Path,
    left: &str,
    right: &str,
) -> Result<String, GitError> {
    let left = left.trim();
    let right = right.trim();
    if left.is_empty() || right.is_empty() {
        return Err(GitError::InvalidInput("请填写要比较的两个引用".to_string()));
    }
    let range = format!("{left}...{right}");
    let output = run_git(
        git,
        repo,
        &["diff", "--stat", "--patch", "--find-renames", &range],
    )?;
    let text = combine_output(&output);
    if text.trim().is_empty() {
        Ok(format!("「{left}」与「{right}」没有差异"))
    } else {
        Ok(text)
    }
}

pub fn push_tag(git: &GitBinary, repo: &Path, name: &str) -> Result<String, GitError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(GitError::InvalidInput("标签名不能为空".to_string()));
    }
    let remote = default_remote(git, repo)?;
    let output = run_git_timeout(git, repo, &["push", &remote, "tag", name], 180)?;
    let text = combine_output(&output);
    if text.trim().is_empty() {
        Ok(format!("已推送标签 {name} 到 {remote}"))
    } else {
        Ok(text)
    }
}

pub fn push_all_tags(git: &GitBinary, repo: &Path) -> Result<String, GitError> {
    let remote = default_remote(git, repo)?;
    let output = run_git_timeout(git, repo, &["push", &remote, "--tags"], 180)?;
    let text = combine_output(&output);
    if text.trim().is_empty() {
        Ok(format!("已将本地标签推送到 {remote}"))
    } else {
        Ok(text)
    }
}

pub fn delete_remote_tag(git: &GitBinary, repo: &Path, name: &str) -> Result<String, GitError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(GitError::InvalidInput("标签名不能为空".to_string()));
    }
    let remote = default_remote(git, repo)?;
    let output = run_git_timeout(
        git,
        repo,
        &["push", &remote, "--delete", &format!("refs/tags/{name}")],
        180,
    )?;
    let text = combine_output(&output);
    if text.trim().is_empty() {
        Ok(format!("已删除远程标签 {name}"))
    } else {
        Ok(text)
    }
}

fn parse_commits(raw: &str) -> Vec<CommitInfo> {
    split_records(raw)
        .into_iter()
        .filter_map(|parts| {
            if parts.len() < 5 {
                return None;
            }
            Some(CommitInfo {
                hash: parts[0].clone(),
                short_hash: parts[1].clone(),
                author: parts[2].clone(),
                date: parts[3].clone(),
                subject: parts[4].clone(),
                parents: parts.get(5).cloned().unwrap_or_default(),
                refs: parts.get(6).cloned().unwrap_or_default(),
            })
        })
        .collect()
}

fn parse_stashes(raw: &str) -> Vec<StashInfo> {
    split_records(raw)
        .into_iter()
        .filter_map(|parts| {
            if parts.len() < 2 {
                return None;
            }
            let index = parts[0]
                .trim_start_matches("stash@{")
                .trim_end_matches('}')
                .parse()
                .ok()?;
            Some(StashInfo {
                index,
                message: parts[1].clone(),
            })
        })
        .collect()
}

fn parse_tags(raw: &str) -> Vec<TagInfo> {
    split_records(raw)
        .into_iter()
        .filter_map(|parts| {
            if parts.len() < 2 {
                return None;
            }
            Some(TagInfo {
                name: parts[0].clone(),
                tip: parts[1].clone(),
            })
        })
        .collect()
}

fn split_records(raw: &str) -> Vec<Vec<String>> {
    raw.split('\u{1e}')
        .map(|record| record.trim_matches(['\n', '\r']).to_string())
        .filter(|record| !record.is_empty())
        .map(|record| record.split('\u{1f}').map(|part| part.to_string()).collect())
        .collect()
}

fn stash_ref(index: u32) -> String {
    format!("stash@{{{index}}}")
}

fn is_hex_hash(hash: &str) -> bool {
    let len = hash.len();
    // Allow abbreviated and full SHA-1 (40) / SHA-256 (64) object names.
    (4..=64).contains(&len) && hash.chars().all(|c| c.is_ascii_hexdigit())
}

fn confined_child(repo: &Path, relative: &str) -> Result<std::path::PathBuf, GitError> {
    if relative.is_empty()
        || relative.contains('\0')
        || Path::new(relative).is_absolute()
        || relative.split(['/', '\\']).any(|part| part == "..")
    {
        return Err(GitError::InvalidPath(relative.to_string()));
    }
    let full = repo.join(relative);
    let repo_canon = repo.canonicalize().map_err(|e| GitError::Io {
        path: repo.display().to_string(),
        message: e.to_string(),
    })?;
    let full_canon = if full.exists() {
        full.canonicalize().map_err(|e| GitError::Io {
            path: full.display().to_string(),
            message: e.to_string(),
        })?
    } else {
        return Err(GitError::InvalidPath(relative.to_string()));
    };
    if !full_canon.starts_with(&repo_canon) {
        return Err(GitError::InvalidPath(relative.to_string()));
    }
    Ok(full_canon)
}

#[cfg(test)]
mod parse_tests {
    use super::*;

    #[test]
    fn parses_commit_stash_and_tag_records() {
        let commits = parse_commits("abc\u{1f}ab\u{1f}Ann\u{1f}2026-01-01\u{1f}hello\u{1e}");
        assert_eq!(commits[0].subject, "hello");
        let stashes = parse_stashes("stash@{1}\u{1f}wip\u{1e}");
        assert_eq!(stashes[0].index, 1);
        let tags = parse_tags("v1\u{1f}deadbee\u{1e}");
        assert_eq!(tags[0].name, "v1");
        assert!(!is_hex_hash("zz"));
        assert!(is_hex_hash("abc123"));
    }
}

#[cfg(test)]
mod integration {
    use super::*;
    use std::fs;

    #[test]
    fn stage_commit_and_diff_on_real_repo() {
        let git = resolve_git().expect("git installed");
        let dir = std::env::temp_dir().join(format!("local-git-it-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        assert!(!is_repository(&git, &dir).unwrap());
        init_repository(&git, &dir).unwrap();
        assert!(is_repository(&git, &dir).unwrap());

        fs::write(dir.join("a.txt"), "hello\n").unwrap();
        let status = repo_status(&git, &dir).unwrap();
        assert!(status.changes.iter().any(|c| c.path == "a.txt" && c.untracked));

        stage_paths(&git, &dir, &["a.txt".into()]).unwrap();
        let staged = repo_status(&git, &dir).unwrap();
        let file = staged.changes.iter().find(|c| c.path == "a.txt").unwrap();
        assert!(file.staged);
        let diff = file_diff(&git, &dir, "a.txt", true).unwrap();
        assert!(diff.contains("+hello"));

        std::env::set_var("GIT_AUTHOR_NAME", "Local Git Test");
        std::env::set_var("GIT_AUTHOR_EMAIL", "test@example.com");
        std::env::set_var("GIT_COMMITTER_NAME", "Local Git Test");
        std::env::set_var("GIT_COMMITTER_EMAIL", "test@example.com");
        commit(&git, &dir, "first").unwrap();

        let after = repo_status(&git, &dir).unwrap();
        assert!(after.changes.is_empty());
        let branches = list_branches(&git, &dir).unwrap();
        assert!(branches.iter().any(|b| b.is_current));

        let _ = fs::remove_dir_all(&dir);
    }
}

fn combine_output(output: &runner::GitOutput) -> String {
    let mut text = output.stdout.clone();
    if !output.stderr.trim().is_empty() {
        if !text.trim().is_empty() {
            text.push('\n');
        }
        text.push_str(&output.stderr);
    }
    text
}
