use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitInfo {
    pub path: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub status: String,
    pub staged: bool,
    pub unstaged: bool,
    pub untracked: bool,
    pub conflicted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    pub path: String,
    pub branch: String,
    pub is_detached: bool,
    pub ahead: u32,
    pub behind: u32,
    /// Ongoing Git operation: `"merge"`, `"cherry-pick"`, or empty.
    #[serde(default)]
    pub operation: String,
    pub changes: Vec<FileChange>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitTerminalEvent {
    pub kind: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    pub name: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub name: String,
    pub email: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub hash: String,
    pub short_hash: String,
    pub author: String,
    pub date: String,
    pub subject: String,
    /// Space-separated parent hashes (empty for root).
    #[serde(default)]
    pub parents: String,
    /// Decoration from `%d`, e.g. ` (HEAD -> main, tag: v1.0)`.
    #[serde(default)]
    pub refs: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StashInfo {
    pub index: u32,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagInfo {
    pub name: String,
    pub tip: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub is_current: bool,
    pub upstream: Option<String>,
    pub tip: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteBranchInfo {
    /// e.g. `origin/main`
    pub name: String,
    pub remote: String,
    pub branch: String,
    pub tip: String,
    /// Local branch with the same short name already exists.
    pub has_local: bool,
}

/// Fast path used right after opening a repo (keeps the UI responsive).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoCore {
    pub status: RepoStatus,
    pub branches: Vec<BranchInfo>,
    pub remote_branches: Vec<RemoteBranchInfo>,
    pub identity: Identity,
    pub remotes: Vec<RemoteInfo>,
}

/// Heavier lists loaded after the main pane is already usable.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoExtras {
    pub commits: Vec<CommitInfo>,
    pub stashes: Vec<StashInfo>,
    pub tags: Vec<TagInfo>,
}

/// Full snapshot (core + extras) for callers that still want one shot.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoSnapshot {
    pub status: RepoStatus,
    pub branches: Vec<BranchInfo>,
    pub remote_branches: Vec<RemoteBranchInfo>,
    pub commits: Vec<CommitInfo>,
    pub stashes: Vec<StashInfo>,
    pub tags: Vec<TagInfo>,
    pub identity: Identity,
    pub remotes: Vec<RemoteInfo>,
}

#[derive(Debug, Error)]
pub enum GitError {
    #[error("未找到 git 可执行文件，请先安装 Git for Windows")]
    GitNotFound,
    #[error("{0}")]
    InvalidInput(String),
    #[error("路径无效: {0}")]
    InvalidPath(String),
    #[error("不是 Git 仓库: {0}")]
    NotARepository(String),
    #[error("git 执行失败 (exit {code}): {}", format_command_output(.stdout, .stderr))]
    CommandFailed {
        code: i32,
        stderr: String,
        stdout: String,
    },
    #[error("IO 错误 ({path}): {message}")]
    Io { path: String, message: String },
}

fn format_command_output(stdout: &str, stderr: &str) -> String {
    match (stdout.trim().is_empty(), stderr.trim().is_empty()) {
        (true, true) => String::new(),
        (false, true) => stdout.trim().to_string(),
        (true, false) => stderr.trim().to_string(),
        (false, false) => format!("{}\n{}", stderr.trim(), stdout.trim()),
    }
}

impl Serialize for GitError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}
