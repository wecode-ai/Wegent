// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::task_runtime::{
    mcp::{CloudCollaborationRoundCommand, CloudCollaborationRoundDispatcher},
    mcp_http::register_cloud_collaboration_dispatcher,
};

const CLOUD_COLLABORATION_ROUND_KEY: &str = "cloudCollaborationRound";
const TERMINAL_EXECUTION_STATUSES: &[&str] = &["completed", "failed", "cancelled"];
const CLOUD_COLLABORATION_POLL_INTERVAL: Duration = Duration::from_secs(2);
const CLOUD_COLLABORATION_RESUME_INTERVAL: Duration = Duration::from_secs(1);

impl RuntimeWorkRpcHandler {
    pub(super) fn register_cloud_collaboration_dispatcher(&self) {
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            log_executor_event(
                "cloud collaboration dispatcher registration skipped",
                &[("reason", "tokio runtime is unavailable".to_owned())],
            );
            return;
        };
        let handler = self.clone();
        let dispatcher = CloudCollaborationRoundDispatcher::new(move |command| {
            handler.persist_cloud_collaboration_round(&command)?;
            let handler = handler.clone();
            runtime.spawn(async move {
                handler.monitor_cloud_collaboration_round(command).await;
            });
            Ok(())
        });
        if let Err(error) = register_cloud_collaboration_dispatcher(dispatcher) {
            log_executor_event(
                "cloud collaboration dispatcher registration failed",
                &[("error", error)],
            );
        }
    }

    pub(super) fn resume_cloud_collaboration_rounds(&self) {
        for link in self.local_task_links(false) {
            let Some(command) = link
                .runtime_handle
                .get(CLOUD_COLLABORATION_ROUND_KEY)
                .cloned()
                .and_then(|value| {
                    serde_json::from_value::<CloudCollaborationRoundCommand>(value).ok()
                })
            else {
                continue;
            };
            let handler = self.clone();
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(async move {
                    handler.monitor_cloud_collaboration_round(command).await;
                });
            }
        }
    }

    fn persist_cloud_collaboration_round(
        &self,
        command: &CloudCollaborationRoundCommand,
    ) -> Result<(), String> {
        if self
            .local_task_link(&command.manager_runtime_task_id)
            .is_none()
        {
            return Err("Collaboration manager Runtime task was not found".to_owned());
        }
        let encoded = serde_json::to_value(command).map_err(|error| error.to_string())?;
        self.store
            .update_task(&command.manager_runtime_task_id, |link| {
                if !link.runtime_handle.is_object() {
                    link.runtime_handle = json!({});
                }
                link.runtime_handle
                    .as_object_mut()
                    .expect("Runtime handle was normalized")
                    .insert(CLOUD_COLLABORATION_ROUND_KEY.to_owned(), encoded);
            });
        Ok(())
    }

    fn clear_cloud_collaboration_round(&self, manager_runtime_task_id: &str) {
        self.store.update_task(manager_runtime_task_id, |link| {
            if let Some(handle) = link.runtime_handle.as_object_mut() {
                handle.remove(CLOUD_COLLABORATION_ROUND_KEY);
            }
        });
    }

    async fn monitor_cloud_collaboration_round(&self, command: CloudCollaborationRoundCommand) {
        let key = format!("{}:{}", command.manager_runtime_task_id, command.round_id);
        {
            let mut active = self
                .active_collaboration_rounds
                .lock()
                .expect("collaboration round registry lock should not be poisoned");
            if !active.insert(key.clone()) {
                return;
            }
        }

        let result = match self.wait_for_cloud_collaboration_round(&command).await {
            Ok(outcomes) => {
                self.wait_for_cloud_manager_idle(&command.manager_runtime_task_id)
                    .await;
                self.resume_cloud_manager(&command, outcomes).await
            }
            Err(error) => Err(error),
        };
        if let Err(error) = result {
            log_executor_event(
                "cloud collaboration round failed",
                &[
                    ("dispatch_id", command.dispatch_id.clone()),
                    ("round_id", command.round_id.clone()),
                    ("error", error),
                ],
            );
        }
        self.active_collaboration_rounds
            .lock()
            .expect("collaboration round registry lock should not be poisoned")
            .remove(&key);
    }

    async fn wait_for_cloud_collaboration_round(
        &self,
        command: &CloudCollaborationRoundCommand,
    ) -> Result<Vec<Value>, String> {
        let client = reqwest::Client::new();
        loop {
            let connection = self
                .backend_connection_snapshot()
                .map_err(|error| error.message)?
                .filter(|value| {
                    !value.backend_url.trim().is_empty() && !value.auth_token.trim().is_empty()
                });
            let Some(connection) = connection else {
                sleep(CLOUD_COLLABORATION_POLL_INTERVAL).await;
                continue;
            };
            let response = match client
                .post(format!(
                    "{}/api/v1/cloud-projects/{}/executions/statuses",
                    connection.backend_url.trim_end_matches('/'),
                    command.project_id
                ))
                .bearer_auth(&connection.auth_token)
                .json(&json!({"execution_ids": command.execution_ids}))
                .send()
                .await
            {
                Ok(response) => response,
                Err(error) => {
                    log_executor_event(
                        "cloud collaboration status request failed",
                        &[
                            ("round_id", command.round_id.clone()),
                            ("error", error.to_string()),
                        ],
                    );
                    sleep(CLOUD_COLLABORATION_POLL_INTERVAL).await;
                    continue;
                }
            };
            if !response.status().is_success() {
                let status = response.status();
                if status.is_server_error() || status.as_u16() == 429 {
                    log_executor_event(
                        "cloud collaboration status request rejected temporarily",
                        &[
                            ("round_id", command.round_id.clone()),
                            ("status", status.to_string()),
                        ],
                    );
                    sleep(CLOUD_COLLABORATION_POLL_INTERVAL).await;
                    continue;
                }
                return Err(format!("Collaboration status request failed ({status})"));
            }
            let value = match response.json::<Value>().await {
                Ok(value) => value,
                Err(error) => {
                    log_executor_event(
                        "cloud collaboration status response was invalid",
                        &[
                            ("round_id", command.round_id.clone()),
                            ("error", error.to_string()),
                        ],
                    );
                    sleep(CLOUD_COLLABORATION_POLL_INTERVAL).await;
                    continue;
                }
            };
            let outcomes = value
                .get("items")
                .and_then(Value::as_array)
                .cloned()
                .ok_or_else(|| "Collaboration execution status response is invalid".to_owned())?;
            if outcomes.iter().all(|outcome| {
                outcome
                    .get("status")
                    .and_then(Value::as_str)
                    .is_some_and(|status| TERMINAL_EXECUTION_STATUSES.contains(&status))
            }) {
                return Ok(outcomes);
            }
            sleep(CLOUD_COLLABORATION_POLL_INTERVAL).await;
        }
    }

    async fn wait_for_cloud_manager_idle(&self, manager_runtime_task_id: &str) {
        while self.is_busy_local_task(manager_runtime_task_id) {
            sleep(Duration::from_millis(200)).await;
        }
    }

    async fn resume_cloud_manager(
        &self,
        command: &CloudCollaborationRoundCommand,
        outcomes: Vec<Value>,
    ) -> Result<(), String> {
        loop {
            let Some(link) = self.local_task_link(&command.manager_runtime_task_id) else {
                return Err("Collaboration manager Runtime task was not found".to_owned());
            };
            let mut request = runtime_event_request_from_link(&link);
            request.subtask_id = format!(
                "{}-collaboration-round-{}",
                command.manager_runtime_task_id, command.round_id
            );
            request.prompt = Value::String(format!(
                "上一轮任务已经全部结束。请读取以下执行结果，综合判断是否需要分配下一轮任务；如 Issue 已达到待确认或完成条件，请显式调用 update_issue_status。不要直接执行成员工作。\n\n{}",
                serde_json::to_string_pretty(&outcomes).unwrap_or_else(|_| "[]".to_owned()),
            ));
            request.new_session = false;
            self.apply_backend_connection(&mut request);
            let response = self
                .send_message(json!({
                    "taskId": command.manager_runtime_task_id,
                    "executionRequest": request,
                }))
                .await;
            match response {
                Ok(value)
                    if value.get("success").and_then(Value::as_bool) == Some(true)
                        && value.get("accepted").and_then(Value::as_bool) == Some(true) =>
                {
                    self.clear_cloud_collaboration_round(&command.manager_runtime_task_id);
                    return Ok(());
                }
                Ok(value) => {
                    log_executor_event(
                        "cloud collaboration manager resume rejected",
                        &[
                            ("round_id", command.round_id.clone()),
                            ("response", value.to_string()),
                        ],
                    );
                }
                Err(error) => {
                    log_executor_event(
                        "cloud collaboration manager resume failed",
                        &[
                            ("round_id", command.round_id.clone()),
                            ("error", error.message),
                        ],
                    );
                }
            }
            sleep(CLOUD_COLLABORATION_RESUME_INTERVAL).await;
            self.wait_for_cloud_manager_idle(&command.manager_runtime_task_id)
                .await;
        }
    }
}
