use super::runner::{emit_terminal, ensure_git, local_proxy, GitBinary};
use super::types::GitError;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

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
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ProviderStore {
    #[serde(default)]
    client_id: String,
    #[serde(default)]
    client_secret: String,
    #[serde(default)]
    token: String,
    #[serde(default)]
    login: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    avatar_url: String,
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
pub struct ProviderStatus {
    pub provider: String,
    pub logged_in: bool,
    pub login: String,
    pub name: String,
    pub avatar_url: String,
    pub client_id: String,
    pub has_client_id: bool,
    pub has_client_secret: bool,
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

static PENDING: Mutex<Option<PendingOauth>> = Mutex::new(None);

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

fn load_store() -> Result<AuthStore, GitError> {
    let path = auth_store_path()?;
    if path.exists() {
        let text = std::fs::read_to_string(&path).map_err(|e| GitError::Io {
            path: path.display().to_string(),
            message: e.to_string(),
        })?;
        return serde_json::from_str(&text)
            .map_err(|e| GitError::InvalidInput(format!("读取登录配置失败：{e}")));
    }

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
                let store = AuthStore {
                    github: ProviderStore {
                        client_id: old.client_id,
                        client_secret: String::new(),
                        token: old.token,
                        login: old.login,
                        name: old.name,
                        avatar_url: old.avatar_url,
                    },
                    gitee: ProviderStore::default(),
                };
                let _ = save_store(&store);
                return Ok(store);
            }
        }
    }
    Ok(AuthStore::default())
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

fn status_of(provider: Provider, slot: &ProviderStore) -> ProviderStatus {
    ProviderStatus {
        provider: provider.as_str().to_string(),
        logged_in: !slot.token.is_empty() && !slot.login.is_empty(),
        login: slot.login.clone(),
        name: slot.name.clone(),
        avatar_url: slot.avatar_url.clone(),
        client_id: slot.client_id.clone(),
        has_client_id: !slot.client_id.trim().is_empty(),
        has_client_secret: !slot.client_secret.trim().is_empty(),
    }
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

fn fetch_user(provider: Provider, token: &str) -> Result<ApiUser, GitError> {
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
    }
    .map_err(|e| GitError::InvalidInput(format!("{} API 请求失败：{e}", provider.label())))?;

    if !(200..300).contains(&response.status()) {
        return Err(GitError::InvalidInput(format!(
            "{} 登录无效（HTTP {}）",
            provider.label(),
            response.status()
        )));
    }
    response
        .into_json::<ApiUser>()
        .map_err(|e| GitError::InvalidInput(format!("解析用户信息失败：{e}")))
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

fn persist_session(
    provider: Provider,
    token: &str,
    user: &ApiUser,
) -> Result<ProviderStatus, GitError> {
    let mut store = load_store()?;
    {
        let slot = provider_slot_mut(&mut store, provider);
        slot.token = token.to_string();
        slot.login = user.login.clone();
        slot.name = user.name.clone().unwrap_or_default();
        slot.avatar_url = user.avatar_url.clone();
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
    use std::time::{SystemTime, UNIX_EPOCH};
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

fn exchange_code(
    provider: Provider,
    code: &str,
    redirect_uri: &str,
    client_id: &str,
    client_secret: &str,
) -> Result<String, GitError> {
    let agent = http_agent();
    let token = match provider {
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
            let body = response
                .into_json::<TokenResponse>()
                .map_err(|e| GitError::InvalidInput(format!("解析 GitHub Token 失败：{e}")))?;
            if let Some(err) = body.error {
                let desc = body.error_description.unwrap_or(err);
                return Err(GitError::InvalidInput(format!("GitHub Token 错误：{desc}")));
            }
            body.access_token
                .filter(|t| !t.is_empty())
                .ok_or_else(|| GitError::InvalidInput("GitHub 未返回 access_token".to_string()))?
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
            let body = response
                .into_json::<TokenResponse>()
                .map_err(|e| GitError::InvalidInput(format!("解析 Gitee Token 失败：{e}")))?;
            if let Some(err) = body.error {
                let desc = body.error_description.unwrap_or(err);
                return Err(GitError::InvalidInput(format!("Gitee Token 错误：{desc}")));
            }
            body.access_token
                .filter(|t| !t.is_empty())
                .ok_or_else(|| GitError::InvalidInput("Gitee 未返回 access_token".to_string()))?
        }
    };
    Ok(token)
}

fn refresh_provider(provider: Provider) -> Result<ProviderStatus, GitError> {
    let mut store = load_store()?;
    let token = provider_slot(&store, provider).token.clone();
    if token.is_empty() {
        return Ok(status_of(provider, provider_slot(&store, provider)));
    }
    match fetch_user(provider, &token) {
        Ok(user) => {
            {
                let slot = provider_slot_mut(&mut store, provider);
                slot.login = user.login;
                slot.name = user.name.unwrap_or_default();
                slot.avatar_url = user.avatar_url;
            }
            save_store(&store)?;
            Ok(status_of(provider, provider_slot(&store, provider)))
        }
        Err(err) => {
            emit_terminal("err", &format!("{} 会话失效：{err}", provider.label()));
            let login = provider_slot(&store, provider).login.clone();
            {
                let slot = provider_slot_mut(&mut store, provider);
                slot.token.clear();
                slot.login.clear();
                slot.name.clear();
                slot.avatar_url.clear();
            }
            save_store(&store)?;
            if !login.is_empty() {
                let _ = reject_credential(provider, &login);
            }
            Ok(status_of(provider, provider_slot(&store, provider)))
        }
    }
}

pub fn auth_accounts() -> Result<AuthAccounts, GitError> {
    Ok(AuthAccounts {
        github: refresh_provider(Provider::Github)?,
        gitee: refresh_provider(Provider::Gitee)?,
    })
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

pub fn auth_browser_begin(provider_raw: &str) -> Result<OauthBegin, GitError> {
    let provider = Provider::parse(provider_raw)?;
    let store = load_store()?;
    let slot = provider_slot(&store, provider);
    let client_id = slot.client_id.trim();
    let client_secret = slot.client_secret.trim();
    if client_id.is_empty() || client_secret.is_empty() {
        return Err(GitError::InvalidInput(format!(
            "网站登录需要填写 {} 的 Client ID 和 Client Secret",
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
            url_encode(client_id),
            url_encode(&redirect_uri),
            url_encode("repo"),
            url_encode(&state),
        ),
        Provider::Gitee => format!(
            "https://gitee.com/oauth/authorize?client_id={}&redirect_uri={}&response_type=code&scope={}&state={}",
            url_encode(client_id),
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
    let token = exchange_code(
        provider,
        &code,
        &pending.redirect_uri,
        slot.client_id.trim(),
        slot.client_secret.trim(),
    )?;
    let user = fetch_user(provider, &token)?;
    persist_session(provider, &token, &user)
}

pub fn auth_device_start() -> Result<GithubDeviceStart, GitError> {
    let store = load_store()?;
    let client_id = store.github.client_id.trim();
    if client_id.is_empty() {
        return Err(GitError::InvalidInput(
            "设备码登录请先填写 GitHub Client ID".to_string(),
        ));
    }
    emit_terminal("info", "正在申请 GitHub 设备码…");
    let agent = http_agent();
    let response = agent
        .post("https://github.com/login/device/code")
        .set("Accept", "application/json")
        .set("User-Agent", "qingzhi")
        .send_form(&[("client_id", client_id), ("scope", "repo")])
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
    let client_id = store.github.client_id.trim();
    if client_id.is_empty() {
        return Err(GitError::InvalidInput("缺少 GitHub Client ID".to_string()));
    }
    let agent = http_agent();
    let response = agent
        .post("https://github.com/login/oauth/access_token")
        .set("Accept", "application/json")
        .set("User-Agent", "qingzhi")
        .send_form(&[
            ("client_id", client_id),
            ("device_code", device_code.trim()),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ])
        .map_err(|e| GitError::InvalidInput(format!("轮询登录失败：{e}")))?;
    let body = response
        .into_json::<TokenResponse>()
        .map_err(|e| GitError::InvalidInput(format!("解析登录结果失败：{e}")))?;

    if let Some(token) = body.access_token.filter(|t| !t.is_empty()) {
        let user = fetch_user(Provider::Github, &token)?;
        let account = persist_session(Provider::Github, &token, &user)?;
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

pub fn auth_github_gcm_login() -> Result<ProviderStatus, GitError> {
    let git = ensure_git()?;
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

    let filled = fill_github_credential(&git)?;
    let token = filled
        .password
        .filter(|p| !p.is_empty())
        .ok_or_else(|| GitError::InvalidInput("凭据管理器没有返回 GitHub 凭据".to_string()))?;
    let user = fetch_user(Provider::Github, &token)?;
    persist_session(Provider::Github, &token, &user)
}

struct FilledCredential {
    password: Option<String>,
}

fn fill_github_credential(git: &GitBinary) -> Result<FilledCredential, GitError> {
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
        let _ = stdin.write_all(b"protocol=https\nhost=github.com\n\n");
    }
    let output = child.wait_with_output().map_err(|e| GitError::Io {
        path: git.path.display().to_string(),
        message: e.to_string(),
    })?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(GitError::InvalidInput(format!(
            "读取 GitHub 凭据失败：{err}"
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
    persist_session(provider, token, &user)
}

pub fn auth_logout(provider_raw: &str) -> Result<ProviderStatus, GitError> {
    let provider = Provider::parse(provider_raw)?;
    let mut store = load_store()?;
    let login = provider_slot(&store, provider).login.clone();
    {
        let slot = provider_slot_mut(&mut store, provider);
        slot.token.clear();
        slot.login.clear();
        slot.name.clear();
        slot.avatar_url.clear();
    }
    save_store(&store)?;
    if !login.is_empty() {
        let _ = reject_credential(provider, &login);
    }
    emit_terminal("info", &format!("已退出 {} 登录", provider.label()));
    Ok(status_of(provider, provider_slot(&store, provider)))
}
