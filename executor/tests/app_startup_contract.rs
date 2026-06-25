// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::sync::{Mutex, MutexGuard, OnceLock};

use wegent_executor::app::{cli::CliArgs, startup_plan, StartupPlan};

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
fn docker_mode_plans_http_server_with_image_defaults() {
    let _lock = env_lock();
    let _mode = EnvGuard::set("EXECUTOR_MODE", "docker");
    let _port = EnvGuard::set("PORT", "10088");
    let _host = EnvGuard::remove("HOST");

    let args = CliArgs::parse_from(["wegent-executor"]).unwrap();
    let plan = startup_plan(args).unwrap();

    assert_eq!(
        plan,
        StartupPlan::DockerServer {
            host: "0.0.0.0".to_owned(),
            port: 10088
        }
    );
    assert_eq!(plan.bind_addr().unwrap().to_string(), "0.0.0.0:10088");
}

#[test]
fn local_mode_without_backend_plans_app_ipc_sidecar() {
    let _lock = env_lock();
    let _mode = EnvGuard::remove("EXECUTOR_MODE");
    let _backend = EnvGuard::remove("WEGENT_BACKEND_URL");
    let _device_id = EnvGuard::remove("DEVICE_ID");
    let _home = EnvGuard::set("WEGENT_EXECUTOR_HOME", unique_home("no-backend").as_str());

    let args = CliArgs::parse_from(["wegent-executor"]).unwrap();
    let plan = startup_plan(args).unwrap();

    assert_eq!(
        plan,
        StartupPlan::LocalSidecar {
            backend_enabled: false,
            device_id: "local-device".to_owned()
        }
    );
}

#[test]
fn local_mode_with_backend_plans_sidecar_plus_backend_runner() {
    let _lock = env_lock();
    let _mode = EnvGuard::remove("EXECUTOR_MODE");
    let _backend = EnvGuard::set("WEGENT_BACKEND_URL", "http://localhost:8000");
    let _device_id = EnvGuard::set("DEVICE_ID", "device-1");
    let _home = EnvGuard::set("WEGENT_EXECUTOR_HOME", unique_home("backend").as_str());

    let args = CliArgs::parse_from(["wegent-executor"]).unwrap();
    let plan = startup_plan(args).unwrap();

    assert_eq!(
        plan,
        StartupPlan::LocalSidecar {
            backend_enabled: true,
            device_id: "device-1".to_owned()
        }
    );
}

fn unique_home(label: &str) -> String {
    std::env::temp_dir()
        .join(format!(
            "wegent-executor-app-startup-{label}-{}",
            std::process::id()
        ))
        .display()
        .to_string()
}
