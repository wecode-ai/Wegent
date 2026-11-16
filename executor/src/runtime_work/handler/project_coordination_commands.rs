//! Personal and project Routers submit effects through existing authoritative queues.
use super::stand_in::settings_error;
use super::*;

#[cfg(test)]
#[path = "project_coordination_commands_tests.rs"]
pub(super) mod tests;

impl RuntimeWorkRpcHandler {
    pub(super) async fn project_coordination_command(
        &self,
        method: &str,
        payload: Value,
    ) -> Result<Value, AppIpcError> {
        let user = payload["userId"]
            .as_i64()
            .filter(|user| *user >= 0)
            .ok_or_else(|| AppIpcError::new("bad_request", "userId is required"))?;
        let project = super::stand_in_tasks::required(&payload, "projectId")?;
        let group = super::stand_in_tasks::required(&payload, "groupId")?;
        let command = super::stand_in_tasks::required(&payload, "commandId")?;
        let storage = super::stand_in_tasks::required(&payload, "projectStore")?;
        super::project_coordinator::validate_project_coordinator_target(project, group)?;
        if command.is_empty()
            || command.len() > 64
            || !command
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
        {
            return Err(AppIpcError::new(
                "bad_request",
                "Invalid coordination command identity",
            ));
        }
        if !matches!(storage, "local" | "cloud") {
            return Err(AppIpcError::new("bad_request", "Invalid project storage"));
        }
        if storage == "cloud" || self.backend_connection_snapshot()?.is_some() {
            self.verify_runtime_user(&json!({"userId":user})).await?;
        }
        let dispatch = method == "runtime.project_coordinator.command.dispatch";
        let mut input = payload["input"].clone();
        if input.is_object() {
            input["deviceId"] = json!(self.device_id);
        }
        if storage == "cloud" {
            return self.project_coordination_http(if dispatch { reqwest::Method::PUT } else { reqwest::Method::GET },
                &format!("/v1/cloud-projects/{project}/coordinator-bindings/{group}/commands/{command}"), dispatch.then_some(&input)).await;
        }
        let store = LocalTaskStore::open(self.task_store_path.as_ref()).map_err(settings_error)?;
        if dispatch {
            store.dispatch_project_coordination_command(
                user,
                &self.device_id,
                project,
                group,
                command,
                &input,
            )
        } else {
            store.project_coordination_command_receipt(user, project, group, command)
        }
        .map_err(settings_error)
    }

    pub(super) async fn project_coordination_http(
        &self,
        method: reqwest::Method,
        path: &str,
        input: Option<&Value>,
    ) -> Result<Value, AppIpcError> {
        let response = self.runtime_request(method, path, input).await?;
        let status = response.status();
        let body: Value = response.json().await.map_err(|_| {
            AppIpcError::new(
                "cloud_response_invalid",
                "Invalid project coordination response",
            )
        })?;
        if !status.is_success() {
            let code = match status.as_u16() {
                409 => "stale_context",
                403 => "permission_denied",
                404 => "project_unavailable",
                _ => "cloud_request_failed",
            };
            return Err(AppIpcError::new(
                code,
                body["detail"]
                    .as_str()
                    .map(ToOwned::to_owned)
                    .unwrap_or_else(|| format!("Project coordination request returned {status}")),
            ));
        }
        Ok(body)
    }

    pub(super) async fn reconcile_local_project_coordination(&self) {
        let revoked = LocalTaskStore::open(self.task_store_path.as_ref())
            .and_then(|store| store.reconcile_project_coordination_authority());
        let revoked = match revoked {
            Ok(rows) => rows,
            Err(error) => {
                log_executor_event(
                    "local project coordination authority check failed",
                    &[("error", error.to_string())],
                );
                return;
            }
        };
        for row in revoked.into_iter().filter(|row| {
            row.status == "cancel_requested"
                && row.runtime_device_id.as_deref() == Some(&self.device_id)
        }) {
            let Some(task) = row.runtime_task_id else {
                continue;
            };
            let removed = match self.remove_queued_turn(&task).await {
                Ok(removed) => removed,
                Err(error) => {
                    log_executor_event(
                        "local project coordination queue cancellation failed",
                        &[("error", error.message)],
                    );
                    continue;
                }
            };
            let reserved = self
                .turn_scheduler
                .lock()
                .expect("runtime scheduler lock")
                .active_task_ids
                .contains_key(&task);
            let queue_cancelled = self
                .local_task_link(&task)
                .and_then(|link| crate::runtime_work::lifecycle::native_execution_state(&link))
                .is_some_and(|state| {
                    state.phase == crate::runtime_work::lifecycle::NativeExecutionPhase::Idle
                        && state.execution_outcome.as_deref() == Some("cancelled")
                });
            if !reserved && !self.is_active_local_task(&task) && (removed || queue_cancelled) {
                self.finish_queue_run(
                    &task,
                    &self
                        .local_task_link(&task)
                        .map(|link| runtime_event_request_from_link(&link))
                        .unwrap_or_default(),
                    AutomationRunStatus::Cancelled,
                    Some("Project coordination was cancelled before Native execution".into()),
                    None,
                );
                continue;
            }
            // Only a Runtime completion callback may confirm a delivered execution stopped.
            self.request_active_turn_stop(&task);
        }
    }
}
