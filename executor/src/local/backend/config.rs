// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    env,
    net::{IpAddr, UdpSocket},
    path::PathBuf,
    time::Duration,
};

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
    pub device_name: String,
    pub device_type: String,
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
        let client_ip = detect_client_ip();
        let runtime_transfer_host = env::var("RUNTIME_TRANSFER_HOST")
            .ok()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| client_ip.clone());

        Self {
            backend_url: config
                .connection
                .backend_url
                .trim()
                .trim_end_matches('/')
                .to_owned(),
            auth_token: normalize_token(&config.connection.auth_token),
            device_id: normalize_nonempty(config.device_id, "local-device"),
            device_name: normalize_nonempty(config.device_name, &default_device_name()),
            device_type: normalize_nonempty(config.device_type, "local"),
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
    token
        .strip_prefix("Bearer ")
        .or_else(|| token.strip_prefix("bearer "))
        .unwrap_or(token)
        .to_owned()
}

fn normalize_nonempty(value: String, default: &str) -> String {
    let value = value.trim();
    if value.is_empty() {
        default.to_owned()
    } else {
        value.to_owned()
    }
}

fn duration_from_env(name: &str, default_seconds: u64) -> Duration {
    env::var(name)
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
        .map(Duration::from_secs)
        .unwrap_or_else(|| Duration::from_secs(default_seconds))
}

fn detect_client_ip() -> String {
    UdpSocket::bind("0.0.0.0:0")
        .and_then(|socket| {
            socket.connect("8.8.8.8:80")?;
            socket.local_addr()
        })
        .ok()
        .map(|address| address.ip().to_string())
        .filter(|ip| is_usable_device_ip(ip))
        .unwrap_or_else(|| "127.0.0.1".to_owned())
}

fn default_device_name() -> String {
    let host = env::var("HOSTNAME")
        .or_else(|_| env::var("COMPUTERNAME"))
        .unwrap_or_else(|_| "local".to_owned());
    format!("{} - {host}", env::consts::OS)
}

fn home_dir() -> PathBuf {
    env::var("HOME")
        .or_else(|_| env::var("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}
