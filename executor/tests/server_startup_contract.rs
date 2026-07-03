// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    net::SocketAddr,
    sync::{Mutex, MutexGuard, OnceLock},
};

use wegent_executor::server::{startup_log_line, ServerConfig};

fn env_lock() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(())).lock().unwrap()
}

struct EnvGuard {
    key: &'static str,
    previous: Option<String>,
}

impl EnvGuard {
    fn set(key: &'static str, value: &str) -> Self {
        let previous = std::env::var(key).ok();
        std::env::set_var(key, value);
        Self { key, previous }
    }

    fn remove(key: &'static str) -> Self {
        let previous = std::env::var(key).ok();
        std::env::remove_var(key);
        Self { key, previous }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        if let Some(previous) = &self.previous {
            std::env::set_var(self.key, previous);
        } else {
            std::env::remove_var(self.key);
        }
    }
}

#[test]
fn server_config_uses_executor_image_defaults() {
    let _lock = env_lock();
    let _host = EnvGuard::remove("HOST");
    let _port = EnvGuard::remove("PORT");

    let config = ServerConfig::from_env().unwrap();

    assert_eq!(config.host, "0.0.0.0");
    assert_eq!(config.port, 10001);
    assert_eq!(config.bind_addr().unwrap().to_string(), "0.0.0.0:10001");
}

#[test]
fn server_config_reads_host_and_port_from_environment() {
    let _lock = env_lock();
    let _host = EnvGuard::set("HOST", "127.0.0.1");
    let _port = EnvGuard::set("PORT", "10099");

    let config = ServerConfig::from_env().unwrap();

    assert_eq!(config.host, "127.0.0.1");
    assert_eq!(config.port, 10099);
    assert_eq!(config.bind_addr().unwrap().to_string(), "127.0.0.1:10099");
}

#[test]
fn server_config_rejects_invalid_port() {
    let _lock = env_lock();
    let _host = EnvGuard::remove("HOST");
    let _port = EnvGuard::set("PORT", "invalid");

    let error = ServerConfig::from_env().unwrap_err();

    assert!(error.to_string().contains("invalid PORT"));
}

#[test]
fn server_config_rejects_invalid_bind_host() {
    let config = ServerConfig {
        host: "not a host".to_owned(),
        port: 10001,
    };

    let error = config.bind_addr().unwrap_err();

    assert!(error.to_string().contains("invalid server bind address"));
}

#[test]
fn startup_log_line_includes_bound_address() {
    let bind_addr: SocketAddr = "127.0.0.1:10002".parse().unwrap();
    let line = startup_log_line(bind_addr);

    assert_eq!(line.as_bytes()[4], b'-');
    assert_eq!(line.as_bytes()[7], b'-');
    assert!(line.ends_with(" listening on 127.0.0.1:10002"));
}
