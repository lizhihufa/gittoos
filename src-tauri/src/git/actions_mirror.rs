//! 双向 Actions 镜像：
//! - GitHub → Gitee：push 到 GitHub 后由 workflow 推到 Gitee
//! - Gitee → GitHub：推到 Gitee 后触发 GitHub workflow_dispatch，从 Gitee 拉回并推到 GitHub
//! Secrets / 远程 / workflow 尽量一键写好，减少去网页配置。

use super::auth::{
    create_or_get_hosting_repo, github_access_token, provider_access_token, provider_login_name,
    Provider,
};
use super::runner::GitBinary;
use super::types::GitError;
use super::{
    commit, infer_repo_name, list_remotes, set_remote_url, stage_paths,
};
use crypto_box::PublicKey;
use serde::{Deserialize, Serialize};
use std::path::Path;

const WORKFLOW_FORWARD_REL: &str = ".github/workflows/qingzhi-mirror-gitee.yml";
const WORKFLOW_REVERSE_REL: &str = ".github/workflows/qingzhi-mirror-from-gitee.yml";

const WORKFLOW_FORWARD_YAML: &str = r#"# 由青枝写入：推送到 GitHub 后，用 Actions 镜像到 Gitee。
# Secrets：GITEE_TOKEN、GITEE_USER，可选 GITEE_REPO（owner/repo）。
name: Qingzhi mirror to Gitee

on:
  push:
  workflow_dispatch:

jobs:
  mirror:
    runs-on: ubuntu-latest
    env:
      GITEE_TOKEN: ${{ secrets.GITEE_TOKEN }}
      GITEE_USER: ${{ secrets.GITEE_USER }}
      GITEE_REPO: ${{ secrets.GITEE_REPO }}
    steps:
      - name: Guard
        id: guard
        run: |
          if [ -z "$GITEE_TOKEN" ] || [ -z "$GITEE_USER" ]; then
            echo "未配置 GITEE_TOKEN / GITEE_USER，跳过镜像。"
            echo "ok=0" >> "$GITHUB_OUTPUT"
          else
            echo "ok=1" >> "$GITHUB_OUTPUT"
          fi

      - name: Checkout
        if: steps.guard.outputs.ok == '1'
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Push to Gitee
        if: steps.guard.outputs.ok == '1'
        run: |
          set -euo pipefail
          REPO="${GITEE_REPO:-$GITHUB_REPOSITORY}"
          REMOTE="https://${GITEE_USER}:${GITEE_TOKEN}@gitee.com/${REPO}.git"
          if [ "${GITHUB_REF_TYPE}" = "tag" ]; then
            git push --force "$REMOTE" "refs/tags/${GITHUB_REF_NAME}"
          else
            git push --force "$REMOTE" "HEAD:refs/heads/${GITHUB_REF_NAME}"
          fi
          git push --force --tags "$REMOTE" || true
          echo "已镜像到 Gitee：${REPO}"
"#;

const WORKFLOW_REVERSE_YAML: &str = r#"# 由青枝写入：从 Gitee 拉代码并强制推到本 GitHub 仓库（反向镜像）。
# 由青枝在「同步推送 GitHub」时触发 workflow_dispatch；也可手动 Run workflow。
# Secrets：GITEE_TOKEN、GITEE_USER，可选 GITEE_REPO（owner/repo）。
name: Qingzhi mirror from Gitee

on:
  workflow_dispatch:
  schedule:
    - cron: "15 */6 * * *"
  repository_dispatch:
    types: [qingzhi-gitee-push]

permissions:
  contents: write

jobs:
  mirror:
    runs-on: ubuntu-latest
    env:
      GITEE_TOKEN: ${{ secrets.GITEE_TOKEN }}
      GITEE_USER: ${{ secrets.GITEE_USER }}
      GITEE_REPO: ${{ secrets.GITEE_REPO }}
    steps:
      - name: Guard
        id: guard
        run: |
          if [ -z "$GITEE_TOKEN" ] || [ -z "$GITEE_USER" ]; then
            echo "未配置 GITEE_TOKEN / GITEE_USER，跳过。"
            echo "ok=0" >> "$GITHUB_OUTPUT"
          else
            echo "ok=1" >> "$GITHUB_OUTPUT"
          fi

      - name: Mirror Gitee → GitHub
        if: steps.guard.outputs.ok == '1'
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          set -euo pipefail
          REPO="${GITEE_REPO:-$GITHUB_REPOSITORY}"
          SRC="https://${GITEE_USER}:${GITEE_TOKEN}@gitee.com/${REPO}.git"
          DST="https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"
          WORK="${RUNNER_TEMP}/qingzhi-mirror"
          rm -rf "$WORK"
          git clone --mirror "$SRC" "$WORK"
          cd "$WORK"
          git remote set-url --push origin "$DST"
          git push --mirror origin
          echo "已从 Gitee 镜像到 GitHub：${GITHUB_REPOSITORY}"
"#;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionsMirrorSetup {
    pub workflow_path: String,
    pub workflow_written: bool,
    pub workflow_exists: bool,
    pub reverse_workflow_path: String,
    pub reverse_workflow_written: bool,
    pub reverse_workflow_exists: bool,
    pub gitee_url: String,
    pub gitee_full_name: String,
    pub github_owner: String,
    pub github_repo: String,
    pub secrets_url: String,
    pub secret_configured: bool,
    pub pushed: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionsMirrorStatus {
    pub workflow_exists: bool,
    pub workflow_path: String,
    pub reverse_workflow_exists: bool,
    pub reverse_workflow_path: String,
    pub has_gitee_remote: bool,
    pub github_owner: String,
    pub github_repo: String,
    pub secrets_url: String,
}

pub fn actions_mirror_status(git: &GitBinary, repo: &Path) -> Result<ActionsMirrorStatus, GitError> {
    let _ = git;
    let forward = repo.join(WORKFLOW_FORWARD_REL);
    let reverse = repo.join(WORKFLOW_REVERSE_REL);
    let (owner, name) = resolve_github_owner_repo(git, repo)?;
    let remotes = list_remotes(git, repo).unwrap_or_default();
    let has_gitee = remotes.iter().any(|r| {
        r.name == "gitee" || r.url.to_ascii_lowercase().contains("gitee.com")
    });
    Ok(ActionsMirrorStatus {
        workflow_exists: forward.is_file(),
        workflow_path: WORKFLOW_FORWARD_REL.to_string(),
        reverse_workflow_exists: reverse.is_file(),
        reverse_workflow_path: WORKFLOW_REVERSE_REL.to_string(),
        has_gitee_remote: has_gitee,
        github_owner: owner.clone(),
        github_repo: name.clone(),
        secrets_url: if owner.is_empty() {
            String::new()
        } else {
            format!("https://github.com/{owner}/{name}/settings/secrets/actions")
        },
    })
}

fn write_workflow(path: &Path, yaml: &str) -> Result<bool, GitError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| GitError::Io {
            path: parent.display().to_string(),
            message: e.to_string(),
        })?;
    }
    let existed = path.is_file();
    let same = existed && std::fs::read_to_string(path).unwrap_or_default() == yaml;
    if same {
        return Ok(false);
    }
    std::fs::write(path, yaml).map_err(|e| GitError::Io {
        path: path.display().to_string(),
        message: e.to_string(),
    })?;
    Ok(true)
}

/// 一键安装双向 workflow、确保 Gitee 仓、自动写 Secrets，并尽量提交推送 workflow。
pub fn setup_actions_mirror(
    git: &GitBinary,
    repo: &Path,
    configure_secret: bool,
) -> Result<ActionsMirrorSetup, GitError> {
    let (owner, name) = resolve_github_owner_repo(git, repo)?;
    if owner.is_empty() || name.is_empty() {
        return Err(GitError::InvalidInput(
            "当前仓库没有可用的 GitHub 远程（需含 github.com）。请先配置 GitHub 远程后再安装。"
                .to_string(),
        ));
    }

    let forward_path = repo.join(WORKFLOW_FORWARD_REL);
    let reverse_path = repo.join(WORKFLOW_REVERSE_REL);
    let forward_written = write_workflow(&forward_path, WORKFLOW_FORWARD_YAML)?;
    let reverse_written = write_workflow(&reverse_path, WORKFLOW_REVERSE_YAML)?;

    let repo_name = infer_repo_name(git, repo)?;
    let created = create_or_get_hosting_repo("gitee", &repo_name, false, "")?;
    set_remote_url(git, repo, "gitee", &created.clone_url)?;

    let secrets_url = format!("https://github.com/{owner}/{name}/settings/secrets/actions");
    let mut secret_configured = false;
    let secret_note = if configure_secret {
        match try_configure_gitee_secrets(&owner, &name, &created.full_name) {
            Ok(()) => {
                secret_configured = true;
                "已自动写入 GitHub Secrets（GITEE_TOKEN / GITEE_USER / GITEE_REPO），无需打开网页。"
                    .to_string()
            }
            Err(err) => format!(
                "自动写 Secrets 失败（{err}）。请确认已登录 GitHub（含 workflow 权限）与 Gitee。"
            ),
        }
    } else {
        "已跳过 Secrets 写入。".to_string()
    };

    let mut pushed = false;
    let push_note = if forward_written || reverse_written {
        match auto_commit_and_push_workflows(git, repo) {
            Ok(msg) => {
                pushed = true;
                msg
            }
            Err(err) => format!(
                "工作流已写入本地，但自动提交/推送失败（{err}）。请在改动里暂存 .github/workflows 后推送到 GitHub。"
            ),
        }
    } else {
        "工作流文件已是最新。".to_string()
    };

    Ok(ActionsMirrorSetup {
        workflow_path: WORKFLOW_FORWARD_REL.to_string(),
        workflow_written: forward_written,
        workflow_exists: true,
        reverse_workflow_path: WORKFLOW_REVERSE_REL.to_string(),
        reverse_workflow_written: reverse_written,
        reverse_workflow_exists: true,
        gitee_url: created.clone_url,
        gitee_full_name: created.full_name.clone(),
        github_owner: owner,
        github_repo: name,
        secrets_url,
        secret_configured,
        pushed,
        message: format!(
            "已一键准备双向 Actions 镜像。\n\
             · GitHub → Gitee：推 GitHub 后自动镜像\n\
             · Gitee → GitHub：同步推送时触发 Actions 从 Gitee 拉回\n\
             Gitee 仓：{}\n{}\n{}",
            created.html_url, secret_note, push_note
        ),
    })
}

fn auto_commit_and_push_workflows(git: &GitBinary, repo: &Path) -> Result<String, GitError> {
    let paths = vec![
        WORKFLOW_FORWARD_REL.to_string(),
        WORKFLOW_REVERSE_REL.to_string(),
    ];
    stage_paths(git, repo, &paths)?;
    let _ = commit(
        git,
        repo,
        "chore: install Qingzhi bidirectional Actions mirror",
    )?;
    // Prefer github remote name, else origin.
    let remotes = list_remotes(git, repo).unwrap_or_default();
    let remote = remotes
        .iter()
        .find(|r| r.name == "github")
        .or_else(|| remotes.iter().find(|r| r.name == "origin"))
        .map(|r| r.name.as_str())
        .unwrap_or("origin");
    super::push_with_options(git, repo, false, None, Some(remote))?;
    Ok(format!(
        "已自动提交并推送 workflow 到 {remote}（请确认 GitHub 已收到文件）。"
    ))
}

/// 触发「从 Gitee 镜像到 GitHub」的 workflow_dispatch。
pub fn trigger_reverse_actions_mirror(git: &GitBinary, repo: &Path) -> Result<String, GitError> {
    let (owner, name) = resolve_github_owner_repo(git, repo)?;
    if owner.is_empty() || name.is_empty() {
        return Err(GitError::InvalidInput(
            "找不到 GitHub 仓库，无法触发反向镜像。".to_string(),
        ));
    }
    let reverse = repo.join(WORKFLOW_REVERSE_REL);
    if !reverse.is_file() {
        return Err(GitError::InvalidInput(
            "尚未安装反向镜像工作流。请到设置 → 行为，点「一键安装双向 Actions 镜像」。"
                .to_string(),
        ));
    }
    let gh_token = github_access_token()?.ok_or_else(|| {
        GitError::InvalidInput("请先登录 GitHub，才能触发 Actions。".to_string())
    })?;

    let agent = ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(15))
        .timeout_read(std::time::Duration::from_secs(30))
        .build();

    // Resolve workflow id by filename
    let list_url = format!("https://api.github.com/repos/{owner}/{name}/actions/workflows");
    let list_resp = agent
        .get(&list_url)
        .set("Authorization", &format!("Bearer {gh_token}"))
        .set("Accept", "application/vnd.github+json")
        .set("User-Agent", "qingzhi")
        .set("X-GitHub-Api-Version", "2022-11-28")
        .call()
        .map_err(|e| GitError::InvalidInput(format!("读取 workflow 列表失败：{e}")))?;
    if !(200..300).contains(&list_resp.status()) {
        return Err(GitError::InvalidInput(format!(
            "读取 workflow 列表失败（HTTP {}）",
            list_resp.status()
        )));
    }
    #[derive(Deserialize)]
    struct WfList {
        workflows: Vec<WfItem>,
    }
    #[derive(Deserialize)]
    struct WfItem {
        id: u64,
        path: String,
    }
    let list = list_resp
        .into_json::<WfList>()
        .map_err(|e| GitError::InvalidInput(format!("解析 workflow 列表失败：{e}")))?;
    let wf = list
        .workflows
        .into_iter()
        .find(|w| w.path.ends_with("qingzhi-mirror-from-gitee.yml"))
        .ok_or_else(|| {
            GitError::InvalidInput(
                "GitHub 上还没有反向镜像工作流。请先推送 .github/workflows 后再试。".to_string(),
            )
        })?;

    let dispatch_url = format!(
        "https://api.github.com/repos/{owner}/{name}/actions/workflows/{}/dispatches",
        wf.id
    );
    let body = serde_json::json!({ "ref": default_branch(git, repo) });
    let resp = agent
        .post(&dispatch_url)
        .set("Authorization", &format!("Bearer {gh_token}"))
        .set("Accept", "application/vnd.github+json")
        .set("User-Agent", "qingzhi")
        .set("X-GitHub-Api-Version", "2022-11-28")
        .set("Content-Type", "application/json")
        .send_json(body)
        .map_err(|e| GitError::InvalidInput(format!("触发 Actions 失败：{e}")))?;
    let status = resp.status();
    if status != 204 && status != 200 {
        let text = resp.into_string().unwrap_or_default();
        return Err(GitError::InvalidInput(format!(
            "触发 Actions 失败（HTTP {status}）：{text}"
        )));
    }
    Ok(format!(
        "已触发 GitHub Actions 从 Gitee 镜像到 {owner}/{name}。可在 Actions 页查看进度。"
    ))
}

fn default_branch(git: &GitBinary, repo: &Path) -> String {
    use super::runner::run_git;
    if let Ok(out) = run_git(git, repo, &["rev-parse", "--abbrev-ref", "HEAD"]) {
        let b = out.stdout.trim().to_string();
        if !b.is_empty() && b != "HEAD" {
            return b;
        }
    }
    "main".to_string()
}

fn resolve_github_owner_repo(git: &GitBinary, repo: &Path) -> Result<(String, String), GitError> {
    let remotes = list_remotes(git, repo)?;
    let origin = remotes
        .iter()
        .find(|r| r.name == "github")
        .or_else(|| remotes.iter().find(|r| r.name == "origin"))
        .or_else(|| {
            remotes
                .iter()
                .find(|r| r.url.to_ascii_lowercase().contains("github.com"))
        })
        .or(remotes.first());
    let Some(remote) = origin else {
        return Ok((String::new(), String::new()));
    };
    Ok(parse_github_owner_repo(&remote.url).unwrap_or_default())
}

fn parse_github_owner_repo(url: &str) -> Option<(String, String)> {
    let lower = url.trim().to_ascii_lowercase();
    if !lower.contains("github.com") {
        return None;
    }
    let trimmed = url.trim().trim_end_matches('/').trim_end_matches(".git");
    let parts: Vec<&str> = if let Some(rest) = trimmed.strip_prefix("git@github.com:") {
        rest.split('/').collect()
    } else if let Some(idx) = trimmed.find("github.com/") {
        trimmed[idx + "github.com/".len()..].split('/').collect()
    } else if let Some(idx) = trimmed.find("github.com:") {
        trimmed[idx + "github.com:".len()..].split('/').collect()
    } else {
        return None;
    };
    if parts.len() < 2 {
        return None;
    }
    let owner = parts[0].trim();
    let name = parts[1].trim();
    if owner.is_empty() || name.is_empty() {
        None
    } else {
        Some((owner.to_string(), name.to_string()))
    }
}

#[derive(Deserialize)]
struct GithubPublicKey {
    key_id: String,
    key: String,
}

fn try_configure_gitee_secrets(
    owner: &str,
    repo: &str,
    gitee_full_name: &str,
) -> Result<(), GitError> {
    let gh_token = github_access_token()?.ok_or_else(|| {
        GitError::InvalidInput("请先登录 GitHub，才能自动写入 Actions Secrets。".to_string())
    })?;
    let gitee_token = provider_access_token(Provider::Gitee)?.ok_or_else(|| {
        GitError::InvalidInput("请先登录 Gitee，才能把令牌写入 GitHub Secrets。".to_string())
    })?;
    let gitee_user = provider_login_name(Provider::Gitee)?.ok_or_else(|| {
        GitError::InvalidInput("无法读取 Gitee 用户名。".to_string())
    })?;

    put_github_actions_secret(owner, repo, &gh_token, "GITEE_TOKEN", &gitee_token)?;
    put_github_actions_secret(owner, repo, &gh_token, "GITEE_USER", &gitee_user)?;
    put_github_actions_secret(owner, repo, &gh_token, "GITEE_REPO", gitee_full_name)?;
    Ok(())
}

fn put_github_actions_secret(
    owner: &str,
    repo: &str,
    github_token: &str,
    name: &str,
    value: &str,
) -> Result<(), GitError> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(15))
        .timeout_read(std::time::Duration::from_secs(30))
        .build();
    let pk_url = format!("https://api.github.com/repos/{owner}/{repo}/actions/secrets/public-key");
    let pk_resp = agent
        .get(&pk_url)
        .set("Authorization", &format!("Bearer {github_token}"))
        .set("Accept", "application/vnd.github+json")
        .set("User-Agent", "qingzhi")
        .set("X-GitHub-Api-Version", "2022-11-28")
        .call()
        .map_err(|e| GitError::InvalidInput(format!("读取 Secrets 公钥失败：{e}")))?;
    if !(200..300).contains(&pk_resp.status()) {
        return Err(GitError::InvalidInput(format!(
            "读取 Secrets 公钥失败（HTTP {}）。若刚登录，请重新授权并勾选 workflow 权限。",
            pk_resp.status()
        )));
    }
    let pk = pk_resp
        .into_json::<GithubPublicKey>()
        .map_err(|e| GitError::InvalidInput(format!("解析 Secrets 公钥失败：{e}")))?;
    let key_bytes = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        pk.key.trim(),
    )
    .map_err(|e| GitError::InvalidInput(format!("Secrets 公钥无效：{e}")))?;
    if key_bytes.len() != 32 {
        return Err(GitError::InvalidInput(format!(
            "Secrets 公钥长度异常（{}）",
            key_bytes.len()
        )));
    }
    let mut key_arr = [0u8; 32];
    key_arr.copy_from_slice(&key_bytes);
    let public = PublicKey::from(key_arr);
    let sealed = public
        .seal(&mut rand_core::OsRng, value.as_bytes())
        .map_err(|_| GitError::InvalidInput("加密 Secret 失败".to_string()))?;
    let encrypted = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, sealed);

    let put_url = format!("https://api.github.com/repos/{owner}/{repo}/actions/secrets/{name}");
    let body = serde_json::json!({
        "encrypted_value": encrypted,
        "key_id": pk.key_id,
    });
    let put_resp = agent
        .put(&put_url)
        .set("Authorization", &format!("Bearer {github_token}"))
        .set("Accept", "application/vnd.github+json")
        .set("User-Agent", "qingzhi")
        .set("X-GitHub-Api-Version", "2022-11-28")
        .set("Content-Type", "application/json")
        .send_json(body)
        .map_err(|e| GitError::InvalidInput(format!("写入 Secret「{name}」失败：{e}")))?;
    let status = put_resp.status();
    if status != 201 && status != 204 {
        let text = put_resp.into_string().unwrap_or_default();
        return Err(GitError::InvalidInput(format!(
            "写入 Secret「{name}」失败（HTTP {status}）：{text}"
        )));
    }
    Ok(())
}
