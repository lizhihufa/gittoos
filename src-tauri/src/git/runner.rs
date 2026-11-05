use super::types::{GitError, GitInfo, GitTerminalEvent};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

static GIT_LOCK: Mutex<()> = Mutex::new(());
static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();
/// Nested quiet scopes suppress terminal spam for read-only git queries.
static QUIET_DEPTH: AtomicUsize = AtomicUsize::new(0);

#[derive(Debug, Clone)]
pub struct GitBinary {
    pub path: PathBuf,
    pub version: String,
}

#[derive(Debug, Clone)]
pub struct GitOutput {
    pub stdout: String,
    pub stderr: String,
}

pub fn set_app_handle(app: AppHandle) {
    let _ = APP_HANDLE.set(app);
}

pub fn with_git_quiet<T>(f: impl FnOnce() -> T) -> T {
    QUIET_DEPTH.fetch_add(1, Ordering::SeqCst);
    let result = f();
    QUIET_DEPTH.fetch_sub(1, Ordering::SeqCst);
    result
}

fn is_git_quiet() -> bool {
    QUIET_DEPTH.load(Ordering::SeqCst) > 0
}

pub fn emit_terminal(kind: &str, text: &str) {
    if text.trim().is_empty() {
        return;
    }
    // Keep errors visible even in quiet scopes; hide routine cmd/out spam.
    if is_git_quiet() && kind != "err" {
        return;
    }
    if let Some(app) = APP_HANDLE.get() {
        let _ = app.emit(
            "git-terminal",
            GitTerminalEvent {
                kind: kind.to_string(),
                text: text.to_string(),
            },
        );
    }
}

pub fn resolve_git() -> Result<GitBinary, GitError> {
    let path = which_git().ok_or(GitError::GitNotFound)?;
    git_binary(path)
}

pub fn ensure_git() -> Result<GitBinary, GitError> {
    if let Ok(git) = resolve_git() {
        return Ok(git);
    }
    emit_terminal("info", "未检测到 Git，正在安装完整版 Git for Windows…");
    install_full_git()?;
    // Installer updates PATH for new shells; also check standard locations.
    if let Ok(git) = resolve_git() {
        emit_terminal(
            "info",
            &format!("Git 安装完成：{} ({})", git.version, git.path.display()),
        );
        return Ok(git);
    }
    Err(GitError::InvalidInput(
        "Git 安装结束，但还找不到 git.exe。请关闭软件后重新打开，或手动安装 Git for Windows。"
            .to_string(),
    ))
}

fn git_binary(path: PathBuf) -> Result<GitBinary, GitError> {
    let output = Command::new(&path)
        .arg("--version")
        .output()
        .map_err(|_| GitError::GitNotFound)?;
    if !output.status.success() {
        return Err(GitError::GitNotFound);
    }
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(GitBinary { path, version })
}

pub fn git_info(git: &GitBinary) -> GitInfo {
    GitInfo {
        path: git.path.display().to_string(),
        version: git.version.clone(),
    }
}

fn which_git() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("GIT_EXECUTABLE") {
        let p = PathBuf::from(path);
        if p.exists() {
            return Some(p);
        }
    }

    #[cfg(windows)]
    {
        let candidates = [
            PathBuf::from(r"C:\Program Files\Git\cmd\git.exe"),
            PathBuf::from(r"C:\Program Files\Git\bin\git.exe"),
            PathBuf::from(r"C:\Program Files (x86)\Git\cmd\git.exe"),
        ];
        for candidate in candidates {
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }

    let output = Command::new(if cfg!(windows) { "where" } else { "which" })
        .arg("git")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let first = text.lines().next()?.trim();
    if first.is_empty() {
        None
    } else {
        Some(PathBuf::from(first))
    }
}

pub fn run_git(git: &GitBinary, repo: &Path, args: &[&str]) -> Result<GitOutput, GitError> {
    run_git_timeout(git, repo, args, 45)
}

/// Like `run_git_timeout`, but skips immediately if another git op holds the lock.
/// Used by background polling so the UI never waits behind a long push/delete.
pub fn run_git_timeout_nonblocking(
    git: &GitBinary,
    repo: &Path,
    args: &[&str],
    timeout_secs: u64,
) -> Result<Option<GitOutput>, GitError> {
    if !repo.exists() {
        return Err(GitError::InvalidPath(repo.display().to_string()));
    }
    let Ok(_guard) = GIT_LOCK.try_lock() else {
        return Ok(None);
    };
    Ok(Some(run_git_timeout_locked(git, repo, args, timeout_secs)?))
}

pub fn run_git_timeout(
    git: &GitBinary,
    repo: &Path,
    args: &[&str],
    timeout_secs: u64,
) -> Result<GitOutput, GitError> {
    if !repo.exists() {
        return Err(GitError::InvalidPath(repo.display().to_string()));
    }

    let _guard = GIT_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    run_git_timeout_locked(git, repo, args, timeout_secs)
}

fn run_git_timeout_locked(
    git: &GitBinary,
    repo: &Path,
    args: &[&str],
    timeout_secs: u64,
) -> Result<GitOutput, GitError> {
    let display = format_command(repo, args);
    emit_terminal("cmd", &format!("$ {display}"));

    let mut command = Command::new(&git.path);
    command
        .current_dir(repo)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C.UTF-8")
        .env("LANG", "C.UTF-8");
    if let Some(proxy) = local_proxy() {
        command
            .env("http_proxy", &proxy)
            .env("https_proxy", &proxy)
            .env("HTTP_PROXY", &proxy)
            .env("HTTPS_PROXY", &proxy);
    }
    command
        .args([
            "-c",
            "core.quotepath=false",
            "-c",
            "http.version=HTTP/1.1",
            "-c",
            "http.lowSpeedLimit=1000",
            "-c",
            "http.lowSpeedTime=20",
        ])
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command.spawn().map_err(|e| GitError::Io {
        path: git.path.display().to_string(),
        message: e.to_string(),
    })?;
    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        if let Some(pipe) = stdout_pipe.as_mut() {
            let _ = pipe.read_to_end(&mut stdout);
        }
        if let Some(pipe) = stderr_pipe.as_mut() {
            let _ = pipe.read_to_end(&mut stderr);
        }
        let _ = tx.send((stdout, stderr));
    });

    let deadline = Instant::now() + Duration::from_secs(timeout_secs);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                let msg = format!("操作超过 {timeout_secs} 秒仍无响应。请检查网络，或稍后再点一次。");
                emit_terminal("err", &msg);
                return Err(GitError::InvalidInput(msg));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(200)),
            Err(e) => {
                return Err(GitError::Io {
                    path: git.path.display().to_string(),
                    message: e.to_string(),
                });
            }
        }
    };

    let (stdout_bytes, stderr_bytes) = rx.recv().unwrap_or_default();
    let stdout = decode_bytes(&stdout_bytes);
    let stderr = decode_bytes(&stderr_bytes);
    if !stdout.trim().is_empty() {
        emit_terminal("out", stdout.trim_end());
    }
    if !stderr.trim().is_empty() {
        emit_terminal(if status.success() { "out" } else { "err" }, stderr.trim_end());
    }
    if status.success() {
        Ok(GitOutput { stdout, stderr })
    } else {
        Err(GitError::CommandFailed {
            code: status.code().unwrap_or(1),
            stderr,
            stdout,
        })
    }
}

pub fn run_shell(git: &GitBinary, repo: &Path, line: &str) -> Result<String, GitError> {
    let line = line.trim();
    if line.is_empty() {
        return Err(GitError::InvalidInput("请输入命令".to_string()));
    }
    if !repo.exists() {
        return Err(GitError::InvalidPath(repo.display().to_string()));
    }

    let _guard = GIT_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    let mut command = Command::new("cmd");
    command
        .current_dir(repo)
        .arg("/c")
        .arg(line)
        .env("GIT_TERMINAL_PROMPT", "0");
    if let Some(parent) = git.path.parent() {
        let path = std::env::var("PATH").unwrap_or_default();
        command.env("PATH", format!("{};{}", parent.display(), path));
    }
    if let Some(proxy) = local_proxy() {
        command
            .env("http_proxy", &proxy)
            .env("https_proxy", &proxy)
            .env("HTTP_PROXY", &proxy)
            .env("HTTPS_PROXY", &proxy);
    }
    command.stdout(Stdio::piped()).stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command.spawn().map_err(|e| GitError::Io {
        path: "cmd.exe".to_string(),
        message: e.to_string(),
    })?;
    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        if let Some(pipe) = stdout_pipe.as_mut() {
            let _ = pipe.read_to_end(&mut stdout);
        }
        if let Some(pipe) = stderr_pipe.as_mut() {
            let _ = pipe.read_to_end(&mut stderr);
        }
        let _ = tx.send((stdout, stderr));
    });

    let timeout_secs = 120_u64;
    let deadline = Instant::now() + Duration::from_secs(timeout_secs);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(GitError::InvalidInput(format!(
                    "命令超过 {timeout_secs} 秒仍未结束"
                )));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(200)),
            Err(e) => {
                return Err(GitError::Io {
                    path: "cmd.exe".to_string(),
                    message: e.to_string(),
                });
            }
        }
    };

    let (stdout_bytes, stderr_bytes) = rx.recv().unwrap_or_default();
    let stdout = decode_bytes(&stdout_bytes);
    let stderr = decode_bytes(&stderr_bytes);
    let mut text = String::new();
    if !stdout.trim().is_empty() {
        text.push_str(stdout.trim_end());
    }
    if !stderr.trim().is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(stderr.trim_end());
    }
    if !status.success() {
        let code = status.code().unwrap_or(1);
        if text.is_empty() {
            text = format!("命令失败，退出码 {code}");
        }
        return Err(GitError::InvalidInput(text));
    }
    Ok(text)
}

fn format_command(repo: &Path, args: &[&str]) -> String {
    let mut parts = vec!["git".to_string()];
    for arg in args {
        if arg.contains(' ') {
            parts.push(format!("\"{arg}\""));
        } else {
            parts.push((*arg).to_string());
        }
    }
    format!("{}    # cwd: {}", parts.join(" "), repo.display())
}

fn install_full_git() -> Result<(), GitError> {
    if try_winget_install_git() {
        return Ok(());
    }

    let dir = download_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| GitError::Io {
        path: dir.display().to_string(),
        message: e.to_string(),
    })?;
    let installer = dir.join("Git-64-bit.exe");
    let _ = std::fs::remove_file(&installer);

    // Prefer China mirrors first; GitHub last (often blocked).
    let urls = [
        "https://cdn.npmmirror.com/binaries/git-for-windows/v2.55.0.windows.5/Git-2.55.0.5-64-bit.exe",
        "https://mirrors.huaweicloud.com/git-for-windows/v2.55.0.windows.5/Git-2.55.0.5-64-bit.exe",
        "https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.5/Git-2.55.0.5-64-bit.exe",
    ];
    let mut last_error = "未知错误".to_string();
    for url in urls {
        emit_terminal("info", &format!("正在下载：{url}"));
        match download_file(url, &installer) {
            Ok(()) => {
                let size = installer.metadata().map(|m| m.len()).unwrap_or(0);
                if size > 10_000_000 {
                    emit_terminal("info", &format!("下载完成（{:.1} MB）", size as f64 / 1_000_000.0));
                    last_error.clear();
                    break;
                }
                let _ = std::fs::remove_file(&installer);
                last_error = format!("下载的安装包不完整（{size} 字节）");
            }
            Err(err) => {
                let _ = std::fs::remove_file(&installer);
                last_error = err;
                emit_terminal("info", &format!("此源失败：{last_error}"));
            }
        }
    }
    if !last_error.is_empty() {
        return Err(GitError::InvalidInput(format!(
            "下载完整版 Git 失败：{last_error}。也可手动安装后重开本软件。"
        )));
    }

    emit_terminal(
        "info",
        "正在静默安装 Git for Windows（可能弹出系统权限确认）…",
    );
    let status = Command::new(&installer)
        .args([
            "/VERYSILENT",
            "/NORESTART",
            "/NOCANCEL",
            "/SP-",
            "/CLOSEAPPLICATIONS",
            "/RESTARTAPPLICATIONS",
            "/COMPONENTS=gitlfs,assoc,icons",
            "/o:PathOption=Cmd",
            "/o:SSHOption=OpenSSH",
            "/o:CURLOption=OpenSSL",
        ])
        .status()
        .map_err(|e| GitError::Io {
            path: installer.display().to_string(),
            message: e.to_string(),
        })?;
    if status.success() {
        emit_terminal("info", "官方安装包执行完成");
        Ok(())
    } else {
        Err(GitError::InvalidInput(
            "Git 安装失败。请手动安装 Git for Windows 后重开软件。".to_string(),
        ))
    }
}

fn try_winget_install_git() -> bool {
    let Some(winget) = find_winget() else {
        emit_terminal("info", "未找到 winget，改为下载官方安装包…");
        return false;
    };
    emit_terminal(
        "info",
        &format!("尝试使用 winget 安装 Git.Git…（{}）", winget.display()),
    );
    let status = Command::new(&winget)
        .args([
            "install",
            "--id",
            "Git.Git",
            "-e",
            "--accept-package-agreements",
            "--accept-source-agreements",
            "--disable-interactivity",
        ])
        .status();
    match status {
        Ok(status) if status.success() => {
            emit_terminal("info", "winget 安装完成");
            true
        }
        Ok(_) => {
            emit_terminal("info", "winget 安装未成功，改为下载官方安装包…");
            false
        }
        Err(err) => {
            emit_terminal(
                "info",
                &format!("winget 启动失败（{err}），改为下载官方安装包…"),
            );
            false
        }
    }
}

fn find_winget() -> Option<PathBuf> {
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let candidate = PathBuf::from(local)
            .join("Microsoft")
            .join("WindowsApps")
            .join("winget.exe");
        if candidate.exists() {
            return Some(candidate);
        }
    }

    let output = Command::new("where").arg("winget").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let first = text.lines().next()?.trim();
    if first.is_empty() {
        None
    } else {
        Some(PathBuf::from(first))
    }
}

fn download_dir() -> Result<PathBuf, GitError> {
    let local = std::env::var("LOCALAPPDATA").map_err(|_| {
        GitError::InvalidInput("找不到本机数据目录，无法下载 Git".to_string())
    })?;
    Ok(PathBuf::from(local).join("qingzhi").join("downloads"))
}

fn download_file(url: &str, destination: &Path) -> Result<(), String> {
    let proxy = local_proxy();
    if let Some(proxy) = proxy.as_deref() {
        emit_terminal("info", &format!("使用本机代理 {proxy}"));
    }

    if let Err(err) = download_with_curl(url, destination, proxy.as_deref()) {
        emit_terminal("info", &format!("curl 下载失败：{err}，改用 PowerShell…"));
        download_with_powershell(url, destination, proxy.as_deref())?;
    }
    Ok(())
}

fn download_with_curl(url: &str, destination: &Path, proxy: Option<&str>) -> Result<(), String> {
    let mut cmd = Command::new("curl.exe");
    cmd.args([
        "-fsSL",
        "--connect-timeout",
        "20",
        "--retry",
        "2",
        "-o",
    ]);
    cmd.arg(destination);
    cmd.arg(url);
    if let Some(proxy) = proxy {
        cmd.args(["-x", proxy]);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = cmd.output().map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("curl 退出码 {}", output.status.code().unwrap_or(1))
        } else {
            stderr
        })
    }
}

fn download_with_powershell(
    url: &str,
    destination: &Path,
    proxy: Option<&str>,
) -> Result<(), String> {
    let dest = destination.display().to_string().replace('\'', "''");
    let proxy = proxy.unwrap_or("").replace('\'', "");
    let script = format!(
        r#"
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'
$proxy = '{proxy}'
if ($proxy) {{
  $env:HTTPS_PROXY = $proxy
  $env:HTTP_PROXY = $proxy
  Invoke-WebRequest -Uri '{url}' -OutFile '{dest}' -UseBasicParsing -TimeoutSec 300 -Proxy $proxy
}} else {{
  Invoke-WebRequest -Uri '{url}' -OutFile '{dest}' -UseBasicParsing -TimeoutSec 300
}}
"#,
        proxy = proxy,
        url = url,
        dest = dest,
    );
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &script]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = cmd.output().map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("PowerShell 退出码 {}", output.status.code().unwrap_or(1))
        };
        Err(format!("{detail}（{url}）"))
    }
}

pub fn local_proxy() -> Option<String> {
    for port in [7897_u16, 7890, 10809, 1080, 20171] {
        let address = std::net::SocketAddr::from(([127, 0, 0, 1], port));
        if std::net::TcpStream::connect_timeout(&address, Duration::from_millis(200)).is_ok() {
            return Some(format!("http://127.0.0.1:{port}"));
        }
    }
    None
}

fn decode_bytes(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

pub fn ensure_repo(git: &GitBinary, repo: &Path) -> Result<(), GitError> {
    let output = run_git(git, repo, &["rev-parse", "--is-inside-work-tree"]);
    match output {
        Ok(out) if out.stdout.trim() == "true" => Ok(()),
        _ => Err(GitError::NotARepository(repo.display().to_string())),
    }
}
