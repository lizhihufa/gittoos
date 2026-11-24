mod git;
mod process_win;
mod update;
mod webview2;

use git::{
    abort_operation, actions_mirror_status, add_to_gitignore, amend_commit, apply_cached_patch,
    apply_workdir_patch, auth_accounts, auth_browser_begin, auth_browser_finish, auth_device_poll,
    auth_device_start, auth_ensure_credentials, auth_login_token, auth_logout,
    auth_manager_login as do_auth_manager_login, auth_save_config, auth_ssh_generate,
    auth_ssh_status, auth_ssh_test, auth_switch_account, checkout_branch, checkout_commit,
    checkout_remote_branch, cherry_pick, clean_files, clone_repository, commit, commit_patch,
    compare_refs, continue_operation, create_branch, create_or_get_hosting_repo, create_tag,
    delete_branch, delete_remote_branch, delete_remote_tag, delete_tag, discard_paths, ensure_git,
    blame_file, fetch, file_diff, git_info, init_repository, is_repository, list_branches,
    list_commits, list_file_commits, list_reflog, list_remote_branches, list_remotes, list_stashes,
    list_rebase_todo, list_tags, merge_branch, publish_hosting_remotes, pull, push_all_tags,
    push_tag, push_with_options, read_identity, read_workdir_file, rebase_branch,
    rebase_interactive, remove_remote, rename_branch, repo_status, repo_status_light_nonblocking,
    reset_to_commit, revert_commit, run_shell, set_app_handle, set_remote_url, setup_actions_mirror,
    set_upstream, skip_rebase, stage_paths, staged_large_files, stash_apply, stash_drop, stash_pop,
    stash_push, stash_show, undo_last_commit, unstage_paths, with_git_quiet, write_identity,
    write_workdir_file,
    ActionsMirrorSetup, ActionsMirrorStatus, AuthAccounts, BranchInfo, CommitInfo, GitBinary,
    GitError, GitInfo, RebaseTodoItem,
    GithubDevicePollResult, GithubDeviceStart, HostingRepo, Identity, LargeFileInfo, OauthBegin,
    ProviderStatus, ReflogInfo, RemoteBranchInfo, RemoteInfo, RepoCore, RepoExtras, RepoSnapshot,
    RepoStatus, SshStatus, SshTestResult, StashInfo, TagInfo,
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

fn wallpaper_slot_prefix(slot: Option<String>) -> Result<&'static str, String> {
    match slot
        .as_deref()
        .unwrap_or("load")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "load" | "" => Ok("wallpaper.load."),
        "terminal" => Ok("wallpaper.terminal."),
        other => Err(format!("未知壁纸槽位：{other}")),
    }
}

#[tauri::command]
fn import_wallpaper(
    app: AppHandle,
    source: String,
    slot: Option<String>,
) -> Result<String, String> {
    let prefix = wallpaper_slot_prefix(slot)?;
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
    // Clear previous files for this slot only.
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(prefix) {
                let _ = std::fs::remove_file(entry.path());
            }
            // Legacy single wallpaper.* (no slot) — clear when setting load wallpaper.
            if prefix == "wallpaper.load."
                && name.starts_with("wallpaper.")
                && !name.starts_with("wallpaper.load.")
                && !name.starts_with("wallpaper.terminal.")
            {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    let dest = dir.join(format!("{prefix}{ext}"));
    std::fs::copy(src, &dest).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
fn clear_wallpaper(app: AppHandle, slot: Option<String>) -> Result<(), String> {
    let prefix = wallpaper_slot_prefix(slot)?;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(prefix) {
                let _ = std::fs::remove_file(entry.path());
            }
            if prefix == "wallpaper.load."
                && name.starts_with("wallpaper.")
                && !name.starts_with("wallpaper.load.")
                && !name.starts_with("wallpaper.terminal.")
            {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    Ok(())
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SystemWallpaperItem {
    path: String,
    kind: String, // "image" | "video"
    label: String,
    source: String,
}

fn wallpaper_kind_from_path(path: &Path) -> Option<&'static str> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" | "jpg" | "jpeg" | "webp" | "bmp" | "gif" => Some("image"),
        "mp4" | "webm" | "mov" => Some("video"),
        // Windows TranscodedWallpaper often has no extension but is an image blob
        "" => {
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if name.contains("wallpaper") || name == "transcodedwallpaper" {
                Some("image")
            } else {
                None
            }
        }
        _ => None,
    }
}

fn push_wallpaper_if_valid(
    out: &mut Vec<SystemWallpaperItem>,
    seen: &mut std::collections::HashSet<String>,
    path: PathBuf,
    source: &str,
) {
    if !path.is_file() {
        return;
    }
    let Some(kind) = wallpaper_kind_from_path(&path) else {
        return;
    };
    // Skip tiny spotlight junk (< 20KB) that aren't real wallpapers
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() < 20_000 {
            return;
        }
    }
    let key = path.to_string_lossy().to_ascii_lowercase();
    if !seen.insert(key) {
        return;
    }
    let label = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("wallpaper")
        .to_string();
    out.push(SystemWallpaperItem {
        path: path.to_string_lossy().to_string(),
        kind: kind.to_string(),
        label,
        source: source.to_string(),
    });
}

fn collect_dir_wallpapers(
    out: &mut Vec<SystemWallpaperItem>,
    seen: &mut std::collections::HashSet<String>,
    dir: &Path,
    source: &str,
    recursive: bool,
) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            push_wallpaper_if_valid(out, seen, path, source);
        } else if recursive && path.is_dir() {
            collect_dir_wallpapers(out, seen, &path, source, false);
        }
    }
}

#[cfg(windows)]
fn desktop_wallpaper_from_registry() -> Option<PathBuf> {
    use std::os::windows::process::CommandExt;
    // Avoid flashing a console window.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let output = std::process::Command::new("reg")
        .args([
            "query",
            r"HKCU\Control Panel\Desktop",
            "/v",
            "WallPaper",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines() {
        if let Some(idx) = line.find("REG_SZ") {
            let path = line[idx + "REG_SZ".len()..].trim();
            if !path.is_empty() {
                return Some(PathBuf::from(path));
            }
        }
    }
    None
}

#[cfg(not(windows))]
fn desktop_wallpaper_from_registry() -> Option<PathBuf> {
    None
}

/// List wallpapers from the current desktop wallpaper and common Windows Wallpaper folders.
#[tauri::command]
fn list_system_wallpapers() -> Result<Vec<SystemWallpaperItem>, String> {
    let mut out: Vec<SystemWallpaperItem> = Vec::new();
    let mut seen = std::collections::HashSet::new();

    if let Some(desk) = desktop_wallpaper_from_registry() {
        push_wallpaper_if_valid(&mut out, &mut seen, desk, "desktop");
    }

    if let Ok(appdata) = std::env::var("APPDATA") {
        let themes = PathBuf::from(&appdata).join(r"Microsoft\Windows\Themes");
        push_wallpaper_if_valid(
            &mut out,
            &mut seen,
            themes.join("TranscodedWallpaper"),
            "themes",
        );
        collect_dir_wallpapers(
            &mut out,
            &mut seen,
            &themes.join("CachedFiles"),
            "themes",
            false,
        );
    }

    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let local = PathBuf::from(local);
        collect_dir_wallpapers(
            &mut out,
            &mut seen,
            &local.join(r"Microsoft\Windows\Themes\CachedFiles"),
            "cached",
            false,
        );
        // Windows Spotlight / Content Delivery assets
        let spotlight = local.join(
            r"Packages\Microsoft.Windows.ContentDeliveryManager_cw5n1h2txyewy\LocalState\Assets",
        );
        if let Ok(entries) = std::fs::read_dir(&spotlight) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_file() {
                    continue;
                }
                if let Ok(meta) = std::fs::metadata(&path) {
                    // Spotlight lock-screen candidates are usually large JPEGs
                    if meta.len() < 80_000 {
                        continue;
                    }
                }
                let key = path.to_string_lossy().to_ascii_lowercase();
                if !seen.insert(key) {
                    continue;
                }
                out.push(SystemWallpaperItem {
                    path: path.to_string_lossy().to_string(),
                    kind: "image".into(),
                    label: path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("spotlight")
                        .to_string(),
                    source: "spotlight".into(),
                });
            }
        }
    }

    // Public / Windows wallpaper folders
    for (dir, source) in [
        (
            PathBuf::from(r"C:\Windows\Web\Wallpaper"),
            "windows",
        ),
        (
            PathBuf::from(r"C:\Windows\Web\Screen"),
            "windows",
        ),
    ] {
        collect_dir_wallpapers(&mut out, &mut seen, &dir, source, true);
    }

    // Prefer desktop first; then cap list size for UI
    out.sort_by(|a, b| {
        let rank = |s: &str| match s {
            "desktop" => 0,
            "themes" => 1,
            "cached" => 2,
            "spotlight" => 3,
            _ => 4,
        };
        rank(&a.source)
            .cmp(&rank(&b.source))
            .then(a.label.cmp(&b.label))
    });
    out.truncate(48);
    Ok(out)
}

#[tauri::command]
fn clear_app_wallpaper_files(app: AppHandle) -> Result<(), String> {
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

const HOSTS_MARKER_BEGIN: &str = "# qingzhi-github-hosts BEGIN";
const HOSTS_MARKER_END: &str = "# qingzhi-github-hosts END";

fn system_hosts_path() -> PathBuf {
    #[cfg(windows)]
    {
        PathBuf::from(r"C:\Windows\System32\drivers\etc\hosts")
    }
    #[cfg(not(windows))]
    {
        PathBuf::from("/etc/hosts")
    }
}

fn strip_managed_hosts_block(content: &str) -> String {
    let mut out = String::new();
    let mut skipping = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed == HOSTS_MARKER_BEGIN {
            skipping = true;
            continue;
        }
        if trimmed == HOSTS_MARKER_END {
            skipping = false;
            continue;
        }
        if !skipping {
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}

fn wrap_hosts_block(block: &str) -> String {
    let body = block
        .lines()
        .filter(|l| {
            let t = l.trim();
            t != HOSTS_MARKER_BEGIN && t != HOSTS_MARKER_END
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!("{HOSTS_MARKER_BEGIN}\n{body}\n{HOSTS_MARKER_END}\n")
}

#[tauri::command]
fn get_system_hosts_path() -> String {
    system_hosts_path().to_string_lossy().to_string()
}

#[tauri::command]
fn reveal_system_hosts() -> Result<(), String> {
    let path = system_hosts_path();
    let dir = path
        .parent()
        .ok_or_else(|| "无法定位 Hosts 目录".to_string())?;
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(dir)
            .spawn()
            .map_err(|e| format!("无法打开资源管理器: {e}"))?;
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(dir)
            .spawn()
            .map_err(|e| format!("无法打开目录: {e}"))?;
        Ok(())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(|e| format!("无法打开目录: {e}"))?;
        Ok(())
    }
}

fn build_hosts_file_content(block: &str) -> String {
    let path = system_hosts_path();
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let cleaned = strip_managed_hosts_block(&existing);
    let trimmed = block.trim();
    if trimmed.is_empty() {
        cleaned
    } else {
        format!("{}\n{}", cleaned.trim_end(), wrap_hosts_block(trimmed))
    }
}

#[cfg(windows)]
fn write_hosts_elevated(next_content: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let temp = std::env::temp_dir().join(format!(
        "qingzhi-hosts-{}.txt",
        std::process::id()
    ));
    std::fs::write(&temp, next_content).map_err(|e| format!("写入临时文件失败: {e}"))?;

    let hosts = system_hosts_path();
    let temp_s = temp.to_string_lossy().replace('\'', "''");
    let hosts_s = hosts.to_string_lossy().replace('\'', "''");
    // Nested elevated powershell: UAC prompt once, then copy over hosts.
    let inner = format!(
        "Copy-Item -LiteralPath '{temp_s}' -Destination '{hosts_s}' -Force; if (-not $?) {{ exit 1 }}"
    );
    let inner_escaped = inner.replace('\'', "''");
    let outer = format!(
        "Start-Process -FilePath powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-Command','{inner_escaped}'; exit $LASTEXITCODE"
    );

    let output = std::process::Command::new("powershell")
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &outer])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("无法请求管理员权限写入 Hosts: {e}"))?;

    let _ = std::fs::remove_file(&temp);
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "管理员写入 Hosts 失败或已取消 UAC 授权。{}",
            if stderr.trim().is_empty() {
                String::new()
            } else {
                format!("\n{stderr}")
            }
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn write_hosts_elevated(next_content: &str) -> Result<(), String> {
    let path = system_hosts_path();
    std::fs::write(&path, next_content).map_err(|e| {
        format!(
            "写入 Hosts 失败（通常需要管理员/root 权限）: {e}\n路径: {}",
            path.display()
        )
    })
}

/// Replace the managed `# qingzhi-github-hosts` block in the system hosts file.
/// Empty `block` removes the managed section. Tries direct write, then elevates (UAC) on Windows.
#[tauri::command]
fn apply_system_hosts(block: String) -> Result<String, String> {
    let path = system_hosts_path();
    let next = build_hosts_file_content(&block);
    match std::fs::write(&path, &next) {
        Ok(()) => Ok(path.to_string_lossy().to_string()),
        Err(e) => {
            // Permission denied → try UAC elevation on Windows.
            let kind = e.kind();
            if kind == std::io::ErrorKind::PermissionDenied
                || kind == std::io::ErrorKind::Other
                || format!("{e}").to_ascii_lowercase().contains("access")
                || format!("{e}").contains("拒绝")
            {
                write_hosts_elevated(&next)?;
                Ok(path.to_string_lossy().to_string())
            } else {
                Err(format!(
                    "写入 Hosts 失败: {e}\n路径: {}",
                    path.display()
                ))
            }
        }
    }
}

fn doh_resolve_a(name: &str) -> Option<String> {
    // Prefer AliDNS DoH — usually reachable in CN; fall back to Cloudflare.
    for base in [
        "https://dns.alidns.com/resolve",
        "https://cloudflare-dns.com/dns-query",
    ] {
        let url = format!("{base}?name={name}&type=A");
        let mut req = ureq::get(&url);
        if base.contains("cloudflare") {
            req = req.set("Accept", "application/dns-json");
        }
        let Ok(resp) = req.call() else {
            continue;
        };
        let Ok(v) = resp.into_json::<serde_json::Value>() else {
            continue;
        };
        if let Some(arr) = v.get("Answer").and_then(|a| a.as_array()) {
            for ans in arr {
                let ty = ans.get("type").and_then(|t| t.as_u64()).unwrap_or(0);
                if ty != 1 {
                    continue;
                }
                if let Some(ip) = ans.get("data").and_then(|d| d.as_str()) {
                    let ip = ip.trim();
                    // Basic IPv4 sanity
                    if ip.split('.').count() == 4 {
                        return Some(ip.to_string());
                    }
                }
            }
        }
    }
    None
}

const GITHUB_HOST_NAMES: &[&str] = &[
    "github.com",
    "api.github.com",
    "codeload.github.com",
    "raw.githubusercontent.com",
    "objects.githubusercontent.com",
    "gist.githubusercontent.com",
];

/// Resolve GitHub-related domains to A records and build a hosts snippet.
#[tauri::command]
fn resolve_github_hosts() -> Result<String, String> {
    let mut lines: Vec<String> = Vec::new();
    let mut ok = 0usize;
    for name in GITHUB_HOST_NAMES {
        if let Some(ip) = doh_resolve_a(name) {
            lines.push(format!("{ip} {name}"));
            ok += 1;
        }
    }
    if ok == 0 {
        return Err(
            "未能解析到 GitHub IP（网络或 DNS 不可用）。可稍后重试，或改用镜像加速。"
                .into(),
        );
    }
    // Fill missing with first successful github.com IP when possible
    let fallback_ip = lines
        .iter()
        .find(|l| l.contains("github.com"))
        .and_then(|l| l.split_whitespace().next())
        .unwrap_or("140.82.121.3")
        .to_string();
    for name in GITHUB_HOST_NAMES {
        if !lines.iter().any(|l| l.ends_with(name)) {
            lines.push(format!("{fallback_ip} {name}"));
        }
    }
    Ok(format!(
        "{HOSTS_MARKER_BEGIN}\n{}\n{HOSTS_MARKER_END}\n",
        lines.join("\n")
    ))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct HostsStatus {
    path: String,
    managed: bool,
}

#[tauri::command]
fn get_hosts_status() -> HostsStatus {
    let path = system_hosts_path();
    let content = std::fs::read_to_string(&path).unwrap_or_default();
    HostsStatus {
        path: path.to_string_lossy().to_string(),
        managed: content.contains(HOSTS_MARKER_BEGIN),
    }
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
    branch: Option<String>,
    depth: Option<u32>,
) -> Result<String, String> {
    let dest = PathBuf::from(&destination);
    let branch = branch
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let depth = depth.filter(|d| *d > 0);
    with_git_async(&state, move |git| {
        clone_repository(git, &url, &dest, branch.as_deref(), depth)
    })
    .await?;
    Ok(destination)
}

#[tauri::command]
async fn setup_actions_mirror_cmd(
    state: State<'_, AppState>,
    path: String,
    configure_secret: Option<bool>,
) -> Result<ActionsMirrorSetup, String> {
    let repo = repo_path(&path)?;
    let configure_secret = configure_secret.unwrap_or(true);
    with_git_async(&state, move |git| {
        setup_actions_mirror(git, &repo, configure_secret)
    })
    .await
}

#[tauri::command]
fn get_actions_mirror_status(
    state: State<'_, AppState>,
    path: String,
) -> Result<ActionsMirrorStatus, String> {
    let repo = repo_path(&path)?;
    with_git_quiet(|| with_git(&state, |git| actions_mirror_status(git, &repo)))
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
async fn get_rebase_todo(
    state: State<'_, AppState>,
    path: String,
    onto: String,
) -> Result<Vec<CommitInfo>, String> {
    let repo = repo_path(&path)?;
    with_git_async(&state, move |git| list_rebase_todo(git, &repo, &onto)).await
}

#[tauri::command]
async fn branch_rebase_interactive(
    state: State<'_, AppState>,
    path: String,
    onto: String,
    items: Vec<RebaseTodoItem>,
) -> Result<String, String> {
    let repo = repo_path(&path)?;
    with_git_async(&state, move |git| {
        rebase_interactive(git, &repo, &onto, &items)
    })
    .await
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
async fn commit_revert(
    state: State<'_, AppState>,
    path: String,
    hash: String,
) -> Result<String, String> {
    let repo = repo_path(&path)?;
    with_git_async(&state, move |git| revert_commit(git, &repo, &hash)).await
}

#[tauri::command]
async fn commit_checkout(
    state: State<'_, AppState>,
    path: String,
    hash: String,
    new_branch: Option<String>,
) -> Result<String, String> {
    let repo = repo_path(&path)?;
    let new_branch = new_branch
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    with_git_async(&state, move |git| {
        checkout_commit(git, &repo, &hash, new_branch.as_deref())
    })
    .await
}

#[tauri::command]
async fn branch_rename(
    state: State<'_, AppState>,
    path: String,
    old_name: String,
    new_name: String,
) -> Result<String, String> {
    let repo = repo_path(&path)?;
    with_git_async(&state, move |git| rename_branch(git, &repo, &old_name, &new_name)).await
}

#[tauri::command]
async fn branch_set_upstream(
    state: State<'_, AppState>,
    path: String,
    remote: String,
    branch: String,
    local_branch: Option<String>,
) -> Result<String, String> {
    let repo = repo_path(&path)?;
    let local_branch = local_branch
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    with_git_async(&state, move |git| {
        set_upstream(git, &repo, &remote, &branch, local_branch.as_deref())
    })
    .await
}

#[tauri::command]
async fn add_gitignore(
    state: State<'_, AppState>,
    path: String,
    paths: Vec<String>,
) -> Result<String, String> {
    let repo = repo_path(&path)?;
    with_git_async(&state, move |git| add_to_gitignore(git, &repo, &paths)).await
}

#[tauri::command]
fn get_file_commits(
    state: State<'_, AppState>,
    path: String,
    file: String,
    limit: Option<u32>,
) -> Result<Vec<CommitInfo>, String> {
    let repo = repo_path(&path)?;
    let limit = limit.unwrap_or(50);
    with_git_quiet(|| with_git(&state, |git| list_file_commits(git, &repo, &file, limit)))
}

#[tauri::command]
async fn get_file_blame(
    state: State<'_, AppState>,
    path: String,
    file: String,
) -> Result<String, String> {
    let repo = repo_path(&path)?;
    with_git_async(&state, move |git| {
        with_git_quiet(|| blame_file(git, &repo, &file))
    })
    .await
}

#[tauri::command]
fn get_reflog(
    state: State<'_, AppState>,
    path: String,
    limit: Option<u32>,
) -> Result<Vec<ReflogInfo>, String> {
    let repo = repo_path(&path)?;
    let limit = limit.unwrap_or(80);
    with_git_quiet(|| with_git(&state, |git| list_reflog(git, &repo, limit)))
}

#[tauri::command]
async fn git_clean(
    state: State<'_, AppState>,
    path: String,
    dry_run: Option<bool>,
    include_ignored: Option<bool>,
) -> Result<String, String> {
    let repo = repo_path(&path)?;
    let dry_run = dry_run.unwrap_or(false);
    let include_ignored = include_ignored.unwrap_or(false);
    with_git_async(&state, move |git| {
        clean_files(git, &repo, dry_run, include_ignored)
    })
    .await
}

#[tauri::command]
async fn compare_refs_cmd(
    state: State<'_, AppState>,
    path: String,
    left: String,
    right: String,
) -> Result<String, String> {
    let repo = repo_path(&path)?;
    with_git_async(&state, move |git| compare_refs(git, &repo, &left, &right)).await
}

#[tauri::command]
async fn remove_remote_cmd(
    state: State<'_, AppState>,
    path: String,
    name: String,
) -> Result<String, String> {
    let repo = repo_path(&path)?;
    with_git_async(&state, move |git| remove_remote(git, &repo, &name)).await
}

#[tauri::command]
async fn apply_workdir_hunk(
    state: State<'_, AppState>,
    path: String,
    patch: String,
    reverse: Option<bool>,
) -> Result<String, String> {
    let repo = repo_path(&path)?;
    let reverse = reverse.unwrap_or(true);
    with_git_async(&state, move |git| {
        apply_workdir_patch(git, &repo, &patch, reverse)
    })
    .await
}

#[tauri::command]
async fn read_repo_file(path: String, file: String) -> Result<String, String> {
    let repo = repo_path(&path)?;
    tauri::async_runtime::spawn_blocking(move || read_workdir_file(&repo, &file))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn write_repo_file(path: String, file: String, content: String) -> Result<(), String> {
    let repo = repo_path(&path)?;
    tauri::async_runtime::spawn_blocking(move || write_workdir_file(&repo, &file, &content))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
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
async fn git_skip_rebase(
    state: State<'_, AppState>,
    path: String,
) -> Result<String, String> {
    let repo = repo_path(&path)?;
    with_git_async(&state, move |git| skip_rebase(git, &repo)).await
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
async fn git_fetch(
    state: State<'_, AppState>,
    path: String,
    remote: Option<String>,
) -> Result<String, String> {
    let repo = repo_path(&path)?;
    let remote = remote
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    with_git_async(&state, move |git| fetch(git, &repo, remote.as_deref())).await
}

#[tauri::command]
async fn git_pull(
    state: State<'_, AppState>,
    path: String,
    allow_unrelated: Option<bool>,
    rebase: Option<bool>,
) -> Result<String, String> {
    let repo = repo_path(&path)?;
    let allow_unrelated = allow_unrelated.unwrap_or(false);
    let rebase = rebase.unwrap_or(false);
    with_git_async(&state, move |git| pull(git, &repo, allow_unrelated, rebase)).await
}

#[tauri::command]
async fn git_push(
    state: State<'_, AppState>,
    path: String,
    force: Option<bool>,
    sync_mirror: Option<String>,
    remote: Option<String>,
) -> Result<String, String> {
    let repo = repo_path(&path)?;
    let force = force.unwrap_or(false);
    let sync_mirror = sync_mirror
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let remote = remote
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    with_git_async(&state, move |git| {
        push_with_options(
            git,
            &repo,
            force,
            sync_mirror.as_deref(),
            remote.as_deref(),
        )
    })
    .await
}

#[tauri::command]
async fn create_hosting_repo(
    provider: String,
    name: String,
    private: Option<bool>,
    description: Option<String>,
) -> Result<HostingRepo, String> {
    let private = private.unwrap_or(false);
    let description = description.unwrap_or_default();
    create_or_get_hosting_repo(&provider, &name, private, &description).map_err(|e| e.to_string())
}

#[tauri::command]
async fn publish_remotes(
    state: State<'_, AppState>,
    path: String,
    name: String,
    to_github: Option<bool>,
    to_gitee: Option<bool>,
    private: Option<bool>,
) -> Result<String, String> {
    let repo = repo_path(&path)?;
    let to_github = to_github.unwrap_or(false);
    let to_gitee = to_gitee.unwrap_or(false);
    let private = private.unwrap_or(false);
    with_git_async(&state, move |git| {
        publish_hosting_remotes(git, &repo, &name, to_github, to_gitee, private)
    })
    .await
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
async fn apply_stash(
    state: State<'_, AppState>,
    path: String,
    index: u32,
) -> Result<String, String> {
    let repo = repo_path(&path)?;
    with_git_async(&state, move |git| stash_apply(git, &repo, index)).await
}

#[tauri::command]
async fn show_stash(
    state: State<'_, AppState>,
    path: String,
    index: u32,
) -> Result<String, String> {
    let repo = repo_path(&path)?;
    with_git_async(&state, move |git| stash_show(git, &repo, index)).await
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
    message: Option<String>,
) -> Result<(), String> {
    let repo = repo_path(&path)?;
    let message = message
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    with_git_async(&state, move |git| {
        create_tag(git, &repo, &name, message.as_deref())
    })
    .await
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
            list_system_wallpapers,
            clear_app_wallpaper_files,
            get_system_hosts_path,
            reveal_system_hosts,
            apply_system_hosts,
            resolve_github_hosts,
            get_hosts_status,
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
            setup_actions_mirror_cmd,
            get_actions_mirror_status,
            get_branches,
            get_remote_branches,
            branch_create,
            branch_checkout,
            remote_branch_checkout,
            branch_delete,
            branch_merge,
            branch_rebase,
            get_rebase_todo,
            branch_rebase_interactive,
            commit_cherry_pick,
            commit_revert,
            commit_checkout,
            branch_rename,
            branch_set_upstream,
            add_gitignore,
            get_file_commits,
            get_file_blame,
            get_reflog,
            git_clean,
            compare_refs_cmd,
            remove_remote_cmd,
            apply_workdir_hunk,
            read_repo_file,
            write_repo_file,
            undo_commit,
            reset_commit,
            remote_branch_delete,
            git_abort_operation,
            git_continue_operation,
            git_skip_rebase,
            git_fetch,
            git_pull,
            git_push,
            create_hosting_repo,
            publish_remotes,
            get_commits,
            get_commit_patch,
            get_stashes,
            create_stash,
            pop_stash,
            apply_stash,
            show_stash,
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
