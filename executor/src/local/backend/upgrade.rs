// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
};

use serde_json::{json, Value};

use crate::{
    config::device::UpdateConfig,
    services::updater::{ProcessManager, RestartPlan, UpdateResult, UpdaterService},
};

use super::{DeviceUpgradeHandler, LocalBackendClient, LocalBackendTransport, LocalTaskController};

const UPGRADE_STATUS_EVENT: &str = "device:upgrade_status";

pub trait LocalUpgradeService: Send + Sync + 'static {
    fn check_and_update<'a>(
        &'a self,
        update_config: UpdateConfig,
        auto_confirm: bool,
        verbose: bool,
    ) -> Pin<Box<dyn Future<Output = UpdateResult> + Send + 'a>>;
}

pub trait DeviceRestartScheduler: Send + Sync + 'static {
    fn schedule_restart<'a>(
        &'a self,
        verbose: bool,
    ) -> Pin<Box<dyn Future<Output = bool> + Send + 'a>>;
}

#[derive(Clone, Default)]
pub(super) struct DefaultLocalUpgradeService;

impl LocalUpgradeService for DefaultLocalUpgradeService {
    fn check_and_update<'a>(
        &'a self,
        update_config: UpdateConfig,
        auto_confirm: bool,
        _verbose: bool,
    ) -> Pin<Box<dyn Future<Output = UpdateResult> + Send + 'a>> {
        Box::pin(async move {
            UpdaterService::new(update_config, auto_confirm)
                .check_and_update()
                .await
        })
    }
}

#[derive(Clone, Default)]
pub(super) struct NoopRestartScheduler;

impl DeviceRestartScheduler for NoopRestartScheduler {
    fn schedule_restart<'a>(
        &'a self,
        _verbose: bool,
    ) -> Pin<Box<dyn Future<Output = bool> + Send + 'a>> {
        Box::pin(async { true })
    }
}

#[derive(Clone, Default)]
pub(super) struct ProcessRestartScheduler;

impl DeviceRestartScheduler for ProcessRestartScheduler {
    fn schedule_restart<'a>(
        &'a self,
        verbose: bool,
    ) -> Pin<Box<dyn Future<Output = bool> + Send + 'a>> {
        Box::pin(async move {
            let Ok(binary) = std::env::current_exe() else {
                return false;
            };
            let binary = binary.display().to_string();
            let args = std::env::args().skip(1).collect::<Vec<_>>();
            let plan = RestartPlan::for_binary(&binary, args, verbose);
            if !ProcessManager::default().spawn_restart(&plan) {
                return false;
            }
            tokio::spawn(async {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                std::process::exit(0);
            });
            true
        })
    }
}

#[derive(Clone)]
pub struct LocalDeviceUpgradeHandler<T>
where
    T: LocalBackendTransport,
{
    client: LocalBackendClient<T>,
    task_controller: Option<Arc<dyn LocalTaskController>>,
    update_config: UpdateConfig,
    service: Arc<dyn LocalUpgradeService>,
    restart_scheduler: Arc<dyn DeviceRestartScheduler>,
    in_progress: Arc<Mutex<bool>>,
}

impl<T> LocalDeviceUpgradeHandler<T>
where
    T: LocalBackendTransport,
{
    pub fn with_service<S>(
        client: LocalBackendClient<T>,
        task_controller: Option<Arc<dyn LocalTaskController>>,
        update_config: UpdateConfig,
        service: S,
    ) -> Self
    where
        S: LocalUpgradeService,
    {
        Self {
            client,
            task_controller,
            update_config,
            service: Arc::new(service),
            restart_scheduler: Arc::new(NoopRestartScheduler),
            in_progress: Arc::new(Mutex::new(false)),
        }
    }

    pub(super) fn with_service_arc(
        client: LocalBackendClient<T>,
        task_controller: Option<Arc<dyn LocalTaskController>>,
        update_config: UpdateConfig,
        service: Arc<dyn LocalUpgradeService>,
    ) -> Self {
        Self {
            client,
            task_controller,
            update_config,
            service,
            restart_scheduler: Arc::new(NoopRestartScheduler),
            in_progress: Arc::new(Mutex::new(false)),
        }
    }

    pub(super) fn with_service_and_restart<S, R>(
        client: LocalBackendClient<T>,
        task_controller: Option<Arc<dyn LocalTaskController>>,
        update_config: UpdateConfig,
        service: S,
        restart_scheduler: R,
    ) -> Self
    where
        S: LocalUpgradeService,
        R: DeviceRestartScheduler,
    {
        Self {
            client,
            task_controller,
            update_config,
            service: Arc::new(service),
            restart_scheduler: Arc::new(restart_scheduler),
            in_progress: Arc::new(Mutex::new(false)),
        }
    }

    async fn run_upgrade(&self, payload: Value) -> Value {
        if !self.try_start_upgrade() {
            self.emit_status(
                "error",
                "Upgrade already in progress",
                None,
                None,
                Some("Upgrade already in progress"),
                None,
            )
            .await;
            return json!({
                "success": false,
                "status": "error",
                "error": "Upgrade already in progress",
            });
        }

        let result = self.run_upgrade_inner(payload).await;
        *self.in_progress.lock().expect("upgrade state lock") = false;
        result
    }

    async fn run_upgrade_inner(&self, payload: Value) -> Value {
        let running_task_ids = self
            .task_controller
            .as_ref()
            .map(|controller| controller.running_task_ids())
            .unwrap_or_default();
        if !running_task_ids.is_empty() && !payload_bool(&payload, "force_stop_tasks", false) {
            self.emit_status(
                "busy",
                "Cannot upgrade: tasks are running",
                None,
                None,
                None,
                None,
            )
            .await;
            return json!({
                "success": false,
                "status": "busy",
                "error": "Cannot upgrade: tasks are running",
                "running_task_ids": running_task_ids,
            });
        }

        if !running_task_ids.is_empty() {
            if let Some(controller) = &self.task_controller {
                for task_id in running_task_ids {
                    if !controller.cancel_task(task_id, None).await {
                        self.emit_status(
                            "error",
                            "Failed to stop running tasks",
                            None,
                            None,
                            Some("Failed to stop running tasks"),
                            None,
                        )
                        .await;
                        return json!({
                            "success": false,
                            "status": "error",
                            "error": "Failed to stop running tasks",
                        });
                    }
                }
                self.client
                    .set_running_task_ids(controller.running_task_ids());
                let _ = self
                    .client
                    .send_heartbeat(self.client.config.heartbeat_timeout)
                    .await;
            }
        }

        self.emit_status(
            "checking",
            "Checking for updates...",
            None,
            None,
            None,
            None,
        )
        .await;

        let update_config = request_update_config(&self.update_config, &payload);
        let auto_confirm = payload_bool(&payload, "auto_confirm", true);
        let verbose = payload_bool(&payload, "verbose", false);
        let result = self
            .service
            .check_and_update(update_config, auto_confirm, verbose)
            .await;
        self.emit_result_status(&result, verbose).await;
        result_ack(result)
    }

    fn try_start_upgrade(&self) -> bool {
        let mut in_progress = self.in_progress.lock().expect("upgrade state lock");
        if *in_progress {
            return false;
        }
        *in_progress = true;
        true
    }

    async fn emit_result_status(&self, result: &UpdateResult, verbose: bool) {
        if result.success && result.already_latest {
            self.emit_status(
                "skipped",
                "Already on latest version",
                result.old_version.as_deref(),
                result.new_version.as_deref(),
                None,
                None,
            )
            .await;
            return;
        }

        if result.success {
            self.emit_status(
                "success",
                "Upgrade completed successfully",
                result.old_version.as_deref(),
                result.new_version.as_deref(),
                None,
                None,
            )
            .await;
            self.emit_status(
                "restarting",
                "Restarting executor...",
                result.old_version.as_deref(),
                result.new_version.as_deref(),
                None,
                None,
            )
            .await;
            if !self.restart_scheduler.schedule_restart(verbose).await {
                self.emit_status(
                    "error",
                    "Failed to restart executor",
                    result.old_version.as_deref(),
                    result.new_version.as_deref(),
                    Some("Failed to restart executor"),
                    None,
                )
                .await;
            }
            return;
        }

        let error = result.error.as_deref().unwrap_or("unknown error");
        self.emit_status(
            "error",
            &format!("Upgrade failed: {error}"),
            result.old_version.as_deref(),
            result.new_version.as_deref(),
            Some(error),
            None,
        )
        .await;
    }

    async fn emit_status(
        &self,
        status: &str,
        message: &str,
        old_version: Option<&str>,
        new_version: Option<&str>,
        error: Option<&str>,
        progress: Option<u8>,
    ) {
        let mut payload = json!({
            "device_id": self.client.config.device_id,
            "status": status,
            "message": message,
        });
        if let Some(old_version) = old_version {
            payload["old_version"] = json!(old_version);
        }
        if let Some(new_version) = new_version {
            payload["new_version"] = json!(new_version);
        }
        if let Some(error) = error {
            payload["error"] = json!(error);
        }
        if let Some(progress) = progress {
            payload["progress"] = json!(progress);
        }
        let _ = self.emit_status_payload(payload).await;
    }

    async fn emit_status_payload(&self, payload: Value) -> Result<(), String> {
        self.client
            .emit_raw_event(UPGRADE_STATUS_EVENT, payload)
            .await
    }
}

impl<T> DeviceUpgradeHandler for LocalDeviceUpgradeHandler<T>
where
    T: LocalBackendTransport,
{
    fn handle_upgrade<'a>(
        &'a self,
        payload: Value,
    ) -> Pin<Box<dyn Future<Output = Value> + Send + 'a>> {
        Box::pin(async move { self.run_upgrade(payload).await })
    }
}

pub(super) fn default_upgrade_handler<T>(
    client: LocalBackendClient<T>,
    task_controller: Option<Arc<dyn LocalTaskController>>,
    update_config: UpdateConfig,
) -> LocalDeviceUpgradeHandler<T>
where
    T: LocalBackendTransport,
{
    LocalDeviceUpgradeHandler::with_service_and_restart(
        client,
        task_controller,
        update_config,
        DefaultLocalUpgradeService,
        ProcessRestartScheduler,
    )
}

fn request_update_config(base: &UpdateConfig, payload: &Value) -> UpdateConfig {
    let mut config = base.clone();
    if let Some(registry) = payload_string(payload, "registry") {
        config.registry = registry;
    }
    if let Some(registry_token) = payload_string(payload, "registry_token") {
        config.registry_token = registry_token;
    }
    config
}

fn result_ack(result: UpdateResult) -> Value {
    json!({
        "success": result.success,
        "already_latest": result.already_latest,
        "old_version": result.old_version,
        "new_version": result.new_version,
        "error": result.error,
    })
}

fn payload_bool(payload: &Value, key: &str, default: bool) -> bool {
    payload.get(key).and_then(Value::as_bool).unwrap_or(default)
}

fn payload_string(payload: &Value, key: &str) -> Option<String> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}
