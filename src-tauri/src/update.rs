//! Check / download / publish GitHub & Gitee Releases for 青枝.
use crate::git::{
    github_access_token, local_proxy, provider_access_token, set_app_handle, Provider,
};
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

/// Streams bytes while emitting upload/download progress.
struct ProgressReader<R> {
    inner: R,
    total: u64,
    done: u64,
    last_pct: u32,
    last_emit_at: u64,
    /// Map reader 0..=100 into this range (e.g. upload 20..=95).
    pct_from: u32,
    pct_to: u32,
    label_prefix: String,
}

impl<R: Read> ProgressReader<R> {
    fn new(inner: R, total: u64, pct_from: u32, pct_to: u32, label_prefix: impl Into<String>) -> Self {
        Self {
            inner,
            total,
            done: 0,
            last_pct: pct_from.saturating_sub(1),
            last_emit_at: 0,
            pct_from,
            pct_to: pct_to.max(pct_from),
            label_prefix: label_prefix.into(),
        }
    }

    fn emit_if_needed(&mut self, force: bool) {
        let span = (self.pct_to - self.pct_from) as u64;
        let pct = if self.total > 0 {
            self.pct_from + ((self.done.min(self.total) * span) / self.total) as u32
        } else {
            // Unknown size: nudge within range every ~512KB.
            let step = (self.done / (512 * 1024)) as u32;
            (self.pct_from + (step % (span.max(1) as u32 + 1))).min(self.pct_to.saturating_sub(1))
        };
        let should = force
            || pct >= self.last_pct + 1
            || self.done.saturating_sub(self.last_emit_at) >= 256 * 1024;
        if !should {
            return;
        }
        self.last_pct = pct;
        self.last_emit_at = self.done;
        let label = if self.total > 0 {
            format!(
                "{} {} / {}",
                self.label_prefix,
                format_bytes(self.done),
                format_bytes(self.total)
            )
        } else {
            format!("{} {}", self.label_prefix, format_bytes(self.done))
        };
        emit_progress(pct.min(self.pct_to), &label);
    }
}

impl<R: Read> Read for ProgressReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        if n == 0 {
            self.emit_if_needed(true);
            return Ok(0);
        }
        self.done += n as u64;
        self.emit_if_needed(false);
        Ok(n)
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
    // ureq returns Err(Status) for non-2xx; normalize so callers can match "HTTP 404".
    let resp = match req.call() {
        Ok(r) => r,
        Err(ureq::Error::Status(code, resp)) => {
            let body = resp.into_string().unwrap_or_default();
            return Err(format!(
                "GitHub HTTP {code}：{}",
                body.chars().take(200).collect::<String>()
            ));
        }
        Err(e) => return Err(format!("请求 GitHub 失败：{e}")),
    };
    let status = resp.status();
    let body = resp.into_string().map_err(|e| format!("读取响应失败：{e}"))?;
    if !(200..300).contains(&status) {
        return Err(format!(
            "GitHub HTTP {status}：{}",
            body.chars().take(200).collect::<String>()
        ));
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

    let mut reader = ProgressReader::new(resp.into_reader(), total, 2, 99, "下载中");
    let mut file = File::create(&dest).map_err(|e| format!("无法写入下载文件：{e}"))?;
    let mut buf = [0u8; 64 * 1024];

    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("下载中断：{e}"))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n])
            .map_err(|e| format!("写入失败：{e}"))?;
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
        // Tag 尚无 Release 时 GitHub 返回 404，随后自动创建。
        Err(e) if e.contains("HTTP 404") || e.contains("status code 404") => {}
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
    let reader = ProgressReader::new(file, file_len, 20, 95, "上传中");
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
        .send(reader)
        .map_err(|e| format!("上传失败：{e}"))?;
    let status = resp.status();
    let text = resp.into_string().unwrap_or_default();
    if !(200..300).contains(&status) {
        return Err(format!(
            "上传失败 HTTP {status}：{}",
            text.chars().take(240).collect::<String>()
        ));
    }
    emit_progress(98, "上传完成，确认中…");
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

// ─── Gitee Releases ───────────────────────────────────────────────

fn optional_gitee_token() -> Option<String> {
    provider_access_token(Provider::Gitee).ok().flatten()
}

fn require_gitee_token() -> Result<String, String> {
    optional_gitee_token()
        .ok_or_else(|| "请先在「账号登录」里登录 Gitee（需要有仓库写入权限的 Token）".to_string())
}

fn gitee_owner_repo(owner: Option<String>, repo: Option<String>) -> Result<(String, String), String> {
    let owner = owner.unwrap_or_default().trim().to_string();
    let repo = repo.unwrap_or_default().trim().to_string();
    if owner.is_empty() || repo.is_empty() {
        return Err("请填写 Gitee 仓库 owner/repo".to_string());
    }
    Ok((owner, repo))
}

fn gitee_get_json(url: &str, token: Option<&str>) -> Result<String, String> {
    let agent = http_agent(45);
    let sep = if url.contains('?') { '&' } else { '?' };
    let full = match token.filter(|t| !t.is_empty()) {
        Some(t) => format!("{url}{sep}access_token={t}"),
        None => url.to_string(),
    };
    let resp = match agent.get(&full).set("User-Agent", "qingzhi").call() {
        Ok(r) => r,
        Err(ureq::Error::Status(code, resp)) => {
            let body = resp.into_string().unwrap_or_default();
            return Err(format!(
                "Gitee HTTP {code}：{}",
                body.chars().take(200).collect::<String>()
            ));
        }
        Err(e) => return Err(format!("请求 Gitee 失败：{e}")),
    };
    let status = resp.status();
    let body = resp.into_string().map_err(|e| format!("读取响应失败：{e}"))?;
    if !(200..300).contains(&status) {
        return Err(format!(
            "Gitee HTTP {status}：{}",
            body.chars().take(200).collect::<String>()
        ));
    }
    Ok(body)
}

#[derive(Deserialize)]
struct GiteeRelease {
    id: Option<u64>,
    tag_name: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    html_url: Option<String>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    assets: Vec<GiteeAsset>,
}

#[derive(Deserialize)]
struct GiteeAsset {
    #[serde(default)]
    id: u64,
    #[serde(default)]
    name: String,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    browser_download_url: String,
}

fn gitee_release_to_item(rel: GiteeRelease, owner: &str, repo: &str) -> Option<ReleaseItem> {
    let id = rel.id?;
    let html_url = rel.html_url.unwrap_or_else(|| {
        format!("https://gitee.com/{owner}/{repo}/releases/{id}")
    });
    Some(ReleaseItem {
        id,
        tag_name: rel.tag_name,
        name: rel.name.unwrap_or_default(),
        body: rel.body.unwrap_or_default(),
        html_url,
        published_at: rel.created_at.unwrap_or_default(),
        assets: rel
            .assets
            .into_iter()
            .filter(|a| a.id > 0 && !a.name.is_empty())
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

fn gitee_list_attach_files(
    owner: &str,
    repo: &str,
    token: &str,
    release_id: u64,
) -> Result<Vec<ReleaseAssetInfo>, String> {
    let url = format!(
        "https://gitee.com/api/v5/repos/{owner}/{repo}/releases/{release_id}/attach_files"
    );
    let text = gitee_get_json(&url, Some(token))?;
    let assets: Vec<GiteeAsset> =
        serde_json::from_str(&text).map_err(|e| format!("解析 Gitee 附件失败：{e}"))?;
    Ok(assets
        .into_iter()
        .filter(|a| a.id > 0 && !a.name.is_empty())
        .map(|a| ReleaseAssetInfo {
            id: a.id,
            name: a.name,
            size: a.size,
            size_label: format_bytes(a.size),
            download_url: a.browser_download_url,
        })
        .collect())
}

pub fn list_gitee_releases(
    owner: Option<String>,
    repo: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<ReleaseItem>, String> {
    let (owner, repo) = gitee_owner_repo(owner, repo)?;
    let per_page = limit.unwrap_or(20).clamp(1, 50);
    let token = optional_gitee_token();
    let url = format!(
        "https://gitee.com/api/v5/repos/{owner}/{repo}/releases?page=1&per_page={per_page}"
    );
    let body = gitee_get_json(&url, token.as_deref())?;
    let releases: Vec<GiteeRelease> =
        serde_json::from_str(&body).map_err(|e| format!("解析 Gitee Release 列表失败：{e}"))?;
    let mut items: Vec<ReleaseItem> = releases
        .into_iter()
        .filter_map(|r| gitee_release_to_item(r, &owner, &repo))
        .collect();
    // Enrich assets via attach_files when list payload is empty / incomplete.
    if let Some(tok) = token.as_deref() {
        for item in &mut items {
            if item.assets.is_empty() {
                if let Ok(assets) = gitee_list_attach_files(&owner, &repo, tok, item.id) {
                    item.assets = assets;
                }
            }
        }
    }
    Ok(items)
}

pub fn delete_gitee_release_asset(
    release_id: u64,
    asset_id: u64,
    owner: Option<String>,
    repo: Option<String>,
) -> Result<(), String> {
    let token = require_gitee_token()?;
    let (owner, repo) = gitee_owner_repo(owner, repo)?;
    let agent = http_agent(45);
    let url = format!(
        "https://gitee.com/api/v5/repos/{owner}/{repo}/releases/{release_id}/attach_files/{asset_id}?access_token={token}"
    );
    let resp = agent
        .delete(&url)
        .set("User-Agent", "qingzhi")
        .call()
        .map_err(|e| format!("删除 Gitee 附件失败：{e}"))?;
    let status = resp.status();
    if status != 204 && !(200..300).contains(&status) {
        let text = resp.into_string().unwrap_or_default();
        return Err(format!(
            "删除 Gitee 附件失败 HTTP {status}：{}",
            text.chars().take(200).collect::<String>()
        ));
    }
    Ok(())
}

pub fn delete_gitee_release(
    release_id: u64,
    owner: Option<String>,
    repo: Option<String>,
) -> Result<(), String> {
    let token = require_gitee_token()?;
    let (owner, repo) = gitee_owner_repo(owner, repo)?;
    let agent = http_agent(45);
    let url = format!(
        "https://gitee.com/api/v5/repos/{owner}/{repo}/releases/{release_id}?access_token={token}"
    );
    let resp = agent
        .delete(&url)
        .set("User-Agent", "qingzhi")
        .call()
        .map_err(|e| format!("删除 Gitee Release 失败：{e}"))?;
    let status = resp.status();
    if status != 204 && !(200..300).contains(&status) {
        let text = resp.into_string().unwrap_or_default();
        return Err(format!(
            "删除 Gitee Release 失败 HTTP {status}：{}",
            text.chars().take(200).collect::<String>()
        ));
    }
    Ok(())
}

fn gitee_ensure_release(
    owner: &str,
    repo: &str,
    token: &str,
    tag: &str,
    name: &str,
    body: &str,
) -> Result<GiteeRelease, String> {
    let get_url = format!(
        "https://gitee.com/api/v5/repos/{owner}/{repo}/releases/tags/{tag}"
    );
    match gitee_get_json(&get_url, Some(token)) {
        Ok(text) => {
            return serde_json::from_str(&text)
                .map_err(|e| format!("解析已有 Gitee Release 失败：{e}"));
        }
        Err(e) if e.contains("HTTP 404") => {}
        Err(e) => return Err(e),
    }

    let agent = http_agent(60);
    let payload = serde_json::json!({
        "access_token": token,
        "tag_name": tag,
        "name": name,
        "body": body,
        "target_commitish": "master",
    });
    let resp = agent
        .post(&format!(
            "https://gitee.com/api/v5/repos/{owner}/{repo}/releases"
        ))
        .set("User-Agent", "qingzhi")
        .set("Content-Type", "application/json")
        .send_json(payload)
        .map_err(|e| format!("创建 Gitee Release 失败：{e}"))?;
    let status = resp.status();
    let text = resp.into_string().unwrap_or_default();
    if !(200..300).contains(&status) {
        // Retry with main if master rejected
        if text.contains("target_commitish") || text.contains("master") {
            let payload2 = serde_json::json!({
                "access_token": token,
                "tag_name": tag,
                "name": name,
                "body": body,
                "target_commitish": "main",
            });
            let resp2 = agent
                .post(&format!(
                    "https://gitee.com/api/v5/repos/{owner}/{repo}/releases"
                ))
                .set("User-Agent", "qingzhi")
                .set("Content-Type", "application/json")
                .send_json(payload2)
                .map_err(|e| format!("创建 Gitee Release 失败：{e}"))?;
            let status2 = resp2.status();
            let text2 = resp2.into_string().unwrap_or_default();
            if !(200..300).contains(&status2) {
                return Err(format!(
                    "创建 Gitee Release 失败 HTTP {status2}：{}",
                    text2.chars().take(240).collect::<String>()
                ));
            }
            return serde_json::from_str(&text2)
                .map_err(|e| format!("解析新建 Gitee Release 失败：{e}"));
        }
        return Err(format!(
            "创建 Gitee Release 失败 HTTP {status}：{}",
            text.chars().take(240).collect::<String>()
        ));
    }
    serde_json::from_str(&text).map_err(|e| format!("解析新建 Gitee Release 失败：{e}"))
}

fn gitee_delete_asset_if_exists(
    owner: &str,
    repo: &str,
    token: &str,
    release_id: u64,
    file_name: &str,
) -> Result<(), String> {
    let assets = gitee_list_attach_files(owner, repo, token, release_id)?;
    for a in assets {
        if a.name == file_name {
            let _ = delete_gitee_release_asset(
                release_id,
                a.id,
                Some(owner.to_string()),
                Some(repo.to_string()),
            );
        }
    }
    Ok(())
}

fn gitee_upload_attach(
    owner: &str,
    repo: &str,
    token: &str,
    release_id: u64,
    path: &Path,
    file_name: &str,
) -> Result<(), String> {
    let file_len = path
        .metadata()
        .map(|m| m.len())
        .unwrap_or(0);
    let file = File::open(path).map_err(|e| format!("读取上传文件失败：{e}"))?;
    let mut reader = ProgressReader::new(file, file_len, 20, 55, "读取安装包");
    let mut file_bytes = Vec::with_capacity(file_len as usize);
    reader
        .read_to_end(&mut file_bytes)
        .map_err(|e| format!("读取上传文件失败：{e}"))?;

    let boundary = format!(
        "----QingzhiBoundary{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    let mut body: Vec<u8> = Vec::new();
    // access_token
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(
        b"Content-Disposition: form-data; name=\"access_token\"\r\n\r\n",
    );
    body.extend_from_slice(token.as_bytes());
    body.extend_from_slice(b"\r\n");
    // file
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(
        format!(
            "Content-Disposition: form-data; name=\"file\"; filename=\"{file_name}\"\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(b"Content-Type: application/octet-stream\r\n\r\n");
    body.extend_from_slice(&file_bytes);
    body.extend_from_slice(b"\r\n");
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());

    emit_progress(60, &format!("上传到 Gitee（{}）…", format_bytes(file_len)));
    let url = format!(
        "https://gitee.com/api/v5/repos/{owner}/{repo}/releases/{release_id}/attach_files"
    );
    let agent = http_agent(1800);
    let resp = agent
        .post(&url)
        .set("User-Agent", "qingzhi")
        .set(
            "Content-Type",
            &format!("multipart/form-data; boundary={boundary}"),
        )
        .send_bytes(&body)
        .map_err(|e| format!("上传到 Gitee 失败：{e}"))?;
    let status = resp.status();
    let text = resp.into_string().unwrap_or_default();
    if !(200..300).contains(&status) {
        return Err(format!(
            "上传到 Gitee 失败 HTTP {status}：{}",
            text.chars().take(240).collect::<String>()
        ));
    }
    emit_progress(98, "上传完成，确认中…");
    Ok(())
}

pub fn publish_gitee_release(
    file_path: &str,
    tag: &str,
    title: Option<String>,
    notes: Option<String>,
    owner: Option<String>,
    repo: Option<String>,
) -> Result<PublishResult, String> {
    let token = require_gitee_token()?;
    let (owner, repo) = gitee_owner_repo(owner, repo)?;
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

    emit_progress(5, "检查 Gitee Release…");
    let release = gitee_ensure_release(
        &owner,
        &repo,
        &token,
        &tag_name,
        title.as_deref().unwrap_or(&tag_name),
        notes.as_deref().unwrap_or(""),
    )?;
    let release_id = release
        .id
        .ok_or_else(|| "Gitee Release 缺少 id".to_string())?;

    emit_progress(15, "准备上传…");
    gitee_delete_asset_if_exists(&owner, &repo, &token, release_id, &file_name)?;

    emit_progress(
        20,
        &format!("上传到 Gitee {}（{}）…", file_name, format_bytes(file_len)),
    );
    gitee_upload_attach(&owner, &repo, &token, release_id, &path, &file_name)?;

    let html_url = release.html_url.unwrap_or_else(|| {
        format!("https://gitee.com/{owner}/{repo}/releases")
    });
    emit_progress(100, "发布完成");
    Ok(PublishResult {
        tag_name,
        html_url,
        asset_name: file_name,
    })
}
