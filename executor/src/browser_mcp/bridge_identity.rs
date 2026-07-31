use std::{env, fs, net::SocketAddr, path::PathBuf};

use serde::Deserialize;

use super::{BRIDGE_TOKEN_ENV, BRIDGE_URL_ENV, DEFAULT_BRIDGE_URL};

const BRIDGE_RUNTIME_FILE_ENV: &str = "WEWORK_EMBEDDED_BROWSER_BRIDGE_RUNTIME_FILE";
const BRIDGE_RUNTIME_FILE: &str = "runtime/embedded-browser-bridge.json";

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct BridgeIdentity {
    pub(crate) base_url: String,
    pub(crate) token: Option<String>,
    generation: Option<(u32, u128)>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeRuntimeRecord {
    schema_version: u8,
    pid: u32,
    address: String,
    token: String,
    started_at_unix_ms: u128,
}

pub(crate) fn current_bridge_identity() -> BridgeIdentity {
    bridge_identity_from_sources(environment_identity(), runtime_file_path())
}

fn bridge_identity_from_sources(
    environment: Option<BridgeIdentity>,
    runtime_path: Option<PathBuf>,
) -> BridgeIdentity {
    environment
        .or_else(|| read_runtime_identity(runtime_path))
        .unwrap_or_else(default_identity)
}

fn read_runtime_identity(path: Option<PathBuf>) -> Option<BridgeIdentity> {
    let content = fs::read_to_string(path?).ok()?;
    let identity = parse_runtime_identity(&content).ok()?;
    if identity.runtime_process_is_alive() {
        Some(identity)
    } else {
        None
    }
}

fn parse_runtime_identity(content: &str) -> Result<BridgeIdentity, String> {
    let record = serde_json::from_str::<BridgeRuntimeRecord>(content)
        .map_err(|error| format!("Invalid embedded browser bridge runtime: {error}"))?;
    if record.schema_version != 1 || record.pid == 0 {
        return Err("Unsupported embedded browser bridge runtime record".to_string());
    }
    let address = record
        .address
        .parse::<SocketAddr>()
        .map_err(|error| format!("Invalid embedded browser bridge address: {error}"))?;
    if !address.ip().is_loopback() {
        return Err("Embedded browser bridge runtime must use a loopback address".to_string());
    }
    let token = record.token.trim();
    if token.is_empty() {
        return Err("Embedded browser bridge runtime token is empty".to_string());
    }
    Ok(BridgeIdentity {
        base_url: format!("http://{address}"),
        token: Some(token.to_owned()),
        generation: Some((record.pid, record.started_at_unix_ms)),
    })
}

fn environment_identity() -> Option<BridgeIdentity> {
    non_empty_env(BRIDGE_URL_ENV).map(|base_url| BridgeIdentity {
        base_url,
        token: non_empty_env(BRIDGE_TOKEN_ENV),
        generation: None,
    })
}

fn default_identity() -> BridgeIdentity {
    BridgeIdentity {
        base_url: DEFAULT_BRIDGE_URL.to_owned(),
        token: non_empty_env(BRIDGE_TOKEN_ENV),
        generation: None,
    }
}

fn runtime_file_path() -> Option<PathBuf> {
    if let Some(path) = non_empty_env(BRIDGE_RUNTIME_FILE_ENV) {
        return Some(PathBuf::from(path));
    }
    if let Some(home) = non_empty_env("WEGENT_EXECUTOR_HOME") {
        return Some(PathBuf::from(home).join(BRIDGE_RUNTIME_FILE));
    }
    non_empty_env("HOME").map(|home| {
        PathBuf::from(home)
            .join(".wegent-executor")
            .join(BRIDGE_RUNTIME_FILE)
    })
}

fn non_empty_env(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

impl BridgeIdentity {
    fn runtime_process_is_alive(&self) -> bool {
        self.generation
            .map(|(pid, _)| process_is_alive(pid))
            .unwrap_or(true)
    }
}

#[cfg(unix)]
fn process_is_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(not(unix))]
fn process_is_alive(pid: u32) -> bool {
    pid != 0
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::{bridge_identity_from_sources, parse_runtime_identity, BridgeIdentity};

    #[test]
    fn runtime_identity_accepts_only_authenticated_loopback_bridges() {
        let identity = parse_runtime_identity(
            r#"{"schemaVersion":1,"pid":42,"address":"127.0.0.1:43127","token":"secret","startedAtUnixMs":123}"#,
        )
        .unwrap();

        assert_eq!(identity.base_url, "http://127.0.0.1:43127");
        assert_eq!(identity.token.as_deref(), Some("secret"));
        assert!(parse_runtime_identity(
            r#"{"schemaVersion":1,"pid":42,"address":"10.0.0.1:43127","token":"secret","startedAtUnixMs":123}"#
        )
        .is_err());
        assert!(parse_runtime_identity(
            r#"{"schemaVersion":1,"pid":42,"address":"127.0.0.1:43127","token":"","startedAtUnixMs":123}"#
        )
        .is_err());
    }

    #[test]
    fn environment_bridge_identity_takes_precedence_over_runtime_file() {
        let directory = tempdir().unwrap();
        let runtime_path = directory.path().join("embedded-browser-bridge.json");
        fs::write(
            &runtime_path,
            r#"{"schemaVersion":1,"pid":999999,"address":"127.0.0.1:43127","token":"stale","startedAtUnixMs":123}"#,
        )
        .unwrap();

        let identity = bridge_identity_from_sources(
            Some(BridgeIdentity {
                base_url: "http://127.0.0.1:60398".to_owned(),
                token: Some("current-token".to_owned()),
                generation: None,
            }),
            Some(runtime_path),
        );

        assert_eq!(identity.base_url, "http://127.0.0.1:60398");
        assert_eq!(identity.token.as_deref(), Some("current-token"));
    }

    #[test]
    fn stale_runtime_file_falls_back_to_default_identity() {
        let directory = tempdir().unwrap();
        let runtime_path = directory.path().join("embedded-browser-bridge.json");
        fs::write(
            &runtime_path,
            r#"{"schemaVersion":1,"pid":999999,"address":"127.0.0.1:43127","token":"stale","startedAtUnixMs":123}"#,
        )
        .unwrap();

        let identity = bridge_identity_from_sources(None, Some(runtime_path));

        assert_eq!(identity.base_url, "http://127.0.0.1:9231");
    }

    #[test]
    fn live_runtime_file_is_used_when_environment_url_is_missing() {
        let directory = tempdir().unwrap();
        let runtime_path = directory.path().join("embedded-browser-bridge.json");
        fs::write(
            &runtime_path,
            format!(
                r#"{{"schemaVersion":1,"pid":{},"address":"127.0.0.1:43127","token":"runtime-token","startedAtUnixMs":123}}"#,
                std::process::id()
            ),
        )
        .unwrap();

        let identity = bridge_identity_from_sources(None, Some(runtime_path));

        assert_eq!(identity.base_url, "http://127.0.0.1:43127");
        assert_eq!(identity.token.as_deref(), Some("runtime-token"));
    }
}
