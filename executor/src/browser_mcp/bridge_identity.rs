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
    read_runtime_identity().unwrap_or_else(environment_identity)
}

fn read_runtime_identity() -> Option<BridgeIdentity> {
    let content = fs::read_to_string(runtime_file_path()?).ok()?;
    parse_runtime_identity(&content).ok()
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

fn environment_identity() -> BridgeIdentity {
    BridgeIdentity {
        base_url: non_empty_env(BRIDGE_URL_ENV).unwrap_or_else(|| DEFAULT_BRIDGE_URL.to_owned()),
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

#[cfg(test)]
mod tests {
    use super::parse_runtime_identity;

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
}
