//! App feature permissions — persisted under app data, checked by sensitive commands.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeaturePermissions {
    #[serde(default = "default_true")]
    pub push: bool,
    #[serde(default = "default_true")]
    pub force_push: bool,
    #[serde(default = "default_true")]
    pub publish_remote: bool,
    #[serde(default = "default_true")]
    pub release: bool,
    #[serde(default = "default_true")]
    pub wiki: bool,
    #[serde(default = "default_true")]
    pub mirror: bool,
}

fn default_true() -> bool {
    true
}

impl Default for FeaturePermissions {
    fn default() -> Self {
        Self {
            push: true,
            force_push: true,
            publish_remote: true,
            release: true,
            wiki: true,
            mirror: true,
        }
    }
}

fn permissions_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("feature-permissions.json"))
}

pub fn load(app: &AppHandle) -> FeaturePermissions {
    let Ok(path) = permissions_file(app) else {
        return FeaturePermissions::default();
    };
    let Ok(raw) = std::fs::read_to_string(path) else {
        return FeaturePermissions::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

pub fn save(app: &AppHandle, perms: &FeaturePermissions) -> Result<(), String> {
    let path = permissions_file(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let raw = serde_json::to_string_pretty(perms).map_err(|e| e.to_string())?;
    std::fs::write(&path, raw).map_err(|e| format!("写入权限配置失败：{e}"))
}

fn denied(label: &str) -> String {
    format!("权限已关闭：{label}。请到设置 → 权限中开启。")
}

pub fn require(app: &AppHandle, key: &str) -> Result<(), String> {
    let p = load(app);
    let ok = match key {
        "push" => p.push,
        "forcePush" | "force_push" => p.force_push,
        "publishRemote" | "publish_remote" => p.publish_remote,
        "release" => p.release,
        "wiki" => p.wiki,
        "mirror" => p.mirror,
        _ => true,
    };
    if ok {
        return Ok(());
    }
    let label = match key {
        "push" => "推送到远程",
        "forcePush" | "force_push" => "强制推送",
        "publishRemote" | "publish_remote" => "创建远程仓库",
        "release" => "Release 发布",
        "wiki" => "Wiki 编辑",
        "mirror" => "镜像同步",
        other => other,
    };
    Err(denied(label))
}
