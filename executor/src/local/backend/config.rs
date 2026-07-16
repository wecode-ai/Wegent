// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    env,
    net::{IpAddr, SocketAddr, ToSocketAddrs, UdpSocket},
    path::PathBuf,
    time::Duration,
};

use reqwest::Url;

use crate::{
    config::device::{DeviceConfig, UpdateConfig},
    version::get_version,
};

const DEFAULT_HEARTBEAT_INTERVAL_SECONDS: u64 = 30;
const DEFAULT_HEARTBEAT_TIMEOUT_SECONDS: u64 = 10;
const DEFAULT_RECONNECT_DELAY_SECONDS: u64 = 1;
const DEFAULT_RECONNECT_MAX_DELAY_SECONDS: u64 = 30;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalBackendConfig {
    pub backend_url: String,
    pub auth_token: String,
    pub device_id: String,
    pub runtime_instance_id: String,
    pub device_name: String,
    pub device_type: String,
    pub app_device_id: String,
    pub bind_shell: String,
    pub executor_version: String,
    pub client_ip: String,
    pub runtime_transfer_host: String,
    pub heartbeat_interval: Duration,
    pub heartbeat_timeout: Duration,
    pub registration_timeout: Duration,
    pub reconnect_delay: Duration,
    pub reconnect_delay_max: Duration,
    pub configured_capabilities: Vec<String>,
    pub runtime_auth_home: PathBuf,
    pub local_workspace_root: PathBuf,
    pub update: UpdateConfig,
}

impl LocalBackendConfig {
    pub fn from_device_config(config: DeviceConfig) -> Self {
        let backend_url = config
            .connection
            .backend_url
            .trim()
            .trim_end_matches('/')
            .to_owned();
        let client_ip = detect_client_ip(&backend_url);
        let runtime_transfer_host = env::var("RUNTIME_TRANSFER_HOST")
            .ok()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| client_ip.clone());

        Self {
            backend_url,
            auth_token: normalize_token(&config.connection.auth_token),
            device_id: normalize_nonempty(config.device_id, "local-device"),
            runtime_instance_id: normalize_nonempty(config.runtime_instance_id, "runtime-local"),
            device_name: normalize_nonempty(config.device_name, &default_device_name()),
            device_type: normalize_nonempty(config.device_type, "local"),
            app_device_id: normalize_optional_env("WEGENT_APP_IPC_DEVICE_ID"),
            bind_shell: normalize_nonempty(config.bind_shell, "claudecode").to_ascii_lowercase(),
            executor_version: get_version(),
            client_ip,
            runtime_transfer_host,
            heartbeat_interval: duration_from_env(
                "LOCAL_HEARTBEAT_INTERVAL",
                DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
            ),
            heartbeat_timeout: duration_from_env(
                "LOCAL_HEARTBEAT_CALL_TIMEOUT",
                DEFAULT_HEARTBEAT_TIMEOUT_SECONDS,
            ),
            registration_timeout: Duration::from_secs(10),
            reconnect_delay: duration_from_env(
                "LOCAL_RECONNECT_DELAY",
                DEFAULT_RECONNECT_DELAY_SECONDS,
            ),
            reconnect_delay_max: duration_from_env(
                "LOCAL_RECONNECT_MAX_DELAY",
                DEFAULT_RECONNECT_MAX_DELAY_SECONDS,
            ),
            configured_capabilities: config.capabilities,
            runtime_auth_home: home_dir(),
            local_workspace_root: config.local_workspace_root,
            update: config.update,
        }
    }
}

pub fn is_usable_device_ip(value: &str) -> bool {
    match value.trim().parse::<IpAddr>() {
        Ok(address) => !is_unusable_ip(address),
        Err(_) => false,
    }
}

fn is_unusable_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            address.is_loopback()
                || address.is_unspecified()
                || address.is_multicast()
                || address.is_link_local()
        }
        IpAddr::V6(address) => {
            address.is_loopback()
                || address.is_unspecified()
                || address.is_multicast()
                || (address.segments()[0] & 0xffc0) == 0xfe80
        }
    }
}

fn normalize_token(token: &str) -> String {
    let token = token.trim();
    if let Some(separator) = token.find(char::is_whitespace) {
        let (scheme, value) = token.split_at(separator);
        if scheme.eq_ignore_ascii_case("bearer") {
            return value.trim().to_owned();
        }
    }
    token.to_owned()
}

fn normalize_nonempty(value: String, default: &str) -> String {
    let value = value.trim();
    if value.is_empty() {
        default.to_owned()
    } else {
        value.to_owned()
    }
}

fn normalize_optional_env(name: &str) -> String {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_default()
}

fn duration_from_env(name: &str, default_seconds: u64) -> Duration {
    env::var(name)
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
        .map(Duration::from_secs)
        .unwrap_or_else(|| Duration::from_secs(default_seconds))
}

fn detect_client_ip(backend_url: &str) -> String {
    detect_route_source_ip(backend_url).unwrap_or_else(|| "127.0.0.1".to_owned())
}

fn detect_route_source_ip(backend_url: &str) -> Option<String> {
    let backend_addr = backend_socket_addr(backend_url)?;
    let bind_addr = match backend_addr {
        SocketAddr::V4(_) => "0.0.0.0:0",
        SocketAddr::V6(_) => "[::]:0",
    };
    let socket = UdpSocket::bind(bind_addr).ok()?;
    socket.connect(backend_addr).ok()?;
    let source_ip = socket.local_addr().ok()?.ip();
    is_valid_source_ip(source_ip).then(|| source_ip.to_string())
}

fn backend_socket_addr(backend_url: &str) -> Option<SocketAddr> {
    let url = Url::parse(backend_url).ok()?;
    let host = url.host_str()?;
    let port = url.port_or_known_default()?;
    (host, port).to_socket_addrs().ok()?.next()
}

fn is_valid_source_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => !address.is_unspecified() && !address.is_multicast(),
        IpAddr::V6(address) => !address.is_unspecified() && !address.is_multicast(),
    }
}

fn default_device_name() -> String {
    let host = env::var("HOSTNAME")
        .or_else(|_| env::var("COMPUTERNAME"))
        .unwrap_or_else(|_| "local".to_owned());
    format!("{} - {host}", env::consts::OS)
}

fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

#[cfg(test)]
mod tests {
    use super::{detect_client_ip, normalize_token};

    #[test]
    fn normalize_token_strips_bearer_scheme_case_insensitively() {
        assert_eq!(normalize_token("Bearer wg-token"), "wg-token");
        assert_eq!(normalize_token("bEaReR\t  wg-token  "), "wg-token");
        assert_eq!(normalize_token("Token wg-token"), "Token wg-token");
        assert_eq!(normalize_token("wg-token"), "wg-token");
    }

    #[test]
    fn detect_client_ip_uses_backend_route_source_address() {
        assert_eq!(detect_client_ip("http://127.0.0.1:8000"), "127.0.0.1");
    }
}
