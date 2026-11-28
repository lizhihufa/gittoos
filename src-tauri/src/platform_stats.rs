//! GitHub / Gitee repository summary for Overview charts.
use crate::git::{local_proxy, provider_access_token, Provider};
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformContributor {
    pub login: String,
    pub contributions: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformLanguageShare {
    pub name: String,
    pub bytes: u64,
    pub percent: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformWorkflowRun {
    pub name: String,
    pub status: String,
    pub conclusion: String,
    pub created_at: String,
    pub html_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformRepoStats {
    pub platform: String,
    pub owner: String,
    pub repo: String,
    pub full_name: String,
    pub description: String,
    pub stars: u64,
    pub forks: u64,
    pub watchers: u64,
    pub open_issues: u64,
    pub open_prs: u64,
    pub default_branch: String,
    pub language: String,
    pub private_repo: bool,
    pub html_url: String,
    pub pushed_at: String,
    pub languages: Vec<PlatformLanguageShare>,
    pub contributors: Vec<PlatformContributor>,
    pub workflow_runs: Vec<PlatformWorkflowRun>,
}

fn http_agent() -> ureq::Agent {
    let mut builder = ureq::AgentBuilder::new().timeout(Duration::from_secs(45));
    if let Some(proxy) = local_proxy() {
        if let Ok(p) = ureq::Proxy::new(&proxy) {
            builder = builder.proxy(p);
        }
    }
    builder.build()
}

fn require_owner_repo(owner: &str, repo: &str) -> Result<(String, String), String> {
    let owner = owner.trim().to_string();
    let repo = repo.trim().to_string();
    if owner.is_empty() || repo.is_empty() {
        return Err("未识别仓库 owner/repo".into());
    }
    Ok((owner, repo))
}

pub fn fetch_platform_repo_stats(
    platform: &str,
    owner: &str,
    repo: &str,
) -> Result<PlatformRepoStats, String> {
    let platform = platform.trim().to_ascii_lowercase();
    let (owner, repo) = require_owner_repo(owner, repo)?;
    match platform.as_str() {
        "github" => fetch_github(&owner, &repo),
        "gitee" => fetch_gitee(&owner, &repo),
        _ => Err(format!("未知平台：{platform}")),
    }
}

fn fetch_github(owner: &str, repo: &str) -> Result<PlatformRepoStats, String> {
    let token = provider_access_token(Provider::Github)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "请先登录 GitHub".to_string())?;
    let agent = http_agent();
    let meta_url = format!("https://api.github.com/repos/{owner}/{repo}");
    let meta = agent
        .get(&meta_url)
        .set("Accept", "application/vnd.github+json")
        .set("Authorization", &format!("Bearer {token}"))
        .set("User-Agent", "qingzhi")
        .set("X-GitHub-Api-Version", "2022-11-28")
        .call()
        .map_err(|e| format!("读取 GitHub 仓库失败：{e}"))?;
    if !(200..300).contains(&meta.status()) {
        let code = meta.status();
        let body = meta.into_string().unwrap_or_default();
        return Err(format!(
            "GitHub 仓库 HTTP {code}：{}",
            body.chars().take(180).collect::<String>()
        ));
    }
    let meta_json: serde_json::Value = meta
        .into_json()
        .map_err(|e| format!("解析 GitHub 仓库失败：{e}"))?;

    let languages = {
        let url = format!("https://api.github.com/repos/{owner}/{repo}/languages");
        match agent
            .get(&url)
            .set("Accept", "application/vnd.github+json")
            .set("Authorization", &format!("Bearer {token}"))
            .set("User-Agent", "qingzhi")
            .set("X-GitHub-Api-Version", "2022-11-28")
            .call()
        {
            Ok(resp) if (200..300).contains(&resp.status()) => {
                let map: serde_json::Map<String, serde_json::Value> =
                    resp.into_json().unwrap_or_default();
                share_languages(map)
            }
            _ => vec![],
        }
    };

    let contributors = {
        let url = format!(
            "https://api.github.com/repos/{owner}/{repo}/contributors?per_page=8"
        );
        match agent
            .get(&url)
            .set("Accept", "application/vnd.github+json")
            .set("Authorization", &format!("Bearer {token}"))
            .set("User-Agent", "qingzhi")
            .set("X-GitHub-Api-Version", "2022-11-28")
            .call()
        {
            Ok(resp) if (200..300).contains(&resp.status()) => {
                let list: Vec<serde_json::Value> = resp.into_json().unwrap_or_default();
                list.into_iter()
                    .filter_map(|v| {
                        let login = v.get("login")?.as_str()?.to_string();
                        let contributions = v.get("contributions")?.as_u64()? as u32;
                        Some(PlatformContributor {
                            login,
                            contributions,
                        })
                    })
                    .collect()
            }
            _ => vec![],
        }
    };

    Ok(PlatformRepoStats {
        platform: "github".into(),
        owner: owner.to_string(),
        repo: repo.to_string(),
        full_name: meta_json
            .get("full_name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        description: meta_json
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        stars: meta_json
            .get("stargazers_count")
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
        forks: meta_json
            .get("forks_count")
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
        watchers: meta_json
            .get("subscribers_count")
            .or_else(|| meta_json.get("watchers_count"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
        open_issues: meta_json
            .get("open_issues_count")
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
        open_prs: {
            let url = format!(
                "https://api.github.com/search/issues?q=repo:{owner}/{repo}+is:pr+is:open&per_page=1"
            );
            match agent
                .get(&url)
                .set("Accept", "application/vnd.github+json")
                .set("Authorization", &format!("Bearer {token}"))
                .set("User-Agent", "qingzhi")
                .set("X-GitHub-Api-Version", "2022-11-28")
                .call()
            {
                Ok(resp) if (200..300).contains(&resp.status()) => resp
                    .into_json::<serde_json::Value>()
                    .ok()
                    .and_then(|v| v.get("total_count")?.as_u64())
                    .unwrap_or(0),
                _ => 0,
            }
        },
        default_branch: meta_json
            .get("default_branch")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        language: meta_json
            .get("language")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        private_repo: meta_json
            .get("private")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        html_url: meta_json
            .get("html_url")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        pushed_at: meta_json
            .get("pushed_at")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        languages,
        contributors,
        workflow_runs: {
            let url = format!(
                "https://api.github.com/repos/{owner}/{repo}/actions/runs?per_page=8"
            );
            match agent
                .get(&url)
                .set("Accept", "application/vnd.github+json")
                .set("Authorization", &format!("Bearer {token}"))
                .set("User-Agent", "qingzhi")
                .set("X-GitHub-Api-Version", "2022-11-28")
                .call()
            {
                Ok(resp) if (200..300).contains(&resp.status()) => {
                    let body: serde_json::Value = resp.into_json().unwrap_or_default();
                    body.get("workflow_runs")
                        .and_then(|v| v.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|v| {
                                    Some(PlatformWorkflowRun {
                                        name: v
                                            .get("name")
                                            .and_then(|x| x.as_str())
                                            .unwrap_or("workflow")
                                            .to_string(),
                                        status: v
                                            .get("status")
                                            .and_then(|x| x.as_str())
                                            .unwrap_or("")
                                            .to_string(),
                                        conclusion: v
                                            .get("conclusion")
                                            .and_then(|x| x.as_str())
                                            .unwrap_or("")
                                            .to_string(),
                                        created_at: v
                                            .get("created_at")
                                            .and_then(|x| x.as_str())
                                            .unwrap_or("")
                                            .to_string(),
                                        html_url: v
                                            .get("html_url")
                                            .and_then(|x| x.as_str())
                                            .unwrap_or("")
                                            .to_string(),
                                    })
                                })
                                .collect()
                        })
                        .unwrap_or_default()
                }
                _ => vec![],
            }
        },
    })
}

fn fetch_gitee(owner: &str, repo: &str) -> Result<PlatformRepoStats, String> {
    let token = provider_access_token(Provider::Gitee)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "请先登录 Gitee".to_string())?;
    let agent = http_agent();
    let meta_url = format!(
        "https://gitee.com/api/v5/repos/{owner}/{repo}?access_token={token}"
    );
    let meta = agent
        .get(&meta_url)
        .set("User-Agent", "qingzhi")
        .call()
        .map_err(|e| format!("读取 Gitee 仓库失败：{e}"))?;
    if !(200..300).contains(&meta.status()) {
        let code = meta.status();
        let body = meta.into_string().unwrap_or_default();
        return Err(format!(
            "Gitee 仓库 HTTP {code}：{}",
            body.chars().take(180).collect::<String>()
        ));
    }
    let meta_json: serde_json::Value = meta
        .into_json()
        .map_err(|e| format!("解析 Gitee 仓库失败：{e}"))?;

    let languages = {
        let url = format!(
            "https://gitee.com/api/v5/repos/{owner}/{repo}/languages?access_token={token}"
        );
        match agent.get(&url).set("User-Agent", "qingzhi").call() {
            Ok(resp) if (200..300).contains(&resp.status()) => {
                // Gitee may return { "Java": 123 } or nested — try map of numbers
                match resp.into_json::<serde_json::Value>() {
                    Ok(serde_json::Value::Object(map)) => {
                        let flat: serde_json::Map<String, serde_json::Value> = map
                            .into_iter()
                            .filter(|(_, v)| v.as_u64().is_some() || v.as_f64().is_some())
                            .collect();
                        share_languages(flat)
                    }
                    _ => vec![],
                }
            }
            _ => vec![],
        }
    };

    let contributors = {
        let url = format!(
            "https://gitee.com/api/v5/repos/{owner}/{repo}/contributors?access_token={token}&per_page=8"
        );
        match agent.get(&url).set("User-Agent", "qingzhi").call() {
            Ok(resp) if (200..300).contains(&resp.status()) => {
                let list: Vec<serde_json::Value> = resp.into_json().unwrap_or_default();
                list.into_iter()
                    .filter_map(|v| {
                        let login = v
                            .get("name")
                            .or_else(|| v.get("login"))
                            .and_then(|x| x.as_str())?
                            .to_string();
                        let contributions = v
                            .get("contributions")
                            .and_then(|x| x.as_u64())
                            .unwrap_or(0) as u32;
                        Some(PlatformContributor {
                            login,
                            contributions,
                        })
                    })
                    .collect()
            }
            _ => vec![],
        }
    };

    Ok(PlatformRepoStats {
        platform: "gitee".into(),
        owner: owner.to_string(),
        repo: repo.to_string(),
        full_name: meta_json
            .get("full_name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        description: meta_json
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        stars: meta_json
            .get("stargazers_count")
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
        forks: meta_json
            .get("forks_count")
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
        watchers: meta_json
            .get("watchers_count")
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
        open_issues: meta_json
            .get("open_issues_count")
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
        open_prs: {
            // Gitee: open pull requests count (best-effort; per_page=100)
            let url = format!(
                "https://gitee.com/api/v5/repos/{owner}/{repo}/pulls?access_token={token}&state=open&per_page=100&page=1"
            );
            match agent.get(&url).set("User-Agent", "qingzhi").call() {
                Ok(resp) if (200..300).contains(&resp.status()) => resp
                    .into_json::<Vec<serde_json::Value>>()
                    .map(|v| v.len() as u64)
                    .unwrap_or(0),
                _ => 0,
            }
        },
        default_branch: meta_json
            .get("default_branch")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        language: meta_json
            .get("language")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        private_repo: meta_json
            .get("private")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        html_url: meta_json
            .get("html_url")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        pushed_at: meta_json
            .get("pushed_at")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        languages,
        contributors,
        workflow_runs: vec![],
    })
}

fn share_languages(map: serde_json::Map<String, serde_json::Value>) -> Vec<PlatformLanguageShare> {
    let mut items: Vec<(String, u64)> = map
        .into_iter()
        .filter_map(|(k, v)| {
            let n = v.as_u64().or_else(|| v.as_f64().map(|f| f as u64))?;
            Some((k, n))
        })
        .collect();
    items.sort_by(|a, b| b.1.cmp(&a.1));
    let total: u64 = items.iter().map(|(_, n)| *n).sum::<u64>().max(1);
    items
        .into_iter()
        .take(6)
        .map(|(name, bytes)| PlatformLanguageShare {
            name,
            bytes,
            percent: (bytes as f64) * 100.0 / (total as f64),
        })
        .collect()
}
