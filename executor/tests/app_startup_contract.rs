// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::sync::{Mutex, MutexGuard, OnceLock};

use axum::{routing::get, Json, Router};
use serde_json::json;
use tokio::net::TcpListener;
use wegent_executor::{
    app::{cli::CliArgs, run, startup_plan, HttpServerPlan, SocketSidecarPlan, StartupPlan},
    services::updater::binary_name_for,
    version::get_version,
};

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
fn default_startup_mode_plans_loopback_http_server_and_socket_sidecar() {
    let _lock = env_lock();
    let _mode = EnvGuard::remove("EXECUTOR_MODE");
    let _backend = EnvGuard::remove("WEGENT_BACKEND_URL");
    let _device_id = EnvGuard::remove("DEVICE_ID");
    let _port = EnvGuard::set("PORT", "10088");
    let _host = EnvGuard::remove("HOST");
    let home = unique_home("default");
    let _home = EnvGuard::set("WEGENT_EXECUTOR_HOME", home.to_str().unwrap());

    let args = CliArgs::parse_from(["wegent-executor"]).unwrap();
    let plan = startup_plan(args).unwrap();

    assert_eq!(
        plan,
        StartupPlan {
            http_server: Some(HttpServerPlan {
                host: "127.0.0.1".to_owned(),
                port: 0,
            }),
            socket_sidecar: Some(SocketSidecarPlan {
                backend_enabled: false,
                device_id: plan.socket_sidecar.as_ref().unwrap().device_id.clone(),
            }),
        }
    );
    let socket_sidecar = plan.socket_sidecar.unwrap();
    assert!(!socket_sidecar.backend_enabled);
    assert!(socket_sidecar.device_id.starts_with("device-"));
    assert_ne!(socket_sidecar.device_id, "local-device");
}

#[test]
fn startup_plan_with_backend_enables_backend_sidecar_and_loopback_http_server() {
    let _lock = env_lock();
    let _mode = EnvGuard::remove("EXECUTOR_MODE");
    let _port = EnvGuard::set("PORT", "10089");
    let _backend = EnvGuard::set("WEGENT_BACKEND_URL", "http://localhost:8000");
    let _device_id = EnvGuard::set("DEVICE_ID", "device-1");
    let home = unique_home("backend");
    let _home = EnvGuard::set("WEGENT_EXECUTOR_HOME", home.to_str().unwrap());

    let args = CliArgs::parse_from(["wegent-executor"]).unwrap();
    let plan = startup_plan(args).unwrap();

    assert_eq!(
        plan,
        StartupPlan {
            http_server: Some(HttpServerPlan {
                host: "127.0.0.1".to_owned(),
                port: 0,
            }),
            socket_sidecar: Some(SocketSidecarPlan {
                backend_enabled: true,
                device_id: "device-1".to_owned(),
            }),
        }
    );
}

#[test]
fn docker_executor_mode_plans_http_without_socket_sidecar() {
    let _lock = env_lock();
    let _mode = EnvGuard::set("EXECUTOR_MODE", "docker");
    let _port = EnvGuard::set("PORT", "10090");
    let _backend = EnvGuard::set("WEGENT_BACKEND_URL", "http://localhost:8000");
    let _device_id = EnvGuard::set("DEVICE_ID", "device-docker");
    let home = unique_home("docker-mode");
    let _home = EnvGuard::set("WEGENT_EXECUTOR_HOME", home.to_str().unwrap());

    let args = CliArgs::parse_from(["wegent-executor"]).unwrap();
    let plan = startup_plan(args).unwrap();

    assert_eq!(
        plan,
        StartupPlan {
            http_server: Some(HttpServerPlan {
                host: "0.0.0.0".to_owned(),
                port: 10090,
            }),
            socket_sidecar: None,
        }
    );
}

#[tokio::test]
async fn upgrade_flag_runs_update_check_without_starting_runtime() {
    let current_version = get_version();
    let (registry_url, _server) = registry_server(&current_version).await;
    let config_path = unique_home("upgrade").join("device-config.json");
    std::fs::create_dir_all(config_path.parent().unwrap()).unwrap();
    std::fs::write(
        &config_path,
        json!({
            "mode": "local",
            "device_id": "upgrade-device",
            "update": {
                "registry": registry_url,
                "registry_token": "registry-token"
            }
        })
        .to_string(),
    )
    .unwrap();
    let args = CliArgs::parse_from([
        "wegent-executor",
        "--upgrade",
        "--yes",
        "--config",
        config_path.to_str().unwrap(),
    ])
    .unwrap();

    run(args).await.unwrap();
}

async fn registry_server(version: &str) -> (String, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let route = format!(
        "/{}/update.json",
        binary_name_for(std::env::consts::OS, std::env::consts::ARCH)
    );
    let response = json!({
        "version": version,
        "url": "https://example.com/download"
    });
    let app = Router::new().route(&route, get(move || async move { Json(response) }));
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (base_url, server)
}

fn unique_home(label: &str) -> std::path::PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "wegent-executor-app-startup-{label}-{}-{nanos}",
        std::process::id()
    ))
}
