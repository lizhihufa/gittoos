mod auth;
mod runner;
mod status;
mod types;

pub use auth::{
    auth_accounts, auth_browser_begin, auth_browser_finish, auth_device_poll, auth_device_start,
    auth_ensure_credentials, auth_login_token, auth_logout, auth_manager_login, auth_save_config,
    auth_ssh_generate, auth_ssh_status, auth_ssh_test, auth_switch_account, AuthAccounts,
    GithubDevicePollResult, GithubDeviceStart, OauthBegin, ProviderStatus, SshStatus,
    SshTestResult,
};
pub use runner::{
    ensure_git, git_info, run_shell, set_app_handle, with_git_quiet, GitBinary,
};
pub use status::{repo_status, repo_status_light_nonblocking};
pub use types::*;

use runner::{run_git, run_git_timeout};
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

pub fn clone_repository(git: &GitBinary, url: &str, destination: &Path) -> Result<String, GitError> {
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
        let output = run_git_timeout(git, destination, &["clone", url, "."], 300)?;
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
    let output = run_git_timeout(git, parent, &["clone", url, folder_name], 300)?;
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
        Some("merge") => {
            let output = run_git(git, repo, &["merge", "--abort"])?;
            Ok(combine_output(&output))
        }
        _ => Err(GitError::InvalidInput(
            "当前没有进行中的合并、拣选或变基。".to_string(),
        )),
    }
}

pub fn continue_operation(git: &GitBinary, repo: &Path) -> Result<String, GitError> {
    let op = ongoing_operation(git, repo)?.ok_or_else(|| {
        GitError::InvalidInput("当前没有进行中的合并、拣选或变基。".to_string())
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
        // Merge: finish with the prepared merge message, no editor.
        _ => run_git(git, repo, &["commit", "--no-edit"])?,
    };
    let text = combine_output(&output);
    Ok(if text.trim().is_empty() {
        match op {
            "rebase" => "变基已完成。".to_string(),
            "cherry-pick" => "拣选已完成。".to_string(),
            _ => "合并已完成。".to_string(),
        }
    } else {
        text
    })
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

pub fn apply_cached_patch(
    git: &GitBinary,
    repo: &Path,
    patch: &str,
    reverse: bool,
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
    let mut args = vec!["apply", "--cached", "--whitespace=nowarn"];
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

pub fn fetch(git: &GitBinary, repo: &Path) -> Result<String, GitError> {
    let remote = default_remote(git, repo)?;
    let output = run_git_timeout(git, repo, &["fetch", "--prune", &remote], 180)?;
    Ok(combine_output(&output))
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

pub fn pull(git: &GitBinary, repo: &Path, allow_unrelated: bool) -> Result<String, GitError> {
    let remote = default_remote(git, repo)?;
    let fetch_out = run_git_timeout(git, repo, &["fetch", "--prune", &remote], 180)?;
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

pub fn push(git: &GitBinary, repo: &Path, force: bool) -> Result<String, GitError> {
    if !has_commits(git, repo)? {
        return Err(GitError::InvalidInput(
            "还没有任何提交。请先在左侧写说明并点「提交」，再推送。".to_string(),
        ));
    }
    let remote = default_remote(git, repo)?;
    let branch = current_branch(git, repo)?.ok_or_else(|| {
        GitError::InvalidInput("当前不在分支上，无法推送。请先提交一次。".to_string())
    })?;

    let result = if force {
        // --force-with-lease refuses to overwrite if remote moved unexpectedly.
        run_git_timeout(
            git,
            repo,
            &["push", "--force-with-lease", "-u", &remote, &branch],
            180,
        )
    } else if upstream_of_head(git, repo)?.is_some() {
        run_git_timeout(git, repo, &["push"], 180)
    } else {
        run_git_timeout(git, repo, &["push", "-u", &remote, &branch], 180)
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
                Err(GitError::InvalidInput(format!(
                    "推送失败。\n{text}"
                )))
            } else {
                Err(GitError::CommandFailed { code, stderr, stdout })
            }
        }
        Err(err) => Err(err),
    }
}

fn is_non_fast_forward_push(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("non-fast-forward")
        || lower.contains("fetch first")
        || (lower.contains("rejected")
            && (lower.contains("behind") || lower.contains("tip of your current branch")))
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

pub fn create_tag(git: &GitBinary, repo: &Path, name: &str) -> Result<(), GitError> {
    let name = name.trim();
    if name.is_empty() || name.contains([' ', '\t', '\n', '~', '^', ':', '?', '*', '[']) {
        return Err(GitError::InvalidInput("标签名无效".to_string()));
    }
    run_git(git, repo, &["tag", name])?;
    Ok(())
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
