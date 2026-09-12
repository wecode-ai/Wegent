// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

mod automations;
mod codex_global_state;
mod codex_notifications;
mod codex_rollout;
mod codex_transcript_page;
mod connectors;
mod events;
pub mod fork_transfer;
mod handler;
pub(crate) mod local_connector_auth;
pub(crate) mod native_transcript;
mod notification_mapping;
mod remote_projects;
mod response;
mod runtime_handle_messages;
mod store;
mod task_create_contract;
mod transcript;
mod transcript_page;
mod util;
mod worktrees;

pub use handler::RuntimeWorkRpcHandler;
pub(crate) use notification_mapping::codex_stream_debug_enabled;
pub(crate) use util::runtime_task_title;

pub(crate) fn runtime_features() -> serde_json::Value {
    let gateway_enabled = env_enabled("DEVICE_SESSION_GATEWAY_ENABLED", true);
    serde_json::json!({
        "schemaVersion": 4,
        "runtimeTaskCreate": {
            "schemaVersions": [1, 2],
            "features": {
                "attachments": true,
                "goal": true,
                "supervisor": true,
                "permissionMode": true,
                "projectPlugins": true,
                "skills": true,
                "standaloneWorkspace": true,
                "workspaceInheritance": true,
                "worktree": true
            }
        },
        "interactiveSessions": {
            "codeServer": gateway_enabled && env_enabled("DEVICE_CODE_SERVER_ENABLED", true),
            "terminal": env_enabled("DEVICE_TERMINAL_ENABLED", true),
        },
        "desktop": vnc_desktop_features(gateway_enabled),
        "worktrees": worktrees::WorktreeManager::capabilities_from_env(),
    })
}

fn vnc_desktop_features(gateway_enabled: bool) -> Option<serde_json::Value> {
    use std::io::Read;
    use std::net::{SocketAddr, TcpStream};
    use std::time::Duration;

    if !gateway_enabled || !env_enabled("DEVICE_VNC_DESKTOP_ENABLED", false) {
        return None;
    }
    let address = std::env::var("DEVICE_VNC_RFB_ADDR")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "127.0.0.1:5901".to_owned())
        .parse::<SocketAddr>()
        .ok()?;
    if !address.ip().is_loopback() {
        return None;
    }
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_millis(250)).ok()?;
    stream
        .set_read_timeout(Some(Duration::from_millis(250)))
        .ok()?;
    let mut banner = [0_u8; 12];
    stream.read_exact(&mut banner).ok()?;
    if !banner.starts_with(b"RFB ") {
        return None;
    }
    let clipboard = match std::env::var("DEVICE_VNC_CLIPBOARD_MODE")
        .ok()
        .as_deref()
        .map(str::trim)
    {
        Some("none") => "none",
        Some("text") => "text",
        _ => "extended-text",
    };
    Some(serde_json::json!({
        "version": 1,
        "available": true,
        "protocol": "rfb",
        "transport": "websocket",
        "clipboard": clipboard,
    }))
}

fn env_enabled(name: &str, default: bool) -> bool {
    std::env::var(name)
        .ok()
        .map(|value| {
            !matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "" | "0" | "false" | "no" | "off"
            )
        })
        .unwrap_or(default)
}

pub(crate) fn codex_workspace_roots() -> Vec<std::path::PathBuf> {
    codex_global_state::CodexGlobalProjectIndex::load()
        .projects()
        .iter()
        .flat_map(|project| project.roots.iter())
        .map(std::path::PathBuf::from)
        .collect()
}
