//! Check / download / publish GitHub Releases for 青枝.
use crate::git::{github_access_token, local_proxy, set_app_handle};
use crate::process_win::hide_console;
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub const DEFAULT_OWNER: &str = "lizhihufa";
pub const DEFAULT_REPO: &str = "gittoos";

static APP: OnceLock<AppHandle> = OnceLock::new();

pub fn init_update_handle(app: AppHandle) {
    let _ = APP.set(app.clone());
    // Re-use git terminal handle if already set; update progress uses its own event.
    set_app_handle(app);
}

fn emit_progress(percent: u32, label: &str) {
    if let Some(app) = APP.get() {
        let _ = app.emit(
            "update-progress",
            UpdateProgressEvent {
                percent: percent.min(100),
                label: label.to_string(),
            },
        );
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgressEvent {
    pub percent: u32,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub update_available: bool,
    pub current_version: String,
    pub latest_version: String,
    pub tag_name: String,
    pub name: String,
    pub body: String,
    pub html_url: String,
    pub asset_name: String,
    pub asset_url: String,
    pub asset_size: u64,
    pub owner: String,
    pub repo: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishResult {
    pub tag_name: String,
    pub html_url: String,
    pub asset_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseAssetInfo {
    pub id: u64,
    pub name: String,
    pub size: u64,
    pub size_label: String,
    pub download_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseItem {
    pub id: u64,
    pub tag_name: String,
    pub name: String,
    pub body: String,
    pub html_url: String,
    pub published_at: String,
    pub assets: Vec<ReleaseAssetInfo>,
}

#[derive(Deserialize)]
struct GhRelease {
    id: Option<u64>,
    tag_name: String,
    name: Option<String>,
    body: Option<String>,
    html_url: String,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    assets: Vec<GhAsset>,
}

#[derive(Deserialize)]
struct GhAsset {
    #[serde(default)]
    id: u64,
    name: String,
    size: u64,
    browser_download_url: String,
}

fn http_agent(timeout_secs: u64) -> ureq::Agent {
    let mut builder = ureq::AgentBuilder::new().timeout(Duration::from_secs(timeout_secs));
    if let Some(proxy) = local_proxy() {
        if let Ok(p) = ureq::Proxy::new(&proxy) {
            builder = builder.proxy(p);
        }
    }
    builder.build()
}

fn normalize_version(raw: &str) -> String {
    raw.trim().trim_start_matches(['v', 'V']).trim().to_string()
}

fn parse_semver(raw: &str) -> Option<(u64, u64, u64)> {
    let v = normalize_version(raw);
    let mut parts = v.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().unwrap_or("0").parse().unwrap_or(0);
    let patch = parts
        .next()
        .unwrap_or("0")
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect::<String>()
        .parse()
        .unwrap_or(0);
    Some((major, minor, patch))
}

fn version_cmp(a: &str, b: &str) -> Option<std::cmp::Ordering> {
    let a = parse_semver(a)?;
    let b = parse_semver(b)?;
    Some(a.cmp(&b))
}

fn pick_installer_asset(assets: &[GhAsset]) -> Option<&GhAsset> {
    assets.iter().find(|a| {
        let n = a.name.to_ascii_lowercase();
        n.ends_with("-setup.exe") || (n.ends_with(".exe") && n.contains("setup"))
    }).or_else(|| {
        assets.iter().find(|a| a.name.to_ascii_lowercase().ends_with(".exe"))
    })
}

fn github_get_json(url: &str, token: Option<&str>) -> Result<String, String> {
    let agent = http_agent(45);
    let mut req = agent
        .get(url)
        .set("Accept", "application/vnd.github+json")
        .set("User-Agent", "qingzhi")
        .set("X-GitHub-Api-Version", "2022-11-28");
    if let Some(t) = token.filter(|t| !t.is_empty()) {
        req = req.set("Authorization", &format!("Bearer {t}"));
    }
    let resp = req.call().map_err(|e| format!("请求 GitHub 失败：{e}"))?;
    let status = resp.status();
    let body = resp.into_string().map_err(|e| format!("读取响应失败：{e}"))?;
    if !(200..300).contains(&status) {
        return Err(format!("GitHub HTTP {status}：{}", body.chars().take(200).collect::<String>()));
    }
    Ok(body)
}

pub fn check_for_update(
    current_version: &str,
    owner: Option<String>,
    repo: Option<String>,
) -> Result<UpdateInfo, String> {
    let owner = owner
        .unwrap_or_else(|| DEFAULT_OWNER.to_string())
        .trim()
        .to_string();
    let repo = repo
        .unwrap_or_else(|| DEFAULT_REPO.to_string())
        .trim()
        .to_string();
    if owner.is_empty() || repo.is_empty() {
        return Err("请填写 GitHub 仓库 owner/repo".to_string());
    }

    let url = format!("https://api.github.com/repos/{owner}/{repo}/releases/latest");
    let body = github_get_json(&url, None)?;
    let release: GhRelease =
        serde_json::from_str(&body).map_err(|e| format!("解析 Release 失败：{e}"))?;

    let asset = pick_installer_asset(&release.assets).ok_or_else(|| {
        "最新 Release 里没有找到安装包（.exe）。请先上传安装包到 GitHub Releases。".to_string()
    })?;

    let latest = normalize_version(&release.tag_name);
    let current = normalize_version(current_version);
    let newer = match version_cmp(&latest, &current) {
        Some(std::cmp::Ordering::Greater) => true,
        Some(_) => false,
        None => latest != current && !latest.is_empty(),
    };

    Ok(UpdateInfo {
        update_available: newer,
        current_version: current,
        latest_version: latest,
        tag_name: release.tag_name,
        name: release.name.unwrap_or_default(),
        body: release.body.unwrap_or_default(),
        html_url: release.html_url,
        asset_name: asset.name.clone(),
        asset_url: asset.browser_download_url.clone(),
        asset_size: asset.size,
        owner,
        repo,
    })
}

fn downloads_dir() -> Result<PathBuf, String> {
    let local = std::env::var("LOCALAPPDATA").map_err(|_| "找不到 LOCALAPPDATA".to_string())?;
    let dir = PathBuf::from(local).join("qingzhi").join("updates");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建下载目录失败：{e}"))?;
    Ok(dir)
}

pub fn download_update(asset_url: &str, asset_name: &str) -> Result<String, String> {
    let name = Path::new(asset_name)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("qingzhi-setup.exe");
    let dest = downloads_dir()?.join(name);
    if dest.exists() {
        let _ = std::fs::remove_file(&dest);
    }

    emit_progress(1, "开始下载…");
    let agent = http_agent(600);
    let resp = agent
        .get(asset_url)
        .set("User-Agent", "qingzhi")
        .set("Accept", "application/octet-stream")
        .call()
        .map_err(|e| format!("下载失败：{e}"))?;

    if !(200..300).contains(&resp.status()) {
        return Err(format!("下载失败：HTTP {}", resp.status()));
    }

    let total = resp
        .header("Content-Length")
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);

    let mut reader = resp.into_reader();
    let mut file = File::create(&dest).map_err(|e| format!("无法写入下载文件：{e}"))?;
    let mut buf = [0u8; 64 * 1024];
    let mut done: u64 = 0;
    let mut last_pct: u32 = 0;

    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("下载中断：{e}"))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n])
            .map_err(|e| format!("写入失败：{e}"))?;
        done += n as u64;
        if total > 0 {
            let pct = ((done * 100) / total) as u32;
            if pct >= last_pct + 1 || pct == 100 {
                last_pct = pct;
                emit_progress(
                    pct,
                    &format!(
                        "下载中 {} / {}",
                        format_bytes(done),
                        format_bytes(total)
                    ),
                );
            }
        } else if done % (8 * 1024 * 1024) < 64 * 1024 {
            emit_progress(
                ((done / (1024 * 1024)) % 99) as u32,
                &format!("已下载 {}", format_bytes(done)),
            );
        }
    }
    file.flush().ok();
    emit_progress(100, "下载完成");
    Ok(dest.display().to_string())
}

fn format_bytes(n: u64) -> String {
    if n >= 1024 * 1024 * 1024 {
        format!("{:.2} GB", n as f64 / (1024.0 * 1024.0 * 1024.0))
    } else if n >= 1024 * 1024 {
        format!("{:.1} MB", n as f64 / (1024.0 * 1024.0))
    } else if n >= 1024 {
        format!("{:.1} KB", n as f64 / 1024.0)
    } else {
        format!("{n} B")
    }
}

pub fn launch_installer(path: &str, exit_app: bool) -> Result<(), String> {
    let p = PathBuf::from(path);
    if !p.is_file() {
        return Err("安装包不存在".to_string());
    }
    let mut cmd = Command::new(&p);
    hide_console(&mut cmd);
    cmd.spawn().map_err(|e| format!("无法启动安装程序：{e}"))?;
    if exit_app {
        if let Some(app) = APP.get() {
            app.exit(0);
        }
    }
    Ok(())
}

fn optional_github_token() -> Option<String> {
    github_access_token().ok().flatten()
}

fn require_github_token() -> Result<String, String> {
    optional_github_token()
        .ok_or_else(|| "请先在「账号登录」里登录 GitHub（需要有仓库写入权限的 Token）".to_string())
}

fn owner_repo(owner: Option<String>, repo: Option<String>) -> Result<(String, String), String> {
    let owner = owner
        .unwrap_or_else(|| DEFAULT_OWNER.to_string())
        .trim()
        .to_string();
    let repo = repo
        .unwrap_or_else(|| DEFAULT_REPO.to_string())
        .trim()
        .to_string();
    if owner.is_empty() || repo.is_empty() {
        return Err("请填写 GitHub 仓库 owner/repo".to_string());
    }
    Ok((owner, repo))
}

fn release_to_item(rel: GhRelease) -> Option<ReleaseItem> {
    let id = rel.id?;
    Some(ReleaseItem {
        id,
        tag_name: rel.tag_name,
        name: rel.name.unwrap_or_default(),
        body: rel.body.unwrap_or_default(),
        html_url: rel.html_url,
        published_at: rel.published_at.unwrap_or_default(),
        assets: rel
            .assets
            .into_iter()
            .map(|a| ReleaseAssetInfo {
                id: a.id,
                name: a.name,
                size: a.size,
                size_label: format_bytes(a.size),
                download_url: a.browser_download_url,
            })
            .collect(),
    })
}

/// List recent GitHub Releases (public OK; token used when logged in).
pub fn list_github_releases(
    owner: Option<String>,
    repo: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<ReleaseItem>, String> {
    let (owner, repo) = owner_repo(owner, repo)?;
    let per_page = limit.unwrap_or(20).clamp(1, 50);
    let url = format!(
        "https://api.github.com/repos/{owner}/{repo}/releases?per_page={per_page}"
    );
    let token = optional_github_token();
    let body = github_get_json(&url, token.as_deref())?;
    let releases: Vec<GhRelease> =
        serde_json::from_str(&body).map_err(|e| format!("解析 Release 列表失败：{e}"))?;
    Ok(releases.into_iter().filter_map(release_to_item).collect())
}

pub fn delete_github_release_asset(
    asset_id: u64,
    owner: Option<String>,
    repo: Option<String>,
) -> Result<(), String> {
    let token = require_github_token()?;
    let (owner, repo) = owner_repo(owner, repo)?;
    let agent = http_agent(45);
    let resp = agent
        .delete(&format!(
            "https://api.github.com/repos/{owner}/{repo}/releases/assets/{asset_id}"
        ))
        .set("Accept", "application/vnd.github+json")
        .set("Authorization", &format!("Bearer {token}"))
        .set("User-Agent", "qingzhi")
        .set("X-GitHub-Api-Version", "2022-11-28")
        .call()
        .map_err(|e| format!("删除附件失败：{e}"))?;
    let status = resp.status();
    if status != 204 && !(200..300).contains(&status) {
        let text = resp.into_string().unwrap_or_default();
        return Err(format!(
            "删除附件失败 HTTP {status}：{}",
            text.chars().take(200).collect::<String>()
        ));
    }
    Ok(())
}

pub fn delete_github_release(
    release_id: u64,
    owner: Option<String>,
    repo: Option<String>,
) -> Result<(), String> {
    let token = require_github_token()?;
    let (owner, repo) = owner_repo(owner, repo)?;
    let agent = http_agent(45);
    let resp = agent
        .delete(&format!(
            "https://api.github.com/repos/{owner}/{repo}/releases/{release_id}"
        ))
        .set("Accept", "application/vnd.github+json")
        .set("Authorization", &format!("Bearer {token}"))
        .set("User-Agent", "qingzhi")
        .set("X-GitHub-Api-Version", "2022-11-28")
        .call()
        .map_err(|e| format!("删除 Release 失败：{e}"))?;
    let status = resp.status();
    if status != 204 && !(200..300).contains(&status) {
        let text = resp.into_string().unwrap_or_default();
        return Err(format!(
            "删除 Release 失败 HTTP {status}：{}",
            text.chars().take(200).collect::<String>()
        ));
    }
    Ok(())
}

pub fn publish_github_release(
    file_path: &str,
    tag: &str,
    title: Option<String>,
    notes: Option<String>,
    owner: Option<String>,
    repo: Option<String>,
) -> Result<PublishResult, String> {
    let token = require_github_token()?;
    let (owner, repo) = owner_repo(owner, repo)?;
    let tag = tag.trim();
    if tag.is_empty() {
        return Err("请填写版本 Tag（例如 v1.4.2）".to_string());
    }
    let tag_name = if tag.starts_with('v') || tag.starts_with('V') {
        tag.to_string()
    } else {
        format!("v{tag}")
    };

    let path = PathBuf::from(file_path);
    if !path.is_file() {
        return Err("安装包文件不存在".to_string());
    }
    let file_name = path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "无效的文件名".to_string())?
        .to_string();
    let file_len = path
        .metadata()
        .map_err(|e| format!("读取文件大小失败：{e}"))?
        .len();

    emit_progress(5, "检查 GitHub Release…");
    let release = ensure_release(
        &owner,
        &repo,
        &token,
        &tag_name,
        title.as_deref().unwrap_or(&tag_name),
        notes.as_deref().unwrap_or(""),
    )?;

    let release_id = release
        .id
        .ok_or_else(|| "Release 缺少 id".to_string())?;

    // Delete existing asset with same name if re-uploading.
    emit_progress(15, "准备上传…");
    delete_asset_if_exists(&owner, &repo, &token, release_id, &file_name)?;

    emit_progress(20, &format!("上传 {}（{}）…", file_name, format_bytes(file_len)));
    upload_asset(&owner, &repo, &token, release_id, &path, &file_name, file_len)?;

    emit_progress(100, "发布完成");
    Ok(PublishResult {
        tag_name: tag_name.clone(),
        html_url: release.html_url,
        asset_name: file_name,
    })
}

fn ensure_release(
    owner: &str,
    repo: &str,
    token: &str,
    tag: &str,
    name: &str,
    body: &str,
) -> Result<GhRelease, String> {
    let get_url = format!("https://api.github.com/repos/{owner}/{repo}/releases/tags/{tag}");
    match github_get_json(&get_url, Some(token)) {
        Ok(text) => {
            let rel: GhRelease =
                serde_json::from_str(&text).map_err(|e| format!("解析已有 Release 失败：{e}"))?;
            return Ok(rel);
        }
        Err(e) if e.contains("HTTP 404") => {}
        Err(e) => return Err(e),
    }

    let agent = http_agent(60);
    let payload = serde_json::json!({
        "tag_name": tag,
        "name": name,
        "body": body,
        "draft": false,
        "prerelease": false,
    });
    let resp = agent
        .post(&format!(
            "https://api.github.com/repos/{owner}/{repo}/releases"
        ))
        .set("Accept", "application/vnd.github+json")
        .set("Authorization", &format!("Bearer {token}"))
        .set("User-Agent", "qingzhi")
        .set("X-GitHub-Api-Version", "2022-11-28")
        .send_json(payload)
        .map_err(|e| format!("创建 Release 失败：{e}"))?;
    let status = resp.status();
    let text = resp.into_string().unwrap_or_default();
    if !(200..300).contains(&status) {
        return Err(format!(
            "创建 Release 失败 HTTP {status}：{}",
            text.chars().take(240).collect::<String>()
        ));
    }
    serde_json::from_str(&text).map_err(|e| format!("解析新建 Release 失败：{e}"))
}

fn list_release_assets(
    owner: &str,
    repo: &str,
    token: &str,
    release_id: u64,
) -> Result<Vec<(u64, String)>, String> {
    #[derive(Deserialize)]
    struct Asset {
        id: u64,
        name: String,
    }
    let url = format!("https://api.github.com/repos/{owner}/{repo}/releases/{release_id}/assets");
    let text = github_get_json(&url, Some(token))?;
    let assets: Vec<Asset> =
        serde_json::from_str(&text).map_err(|e| format!("解析资源列表失败：{e}"))?;
    Ok(assets.into_iter().map(|a| (a.id, a.name)).collect())
}

fn delete_asset_if_exists(
    owner: &str,
    repo: &str,
    token: &str,
    release_id: u64,
    file_name: &str,
) -> Result<(), String> {
    let assets = list_release_assets(owner, repo, token, release_id)?;
    for (id, name) in assets {
        if name == file_name {
            let agent = http_agent(45);
            let _ = agent
                .delete(&format!(
                    "https://api.github.com/repos/{owner}/{repo}/releases/assets/{id}"
                ))
                .set("Accept", "application/vnd.github+json")
                .set("Authorization", &format!("Bearer {token}"))
                .set("User-Agent", "qingzhi")
                .set("X-GitHub-Api-Version", "2022-11-28")
                .call();
        }
    }
    Ok(())
}

fn upload_asset(
    owner: &str,
    repo: &str,
    token: &str,
    release_id: u64,
    path: &Path,
    file_name: &str,
    file_len: u64,
) -> Result<(), String> {
    let encoded = urlencoding_simple(file_name);
    let url = format!(
        "https://uploads.github.com/repos/{owner}/{repo}/releases/{release_id}/assets?name={encoded}"
    );
    let file = File::open(path).map_err(|e| format!("打开安装包失败：{e}"))?;
    // ureq sends the reader; for large files this streams.
    let agent = http_agent(1800);
    let resp = agent
        .post(&url)
        .set("Accept", "application/vnd.github+json")
        .set("Authorization", &format!("Bearer {token}"))
        .set("User-Agent", "qingzhi")
        .set("Content-Type", "application/octet-stream")
        .set("Content-Length", &file_len.to_string())
        .set("X-GitHub-Api-Version", "2022-11-28")
        .send(file)
        .map_err(|e| format!("上传失败：{e}"))?;
    let status = resp.status();
    let text = resp.into_string().unwrap_or_default();
    if !(200..300).contains(&status) {
        return Err(format!(
            "上传失败 HTTP {status}：{}",
            text.chars().take(240).collect::<String>()
        ));
    }
    Ok(())
}

fn urlencoding_simple(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}
