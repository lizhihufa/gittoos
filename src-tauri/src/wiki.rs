//! GitHub / Gitee 仓库 Wiki：以 `{owner}/{repo}.wiki.git` 为数据源。
use crate::git::{
    emit_terminal, ensure_git, local_proxy, provider_access_token, run_git, run_git_timeout,
    set_app_handle, with_git_quiet, GitBinary, GitError, Provider,
};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

static APP: OnceLock<AppHandle> = OnceLock::new();

pub fn init_wiki_handle(app: AppHandle) {
    let _ = APP.set(app.clone());
    set_app_handle(app);
}

fn emit_progress(percent: u32, label: &str) {
    if let Some(app) = APP.get() {
        let _ = app.emit(
            "wiki-progress",
            WikiProgressEvent {
                percent: percent.min(100),
                label: label.to_string(),
            },
        );
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiProgressEvent {
    pub percent: u32,
    pub label: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WikiPlatform {
    Github,
    Gitee,
}

impl WikiPlatform {
    fn from_str(s: &str) -> Result<Self, String> {
        match s.trim().to_ascii_lowercase().as_str() {
            "github" => Ok(Self::Github),
            "gitee" => Ok(Self::Gitee),
            _ => Err(format!("未知平台：{s}（可选 github / gitee）")),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Github => "github",
            Self::Gitee => "gitee",
        }
    }

    fn provider(self) -> Provider {
        match self {
            Self::Github => Provider::Github,
            Self::Gitee => Provider::Gitee,
        }
    }

    fn host(self) -> &'static str {
        match self {
            Self::Github => "github.com",
            Self::Gitee => "gitee.com",
        }
    }

    fn web_wiki_url(self, owner: &str, repo: &str) -> String {
        match self {
            Self::Github => format!("https://github.com/{owner}/{repo}/wiki"),
            Self::Gitee => format!("https://gitee.com/{owner}/{repo}/wikis"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiStatus {
    pub platform: String,
    pub owner: String,
    pub repo: String,
    pub local_path: String,
    pub cloned: bool,
    pub dirty: bool,
    pub page_count: u32,
    pub web_url: String,
    pub has_token: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiPageInfo {
    pub name: String,
    pub slug: String,
    pub path: String,
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

fn cache_root() -> Result<PathBuf, String> {
    let local = std::env::var("LOCALAPPDATA").map_err(|_| "找不到 LOCALAPPDATA".to_string())?;
    let dir = PathBuf::from(local).join("qingzhi").join("wikis");
    fs::create_dir_all(&dir).map_err(|e| format!("创建 Wiki 缓存目录失败：{e}"))?;
    Ok(dir)
}

fn wiki_dir(platform: WikiPlatform, owner: &str, repo: &str) -> Result<PathBuf, String> {
    let owner = sanitize_segment(owner)?;
    let repo = sanitize_segment(repo)?;
    let dir = cache_root()?
        .join(platform.as_str())
        .join(&owner)
        .join(&repo);
    Ok(dir)
}

fn sanitize_segment(raw: &str) -> Result<String, String> {
    let s = raw.trim();
    if s.is_empty()
        || s.contains("..")
        || s.contains('/')
        || s.contains('\\')
        || s.contains(':')
    {
        return Err("无效的 owner/repo".to_string());
    }
    Ok(s.to_string())
}

fn require_owner_repo(owner: &str, repo: &str) -> Result<(String, String), String> {
    let owner = sanitize_segment(owner)?;
    let repo = sanitize_segment(repo)?;
    Ok((owner, repo))
}

fn optional_token(platform: WikiPlatform) -> Option<String> {
    provider_access_token(platform.provider()).ok().flatten()
}

fn require_token(platform: WikiPlatform) -> Result<String, String> {
    optional_token(platform).ok_or_else(|| {
        format!(
            "请先登录 {}（需要仓库 Wiki 写权限）",
            match platform {
                WikiPlatform::Github => "GitHub",
                WikiPlatform::Gitee => "Gitee",
            }
        )
    })
}

fn wiki_git_url(platform: WikiPlatform, owner: &str, repo: &str, token: Option<&str>) -> String {
    let host = platform.host();
    let path = format!("{owner}/{repo}.wiki.git");
    match (platform, token) {
        (WikiPlatform::Github, Some(t)) => {
            format!("https://x-access-token:{t}@{host}/{path}")
        }
        (WikiPlatform::Gitee, Some(t)) => {
            format!("https://oauth2:{t}@{host}/{path}")
        }
        (_, None) => format!("https://{host}/{path}"),
    }
}

fn public_wiki_git_url(platform: WikiPlatform, owner: &str, repo: &str) -> String {
    wiki_git_url(platform, owner, repo, None)
}

fn git() -> Result<GitBinary, String> {
    ensure_git().map_err(|e| e.to_string())
}

fn map_git(err: GitError) -> String {
    err.to_string()
}

fn is_cloned(dir: &Path) -> bool {
    dir.join(".git").exists()
}

fn page_slug_from_name(name: &str) -> String {
    let t = name.trim();
    if t.is_empty() {
        return "Home".to_string();
    }
    t.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            ' ' => '-',
            _ => c,
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

fn page_file(dir: &Path, slug: &str) -> PathBuf {
    let slug = page_slug_from_name(slug);
    dir.join(format!("{slug}.md"))
}

fn list_md_pages(dir: &Path) -> Result<Vec<WikiPageInfo>, String> {
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut pages = Vec::new();
    let entries = fs::read_dir(dir).map_err(|e| format!("读取 Wiki 目录失败：{e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or_default();
        if !name.to_ascii_lowercase().ends_with(".md") {
            continue;
        }
        let slug = name.trim_end_matches(".md").trim_end_matches(".MD");
        pages.push(WikiPageInfo {
            name: slug.replace('-', " "),
            slug: slug.to_string(),
            path: path.display().to_string(),
        });
    }
    pages.sort_by(|a, b| {
        let ah = a.slug.eq_ignore_ascii_case("Home");
        let bh = b.slug.eq_ignore_ascii_case("Home");
        match (ah, bh) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.slug.to_ascii_lowercase().cmp(&b.slug.to_ascii_lowercase()),
        }
    });
    Ok(pages)
}

fn dirty(git: &GitBinary, dir: &Path) -> bool {
    if !is_cloned(dir) {
        return false;
    }
    with_git_quiet(|| {
        run_git(git, dir, &["status", "--porcelain"])
            .map(|o| !o.stdout.trim().is_empty())
            .unwrap_or(false)
    })
}

pub fn wiki_status(
    platform: &str,
    owner: &str,
    repo: &str,
) -> Result<WikiStatus, String> {
    let platform = WikiPlatform::from_str(platform)?;
    let (owner, repo) = require_owner_repo(owner, repo)?;
    let dir = wiki_dir(platform, &owner, &repo)?;
    let git = git()?;
    let pages = if is_cloned(&dir) {
        list_md_pages(&dir)?
    } else {
        vec![]
    };
    Ok(WikiStatus {
        platform: platform.as_str().to_string(),
        owner: owner.clone(),
        repo: repo.clone(),
        local_path: dir.display().to_string(),
        cloned: is_cloned(&dir),
        dirty: dirty(&git, &dir),
        page_count: pages.len() as u32,
        web_url: platform.web_wiki_url(&owner, &repo),
        has_token: optional_token(platform).is_some(),
    })
}

pub fn wiki_list_pages(
    platform: &str,
    owner: &str,
    repo: &str,
) -> Result<Vec<WikiPageInfo>, String> {
    let platform = WikiPlatform::from_str(platform)?;
    let (owner, repo) = require_owner_repo(owner, repo)?;
    let dir = wiki_dir(platform, &owner, &repo)?;
    if !is_cloned(&dir) {
        return Err("尚未同步 Wiki，请先点「同步」或「开启并初始化」".to_string());
    }
    list_md_pages(&dir)
}

pub fn wiki_read_page(
    platform: &str,
    owner: &str,
    repo: &str,
    slug: &str,
) -> Result<String, String> {
    let platform = WikiPlatform::from_str(platform)?;
    let (owner, repo) = require_owner_repo(owner, repo)?;
    let dir = wiki_dir(platform, &owner, &repo)?;
    let file = page_file(&dir, slug);
    if !file.exists() {
        return Err(format!("页面不存在：{slug}"));
    }
    fs::read_to_string(&file).map_err(|e| format!("读取页面失败：{e}"))
}

pub fn wiki_write_page(
    platform: &str,
    owner: &str,
    repo: &str,
    slug: &str,
    content: &str,
) -> Result<(), String> {
    let platform = WikiPlatform::from_str(platform)?;
    let (owner, repo) = require_owner_repo(owner, repo)?;
    let dir = wiki_dir(platform, &owner, &repo)?;
    if !is_cloned(&dir) {
        return Err("尚未同步 Wiki，请先点「同步」或「开启并初始化」".to_string());
    }
    let file = page_file(&dir, slug);
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&file, content).map_err(|e| format!("写入页面失败：{e}"))
}

pub fn wiki_delete_page(
    platform: &str,
    owner: &str,
    repo: &str,
    slug: &str,
) -> Result<(), String> {
    let platform = WikiPlatform::from_str(platform)?;
    let (owner, repo) = require_owner_repo(owner, repo)?;
    let dir = wiki_dir(platform, &owner, &repo)?;
    let file = page_file(&dir, slug);
    if file.exists() {
        fs::remove_file(&file).map_err(|e| format!("删除页面失败：{e}"))?;
    }
    Ok(())
}

/// 开启仓库 Wiki 开关（GitHub has_wiki / Gitee has_wiki）。
pub fn wiki_enable(platform: &str, owner: &str, repo: &str) -> Result<(), String> {
    let platform = WikiPlatform::from_str(platform)?;
    let (owner, repo) = require_owner_repo(owner, repo)?;
    let token = require_token(platform)?;
    emit_progress(10, "正在开启 Wiki…");
    let agent = http_agent(45);
    match platform {
        WikiPlatform::Github => {
            let url = format!("https://api.github.com/repos/{owner}/{repo}");
            let resp = agent
                .patch(&url)
                .set("Accept", "application/vnd.github+json")
                .set("Authorization", &format!("Bearer {token}"))
                .set("User-Agent", "qingzhi")
                .set("X-GitHub-Api-Version", "2022-11-28")
                .send_json(ureq::json!({ "has_wiki": true }))
                .map_err(|e| format!("开启 GitHub Wiki 失败：{e}"))?;
            let status = resp.status();
            if !(200..300).contains(&status) {
                let text = resp.into_string().unwrap_or_default();
                return Err(format!(
                    "开启 GitHub Wiki 失败 HTTP {status}：{}",
                    text.chars().take(200).collect::<String>()
                ));
            }
        }
        WikiPlatform::Gitee => {
            let url = format!("https://gitee.com/api/v5/repos/{owner}/{repo}");
            let resp = agent
                .patch(&url)
                .set("User-Agent", "qingzhi")
                .set("Content-Type", "application/json")
                .send_json(ureq::json!({
                    "access_token": token,
                    "has_wiki": true
                }))
                .map_err(|e| format!("开启 Gitee Wiki 失败：{e}"))?;
            let status = resp.status();
            if !(200..300).contains(&status) {
                let text = resp.into_string().unwrap_or_default();
                return Err(format!(
                    "开启 Gitee Wiki 失败 HTTP {status}：{}",
                    text.chars().take(200).collect::<String>()
                ));
            }
        }
    }
    emit_progress(100, "Wiki 已开启");
    Ok(())
}

fn map_wiki_remote_err(err: impl ToString) -> String {
    let msg = err.to_string();
    if msg.contains("not found")
        || msg.contains("Repository not found")
        || msg.contains("does not exist")
        || msg.contains("404")
    {
        format!(
            "Wiki 远程还不存在或无权访问。请先在网页创建至少一页 Wiki，再点「同步」。\n{msg}"
        )
    } else if msg.contains("no tracking information")
        || msg.contains("There is no tracking information")
    {
        format!(
            "本地 Wiki 未关联远程分支。已尝试自动修复；若仍失败请再点一次「同步」。\n{msg}"
        )
    } else {
        msg
    }
}

fn remote_default_branch(git: &GitBinary, dir: &Path) -> String {
    // Prefer origin/HEAD → origin/master → origin/main
    if let Ok(out) = with_git_quiet(|| {
        run_git(
            git,
            dir,
            &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        )
    }) {
        let name = out.stdout.trim();
        if let Some(branch) = name.strip_prefix("origin/") {
            if !branch.is_empty() {
                return branch.to_string();
            }
        }
    }
    for candidate in ["master", "main"] {
        let ok = with_git_quiet(|| {
            run_git(
                git,
                dir,
                &["rev-parse", "--verify", &format!("refs/remotes/origin/{candidate}")],
            )
        })
        .is_ok();
        if ok {
            return candidate.to_string();
        }
    }
    "master".to_string()
}

fn fresh_clone(git: &GitBinary, dir: &Path, url: &str) -> Result<(), String> {
    emit_progress(20, "正在克隆 Wiki…");
    if dir.exists() {
        fs::remove_dir_all(dir).map_err(|e| format!("清理旧缓存失败：{e}"))?;
    }
    if let Some(parent) = dir.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let folder = dir
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "无效的 Wiki 目录名".to_string())?;
    let parent = dir.parent().ok_or_else(|| "无效的 Wiki 路径".to_string())?;
    run_git_timeout(
        git,
        parent,
        &["clone", "--progress", url, folder],
        300,
    )
    .map_err(map_wiki_remote_err)?;
    emit_progress(90, "克隆完成");
    Ok(())
}

fn pull_existing(git: &GitBinary, dir: &Path, url: &str) -> Result<(), String> {
    emit_progress(30, "正在拉取 Wiki…");
    // Ensure origin points at current token URL
    let has_origin = with_git_quiet(|| run_git(git, dir, &["remote", "get-url", "origin"])).is_ok();
    if has_origin {
        let _ = run_git(git, dir, &["remote", "set-url", "origin", url]);
    } else {
        run_git(git, dir, &["remote", "add", "origin", url]).map_err(map_git)?;
    }

    run_git_timeout(git, dir, &["fetch", "origin", "--progress"], 180)
        .map_err(map_wiki_remote_err)?;

    let branch = remote_default_branch(git, dir);
    // Explicit remote branch — works even without upstream tracking
    let pull = run_git_timeout(
        git,
        dir,
        &[
            "pull",
            "--ff-only",
            "--progress",
            "origin",
            &branch,
        ],
        180,
    );
    match pull {
        Ok(_) => {
            let _ = run_git(
                git,
                dir,
                &["branch", &format!("--set-upstream-to=origin/{branch}")],
            );
            emit_progress(90, "拉取完成");
            Ok(())
        }
        Err(e) => {
            let msg = e.to_string();
            // Local-only init (no common history with web-created wiki) → reclone
            if msg.contains("unrelated histories")
                || msg.contains("diverging")
                || msg.contains("Not possible to fast-forward")
                || msg.contains("refusing to merge")
            {
                emit_terminal(
                    "info",
                    "本地 Wiki 与远程历史不一致，改为重新克隆远程 Wiki…",
                );
                fresh_clone(git, dir, url)
            } else {
                Err(map_wiki_remote_err(e))
            }
        }
    }
}

fn clone_or_pull(
    git: &GitBinary,
    dir: &Path,
    url: &str,
) -> Result<(), String> {
    if is_cloned(dir) {
        match pull_existing(git, dir, url) {
            Ok(()) => Ok(()),
            Err(e) => {
                // Orphan local cache from a failed init: drop and clone cleanly
                let lower = e.to_lowercase();
                if lower.contains("no tracking")
                    || lower.contains("没有跟踪")
                    || lower.contains("not a git repository")
                {
                    emit_terminal("info", "本地 Wiki 缓存异常，改为重新克隆…");
                    fresh_clone(git, dir, url)
                } else {
                    Err(e)
                }
            }
        }
    } else {
        fresh_clone(git, dir, url)
    }
}

pub fn wiki_sync(platform: &str, owner: &str, repo: &str) -> Result<WikiStatus, String> {
    let platform = WikiPlatform::from_str(platform)?;
    let (owner, repo) = require_owner_repo(owner, repo)?;
    let dir = wiki_dir(platform, &owner, &repo)?;
    let git = git()?;
    let token = optional_token(platform);
    let url = wiki_git_url(platform, &owner, &repo, token.as_deref());
    emit_progress(5, "准备同步 Wiki…");
    emit_terminal("info", &format!("Wiki sync → {}", public_wiki_git_url(platform, &owner, &repo)));
    clone_or_pull(&git, &dir, &url)?;
    emit_progress(100, "同步完成");
    wiki_status(platform.as_str(), &owner, &repo)
}

fn commit_all(git: &GitBinary, dir: &Path, message: &str) -> Result<(), String> {
    run_git(git, dir, &["add", "-A"]).map_err(map_git)?;
    let status = with_git_quiet(|| run_git(git, dir, &["status", "--porcelain"])).map_err(map_git)?;
    if status.stdout.trim().is_empty() {
        return Ok(());
    }
    // 避免缺少 identity 导致 commit 失败：临时使用本地 identity
    let _ = run_git(
        git,
        dir,
        &[
            "-c",
            "user.name=qingzhi",
            "-c",
            "user.email=qingzhi@local",
            "commit",
            "-m",
            message,
        ],
    )
    .map_err(map_git)?;
    Ok(())
}

fn push_wiki(git: &GitBinary, dir: &Path, url: &str) -> Result<(), String> {
    let _ = run_git(git, dir, &["remote", "set-url", "origin", url]);
    run_git_timeout(git, dir, &["push", "-u", "origin", "HEAD", "--progress"], 180)
        .map_err(map_git)?;
    Ok(())
}

pub fn wiki_commit_push(
    platform: &str,
    owner: &str,
    repo: &str,
    message: Option<String>,
) -> Result<WikiStatus, String> {
    let platform = WikiPlatform::from_str(platform)?;
    let (owner, repo) = require_owner_repo(owner, repo)?;
    let dir = wiki_dir(platform, &owner, &repo)?;
    if !is_cloned(&dir) {
        return Err("尚未同步 Wiki".to_string());
    }
    let token = require_token(platform)?;
    let git = git()?;
    let msg = message
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Update wiki via qingzhi");
    emit_progress(20, "正在提交…");
    commit_all(&git, &dir, msg)?;
    emit_progress(55, "正在推送…");
    let url = wiki_git_url(platform, &owner, &repo, Some(&token));
    push_wiki(&git, &dir, &url)?;
    emit_progress(100, "推送完成");
    wiki_status(platform.as_str(), &owner, &repo)
}

/// 开启 Wiki，并确保存在 Home.md（必要时创建并推送）。
pub fn wiki_init(
    platform: &str,
    owner: &str,
    repo: &str,
) -> Result<WikiStatus, String> {
    let platform = WikiPlatform::from_str(platform)?;
    let (owner, repo) = require_owner_repo(owner, repo)?;
    let token = require_token(platform)?;
    let git = git()?;
    let dir = wiki_dir(platform, &owner, &repo)?;

    // 1) 打开开关
    let _ = wiki_enable(platform.as_str(), &owner, &repo);

    emit_progress(25, "准备 Wiki 仓库…");
    let url = wiki_git_url(platform, &owner, &repo, Some(&token));

    // 2) 尝试 clone；失败则本地初始化再 push（首页）
    if !is_cloned(&dir) {
        match clone_or_pull(&git, &dir, &url) {
            Ok(()) => {}
            Err(clone_err) => {
                emit_terminal("info", &format!("Wiki clone 未成功，改为本地初始化：{clone_err}"));
                if dir.exists() {
                    let _ = fs::remove_dir_all(&dir);
                }
                fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                run_git(&git, &dir, &["init"]).map_err(map_git)?;
                let _ = run_git(&git, &dir, &["branch", "-M", "master"]);
                run_git(&git, &dir, &["remote", "add", "origin", &url]).map_err(map_git)?;
            }
        }
    }

    // 3) 确保 Home.md
    let home = page_file(&dir, "Home");
    if !home.exists() {
        let body = format!(
            "# {repo}\n\n欢迎使用本仓库 Wiki。\n\n由青枝（qingzhi）创建。\n"
        );
        fs::write(&home, body).map_err(|e| format!("创建 Home.md 失败：{e}"))?;
    }

    emit_progress(70, "提交并推送首页…");
    commit_all(&git, &dir, "Initialize wiki Home page")?;
    push_wiki(&git, &dir, &url).map_err(|e| {
        format!(
            "初始化推送失败：{e}\n也可在网页打开 Wiki 手动创建首页后再点「同步」。"
        )
    })?;
    emit_progress(100, "Wiki 已就绪");
    wiki_status(platform.as_str(), &owner, &repo)
}

pub fn wiki_web_url(platform: &str, owner: &str, repo: &str) -> Result<String, String> {
    let platform = WikiPlatform::from_str(platform)?;
    let (owner, repo) = require_owner_repo(owner, repo)?;
    Ok(platform.web_wiki_url(&owner, &repo))
}
