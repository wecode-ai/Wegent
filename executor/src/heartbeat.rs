// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    env, fmt,
    sync::{Arc, Mutex},
    time::Duration,
};

use reqwest::Client;
use serde_json::json;
use tokio::task::JoinHandle;

use crate::logging::log_executor_event;

const DEFAULT_HEARTBEAT_INTERVAL_SECONDS: u64 = 10;
const DEFAULT_HEARTBEAT_TIMEOUT_SECONDS: u64 = 5;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeartbeatConfig {
    pub heartbeat_id: String,
    pub heartbeat_type: String,
    pub heartbeat_url: String,
    pub interval: Duration,
    pub timeout: Duration,
}

impl HeartbeatConfig {
    pub fn from_env() -> Option<Self> {
        if !heartbeat_enabled() {
            return None;
        }

        let heartbeat_id = env_value("HEARTBEAT_ID").or_else(|| env_value("SANDBOX_ID"))?;
        let heartbeat_type = env_value("HEARTBEAT_TYPE").unwrap_or_else(|| "sandbox".to_owned());
        let heartbeat_url = build_heartbeat_url(&heartbeat_id, &heartbeat_type)?;
        let interval = Duration::from_secs(env_u64(
            "HEARTBEAT_INTERVAL",
            DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
        ));
        let timeout = Duration::from_secs(DEFAULT_HEARTBEAT_TIMEOUT_SECONDS);

        Some(Self {
            heartbeat_id,
            heartbeat_type,
            heartbeat_url,
            interval,
            timeout,
        })
    }

    fn for_task(task_id: &str) -> Option<Self> {
        let heartbeat_id = task_id.trim();
        if heartbeat_id.is_empty() {
            return None;
        }
        let heartbeat_type = "task".to_owned();
        let heartbeat_url = build_heartbeat_url(heartbeat_id, &heartbeat_type)?;
        Some(Self {
            heartbeat_id: heartbeat_id.to_owned(),
            heartbeat_type,
            heartbeat_url,
            interval: Duration::from_secs(env_u64(
                "HEARTBEAT_INTERVAL",
                DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
            )),
            timeout: Duration::from_secs(DEFAULT_HEARTBEAT_TIMEOUT_SECONDS),
        })
    }
}

#[derive(Debug, Clone, Default)]
pub struct TaskHeartbeatController {
    active: Arc<Mutex<Option<ActiveTaskHeartbeat>>>,
}

#[derive(Debug)]
struct ActiveTaskHeartbeat {
    task_id: String,
    handle: JoinHandle<()>,
}

impl Drop for ActiveTaskHeartbeat {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskHeartbeatActivationError {
    EmptyTaskId,
    MissingEndpoint,
    TaskConflict {
        active_task_id: String,
        requested_task_id: String,
    },
    StateUnavailable,
}

impl fmt::Display for TaskHeartbeatActivationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyTaskId => formatter.write_str("task_id is required"),
            Self::MissingEndpoint => {
                formatter.write_str("executor heartbeat endpoint is not configured")
            }
            Self::TaskConflict {
                active_task_id,
                requested_task_id,
            } => write!(
                formatter,
                "executor is bound to task {active_task_id}, not {requested_task_id}"
            ),
            Self::StateUnavailable => {
                formatter.write_str("executor task binding state is unavailable")
            }
        }
    }
}

impl std::error::Error for TaskHeartbeatActivationError {}

impl TaskHeartbeatController {
    pub fn activate(&self, task_id: &str) -> Result<(), TaskHeartbeatActivationError> {
        let requested_task_id = task_id.trim();
        if requested_task_id.is_empty() {
            return Err(TaskHeartbeatActivationError::EmptyTaskId);
        }

        let mut active = self
            .active
            .lock()
            .map_err(|_| TaskHeartbeatActivationError::StateUnavailable)?;
        if let Some(active) = active.as_ref() {
            if active.task_id == requested_task_id {
                return Ok(());
            }
            return Err(TaskHeartbeatActivationError::TaskConflict {
                active_task_id: active.task_id.clone(),
                requested_task_id: requested_task_id.to_owned(),
            });
        }

        let config = HeartbeatConfig::for_task(requested_task_id)
            .ok_or(TaskHeartbeatActivationError::MissingEndpoint)?;
        let handle = start_heartbeat(config);
        *active = Some(ActiveTaskHeartbeat {
            task_id: requested_task_id.to_owned(),
            handle,
        });
        Ok(())
    }
}

pub fn executor_warm_pool_mode_enabled() -> bool {
    env_value("EXECUTOR_WARMPOOL_MODE").is_some_and(|value| value.eq_ignore_ascii_case("true"))
}

pub fn start_heartbeat_from_env() -> Option<JoinHandle<()>> {
    let config = HeartbeatConfig::from_env()?;
    Some(start_heartbeat(config))
}

pub fn start_heartbeat(config: HeartbeatConfig) -> JoinHandle<()> {
    tokio::spawn(async move {
        log_executor_event(
            "heartbeat service started",
            &[
                ("heartbeat_id", config.heartbeat_id.clone()),
                ("heartbeat_type", config.heartbeat_type.clone()),
                ("heartbeat_url", config.heartbeat_url.clone()),
                ("interval_seconds", config.interval.as_secs().to_string()),
            ],
        );

        let client = match Client::builder().timeout(config.timeout).build() {
            Ok(client) => client,
            Err(error) => {
                log_executor_event(
                    "heartbeat service client init failed",
                    &[("error", error.to_string())],
                );
                return;
            }
        };

        loop {
            send_heartbeat(&client, &config).await;
            tokio::time::sleep(config.interval).await;
        }
    })
}

async fn send_heartbeat(client: &Client, config: &HeartbeatConfig) {
    let response = client
        .post(&config.heartbeat_url)
        .json(&json!({
            "heartbeat_id": config.heartbeat_id,
            "heartbeat_type": config.heartbeat_type,
            "timestamp": chrono::Utc::now().timestamp_millis() as f64 / 1000.0,
        }))
        .send()
        .await;

    match response {
        Ok(response) if response.status().is_success() => {
            log_executor_event(
                "heartbeat sent",
                &[
                    ("heartbeat_id", config.heartbeat_id.clone()),
                    ("heartbeat_type", config.heartbeat_type.clone()),
                    ("status", response.status().as_u16().to_string()),
                ],
            );
        }
        Ok(response) => {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            log_executor_event(
                "heartbeat rejected",
                &[
                    ("heartbeat_id", config.heartbeat_id.clone()),
                    ("heartbeat_type", config.heartbeat_type.clone()),
                    ("status", status.as_u16().to_string()),
                    ("response_preview", truncate_for_log(&body)),
                ],
            );
        }
        Err(error) => {
            log_executor_event(
                "heartbeat request failed",
                &[
                    ("heartbeat_id", config.heartbeat_id.clone()),
                    ("heartbeat_type", config.heartbeat_type.clone()),
                    ("error", error.to_string()),
                    ("is_timeout", error.is_timeout().to_string()),
                    ("is_connect", error.is_connect().to_string()),
                ],
            );
        }
    }
}

fn heartbeat_enabled() -> bool {
    env_value("HEARTBEAT_ENABLED").is_some_and(|value| value.eq_ignore_ascii_case("true"))
}

fn build_heartbeat_url(heartbeat_id: &str, heartbeat_type: &str) -> Option<String> {
    let heartbeat_base = env_value("EXECUTOR_MANAGER_HEARTBEAT_BASE_URL")
        .or_else(|| callback_base_url(env_value("CALLBACK_URL").as_deref()))?;
    let heartbeat_base = heartbeat_base.trim_end_matches('/');

    if heartbeat_type == "sandbox" {
        Some(format!(
            "{heartbeat_base}/sandboxes/{heartbeat_id}/heartbeat"
        ))
    } else {
        Some(format!("{heartbeat_base}/tasks/{heartbeat_id}/heartbeat"))
    }
}

fn callback_base_url(callback_url: Option<&str>) -> Option<String> {
    let callback_url = callback_url?;
    if callback_url.contains("/callback") {
        Some(callback_url.replace("/callback", ""))
    } else {
        None
    }
}

fn env_value(key: &str) -> Option<String> {
    env::var(key)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn env_u64(key: &str, default_value: u64) -> u64 {
    env_value(key)
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(default_value)
}

fn truncate_for_log(value: &str) -> String {
    const LIMIT: usize = 500;
    let mut chars = value.chars();
    let truncated: String = chars.by_ref().take(LIMIT).collect();
    if chars.next().is_some() {
        format!("{truncated}...")
    } else {
        truncated
    }
}

#[cfg(test)]
mod tests {
    use super::{
        callback_base_url, executor_warm_pool_mode_enabled, HeartbeatConfig,
        TaskHeartbeatActivationError, TaskHeartbeatController,
    };
    use std::sync::{Mutex, MutexGuard, OnceLock};

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
    fn sandbox_heartbeat_config_matches_python_env_contract() {
        let _lock = env_lock();
        let _enabled = EnvGuard::set("HEARTBEAT_ENABLED", "true");
        let _id = EnvGuard::set("HEARTBEAT_ID", "1385");
        let _kind = EnvGuard::set("HEARTBEAT_TYPE", "sandbox");
        let _base = EnvGuard::set(
            "EXECUTOR_MANAGER_HEARTBEAT_BASE_URL",
            "http://manager/executor-manager",
        );
        let _callback = EnvGuard::remove("CALLBACK_URL");

        let config = HeartbeatConfig::from_env().unwrap();

        assert_eq!(config.heartbeat_id, "1385");
        assert_eq!(config.heartbeat_type, "sandbox");
        assert_eq!(
            config.heartbeat_url,
            "http://manager/executor-manager/sandboxes/1385/heartbeat"
        );
    }

    #[test]
    fn heartbeat_config_derives_manager_base_from_callback_url() {
        let _lock = env_lock();
        let _enabled = EnvGuard::set("HEARTBEAT_ENABLED", "true");
        let _id = EnvGuard::set("HEARTBEAT_ID", "42");
        let _kind = EnvGuard::set("HEARTBEAT_TYPE", "task");
        let _base = EnvGuard::remove("EXECUTOR_MANAGER_HEARTBEAT_BASE_URL");
        let _callback = EnvGuard::set("CALLBACK_URL", "http://manager/executor-manager/callback");

        let config = HeartbeatConfig::from_env().unwrap();

        assert_eq!(
            config.heartbeat_url,
            "http://manager/executor-manager/tasks/42/heartbeat"
        );
    }

    #[test]
    fn callback_base_url_matches_python_replacement() {
        assert_eq!(
            callback_base_url(Some("http://manager/executor-manager/callback")).unwrap(),
            "http://manager/executor-manager"
        );
    }

    #[test]
    fn executor_warm_pool_mode_requires_explicit_executor_flag() {
        let _lock = env_lock();
        let _generic = EnvGuard::set("WARM_POOL_MODE", "true");
        let _executor = EnvGuard::remove("EXECUTOR_WARMPOOL_MODE");

        assert!(!executor_warm_pool_mode_enabled());

        let _executor = EnvGuard::set("EXECUTOR_WARMPOOL_MODE", "true");
        assert!(executor_warm_pool_mode_enabled());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn dynamic_task_heartbeat_is_idempotent_and_rejects_another_task() {
        let _lock = env_lock();
        let _base = EnvGuard::set(
            "EXECUTOR_MANAGER_HEARTBEAT_BASE_URL",
            "http://127.0.0.1:9/executor-manager",
        );
        let _callback = EnvGuard::remove("CALLBACK_URL");
        let _interval = EnvGuard::set("HEARTBEAT_INTERVAL", "3600");
        let controller = TaskHeartbeatController::default();

        assert_eq!(controller.activate("42"), Ok(()));
        assert_eq!(controller.activate("42"), Ok(()));
        assert_eq!(
            controller.activate("43"),
            Err(TaskHeartbeatActivationError::TaskConflict {
                active_task_id: "42".to_owned(),
                requested_task_id: "43".to_owned(),
            })
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn dynamic_task_heartbeat_requires_manager_endpoint() {
        let _lock = env_lock();
        let _base = EnvGuard::remove("EXECUTOR_MANAGER_HEARTBEAT_BASE_URL");
        let _callback = EnvGuard::remove("CALLBACK_URL");
        let controller = TaskHeartbeatController::default();

        assert_eq!(
            controller.activate("42"),
            Err(TaskHeartbeatActivationError::MissingEndpoint)
        );
    }
}
