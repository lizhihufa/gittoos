use super::runner::{emit_terminal, ensure_git, local_proxy, GitBinary};
use super::types::GitError;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    Github,
    Gitee,
}

impl Provider {
    pub fn parse(raw: &str) -> Result<Self, GitError> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "github" => Ok(Self::Github),
            "gitee" => Ok(Self::Gitee),
            _ => Err(GitError::InvalidInput(format!("未知登录平台：{raw}"))),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Github => "github",
            Self::Gitee => "gitee",
        }
    }

    fn host(self) -> &'static str {
        match self {
            Self::Github => "github.com",
            Self::Gitee => "gitee.com",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Github => "GitHub",
            Self::Gitee => "Gitee",
        }
    }

    fn ssh_host(self) -> &'static str {
        match self {
            Self::Github => "git@github.com",
            Self::Gitee => "git@gitee.com",
        }
    }
}

/// Optional compile-time OAuth defaults (set via env at build time).
fn builtin_client_id(provider: Provider) -> &'static str {
    match provider {
        Provider::Github => option_env!("QINGZHI_GITHUB_CLIENT_ID").unwrap_or(""),
        Provider::Gitee => option_env!("QINGZHI_GITEE_CLIENT_ID").unwrap_or(""),
    }
}

fn builtin_client_secret(provider: Provider) -> &'static str {
    match provider {
        Provider::Github => option_env!("QINGZHI_GITHUB_CLIENT_SECRET").unwrap_or(""),
        Provider::Gitee => option_env!("QINGZHI_GITEE_CLIENT_SECRET").unwrap_or(""),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AccountEntry {
    #[serde(default)]
    id: String,
    #[serde(default)]
    login: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    avatar_url: String,
    #[serde(default)]
    token: String,
    #[serde(default)]
    refresh_token: String,
    /// Unix seconds; 0 means unknown / no expiry tracked.
    #[serde(default)]
    token_expires_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ProviderStore {
    #[serde(default)]
    client_id: String,
    #[serde(default)]
    client_secret: String,
    /// Legacy single-session fields (migrated into `accounts`).
    #[serde(default)]
    token: String,
    #[serde(default)]
    login: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    avatar_url: String,
    #[serde(default)]
    accounts: Vec<AccountEntry>,
    #[serde(default)]
    active_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AuthStore {
    #[serde(default)]
    github: ProviderStore,
    #[serde(default)]
    gitee: ProviderStore,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSummary {
    pub id: String,
    pub login: String,
    pub name: String,
    pub avatar_url: String,
    pub active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub provider: String,
    pub logged_in: bool,
    pub login: String,
    pub name: String,
    pub avatar_url: String,
    pub client_id: String,
    pub has_client_id: bool,
    pub has_client_secret: bool,
    /// True when a saved token existed but failed validation (cleared).
    #[serde(default)]
    pub session_expired: bool,
    #[serde(default)]
    pub accounts: Vec<AccountSummary>,
    /// Effective Client ID is available (saved or built-in).
    #[serde(default)]
    pub oauth_ready: bool,
    #[serde(default)]
    pub using_builtin_oauth: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthAccounts {
    pub github: ProviderStatus,
    pub gitee: ProviderStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OauthBegin {
    pub provider: String,
    pub auth_url: String,
    pub redirect_uri: String,
    pub state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubDeviceStart {
    pub user_code: String,
    pub verification_uri: String,
    pub device_code: String,
    pub interval: u64,
    pub expires_in: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubDevicePollResult {
    pub status: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<ProviderStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshKeyInfo {
    pub path: String,
    pub public_key: String,
    pub fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshStatus {
    pub ssh_dir: String,
    pub keys: Vec<SshKeyInfo>,
    pub has_agent: bool,
    pub tip: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTestResult {
    pub ok: bool,
    pub message: String,
}

#[derive(Deserialize)]
struct ApiUser {
    login: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    avatar_url: String,
}

#[derive(Deserialize)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    interval: u64,
}

#[derive(Deserialize)]
struct TokenResponse {
    #[serde(default)]
    access_token: Option<String>,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<u64>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    error_description: Option<String>,
}

struct PendingOauth {
    provider: Provider,
    expected_state: String,
    redirect_uri: String,
    listener: TcpListener,
}

enum ApiFailKind {
    Auth,
    Network,
    Other,
}

static PENDING: Mutex<Option<PendingOauth>> = Mutex::new(None);

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn new_account_id() -> String {
    format!("a{:x}", now_secs().saturating_mul(1000) ^ (std::process::id() as u64))
}

fn auth_store_path() -> Result<PathBuf, GitError> {
    let local = std::env::var("LOCALAPPDATA").map_err(|_| {
        GitError::InvalidInput("找不到本机数据目录".to_string())
    })?;
    Ok(PathBuf::from(local).join("qingzhi").join("auth.json"))
}

fn legacy_github_path() -> Result<PathBuf, GitError> {
    let local = std::env::var("LOCALAPPDATA").map_err(|_| {
        GitError::InvalidInput("找不到本机数据目录".to_string())
    })?;
    Ok(PathBuf::from(local).join("qingzhi").join("github.json"))
}

fn migrate_provider(slot: &mut ProviderStore) {
    if slot.accounts.is_empty() && !slot.token.trim().is_empty() && !slot.login.trim().is_empty() {
        let id = new_account_id();
        slot.accounts.push(AccountEntry {
            id: id.clone(),
            login: slot.login.clone(),
            name: slot.name.clone(),
            avatar_url: slot.avatar_url.clone(),
            token: slot.token.clone(),
            refresh_token: String::new(),
            token_expires_at: 0,
        });
        slot.active_id = id;
    }
    if !slot.accounts.is_empty()
        && (slot.active_id.is_empty()
            || !slot.accounts.iter().any(|a| a.id == slot.active_id))
    {
        slot.active_id = slot.accounts[0].id.clone();
    }
    // Keep legacy mirror of active account for older readers.
    if let Some(active) = active_account(slot).cloned() {
        slot.token = active.token;
        slot.login = active.login;
        slot.name = active.name;
        slot.avatar_url = active.avatar_url;
    } else {
        slot.token.clear();
        slot.login.clear();
        slot.name.clear();
        slot.avatar_url.clear();
    }
}

fn normalize_store(store: &mut AuthStore) {
    migrate_provider(&mut store.github);
    migrate_provider(&mut store.gitee);
}

fn load_store() -> Result<AuthStore, GitError> {
    let path = auth_store_path()?;
    let mut store = if path.exists() {
        let text = std::fs::read_to_string(&path).map_err(|e| GitError::Io {
            path: path.display().to_string(),
            message: e.to_string(),
        })?;
        serde_json::from_str(&text)
            .map_err(|e| GitError::InvalidInput(format!("读取登录配置失败：{e}")))?
    } else {
        // Migrate old github.json if present.
        let legacy = legacy_github_path()?;
        if legacy.exists() {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Legacy {
                #[serde(default)]
                client_id: String,
                #[serde(default)]
                token: String,
                #[serde(default)]
                login: String,
                #[serde(default)]
                name: String,
                #[serde(default)]
                avatar_url: String,
            }
            if let Ok(text) = std::fs::read_to_string(&legacy) {
                if let Ok(old) = serde_json::from_str::<Legacy>(&text) {
                    AuthStore {
                        github: ProviderStore {
                            client_id: old.client_id,
                            client_secret: String::new(),
                            token: old.token,
                            login: old.login,
                            name: old.name,
                            avatar_url: old.avatar_url,
                            accounts: Vec::new(),
                            active_id: String::new(),
                        },
                        gitee: ProviderStore::default(),
                    }
                } else {
                    AuthStore::default()
                }
            } else {
                AuthStore::default()
            }
        } else {
            AuthStore::default()
        }
    };
    normalize_store(&mut store);
    Ok(store)
}

fn save_store(store: &AuthStore) -> Result<(), GitError> {
    let path = auth_store_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| GitError::Io {
            path: parent.display().to_string(),
            message: e.to_string(),
        })?;
    }
    let text = serde_json::to_string_pretty(store)
        .map_err(|e| GitError::InvalidInput(e.to_string()))?;
    std::fs::write(&path, text).map_err(|e| GitError::Io {
        path: path.display().to_string(),
        message: e.to_string(),
    })?;
    Ok(())
}

fn provider_slot(store: &AuthStore, provider: Provider) -> &ProviderStore {
    match provider {
        Provider::Github => &store.github,
        Provider::Gitee => &store.gitee,
    }
}

fn provider_slot_mut(store: &mut AuthStore, provider: Provider) -> &mut ProviderStore {
    match provider {
        Provider::Github => &mut store.github,
        Provider::Gitee => &mut store.gitee,
    }
}

fn active_account(slot: &ProviderStore) -> Option<&AccountEntry> {
    if slot.active_id.is_empty() {
        return slot.accounts.first();
    }
    slot.accounts
        .iter()
        .find(|a| a.id == slot.active_id)
        .or_else(|| slot.accounts.first())
}

fn active_account_mut(slot: &mut ProviderStore) -> Option<&mut AccountEntry> {
    let id = if slot.active_id.is_empty() {
        slot.accounts.first().map(|a| a.id.clone())
    } else if slot.accounts.iter().any(|a| a.id == slot.active_id) {
        Some(slot.active_id.clone())
    } else {
        slot.accounts.first().map(|a| a.id.clone())
    }?;
    slot.accounts.iter_mut().find(|a| a.id == id)
}

fn effective_client_id(provider: Provider, slot: &ProviderStore) -> String {
    let saved = slot.client_id.trim();
    if !saved.is_empty() {
        return saved.to_string();
    }
    builtin_client_id(provider).trim().to_string()
}

fn effective_client_secret(provider: Provider, slot: &ProviderStore) -> String {
    let saved = slot.client_secret.trim();
    if !saved.is_empty() {
        return saved.to_string();
    }
    builtin_client_secret(provider).trim().to_string()
}

fn using_builtin(provider: Provider, slot: &ProviderStore) -> bool {
    slot.client_id.trim().is_empty() && !builtin_client_id(provider).trim().is_empty()
}

fn status_of_with_flag(
    provider: Provider,
    slot: &ProviderStore,
    session_expired: bool,
) -> ProviderStatus {
    let active = active_account(slot);
    let logged_in = active
        .map(|a| !a.token.is_empty() && !a.login.is_empty())
        .unwrap_or(false);
    let cid = effective_client_id(provider, slot);
    let csec = effective_client_secret(provider, slot);
    let accounts = slot
        .accounts
        .iter()
        .map(|a| AccountSummary {
            id: a.id.clone(),
            login: a.login.clone(),
            name: a.name.clone(),
            avatar_url: a.avatar_url.clone(),
            active: active.map(|x| x.id == a.id).unwrap_or(false),
        })
        .collect();
    ProviderStatus {
        provider: provider.as_str().to_string(),
        logged_in,
        login: active.map(|a| a.login.clone()).unwrap_or_default(),
        name: active.map(|a| a.name.clone()).unwrap_or_default(),
        avatar_url: active.map(|a| a.avatar_url.clone()).unwrap_or_default(),
        client_id: if slot.client_id.trim().is_empty() {
            String::new()
        } else {
            slot.client_id.clone()
        },
        has_client_id: !cid.is_empty(),
        has_client_secret: !csec.is_empty(),
        session_expired,
        accounts,
        oauth_ready: !cid.is_empty(),
        using_builtin_oauth: using_builtin(provider, slot),
    }
}

fn status_of(provider: Provider, slot: &ProviderStore) -> ProviderStatus {
    status_of_with_flag(provider, slot, false)
}

fn http_agent() -> ureq::Agent {
    let mut builder = ureq::AgentBuilder::new().timeout(Duration::from_secs(45));
    if let Some(proxy) = local_proxy() {
        emit_terminal("info", &format!("登录请求使用代理 {proxy}"));
        if let Ok(p) = ureq::Proxy::new(&proxy) {
            builder = builder.proxy(p);
        }
    }
    builder.build()
}

fn classify_ureq_error(err: &ureq::Error) -> ApiFailKind {
    match err {
        ureq::Error::Status(401 | 403, _) => ApiFailKind::Auth,
        ureq::Error::Status(_, _) => ApiFailKind::Other,
        ureq::Error::Transport(_) => ApiFailKind::Network,
    }
}

fn fetch_user(provider: Provider, token: &str) -> Result<ApiUser, GitError> {
    fetch_user_detailed(provider, token).map(|(u, _)| u)
}

fn fetch_user_detailed(
    provider: Provider,
    token: &str,
) -> Result<(ApiUser, Option<ApiFailKind>), GitError> {
    let agent = http_agent();
    let response = match provider {
        Provider::Github => agent
            .get("https://api.github.com/user")
            .set("Accept", "application/vnd.github+json")
            .set("Authorization", &format!("Bearer {token}"))
            .set("User-Agent", "qingzhi")
            .set("X-GitHub-Api-Version", "2022-11-28")
            .call(),
        Provider::Gitee => agent
            .get("https://gitee.com/api/v5/user")
            .set("User-Agent", "qingzhi")
            .query("access_token", token)
            .call(),
    };

    match response {
        Ok(resp) => {
            if !(200..300).contains(&resp.status()) {
                let kind = if matches!(resp.status(), 401 | 403) {
                    ApiFailKind::Auth
                } else {
                    ApiFailKind::Other
                };
                let tag = match kind {
                    ApiFailKind::Auth => "auth",
                    ApiFailKind::Network => "network",
                    ApiFailKind::Other => "other",
                };
                return Err(GitError::InvalidInput(format!(
                    "{} 登录无效（HTTP {}）|kind={tag}",
                    provider.label(),
                    resp.status(),
                )));
            }
            let user = resp
                .into_json::<ApiUser>()
                .map_err(|e| GitError::InvalidInput(format!("解析用户信息失败：{e}")))?;
            Ok((user, None))
        }
        Err(e) => {
            let kind = classify_ureq_error(&e);
            let tag = match kind {
                ApiFailKind::Auth => "auth",
                ApiFailKind::Network => "network",
                ApiFailKind::Other => "other",
            };
            Err(GitError::InvalidInput(format!(
                "{} API 请求失败：{e}|kind={tag}",
                provider.label()
            )))
        }
    }
}

fn fail_kind_from_msg(msg: &str) -> ApiFailKind {
    if msg.contains("|kind=network")
        || msg.contains("timed out")
        || msg.contains("Timeout")
        || msg.contains("Connection")
        || msg.contains("connection")
        || msg.contains("dns")
        || msg.contains("Failed to connect")
        || msg.contains("proxy")
    {
        ApiFailKind::Network
    } else if msg.contains("|kind=auth")
        || msg.contains("HTTP 401")
        || msg.contains("HTTP 403")
        || msg.contains("登录无效")
    {
        ApiFailKind::Auth
    } else {
        ApiFailKind::Other
    }
}

fn strip_kind_tag(msg: &str) -> String {
    msg.split("|kind=").next().unwrap_or(msg).trim().to_string()
}

fn credential_payload(host: &str, login: &str, token: Option<&str>) -> String {
    let mut body = format!("protocol=https\nhost={host}\nusername={login}\n");
    if let Some(token) = token {
        body.push_str(&format!("password={token}\n"));
    }
    body.push('\n');
    body
}

fn run_credential(git: &GitBinary, action: &str, payload: &str) -> Result<(), GitError> {
    let mut child = Command::new(&git.path)
        .args(["credential", action])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| GitError::Io {
            path: git.path.display().to_string(),
            message: e.to_string(),
        })?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(payload.as_bytes());
    }
    let output = child.wait_with_output().map_err(|e| GitError::Io {
        path: git.path.display().to_string(),
        message: e.to_string(),
    })?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(GitError::InvalidInput(format!(
            "git credential {action} 失败：{err}"
        )));
    }
    Ok(())
}

fn approve_credential(provider: Provider, login: &str, token: &str) -> Result<(), GitError> {
    let git = ensure_git()?;
    run_credential(
        &git,
        "approve",
        &credential_payload(provider.host(), login, Some(token)),
    )
}

fn reject_credential(provider: Provider, login: &str) -> Result<(), GitError> {
    let git = ensure_git()?;
    run_credential(
        &git,
        "reject",
        &credential_payload(provider.host(), login, None),
    )
}

/// Best-effort clear of system credentials. Must not hang the logout UI.
fn clear_system_credentials(provider: Provider, login: &str) {
    let login = login.trim();
    if login.is_empty() {
        return;
    }
    // Prefer GCM account removal for GitHub (this is what keeps "Select an account").
    if provider == Provider::Github {
        let git = match ensure_git() {
            Ok(g) => g,
            Err(_) => return,
        };
        let _ = Command::new(&git.path)
            .args(["credential-manager", "github", "logout", login, "--no-ui"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    // Also erase generic host / user@host entries (ignore failures / hangs via short wait).
    let targets = [
        format!("git:https://{}", provider.host()),
        format!("git:https://{login}@{}", provider.host()),
    ];
    for target in targets {
        let _ = Command::new("cmdkey")
            .args(["/delete", &target])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    // Avoid `git credential reject` here — GCM may hang the UI thread.
}

fn persist_session(
    provider: Provider,
    token: &str,
    user: &ApiUser,
    refresh_token: Option<&str>,
    expires_in: Option<u64>,
) -> Result<ProviderStatus, GitError> {
    let mut store = load_store()?;
    {
        let slot = provider_slot_mut(&mut store, provider);
        let expires_at = expires_in
            .filter(|s| *s > 0)
            .map(|s| now_secs().saturating_add(s.saturating_sub(60)))
            .unwrap_or(0);
        if let Some(existing) = slot
            .accounts
            .iter_mut()
            .find(|a| a.login.eq_ignore_ascii_case(&user.login))
        {
            existing.token = token.to_string();
            existing.name = user.name.clone().unwrap_or_default();
            existing.avatar_url = user.avatar_url.clone();
            if let Some(rt) = refresh_token.filter(|t| !t.is_empty()) {
                existing.refresh_token = rt.to_string();
            }
            if expires_at > 0 {
                existing.token_expires_at = expires_at;
            }
            slot.active_id = existing.id.clone();
        } else {
            let id = new_account_id();
            slot.accounts.push(AccountEntry {
                id: id.clone(),
                login: user.login.clone(),
                name: user.name.clone().unwrap_or_default(),
                avatar_url: user.avatar_url.clone(),
                token: token.to_string(),
                refresh_token: refresh_token.unwrap_or("").to_string(),
                token_expires_at: expires_at,
            });
            slot.active_id = id;
        }
        migrate_provider(slot);
    }
    save_store(&store)?;
    approve_credential(provider, &user.login, token)?;
    emit_terminal(
        "info",
        &format!(
            "已登录 {}：{}，凭据已写入 git credential（{}）",
            provider.label(),
            user.login,
            provider.host()
        ),
    );
    Ok(status_of(provider, provider_slot(&store, provider)))
}

fn try_refresh_access_token(
    provider: Provider,
    slot: &ProviderStore,
    account: &AccountEntry,
) -> Result<Option<(String, Option<String>, Option<u64>)>, GitError> {
    let refresh = account.refresh_token.trim();
    if refresh.is_empty() {
        return Ok(None);
    }
    let client_id = effective_client_id(provider, slot);
    let client_secret = effective_client_secret(provider, slot);
    if client_id.is_empty() {
        return Ok(None);
    }
    let agent = http_agent();
    let response = match provider {
        Provider::Github => {
            // GitHub OAuth Apps rarely issue refresh tokens; keep a best-effort path.
            if client_secret.is_empty() {
                return Ok(None);
            }
            agent
                .post("https://github.com/login/oauth/access_token")
                .set("Accept", "application/json")
                .set("User-Agent", "qingzhi")
                .send_form(&[
                    ("client_id", client_id.as_str()),
                    ("client_secret", client_secret.as_str()),
                    ("grant_type", "refresh_token"),
                    ("refresh_token", refresh),
                ])
        }
        Provider::Gitee => agent
            .post("https://gitee.com/oauth/token")
            .set("User-Agent", "qingzhi")
            .send_form(&[
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh),
                ("client_id", client_id.as_str()),
                ("client_secret", client_secret.as_str()),
            ]),
    }
    .map_err(|e| GitError::InvalidInput(format!("刷新 Token 失败：{e}")))?;

    let body = response
        .into_json::<TokenResponse>()
        .map_err(|e| GitError::InvalidInput(format!("解析刷新结果失败：{e}")))?;
    if let Some(err) = body.error {
        let desc = body.error_description.unwrap_or(err);
        return Err(GitError::InvalidInput(format!("刷新 Token 失败：{desc}")));
    }
    let access = match body.access_token.filter(|t| !t.is_empty()) {
        Some(t) => t,
        None => return Ok(None),
    };
    Ok(Some((access, body.refresh_token, body.expires_in)))
}

fn remove_account_tokens(
    _provider: Provider,
    slot: &mut ProviderStore,
    account_id: &str,
) -> Option<String> {
    if let Some(pos) = slot.accounts.iter().position(|a| a.id == account_id) {
        let login = slot.accounts[pos].login.clone();
        slot.accounts.remove(pos);
        if slot.active_id == account_id {
            slot.active_id = slot
                .accounts
                .first()
                .map(|a| a.id.clone())
                .unwrap_or_default();
        }
        migrate_provider(slot);
        if login.is_empty() {
            None
        } else {
            Some(login)
        }
    } else {
        None
    }
}

fn refresh_provider(provider: Provider) -> Result<ProviderStatus, GitError> {
    let mut store = load_store()?;
    let active = match active_account(provider_slot(&store, provider)).cloned() {
        Some(a) if !a.token.is_empty() => a,
        _ => return Ok(status_of(provider, provider_slot(&store, provider))),
    };

    // Proactively refresh if we know expiry is near.
    if active.token_expires_at > 0 && now_secs() + 120 >= active.token_expires_at {
        if let Ok(Some((token, new_rt, expires))) =
            try_refresh_access_token(provider, provider_slot(&store, provider), &active)
        {
            let user = fetch_user(provider, &token)?;
            return persist_session(
                provider,
                &token,
                &user,
                new_rt.as_deref().or(Some(active.refresh_token.as_str())),
                expires,
            );
        }
    }

    match fetch_user_detailed(provider, &active.token) {
        Ok((user, _)) => {
            {
                let slot = provider_slot_mut(&mut store, provider);
                if let Some(acc) = active_account_mut(slot) {
                    acc.login = user.login;
                    acc.name = user.name.unwrap_or_default();
                    acc.avatar_url = user.avatar_url;
                }
                migrate_provider(slot);
            }
            save_store(&store)?;
            // Soft: re-inject credentials while validating.
            let _ = approve_credential(provider, &active.login, &active.token);
            Ok(status_of(provider, provider_slot(&store, provider)))
        }
        Err(err) => {
            let msg = err.to_string();
            let kind = fail_kind_from_msg(&msg);
            match kind {
                ApiFailKind::Network | ApiFailKind::Other => {
                    emit_terminal(
                        "info",
                        &format!(
                            "{} 健康检查未确认（网络/临时错误），保留本地登录：{}",
                            provider.label(),
                            strip_kind_tag(&msg)
                        ),
                    );
                    // Still try to keep system credentials in sync.
                    let _ = approve_credential(provider, &active.login, &active.token);
                    Ok(status_of(provider, provider_slot(&store, provider)))
                }
                ApiFailKind::Auth => {
                    // Try OAuth refresh before clearing.
                    match try_refresh_access_token(
                        provider,
                        provider_slot(&store, provider),
                        &active,
                    ) {
                        Ok(Some((token, new_rt, expires))) => {
                            match fetch_user(provider, &token) {
                                Ok(user) => {
                                    return persist_session(
                                        provider,
                                        &token,
                                        &user,
                                        new_rt.as_deref(),
                                        expires,
                                    );
                                }
                                Err(e2) if matches!(fail_kind_from_msg(&e2.to_string()), ApiFailKind::Network) => {
                                    emit_terminal(
                                        "info",
                                        &format!(
                                            "{} Token 已刷新但校验遇网络问题，保留会话",
                                            provider.label()
                                        ),
                                    );
                                    {
                                        let slot = provider_slot_mut(&mut store, provider);
                                        if let Some(acc) = active_account_mut(slot) {
                                            acc.token = token.clone();
                                            if let Some(rt) = new_rt {
                                                acc.refresh_token = rt;
                                            }
                                            if let Some(exp) = expires {
                                                acc.token_expires_at =
                                                    now_secs().saturating_add(exp.saturating_sub(60));
                                            }
                                        }
                                        migrate_provider(slot);
                                    }
                                    save_store(&store)?;
                                    let login = active.login.clone();
                                    let _ = approve_credential(provider, &login, &token);
                                    return Ok(status_of(
                                        provider,
                                        provider_slot(&store, provider),
                                    ));
                                }
                                Err(_) => {}
                            }
                        }
                        _ => {}
                    }

                    emit_terminal(
                        "err",
                        &format!(
                            "{} 会话失效：{}",
                            provider.label(),
                            strip_kind_tag(&msg)
                        ),
                    );
                    let cleared_login = {
                        let slot = provider_slot_mut(&mut store, provider);
                        remove_account_tokens(provider, slot, &active.id)
                    };
                    save_store(&store)?;
                    if let Some(login) = cleared_login {
                        clear_system_credentials(provider, &login);
                    }
                    Ok(status_of_with_flag(
                        provider,
                        provider_slot(&store, provider),
                        true,
                    ))
                }
            }
        }
    }
}

pub fn auth_accounts() -> Result<AuthAccounts, GitError> {
    Ok(AuthAccounts {
        github: refresh_provider(Provider::Github)?,
        gitee: refresh_provider(Provider::Gitee)?,
    })
}

/// Re-write active tokens into git credential (startup / auth-fail retry).
pub fn auth_ensure_credentials() -> Result<AuthAccounts, GitError> {
    let store = load_store()?;
    for provider in [Provider::Github, Provider::Gitee] {
        if let Some(acc) = active_account(provider_slot(&store, provider)) {
            if !acc.token.is_empty() && !acc.login.is_empty() {
                match approve_credential(provider, &acc.login, &acc.token) {
                    Ok(()) => emit_terminal(
                        "info",
                        &format!(
                            "已同步 {} 凭据到 git credential（{}）",
                            provider.label(),
                            acc.login
                        ),
                    ),
                    Err(e) => emit_terminal(
                        "err",
                        &format!("同步 {} 凭据失败：{e}", provider.label()),
                    ),
                }
            }
        }
    }
    Ok(AuthAccounts {
        github: status_of(Provider::Github, provider_slot(&store, Provider::Github)),
        gitee: status_of(Provider::Gitee, provider_slot(&store, Provider::Gitee)),
    })
}

pub fn auth_switch_account(provider_raw: &str, account_id: &str) -> Result<ProviderStatus, GitError> {
    let provider = Provider::parse(provider_raw)?;
    let mut store = load_store()?;
    {
        let slot = provider_slot_mut(&mut store, provider);
        let acc = slot
            .accounts
            .iter()
            .find(|a| a.id == account_id)
            .ok_or_else(|| GitError::InvalidInput("找不到该账号".to_string()))?
            .clone();
        slot.active_id = acc.id.clone();
        migrate_provider(slot);
        approve_credential(provider, &acc.login, &acc.token)?;
        emit_terminal(
            "info",
            &format!("已切换到 {} 账号：{}", provider.label(), acc.login),
        );
    }
    save_store(&store)?;
    Ok(status_of(provider, provider_slot(&store, provider)))
}

pub fn auth_save_config(
    provider_raw: &str,
    client_id: &str,
    client_secret: &str,
) -> Result<ProviderStatus, GitError> {
    let provider = Provider::parse(provider_raw)?;
    let mut store = load_store()?;
    {
        let slot = provider_slot_mut(&mut store, provider);
        slot.client_id = client_id.trim().to_string();
        slot.client_secret = client_secret.trim().to_string();
    }
    save_store(&store)?;
    emit_terminal(
        "info",
        &format!("已保存 {} OAuth 配置", provider.label()),
    );
    Ok(status_of(provider, provider_slot(&store, provider)))
}

fn url_encode(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len() * 2);
    for b in raw.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn random_state() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("lg{nanos:x}")
}

fn parse_query(query: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for pair in query.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            map.insert(
                k.to_string(),
                urlencoding_decode(v).unwrap_or_else(|| v.to_string()),
            );
        }
    }
    map
}

fn urlencoding_decode(raw: &str) -> Option<String> {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok()?;
                out.push(u8::from_str_radix(hex, 16).ok()?);
                i += 3;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

fn wait_for_oauth_code(listener: &TcpListener, expected_state: &str) -> Result<String, GitError> {
    use std::io::ErrorKind;
    use std::time::Instant;

    listener
        .set_nonblocking(true)
        .map_err(|e| GitError::InvalidInput(e.to_string()))?;

    let deadline = Instant::now() + Duration::from_secs(180);
    let (mut stream, _) = loop {
        if Instant::now() >= deadline {
            return Err(GitError::InvalidInput(
                "等待浏览器授权超时（3 分钟）".to_string(),
            ));
        }
        match listener.accept() {
            Ok(conn) => break conn,
            Err(err) if err.kind() == ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(200));
            }
            Err(err) => {
                return Err(GitError::InvalidInput(format!(
                    "等待浏览器回调失败：{err}"
                )));
            }
        }
    };

    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let mut buf = [0_u8; 4096];
    let n = stream
        .read(&mut buf)
        .map_err(|e| GitError::InvalidInput(format!("读取回调失败：{e}")))?;
    let req = String::from_utf8_lossy(&buf[..n]);
    let first_line = req.lines().next().unwrap_or("");
    let path = first_line.split_whitespace().nth(1).unwrap_or("");
    let query = path.split_once('?').map(|(_, q)| q).unwrap_or("");
    let params = parse_query(query);

    let body = if params.get("error").is_some() {
        let desc = params
            .get("error_description")
            .cloned()
            .or_else(|| params.get("error").cloned())
            .unwrap_or_else(|| "授权被拒绝".to_string());
        format!(
            "<html><body style='font-family:sans-serif;padding:2rem'><h2>登录失败</h2><p>{desc}</p><p>可以关闭此窗口。</p></body></html>"
        )
    } else {
        "<html><body style='font-family:sans-serif;padding:2rem'><h2>登录成功</h2><p>可以关闭此窗口，返回青枝。</p></body></html>"
            .to_string()
    };
    let resp = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.write_all(resp.as_bytes());

    if let Some(err) = params.get("error") {
        let desc = params
            .get("error_description")
            .cloned()
            .unwrap_or_else(|| err.clone());
        return Err(GitError::InvalidInput(format!("授权失败：{desc}")));
    }
    let state = params.get("state").cloned().unwrap_or_default();
    if state != expected_state {
        return Err(GitError::InvalidInput("OAuth state 不匹配，请重试".to_string()));
    }
    params
        .get("code")
        .cloned()
        .filter(|c| !c.is_empty())
        .ok_or_else(|| GitError::InvalidInput("回调缺少授权码".to_string()))
}

struct ExchangedToken {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
}

fn exchange_code(
    provider: Provider,
    code: &str,
    redirect_uri: &str,
    client_id: &str,
    client_secret: &str,
) -> Result<ExchangedToken, GitError> {
    let agent = http_agent();
    let body = match provider {
        Provider::Github => {
            let response = agent
                .post("https://github.com/login/oauth/access_token")
                .set("Accept", "application/json")
                .set("User-Agent", "qingzhi")
                .send_form(&[
                    ("client_id", client_id),
                    ("client_secret", client_secret),
                    ("code", code),
                    ("redirect_uri", redirect_uri),
                ])
                .map_err(|e| GitError::InvalidInput(format!("换取 GitHub Token 失败：{e}")))?;
            response
                .into_json::<TokenResponse>()
                .map_err(|e| GitError::InvalidInput(format!("解析 GitHub Token 失败：{e}")))?
        }
        Provider::Gitee => {
            let response = agent
                .post("https://gitee.com/oauth/token")
                .set("User-Agent", "qingzhi")
                .send_form(&[
                    ("grant_type", "authorization_code"),
                    ("code", code),
                    ("client_id", client_id),
                    ("client_secret", client_secret),
                    ("redirect_uri", redirect_uri),
                ])
                .map_err(|e| GitError::InvalidInput(format!("换取 Gitee Token 失败：{e}")))?;
            response
                .into_json::<TokenResponse>()
                .map_err(|e| GitError::InvalidInput(format!("解析 Gitee Token 失败：{e}")))?
        }
    };
    if let Some(err) = body.error {
        let desc = body.error_description.unwrap_or(err);
        return Err(GitError::InvalidInput(format!(
            "{} Token 错误：{desc}",
            provider.label()
        )));
    }
    let access_token = body
        .access_token
        .filter(|t| !t.is_empty())
        .ok_or_else(|| {
            GitError::InvalidInput(format!("{} 未返回 access_token", provider.label()))
        })?;
    Ok(ExchangedToken {
        access_token,
        refresh_token: body.refresh_token.filter(|t| !t.is_empty()),
        expires_in: body.expires_in,
    })
}

pub fn auth_browser_begin(provider_raw: &str) -> Result<OauthBegin, GitError> {
    let provider = Provider::parse(provider_raw)?;
    let store = load_store()?;
    let slot = provider_slot(&store, provider);
    let client_id = effective_client_id(provider, slot);
    let client_secret = effective_client_secret(provider, slot);
    if client_id.is_empty() || client_secret.is_empty() {
        return Err(GitError::InvalidInput(format!(
            "网站登录需要 {} 的 Client ID 和 Client Secret（可在「配置 OAuth」中填写一次，或使用设备码登录）",
            provider.label()
        )));
    }

    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| GitError::InvalidInput(format!("无法启动本地回调：{e}")))?;
    let port = listener
        .local_addr()
        .map_err(|e| GitError::InvalidInput(e.to_string()))?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");
    let state = random_state();

    let auth_url = match provider {
        Provider::Github => format!(
            "https://github.com/login/oauth/authorize?client_id={}&redirect_uri={}&scope={}&state={}",
            url_encode(&client_id),
            url_encode(&redirect_uri),
            url_encode("repo"),
            url_encode(&state),
        ),
        Provider::Gitee => format!(
            "https://gitee.com/oauth/authorize?client_id={}&redirect_uri={}&response_type=code&scope={}&state={}",
            url_encode(&client_id),
            url_encode(&redirect_uri),
            url_encode("user_info projects"),
            url_encode(&state),
        ),
    };

    let mut guard = PENDING
        .lock()
        .map_err(|_| GitError::InvalidInput("登录状态锁失败".to_string()))?;
    *guard = Some(PendingOauth {
        provider,
        expected_state: state.clone(),
        redirect_uri: redirect_uri.clone(),
        listener,
    });

    emit_terminal(
        "info",
        &format!(
            "请在浏览器完成 {} 授权（回调 {}）",
            provider.label(),
            redirect_uri
        ),
    );

    Ok(OauthBegin {
        provider: provider.as_str().to_string(),
        auth_url,
        redirect_uri,
        state,
    })
}

pub fn auth_browser_finish(provider_raw: &str) -> Result<ProviderStatus, GitError> {
    let provider = Provider::parse(provider_raw)?;
    let pending = {
        let mut guard = PENDING
            .lock()
            .map_err(|_| GitError::InvalidInput("登录状态锁失败".to_string()))?;
        guard.take()
    }
    .ok_or_else(|| GitError::InvalidInput("没有进行中的网站登录，请先点击网站登录".to_string()))?;

    if pending.provider != provider {
        return Err(GitError::InvalidInput("登录平台与进行中的授权不一致".to_string()));
    }

    let code = wait_for_oauth_code(&pending.listener, &pending.expected_state)?;
    let store = load_store()?;
    let slot = provider_slot(&store, provider);
    let exchanged = exchange_code(
        provider,
        &code,
        &pending.redirect_uri,
        &effective_client_id(provider, slot),
        &effective_client_secret(provider, slot),
    )?;
    let user = fetch_user(provider, &exchanged.access_token)?;
    persist_session(
        provider,
        &exchanged.access_token,
        &user,
        exchanged.refresh_token.as_deref(),
        exchanged.expires_in,
    )
}

pub fn auth_device_start() -> Result<GithubDeviceStart, GitError> {
    let store = load_store()?;
    let client_id = effective_client_id(Provider::Github, &store.github);
    if client_id.is_empty() {
        return Err(GitError::InvalidInput(
            "设备码登录需要一次填写 GitHub Client ID（在「配置 OAuth」中保存即可，之后可复用）".to_string(),
        ));
    }
    emit_terminal("info", "正在申请 GitHub 设备码…");
    let agent = http_agent();
    let response = agent
        .post("https://github.com/login/device/code")
        .set("Accept", "application/json")
        .set("User-Agent", "qingzhi")
        .send_form(&[("client_id", client_id.as_str()), ("scope", "repo")])
        .map_err(|e| GitError::InvalidInput(format!("申请设备码失败：{e}")))?;
    if !(200..300).contains(&response.status()) {
        return Err(GitError::InvalidInput(format!(
            "申请设备码失败（HTTP {}）",
            response.status()
        )));
    }
    let body = response
        .into_json::<DeviceCodeResponse>()
        .map_err(|e| GitError::InvalidInput(format!("解析设备码失败：{e}")))?;
    Ok(GithubDeviceStart {
        user_code: body.user_code,
        verification_uri: body.verification_uri,
        device_code: body.device_code,
        interval: body.interval.max(5),
        expires_in: body.expires_in,
    })
}

pub fn auth_device_poll(device_code: &str) -> Result<GithubDevicePollResult, GitError> {
    let store = load_store()?;
    let client_id = effective_client_id(Provider::Github, &store.github);
    if client_id.is_empty() {
        return Err(GitError::InvalidInput("缺少 GitHub Client ID".to_string()));
    }
    let agent = http_agent();
    let response = agent
        .post("https://github.com/login/oauth/access_token")
        .set("Accept", "application/json")
        .set("User-Agent", "qingzhi")
        .send_form(&[
            ("client_id", client_id.as_str()),
            ("device_code", device_code.trim()),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ])
        .map_err(|e| GitError::InvalidInput(format!("轮询登录失败：{e}")))?;
    let body = response
        .into_json::<TokenResponse>()
        .map_err(|e| GitError::InvalidInput(format!("解析登录结果失败：{e}")))?;

    if let Some(token) = body.access_token.filter(|t| !t.is_empty()) {
        let user = fetch_user(Provider::Github, &token)?;
        let account = persist_session(
            Provider::Github,
            &token,
            &user,
            body.refresh_token.as_deref(),
            body.expires_in,
        )?;
        return Ok(GithubDevicePollResult {
            status: "success".to_string(),
            message: format!("已登录为 {}", account.login),
            account: Some(account),
        });
    }

    let error = body.error.unwrap_or_else(|| "unknown".to_string());
    let message = body.error_description.unwrap_or_else(|| error.clone());
    let status = match error.as_str() {
        "authorization_pending" => "pending",
        "slow_down" => "slow_down",
        "expired_token" => "expired",
        "access_denied" => "denied",
        other => other,
    };
    if matches!(status, "pending" | "slow_down") {
        Ok(GithubDevicePollResult {
            status: status.to_string(),
            message,
            account: None,
        })
    } else {
        Err(GitError::InvalidInput(format!("GitHub 登录失败：{message}")))
    }
}

/// Open Git Credential Manager / fill stored credentials for GitHub or Gitee.
pub fn auth_manager_login(provider_raw: &str) -> Result<ProviderStatus, GitError> {
    let provider = Provider::parse(provider_raw)?;
    let git = ensure_git()?;
    match provider {
        Provider::Github => {
            emit_terminal("info", "正在打开 Git 凭据管理器登录 GitHub…");
            let output = Command::new(&git.path)
                .args(["credential-manager", "github", "login"])
                .output()
                .map_err(|e| {
                    GitError::InvalidInput(format!(
                        "无法启动 Git 凭据管理器：{e}。请确认已安装完整版 Git for Windows。"
                    ))
                })?;
            if !output.status.success() {
                let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
                let detail = if err.is_empty() {
                    format!("退出码 {}", output.status.code().unwrap_or(1))
                } else {
                    err
                };
                return Err(GitError::InvalidInput(format!(
                    "Git 凭据管理器登录未完成：{detail}"
                )));
            }
        }
        Provider::Gitee => {
            emit_terminal(
                "info",
                "正在通过 Git 凭据管理器读取 Gitee 凭据（若未保存过，会弹出输入框；密码处填私人令牌）…",
            );
        }
    }

    let filled = fill_host_credential(&git, provider.host())?;
    let token = filled
        .password
        .filter(|p| !p.is_empty())
        .ok_or_else(|| {
            GitError::InvalidInput(format!(
                "凭据管理器没有返回 {} 凭据。可改用 Token 或浏览器登录。",
                provider.label()
            ))
        })?;
    let user = fetch_user(provider, &token)?;
    persist_session(provider, &token, &user, None, None)
}

struct FilledCredential {
    password: Option<String>,
}

fn fill_host_credential(git: &GitBinary, host: &str) -> Result<FilledCredential, GitError> {
    let mut child = Command::new(&git.path)
        .args(["credential", "fill"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| GitError::Io {
            path: git.path.display().to_string(),
            message: e.to_string(),
        })?;
    if let Some(mut stdin) = child.stdin.take() {
        let payload = format!("protocol=https\nhost={host}\n\n");
        let _ = stdin.write_all(payload.as_bytes());
    }
    let output = child.wait_with_output().map_err(|e| GitError::Io {
        path: git.path.display().to_string(),
        message: e.to_string(),
    })?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(GitError::InvalidInput(format!(
            "读取 {host} 凭据失败：{err}"
        )));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut password = None;
    for line in text.lines() {
        if let Some(value) = line.strip_prefix("password=") {
            password = Some(value.to_string());
        }
    }
    Ok(FilledCredential { password })
}

pub fn auth_login_token(provider_raw: &str, token: &str) -> Result<ProviderStatus, GitError> {
    let provider = Provider::parse(provider_raw)?;
    let token = token.trim();
    if token.is_empty() {
        return Err(GitError::InvalidInput("请填写 Access Token".to_string()));
    }
    emit_terminal(
        "info",
        &format!("正在用 Token 验证 {} 账号…", provider.label()),
    );
    let user = fetch_user(provider, token)?;
    persist_session(provider, token, &user, None, None)
}

pub fn auth_logout(provider_raw: &str) -> Result<ProviderStatus, GitError> {
    let provider = Provider::parse(provider_raw)?;
    let mut store = load_store()?;
    let mut logins_to_clear: Vec<String> = Vec::new();
    {
        let slot = provider_slot_mut(&mut store, provider);
        // Always clear every saved account for this provider so「退出」真正退出。
        for acc in slot.accounts.drain(..) {
            if !acc.login.trim().is_empty() {
                logins_to_clear.push(acc.login);
            }
        }
        slot.active_id.clear();
        slot.token.clear();
        slot.login.clear();
        slot.name.clear();
        slot.avatar_url.clear();
        migrate_provider(slot);
    }
    // Persist local session first — never block logout on credential helpers.
    save_store(&store)?;
    for login in &logins_to_clear {
        clear_system_credentials(provider, login);
    }
    if provider == Provider::Github {
        let _ = Command::new("cmdkey")
            .args(["/delete", "git:https://github.com"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    emit_terminal("info", &format!("已退出 {} 登录", provider.label()));
    Ok(status_of(provider, provider_slot(&store, provider)))
}

fn home_dir() -> Result<PathBuf, GitError> {
    if let Ok(p) = std::env::var("USERPROFILE") {
        return Ok(PathBuf::from(p));
    }
    if let Ok(p) = std::env::var("HOME") {
        return Ok(PathBuf::from(p));
    }
    Err(GitError::InvalidInput("找不到用户主目录".to_string()))
}

fn ssh_dir() -> Result<PathBuf, GitError> {
    Ok(home_dir()?.join(".ssh"))
}

fn fingerprint_of(pub_key: &str) -> String {
    // Lightweight display fingerprint (not OpenSSH md5/sha256).
    let trimmed = pub_key.trim();
    let parts: Vec<&str> = trimmed.split_whitespace().collect();
    let body = parts.get(1).copied().unwrap_or(trimmed);
    let take = body.chars().take(20).collect::<String>();
    let tail = body
        .chars()
        .rev()
        .take(8)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    format!("{take}…{tail}")
}

fn read_pub_key(path: &Path) -> Option<SshKeyInfo> {
    let text = std::fs::read_to_string(path).ok()?;
    let line = text
        .lines()
        .find(|l| {
            let t = l.trim();
            t.starts_with("ssh-") || t.starts_with("ecdsa-")
        })?
        .trim()
        .to_string();
    Some(SshKeyInfo {
        path: path.display().to_string(),
        public_key: line.clone(),
        fingerprint: fingerprint_of(&line),
    })
}

pub fn auth_ssh_status() -> Result<SshStatus, GitError> {
    let dir = ssh_dir()?;
    let mut keys = Vec::new();
    if dir.is_dir() {
        for name in ["id_ed25519.pub", "id_rsa.pub", "id_ecdsa.pub"] {
            let path = dir.join(name);
            if path.exists() {
                if let Some(info) = read_pub_key(&path) {
                    keys.push(info);
                }
            }
        }
    }
    let has_agent = Command::new("ssh-add")
        .arg("-l")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    let tip = if keys.is_empty() {
        "尚未检测到 SSH 公钥。可生成 ed25519 密钥，再把公钥添加到 GitHub。".to_string()
    } else {
        "已有本地公钥。复制后到 GitHub → Settings → SSH keys 添加一次，之后可用 git@ 地址推拉。".to_string()
    };
    Ok(SshStatus {
        ssh_dir: dir.display().to_string(),
        keys,
        has_agent,
        tip,
    })
}

pub fn auth_ssh_generate() -> Result<SshStatus, GitError> {
    let dir = ssh_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| GitError::Io {
        path: dir.display().to_string(),
        message: e.to_string(),
    })?;
    let key_path = dir.join("id_ed25519");
    if key_path.exists() || dir.join("id_ed25519.pub").exists() {
        return Err(GitError::InvalidInput(
            "已存在 id_ed25519，未覆盖。可直接复制公钥到 GitHub。".to_string(),
        ));
    }
    let comment = format!("qingzhi@{}", whoami_simple());
    emit_terminal("info", "正在生成 ed25519 SSH 密钥…");
    let output = Command::new("ssh-keygen")
        .args([
            "-t",
            "ed25519",
            "-f",
            &key_path.display().to_string(),
            "-N",
            "",
            "-C",
            &comment,
        ])
        .output()
        .map_err(|e| {
            GitError::InvalidInput(format!(
                "无法运行 ssh-keygen：{e}。请确认已安装 OpenSSH 客户端。"
            ))
        })?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(GitError::InvalidInput(format!("生成密钥失败：{err}")));
    }
    emit_terminal("info", &format!("已生成 {}", key_path.display()));
    auth_ssh_status()
}

fn whoami_simple() -> String {
    std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_else(|_| "user".to_string())
}

pub fn auth_ssh_test(provider_raw: &str) -> Result<SshTestResult, GitError> {
    use std::sync::mpsc;
    use std::thread;

    let provider = Provider::parse(provider_raw)?;
    let target = provider.ssh_host();
    emit_terminal("info", &format!("正在测试 SSH：ssh -T {target} …"));

    let child = Command::new("ssh")
        .args([
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=accept-new",
            "-o",
            "ConnectTimeout=12",
            "-o",
            "ConnectionAttempts=1",
            "-o",
            "PreferredAuthentications=publickey",
            "-T",
            target,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            GitError::InvalidInput(format!(
                "无法运行 ssh：{e}。请确认已安装 OpenSSH 客户端（Windows 可选功能）。"
            ))
        })?;

    let pid = child.id();
    let (tx, rx) = mpsc::channel();
    // Move child into worker so pipes are drained via wait_with_output.
    thread::spawn(move || {
        let result = child.wait_with_output();
        let _ = tx.send(result);
    });

    let output = match rx.recv_timeout(Duration::from_secs(20)) {
        Ok(Ok(output)) => output,
        Ok(Err(e)) => {
            return Err(GitError::InvalidInput(format!("等待 ssh 结束失败：{e}")));
        }
        Err(_) => {
            #[cfg(windows)]
            {
                let _ = Command::new("taskkill")
                    .args(["/PID", &pid.to_string(), "/F", "/T"])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
            }
            #[cfg(not(windows))]
            {
                let _ = Command::new("kill")
                    .args(["-9", &pid.to_string()])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
            }
            let message = format!(
                "SSH 测试超时（20 秒）。请检查网络，或确认已把本机公钥添加到 {}。",
                provider.label()
            );
            emit_terminal("err", &message);
            return Ok(SshTestResult {
                ok: false,
                message,
            });
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{stdout}{stderr}");
    let lower = combined.to_ascii_lowercase();
    // GitHub/Gitee return non-zero even on success, with a greeting line.
    let ok = lower.contains("successfully authenticated")
        || combined.contains("认证成功")
        || lower.contains("you've successfully authenticated")
        || (combined.contains("Hi ") && lower.contains("authenticated"))
        || (provider == Provider::Gitee && combined.contains("Hi "));

    let message = if ok {
        let brief = combined
            .lines()
            .map(str::trim)
            .find(|l| !l.is_empty())
            .unwrap_or("SSH 认证成功")
            .to_string();
        emit_terminal("info", &brief);
        brief
    } else {
        let brief = if combined.trim().is_empty() {
            format!(
                "SSH 未通过（退出码 {}）。请先生成/复制公钥，并添加到 {}。",
                output.status.code().unwrap_or(-1),
                provider.label()
            )
        } else {
            combined
                .lines()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .take(4)
                .collect::<Vec<_>>()
                .join(" ")
        };
        emit_terminal("err", &brief);
        brief
    };
    Ok(SshTestResult { ok, message })
}
