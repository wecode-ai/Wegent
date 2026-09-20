// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

mod api_context;
mod automations;
mod codex_global_state;
mod codex_notifications;
mod codex_rollout;
mod codex_transcript_page;
mod collaboration_projects;
mod connectors;
mod events;
pub mod fork_transfer;
mod handler;
pub(crate) mod local_connector_auth;
mod local_execution;
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

pub(crate) use collaboration_projects::sync_local_collaboration_projects;
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
    let desktop_enabled = env_enabled("DEVICE_VNC_DESKTOP_ENABLED", false);
    let address = std::env::var("DEVICE_VNC_RFB_ADDR")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "127.0.0.1:5901".to_owned())
        .parse::<std::net::SocketAddr>()
        .ok()?;
    let clipboard = match std::env::var("DEVICE_VNC_CLIPBOARD_MODE")
        .ok()
        .as_deref()
        .map(str::trim)
    {
        Some("none") => "none",
        Some("text") => "text",
        Some("extended-text") => "extended-text",
        _ => "none",
    };
    vnc_desktop_features_for(gateway_enabled, desktop_enabled, address, clipboard)
}

fn vnc_desktop_features_for(
    gateway_enabled: bool,
    desktop_enabled: bool,
    address: std::net::SocketAddr,
    clipboard: &str,
) -> Option<serde_json::Value> {
    if !gateway_enabled || !desktop_enabled || !address.ip().is_loopback() {
        return None;
    }
    probe_rfb_desktop(address)?;
    Some(serde_json::json!({
        "version": 1,
        "available": true,
        "protocol": "rfb",
        "transport": "websocket",
        "clipboard": clipboard,
    }))
}

fn probe_rfb_desktop(address: std::net::SocketAddr) -> Option<()> {
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::time::Duration;

    let mut stream = TcpStream::connect_timeout(&address, Duration::from_millis(250)).ok()?;
    stream
        .set_read_timeout(Some(Duration::from_millis(250)))
        .ok()?;
    stream
        .set_write_timeout(Some(Duration::from_millis(250)))
        .ok()?;
    let mut banner = [0_u8; 12];
    stream.read_exact(&mut banner).ok()?;
    let version = rfb_probe_version(&banner)?;
    stream.write_all(version).ok()?;
    negotiate_rfb_none_security(&mut stream, version)?;
    stream.write_all(&[1]).ok()?;
    read_rfb_server_init(&mut stream)
}

fn rfb_probe_version(banner: &[u8; 12]) -> Option<&'static [u8; 12]> {
    if &banner[..8] != b"RFB 003." || banner[11] != b'\n' {
        return None;
    }
    let minor = std::str::from_utf8(&banner[8..11])
        .ok()?
        .parse::<u16>()
        .ok()?;
    match minor {
        8.. => Some(b"RFB 003.008\n"),
        7 => Some(b"RFB 003.007\n"),
        3..=6 => Some(b"RFB 003.003\n"),
        _ => None,
    }
}

fn negotiate_rfb_none_security(stream: &mut std::net::TcpStream, version: &[u8; 12]) -> Option<()> {
    use std::io::{Read, Write};

    if version == b"RFB 003.003\n" {
        let mut security_type = [0_u8; 4];
        stream.read_exact(&mut security_type).ok()?;
        return (u32::from_be_bytes(security_type) == 1).then_some(());
    }
    let mut count = [0_u8; 1];
    stream.read_exact(&mut count).ok()?;
    let mut security_types = vec![0_u8; usize::from(count[0])];
    stream.read_exact(&mut security_types).ok()?;
    security_types.contains(&1).then_some(())?;
    stream.write_all(&[1]).ok()?;
    if version == b"RFB 003.008\n" {
        let mut result = [0_u8; 4];
        stream.read_exact(&mut result).ok()?;
        (u32::from_be_bytes(result) == 0).then_some(())?;
    }
    Some(())
}

fn read_rfb_server_init(stream: &mut std::net::TcpStream) -> Option<()> {
    use std::io::Read;

    let mut server_init = [0_u8; 24];
    stream.read_exact(&mut server_init).ok()?;
    let width = u16::from_be_bytes(server_init[0..2].try_into().ok()?);
    let height = u16::from_be_bytes(server_init[2..4].try_into().ok()?);
    (width > 0 && height > 0).then_some(())?;
    let name_len =
        usize::try_from(u32::from_be_bytes(server_init[20..24].try_into().ok()?)).ok()?;
    (name_len <= 64 * 1024).then_some(())?;
    let mut name = vec![0_u8; name_len];
    stream.read_exact(&mut name).ok()
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

#[cfg(test)]
mod vnc_desktop_tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;

    use serde_json::json;

    use super::vnc_desktop_features_for;

    #[test]
    fn reports_vnc_desktop_only_after_a_complete_rfb_probe() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let rfb_task = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.write_all(b"RFB 003.008\n").unwrap();
            let mut version = [0_u8; 12];
            stream.read_exact(&mut version).unwrap();
            assert_eq!(&version, b"RFB 003.008\n");
            stream.write_all(&[1, 1]).unwrap();
            let mut selected_security = [0_u8; 1];
            stream.read_exact(&mut selected_security).unwrap();
            assert_eq!(selected_security, [1]);
            stream.write_all(&0_u32.to_be_bytes()).unwrap();
            let mut shared = [0_u8; 1];
            stream.read_exact(&mut shared).unwrap();
            assert_eq!(shared, [1]);
            let mut server_init = vec![0_u8; 24];
            server_init[0..2].copy_from_slice(&1280_u16.to_be_bytes());
            server_init[2..4].copy_from_slice(&800_u16.to_be_bytes());
            stream.write_all(&server_init).unwrap();
        });

        assert_eq!(
            vnc_desktop_features_for(true, true, address, "text"),
            Some(json!({
                "version": 1,
                "available": true,
                "protocol": "rfb",
                "transport": "websocket",
                "clipboard": "text",
            }))
        );
        rfb_task.join().unwrap();
    }

    #[test]
    fn rejects_disabled_or_non_loopback_vnc_desktops_without_probing() {
        let non_loopback = "192.0.2.1:5901".parse().unwrap();

        assert_eq!(
            vnc_desktop_features_for(false, true, non_loopback, "text"),
            None
        );
        assert_eq!(
            vnc_desktop_features_for(true, false, non_loopback, "text"),
            None
        );
        assert_eq!(
            vnc_desktop_features_for(true, true, non_loopback, "text"),
            None
        );
    }
}
