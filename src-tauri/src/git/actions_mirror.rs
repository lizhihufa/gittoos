//! GitHub Actions → Gitee 镜像：写入 workflow、确保 Gitee 仓、可选写入 Secrets。

use super::auth::{
    create_or_get_hosting_repo, github_access_token, provider_access_token, provider_login_name,
    Provider,
};
use super::runner::GitBinary;
use super::types::GitError;
use super::{infer_repo_name, list_remotes, set_remote_url};
use crypto_box::PublicKey;
use serde::{Deserialize, Serialize};
use std::path::Path;

const WORKFLOW_REL: &str = ".github/workflows/qingzhi-mirror-gitee.yml";

const WORKFLOW_YAML: &str = r#"# 由青枝写入：推送到 GitHub 后，用 Actions 镜像到 Gitee。
# 需要仓库 Secrets：GITEE_TOKEN、GITEE_USER，可选 GITEE_REPO（owner/repo）。
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionsMirrorSetup {
    pub workflow_path: String,
    pub workflow_written: bool,
    pub workflow_exists: bool,
    pub gitee_url: String,
    pub gitee_full_name: String,
    pub github_owner: String,
    pub github_repo: String,
    pub secrets_url: String,
    pub secret_configured: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionsMirrorStatus {
    pub workflow_exists: bool,
    pub workflow_path: String,
    pub has_gitee_remote: bool,
    pub github_owner: String,
    pub github_repo: String,
    pub secrets_url: String,
}

pub fn actions_mirror_status(git: &GitBinary, repo: &Path) -> Result<ActionsMirrorStatus, GitError> {
    let _ = git;
    let workflow = repo.join(WORKFLOW_REL);
    let (owner, name) = resolve_github_owner_repo(git, repo)?;
    let remotes = list_remotes(git, repo).unwrap_or_default();
    let has_gitee = remotes.iter().any(|r| {
        r.name == "gitee" || r.url.to_ascii_lowercase().contains("gitee.com")
    });
    Ok(ActionsMirrorStatus {
        workflow_exists: workflow.is_file(),
        workflow_path: WORKFLOW_REL.to_string(),
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

pub fn setup_actions_mirror(
    git: &GitBinary,
    repo: &Path,
    configure_secret: bool,
) -> Result<ActionsMirrorSetup, GitError> {
    let (owner, name) = resolve_github_owner_repo(git, repo)?;
    if owner.is_empty() || name.is_empty() {
        return Err(GitError::InvalidInput(
            "当前仓库没有可用的 GitHub 远程（origin 需为 github.com）。Actions 镜像仅支持 GitHub → Gitee。"
                .to_string(),
        ));
    }

    let workflow = repo.join(WORKFLOW_REL);
    let existed = workflow.is_file();
    if let Some(parent) = workflow.parent() {
        std::fs::create_dir_all(parent).map_err(|e| GitError::Io {
            path: parent.display().to_string(),
            message: e.to_string(),
        })?;
    }
    let mut written = false;
    if !existed || std::fs::read_to_string(&workflow).unwrap_or_default() != WORKFLOW_YAML {
        std::fs::write(&workflow, WORKFLOW_YAML).map_err(|e| GitError::Io {
            path: workflow.display().to_string(),
            message: e.to_string(),
        })?;
        written = true;
    }

    let repo_name = infer_repo_name(git, repo)?;
    let created = create_or_get_hosting_repo("gitee", &repo_name, false, "")?;
    set_remote_url(git, repo, "gitee", &created.clone_url)?;

    let secrets_url = format!("https://github.com/{owner}/{name}/settings/secrets/actions");
    let mut secret_configured = false;
    let secret_note = if configure_secret {
        match try_configure_gitee_secrets(&owner, &name, &created.full_name) {
            Ok(()) => {
                secret_configured = true;
                "已写入 GitHub Secrets：GITEE_TOKEN、GITEE_USER、GITEE_REPO。".to_string()
            }
            Err(err) => format!(
                "未能自动写入 Secrets（{err}）。请打开 Secrets 页面手动添加 GITEE_TOKEN、GITEE_USER，可选 GITEE_REPO={}.",
                created.full_name
            ),
        }
    } else {
        format!(
            "请在 Secrets 中添加 GITEE_TOKEN、GITEE_USER，可选 GITEE_REPO={}。",
            created.full_name
        )
    };

    let commit_hint = if written {
        "请暂存并提交 .github/workflows/qingzhi-mirror-gitee.yml 后推送到 GitHub（推送 workflow 需要 GitHub 令牌含 workflow 权限；可在登录页重新授权）。"
    } else {
        "工作流文件已存在。"
    };

    Ok(ActionsMirrorSetup {
        workflow_path: WORKFLOW_REL.to_string(),
        workflow_written: written,
        workflow_exists: true,
        gitee_url: created.clone_url,
        gitee_full_name: created.full_name,
        github_owner: owner,
        github_repo: name,
        secrets_url,
        secret_configured,
        message: format!(
            "已准备 Actions 镜像。\nGitee：{}\n{}\n{}",
            created.html_url, commit_hint, secret_note
        ),
    })
}

fn resolve_github_owner_repo(git: &GitBinary, repo: &Path) -> Result<(String, String), GitError> {
    let remotes = list_remotes(git, repo)?;
    let origin = remotes
        .iter()
        .find(|r| r.name == "origin")
        .or_else(|| remotes.iter().find(|r| r.url.to_ascii_lowercase().contains("github.com")))
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

