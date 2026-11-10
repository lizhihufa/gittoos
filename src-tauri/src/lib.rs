mod git;
mod process_win;
mod update;
mod webview2;

use git::{
    abort_operation, amend_commit, apply_cached_patch, auth_accounts, auth_browser_begin,
    auth_browser_finish, auth_device_poll, auth_device_start, auth_ensure_credentials,
    auth_login_token, auth_logout, auth_manager_login as do_auth_manager_login, auth_save_config,
    auth_ssh_generate, auth_ssh_status, auth_ssh_test, auth_switch_account, checkout_branch,
    checkout_remote_branch, cherry_pick, clone_repository, commit, commit_patch, continue_operation,
    create_branch, create_tag, delete_branch, delete_remote_branch, delete_remote_tag, delete_tag,
    discard_paths, ensure_git, fetch, file_diff, git_info, init_repository, is_repository,
    list_branches, list_commits, list_remote_branches, list_remotes, list_stashes, list_tags,
    merge_branch, pull, push, push_all_tags, push_tag, read_identity, rebase_branch, repo_status,
    repo_status_light_nonblocking, reset_to_commit, run_shell, set_app_handle, set_remote_url,
    stage_paths, staged_large_files, stash_drop, stash_pop, stash_push, undo_last_commit,
    unstage_paths, with_git_quiet, write_identity, AuthAccounts, BranchInfo, CommitInfo,
    GitBinary, GitError, GitInfo, GithubDevicePollResult, GithubDeviceStart, Identity,
    LargeFileInfo, OauthBegin, ProviderStatus, RemoteBranchInfo, RemoteInfo, RepoCore,
    RepoExtras, RepoSnapshot, RepoStatus, SshStatus, SshTestResult, StashInfo, TagInfo,
};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

struct AppState {
    git: Mutex<Option<GitBinary>>,
}

fn with_git<T, F>(state: &AppState, f: F) -> Result<T, String>
where
    F: FnOnce(&GitBinary) -> Result<T, GitError>,
{
    // Resolve git under the mutex, then release it before running the command.
    // Holding AppState across a long `git` call freezes every other invoke and
    // makes the window look like "未响应".
    let git = {
        let mut guard = state.git.lock().map_err(|e| e.to_string())?;
        if guard.is_none() {
            *guard = Some(ensure_git().map_err(|e| e.to_string())?);
        }
        guard
            .as_ref()
            .ok_or_else(|| GitError::GitNotFound.to_string())?
            .clone()
    };
    f(&git).map_err(|e| e.to_string())
}

async fn with_git_async<T, F>(state: &AppState, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&GitBinary) -> Result<T, GitError> + Send + 'static,
{
    let git = {
        let mut guard = state.git.lock().map_err(|e| e.to_string())?;
        if guard.is_none() {
            *guard = Some(ensure_git().map_err(|e| e.to_string())?);
        }
        guard
            .as_ref()
            .ok_or_else(|| GitError::GitNotFound.to_string())?
            .clone()
    };
    tauri::async_runtime::spawn_blocking(move || f(&git).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

fn repo_path(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    if !p.exists() {
        return Err(format!("路径不存在: {path}"));
    }
    Ok(p)
}

#[tauri::command]
fn get_git_info(state: State<'_, AppState>) -> Result<GitInfo, String> {
    with_git(&state, |git| Ok(git_info(git)))
}

#[tauri::command]
fn path_exists(path: String) -> bool {
    Path::new(&path).is_dir()
}

#[tauri::command]
fn import_wallpaper(app: AppHandle, source: String) -> Result<String, String> {
    let src = Path::new(&source);
    if !src.is_file() {
        return Err("壁纸文件不存在".into());
    }
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("bin")
        .to_ascii_lowercase();
    let allowed = ["png", "jpg", "jpeg", "webp", "gif", "mp4", "webm", "mov"];
    if !allowed.iter().any(|a| *a == ext) {
        return Err("仅支持图片（png/jpg/webp/gif）或视频（mp4/webm/mov）".into());
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // Clear previous wallpaper files.
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("wallpaper.") {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    let dest = dir.join(format!("wallpaper.{ext}"));
    std::fs::copy(src, &dest).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
fn clear_wallpaper(app: AppHandle) -> Result<(), String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("wallpaper.") {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    Ok(())
}

#[tauri::command]
fn check_repository(state: State<'_, AppState>, path: String) -> Result<bool, String> {
    let repo = repo_path(&path)?;
    with_git_quiet(|| with_git(&state, |git| is_repository(git, &repo)))
}

#[tauri::command]
async fn init_repo(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let repo = repo_path(&path)?;
    with_git_async(&state, move |git| init_repository(git, &repo)).await
}

#[tauri::command]
fn get_status(state: State<'_, AppState>, path: String) -> Result<RepoStatus, String> {
    let repo = repo_path(&path)?;
    with_git_quiet(|| with_git(&state, |git| repo_status(git, &repo)))
}

#[tauri::command]
async fn get_status_light(state: State<'_, AppState>, path: String) -> Result<RepoStatus, String> {
    let repo = repo_path(&path)?;
    with_git_async(&state, move |git| {
        with_git_quiet(|| match repo_status_light_nonblocking(git, &repo) {
            Ok(Some(status)) => Ok(status),
            Ok(None) => Err(GitError::InvalidInput("GIT_BUSY".into())),
            Err(err) => Err(err),
        })
    })
    .await
}

#[tauri::command]
async fn get_repo_core(state: State<'_, AppState>, path: String) -> Result<RepoCore, String> {
    let repo = repo_path(&path)?;
    with_git_async(&state, move |git| {
        with_git_quiet(|| {
            Ok(RepoCore {
                status: repo_status(git, &repo)?,
                branches: list_branches(git, &repo)?,
                remote_branches: list_remote_branches(git, &repo)?,
                identity: read_identity(git, &repo)?,
                remotes: list_remotes(git, &repo)?,
            })
        })
    })
    .await
}

#[tauri::command]
async fn get_repo_extras(state: State<'_, AppState>, path: String) -> Result<RepoExtras, String> {
    let repo = repo_path(&path)?;
    with_git_async(&state, move |git| {
        with_git_quiet(|| {
            Ok(RepoExtras {
                commits: list_commits(git, &repo, 50)?,
                stashes: list_stashes(git, &repo)?,
                tags: list_tags(git, &repo)?,
            })
        })
    })
    .await
}

#[tauri::command]
async fn get_repo_snapshot(
    state: State<'_, AppState>,
    path: String,
) -> Result<RepoSnapshot, String> {
    let repo = repo_path(&path)?;
    with_git_async(&state, move |git| {
        with_git_quiet(|| {
            Ok(RepoSnapshot {
                status: repo_status(git, &repo)?,
                branches: list_branches(git, &repo)?,
                remote_branches: list_remote_branches(git, &repo)?,
                commits: list_commits(git, &repo, 50)?,
                stashes: list_stashes(git, &repo)?,
                tags: list_tags(git, &repo)?,
                identity: read_identity(git, &repo)?,
                remotes: list_remotes(git, &repo)?,
            })
        })
    })
    .await
}

#[tauri::command]
async fn stage_files(
    state: State<'_, AppState>,
    path: String,
    paths: Vec<String>,
) -> Result<(), String> {
    let repo = repo_path(&path)?;
    with_git_async(&state, move |git| stage_paths(git, &repo, &paths)).await
}

#[tauri::command]
async fn unstage_files(
    state: State<'_, AppState>,
    path: String,
    paths: Vec<String>,
) -> Result<(), String> {
    let repo = repo_path(&path)?;
    with_git_async(&state, move |git| unstage_paths(git, &repo, &paths)).await
}

#[tauri::command]
async fn discard_files(
    state: State<'_, AppState>,
    path: String,
    paths: Vec<String>,
) -> Result<(), String> {
    let repo = repo_path(&path)?;
    with_git_async(&state, move |git| discard_paths(git, &repo, &paths)).await
}

#[tauri::command]
async fn get_diff(
    state: State<'_, AppState>,
    path: String,
    file: String,
    staged: bool,
) -> Result<String, String> {
    let repo = repo_path(&path)?;
    with_git_async(&state, move |git| {
        with_git_quiet(|| file_diff(git, &repo, &file, staged))
    })
    .await
}

#[tauri::command]
async fn apply_patch(
    state: State<'_, AppState>,
    path: String,
    patch: String,
    reverse: bool,
) -> Result<String, String> {
    let repo = repo_path(&path)?;
    with_git_async(&state, move |git| {
        apply_cached_patch(git, &repo, &patch, reverse)
    })
    .await
}

#[tauri::command]
fn get_identity(state: State<'_, AppState>, path: String) -> Result<Identity, String> {
    let repo = repo_path(&path)?;
    with_git_quiet(|| with_git(&state, |git| read_identity(git, &repo)))
}

#[tauri::command]
async fn set_identity(
    state: State<'_, AppState>,
    path: String,
    name: String,
    email: String,
    global: bool,
) -> Result<(), String> {
    let repo = repo_path(&path)?;
    with_git_async(&state, move |git| {
        write_identity(git, &repo, &name, &email, global)
    })
    .await
}

#[tauri::command]
async fn list_staged_large_files(
    state: State<'_, AppState>,
    path: String,
    limit_bytes: Option<u64>,
) -> Result<Vec<LargeFileInfo>, String> {
    let repo = repo_path(&path)?;
    let limit = limit_bytes.unwrap_or(0);
    with_git_async(&state, move |git| {
        with_git_quiet(|| staged_large_files(git, &repo, limit))
    })
    .await
}

#[tauri::command]
async fn create_commit(
    state: State<'_, AppState>,
    path: String,
    message: String,
) -> Result<String, String> {
    let repo = repo_path(&path)?;
    with_git_async(&state, move |git| commit(git, &repo, &message)).await
}

#[tauri::command]
async fn amend_last_commit(
    state: State<'_, AppState>,
    path: String,
    message: String,
) -> Result<String, String> {
    let repo = repo_path(&path)?;
    with_git_async(&state, move |git| amend_commit(git, &repo, &message)).await
}

#[tauri::command]
async fn undo_commit(
    state: State<'_, AppState>,
    path: String,
) -> Result<String, String> {
    let repo = repo_path(&path)?;
    with_git_async(&state, move |git| undo_last_commit(git, &repo)).await
}

#[tauri::command]
async fn reset_commit(
    state: State<'_, AppState>,
    path: String,
    hash: String,
    mode: String,
) -> Result<String, String> {
    let repo = repo_path(&path)?;
    with_git_async(&state, move |git| reset_to_commit(git, &repo, &hash, &mode)).await
}

#[tauri::command]
async fn remote_branch_delete(
    state: State<'_, AppState>,
    path: String,
    name: String,
) -> Result<String, String> {
    let repo = repo_path(&path)?;
    with_git_async(&state, move |git| delete_remote_branch(git, &repo, &name)).await
}

#[tauri::command]
async fn clone_repo(
    state: State<'_, AppState>,
    url: String,
    destination: String,
) -> Result<String, String> {
    let dest = PathBuf::from(&destination);
    with_git_async(&state, move |git| clone_repository(git, &url, &dest)).await?;
    Ok(destination)
}

#[tauri::command]
fn get_branches(state: State<'_, AppState>, path: String) -> Result<Vec<BranchInfo>, String> {
    let repo = repo_path(&path)?;
    with_git_quiet(|| with_git(&state, |git| list_branches(git, &repo)))
}

#[tauri::command]
fn get_remote_branches(
    state: State<'_, AppState>,
    path: String,
) -> Result<Vec<RemoteBranchInfo>, String> {
    let repo = repo_path(&path)?;
    with_git_quiet(|| with_git(&state, |git| list_remote_branches(git, &repo)))
}

#[tauri::command]
async fn branch_create(
    state: State<'_, AppState>,
    path: String,
    name: String,
) -> Result<(), String> {
    let repo = repo_path(&path)?;
    with_git_async(&state, move |git| create_branch(git, &repo, &name)).await
}

#[tauri::command]
async fn branch_checkout(
    state: State<'_, AppState>,
    path: String,
    name: String,
) -> Result<(), String> {
    let repo = repo_path(&path)?;
    with_git_async(&state, move |git| checkout_branch(git, &repo, &name)).await
}

#[tauri::command]
async fn remote_branch_checkout(
    state: State<'_, AppState>,
    path: String,
    name: String,
) -> Result<String, String> {
    let repo = repo_path(&path)?;
    with_git_async(&state, move |git| checkout_remote_branch(git, &repo, &name)).await
}

#[tauri::command]
async fn branch_delete(
    state: State<'_, AppState>,
    path: String,
    name: String,
    force: bool,
) -> Result<String, String> {
    let repo = repo_path(&path)?;
    with_git_async(&state, move |git| delete_branch(git, &repo, &name, force)).await
}

#[tauri::command]
async fn branch_merge(
    state: State<'_, AppState>,
    path: String,
    name: String,
) -> Result<String, String> {
    let repo = repo_path(&path)?;
    with_git_async(&state, move |git| merge_branch(git, &repo, &name)).await
}

#[tauri::command]
async fn branch_rebase(
    state: State<'_, AppState>,
    path: String,
    onto: String,
) -> Result<String, String> {
    let repo = repo_path(&path)?;
    with_git_async(&state, move |git| rebase_branch(git, &repo, &onto)).await
}

#[tauri::command]
async fn commit_cherry_pick(
    state: State<'_, AppState>,
    path: String,
    hash: String,
) -> Result<String, String> {
    let repo = repo_path(&path)?;
    with_git_async(&state, move |git| cherry_pick(git, &repo, &hash)).await
}

#[tauri::command]
async fn git_abort_operation(
    state: State<'_, AppState>,
    path: String,
) -> Result<String, String> {
    let repo = repo_path(&path)?;
    with_git_async(&state, move |git| abort_operation(git, &repo)).await
}

#[tauri::command]
async fn git_continue_operation(
    state: State<'_, AppState>,
    path: String,
) -> Result<String, String> {
    let repo = repo_path(&path)?;
    with_git_async(&state, move |git| continue_operation(git, &repo)).await
}

#[tauri::command]
fn get_remotes(state: State<'_, AppState>, path: String) -> Result<Vec<RemoteInfo>, String> {
    let repo = repo_path(&path)?;
    with_git_quiet(|| with_git(&state, |git| list_remotes(git, &repo)))
}

#[tauri::command]
async fn save_remote(
    state: State<'_, AppState>,
    path: String,
    name: String,
    url: String,
) -> Result<(), String> {
    let repo = repo_path(&path)?;
    with_git_async(&state, move |git| set_remote_url(git, &repo, &name, &url)).await
}

#[tauri::command]
async fn git_fetch(state: State<'_, AppState>, path: String) -> Result<String, String> {
    let repo = repo_path(&path)?;
    with_git_async(&state, move |git| fetch(git, &repo)).await
}

#[tauri::command]
async fn git_pull(
    state: State<'_, AppState>,
    path: String,
    allow_unrelated: Option<bool>,
) -> Result<String, String> {
    let repo = repo_path(&path)?;
    let allow_unrelated = allow_unrelated.unwrap_or(false);
    with_git_async(&state, move |git| pull(git, &repo, allow_unrelated)).await
}

#[tauri::command]
async fn git_push(
    state: State<'_, AppState>,
    path: String,
    force: Option<bool>,
) -> Result<String, String> {
    let repo = repo_path(&path)?;
    let force = force.unwrap_or(false);
    with_git_async(&state, move |git| push(git, &repo, force)).await
}

#[tauri::command]
fn get_commits(state: State<'_, AppState>, path: String) -> Result<Vec<CommitInfo>, String> {
    let repo = repo_path(&path)?;
    with_git_quiet(|| with_git(&state, |git| list_commits(git, &repo, 80)))
}

#[tauri::command]
async fn get_commit_patch(
    state: State<'_, AppState>,
    path: String,
    hash: String,
) -> Result<String, String> {
    let repo = repo_path(&path)?;
    with_git_async(&state, move |git| {
        with_git_quiet(|| commit_patch(git, &repo, &hash))
    })
    .await
}

#[tauri::command]
fn get_stashes(state: State<'_, AppState>, path: String) -> Result<Vec<StashInfo>, String> {
    let repo = repo_path(&path)?;
    with_git_quiet(|| with_git(&state, |git| list_stashes(git, &repo)))
}

#[tauri::command]
async fn create_stash(
    state: State<'_, AppState>,
    path: String,
    message: String,
    include_untracked: Option<bool>,
) -> Result<String, String> {
    let repo = repo_path(&path)?;
    let include_untracked = include_untracked.unwrap_or(false);
    with_git_async(&state, move |git| {
        stash_push(git, &repo, &message, include_untracked)
    })
    .await
}

#[tauri::command]
async fn pop_stash(
    state: State<'_, AppState>,
    path: String,
    index: u32,
) -> Result<String, String> {
    let repo = repo_path(&path)?;
    with_git_async(&state, move |git| stash_pop(git, &repo, index)).await
}

#[tauri::command]
async fn drop_stash(
    state: State<'_, AppState>,
    path: String,
    index: u32,
) -> Result<String, String> {
    let repo = repo_path(&path)?;
    with_git_async(&state, move |git| stash_drop(git, &repo, index)).await
}

#[tauri::command]
fn get_tags(state: State<'_, AppState>, path: String) -> Result<Vec<TagInfo>, String> {
    let repo = repo_path(&path)?;
    with_git_quiet(|| with_git(&state, |git| list_tags(git, &repo)))
}

#[tauri::command]
async fn tag_create(
    state: State<'_, AppState>,
    path: String,
    name: String,
) -> Result<(), String> {
    let repo = repo_path(&path)?;
    with_git_async(&state, move |git| create_tag(git, &repo, &name)).await
}

#[tauri::command]
async fn tag_delete(
    state: State<'_, AppState>,
    path: String,
    name: String,
) -> Result<String, String> {
    let repo = repo_path(&path)?;
    with_git_async(&state, move |git| delete_tag(git, &repo, &name)).await
}

#[tauri::command]
async fn tag_push(
    state: State<'_, AppState>,
    path: String,
    name: String,
) -> Result<String, String> {
    let repo = repo_path(&path)?;
    with_git_async(&state, move |git| push_tag(git, &repo, &name)).await
}

#[tauri::command]
async fn tag_push_all(state: State<'_, AppState>, path: String) -> Result<String, String> {
    let repo = repo_path(&path)?;
    with_git_async(&state, move |git| push_all_tags(git, &repo)).await
}

#[tauri::command]
async fn tag_delete_remote(
    state: State<'_, AppState>,
    path: String,
    name: String,
) -> Result<String, String> {
    let repo = repo_path(&path)?;
    with_git_async(&state, move |git| delete_remote_tag(git, &repo, &name)).await
}

#[tauri::command]
async fn run_command(
    state: State<'_, AppState>,
    path: String,
    command: String,
) -> Result<String, String> {
    let repo = repo_path(&path)?;
    with_git_async(&state, move |git| run_shell(git, &repo, &command)).await
}

fn spawn_auth<T, F>(f: F) -> impl std::future::Future<Output = Result<T, String>>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, GitError> + Send + 'static,
{
    async move {
        tauri::async_runtime::spawn_blocking(move || f().map_err(|e| e.to_string()))
            .await
            .map_err(|e| e.to_string())?
    }
}

#[tauri::command]
async fn auth_get_accounts() -> Result<AuthAccounts, String> {
    spawn_auth(auth_accounts).await
}

#[tauri::command]
async fn auth_save_oauth_config(
    provider: String,
    client_id: String,
    client_secret: String,
) -> Result<ProviderStatus, String> {
    spawn_auth(move || auth_save_config(&provider, &client_id, &client_secret)).await
}

#[tauri::command]
async fn auth_start_browser(provider: String) -> Result<OauthBegin, String> {
    spawn_auth(move || auth_browser_begin(&provider)).await
}

#[tauri::command]
async fn auth_finish_browser(provider: String) -> Result<ProviderStatus, String> {
    spawn_auth(move || auth_browser_finish(&provider)).await
}

#[tauri::command]
async fn auth_start_device() -> Result<GithubDeviceStart, String> {
    spawn_auth(auth_device_start).await
}

#[tauri::command]
async fn auth_poll_device(device_code: String) -> Result<GithubDevicePollResult, String> {
    spawn_auth(move || auth_device_poll(&device_code)).await
}

#[tauri::command]
async fn auth_manager_login(provider: String) -> Result<ProviderStatus, String> {
    spawn_auth(move || do_auth_manager_login(&provider)).await
}

#[tauri::command]
async fn auth_github_manager_login() -> Result<ProviderStatus, String> {
    spawn_auth(|| do_auth_manager_login("github")).await
}

#[tauri::command]
async fn auth_login_with_token(provider: String, token: String) -> Result<ProviderStatus, String> {
    spawn_auth(move || auth_login_token(&provider, &token)).await
}

#[tauri::command]
async fn auth_sign_out(provider: String) -> Result<ProviderStatus, String> {
    spawn_auth(move || auth_logout(&provider)).await
}

#[tauri::command]
async fn auth_ensure_creds() -> Result<AuthAccounts, String> {
    spawn_auth(auth_ensure_credentials).await
}

#[tauri::command]
async fn auth_switch_account_cmd(
    provider: String,
    account_id: String,
) -> Result<ProviderStatus, String> {
    spawn_auth(move || auth_switch_account(&provider, &account_id)).await
}

#[tauri::command]
async fn auth_get_ssh_status() -> Result<SshStatus, String> {
    spawn_auth(auth_ssh_status).await
}

#[tauri::command]
async fn auth_generate_ssh_key() -> Result<SshStatus, String> {
    spawn_auth(auth_ssh_generate).await
}

#[tauri::command]
async fn auth_test_ssh(provider: String) -> Result<SshTestResult, String> {
    spawn_auth(move || auth_ssh_test(&provider)).await
}

#[tauri::command]
async fn check_app_update(
    current_version: String,
    owner: Option<String>,
    repo: Option<String>,
) -> Result<update::UpdateInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        update::check_for_update(&current_version, owner, repo)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn download_app_update(asset_url: String, asset_name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        update::download_update(&asset_url, &asset_name)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn launch_app_installer(path: String, exit_app: bool) -> Result<(), String> {
    update::launch_installer(&path, exit_app)
}

#[tauri::command]
async fn publish_github_release(
    file_path: String,
    tag: String,
    title: Option<String>,
    notes: Option<String>,
    owner: Option<String>,
    repo: Option<String>,
) -> Result<update::PublishResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        update::publish_github_release(&file_path, &tag, title, notes, owner, repo)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn list_github_releases(
    owner: Option<String>,
    repo: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<update::ReleaseItem>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        update::list_github_releases(owner, repo, limit)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn delete_github_release_asset(
    asset_id: u64,
    owner: Option<String>,
    repo: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        update::delete_github_release_asset(asset_id, owner, repo)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn delete_github_release(
    release_id: u64,
    owner: Option<String>,
    repo: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        update::delete_github_release(release_id, owner, repo)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(windows)]
    webview2::ensure_webview2();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            set_app_handle(app.handle().clone());
            update::init_update_handle(app.handle().clone());
            Ok(())
        })
        .manage(AppState {
            git: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            get_git_info,
            path_exists,
            import_wallpaper,
            clear_wallpaper,
            check_repository,
            init_repo,
            get_status,
            get_status_light,
            get_repo_core,
            get_repo_extras,
            get_repo_snapshot,
            stage_files,
            unstage_files,
            list_staged_large_files,
            discard_files,
            get_diff,
            apply_patch,
            get_identity,
            set_identity,
            get_remotes,
            save_remote,
            create_commit,
            amend_last_commit,
            clone_repo,
            get_branches,
            get_remote_branches,
            branch_create,
            branch_checkout,
            remote_branch_checkout,
            branch_delete,
            branch_merge,
            branch_rebase,
            commit_cherry_pick,
            undo_commit,
            reset_commit,
            remote_branch_delete,
            git_abort_operation,
            git_continue_operation,
            git_fetch,
            git_pull,
            git_push,
            get_commits,
            get_commit_patch,
            get_stashes,
            create_stash,
            pop_stash,
            drop_stash,
            get_tags,
            tag_create,
            tag_delete,
            tag_push,
            tag_push_all,
            tag_delete_remote,
            run_command,
            auth_get_accounts,
            auth_save_oauth_config,
            auth_start_browser,
            auth_finish_browser,
            auth_start_device,
            auth_poll_device,
            auth_manager_login,
            auth_github_manager_login,
            auth_login_with_token,
            auth_sign_out,
            auth_ensure_creds,
            auth_switch_account_cmd,
            auth_get_ssh_status,
            auth_generate_ssh_key,
            auth_test_ssh,
            check_app_update,
            download_app_update,
            launch_app_installer,
            publish_github_release,
            list_github_releases,
            delete_github_release_asset,
            delete_github_release,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
