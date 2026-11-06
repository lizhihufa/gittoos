use crate::process_win::hide_console;
use std::path::PathBuf;
use std::process::{Command, Stdio};

const INSTALLER_NAME: &str = "MicrosoftEdgeWebView2RuntimeInstallerX64.exe";
const CLIENT_GUID: &str = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";

/// Ensure WebView2 exists before the app window is created.
pub fn ensure_webview2() {
    if webview2_available() {
        return;
    }

    if let Some(installer) = find_installer() {
        let mut cmd = Command::new(&installer);
        cmd.args(["/install"])
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        hide_console(&mut cmd);
        let status = cmd.status();
        if matches!(status, Ok(s) if s.success()) || webview2_available() {
            return;
        }
    }

    let mut cmd = Command::new("cmd");
    cmd.args([
        "/C",
        "start",
        "",
        "https://go.microsoft.com/fwlink/p/?LinkId=2124703",
    ])
    .stdout(Stdio::null())
    .stderr(Stdio::null());
    hide_console(&mut cmd);
    let _ = cmd.status();
}

fn webview2_available() -> bool {
    let keys = [
        format!(r"HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{CLIENT_GUID}"),
        format!(r"HKLM\SOFTWARE\Microsoft\EdgeUpdate\Clients\{CLIENT_GUID}"),
        format!(r"HKCU\SOFTWARE\Microsoft\EdgeUpdate\Clients\{CLIENT_GUID}"),
    ];
    for key in keys {
        let mut cmd = Command::new("reg");
        cmd.args(["query", &key, "/v", "pv"])
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        hide_console(&mut cmd);
        let Ok(output) = cmd.output() else {
            continue;
        };
        if !output.status.success() {
            continue;
        }
        let text = String::from_utf8_lossy(&output.stdout);
        for line in text.lines() {
            if !line.contains("pv") {
                continue;
            }
            if let Some(version) = line.split_whitespace().last() {
                if !version.is_empty() && version != "0.0.0.0" && version.contains('.') {
                    return true;
                }
            }
        }
    }
    false
}

fn find_installer() -> Option<PathBuf> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for candidate in [
                dir.join(INSTALLER_NAME),
                dir.join("resources").join(INSTALLER_NAME),
            ] {
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
            if let Ok(entries) = std::fs::read_dir(dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_file()
                        && path
                            .file_name()
                            .is_some_and(|n| n == INSTALLER_NAME)
                    {
                        return Some(path);
                    }
                    let nested = path.join(INSTALLER_NAME);
                    if nested.is_file() {
                        return Some(nested);
                    }
                }
            }
        }
    }

    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join(INSTALLER_NAME);
    if dev.is_file() {
        return Some(dev);
    }
    None
}
