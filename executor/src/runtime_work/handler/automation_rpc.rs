// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use chrono::Utc;
use serde_json::Value;

use super::*;
use crate::runtime_work::automations::{Automation, ConversationMode};
use crate::{
    project_workflows::{ExecutionTargetRef, TaskBindingInput},
    task_runtime::{TaskCreate, TaskRuntime},
};

const AUTOMATION_SCHEDULER_INTERVAL_SECONDS: u64 = 30;

impl RuntimeWorkRpcHandler {
    pub(super) async fn list_automations(&self) -> Result<Value, AppIpcError> {
        Ok(json!({"items": self.automation_store.list()}))
    }

    pub(super) async fn get_automation(&self, payload: Value) -> Result<Value, AppIpcError> {
        let automation_id = automation_id(&payload)?;
        let automation = self
            .automation_store
            .get(&automation_id)
            .ok_or_else(|| AppIpcError::new("not_found", "automation not found"))?;
        Ok(json!({"automation": automation}))
    }

    pub(super) async fn create_automation(&self, payload: Value) -> Result<Value, AppIpcError> {
        let automation = automation_from_payload(&payload)?;
        let automation = self
            .automation_store
            .create(automation)
            .map_err(automation_store_error)?;
        self.emit_automations_changed(&automation.id, "created");
        Ok(json!({"automation": automation}))
    }

    pub(super) async fn update_automation(&self, payload: Value) -> Result<Value, AppIpcError> {
        let automation = automation_from_payload(&payload)?;
        let automation = self
            .automation_store
            .update(automation)
            .map_err(automation_store_error)?;
        self.emit_automations_changed(&automation.id, "updated");
        Ok(json!({"automation": automation}))
    }

    pub(super) async fn delete_automation(&self, payload: Value) -> Result<Value, AppIpcError> {
        let automation_id = automation_id(&payload)?;
        let deleted = self
            .automation_store
            .delete(&automation_id)
            .map_err(automation_store_error)?;
        if deleted {
            self.emit_automations_changed(&automation_id, "deleted");
        }
        Ok(json!({"deleted": deleted, "automationId": automation_id}))
    }

    pub(super) async fn toggle_automation(&self, payload: Value) -> Result<Value, AppIpcError> {
        let automation_id = automation_id(&payload)?;
        let enabled = bool_field(&payload, "enabled")
            .ok_or_else(|| AppIpcError::new("bad_request", "enabled is required"))?;
        let automation = self
            .automation_store
            .toggle(&automation_id, enabled)
            .map_err(automation_store_error)?;
        self.emit_automations_changed(&automation.id, "updated");
        Ok(json!({"automation": automation}))
    }

    pub(super) async fn run_automation_now(&self, payload: Value) -> Result<Value, AppIpcError> {
        let automation_id = automation_id(&payload)?;
        let (automation, run) = self
            .automation_store
            .start_manual_run(&automation_id)
            .map_err(automation_store_error)?;
        let run_id = run.id.clone();
        if run.status == AutomationRunStatus::Pending {
            self.execute_automation(automation, run).await;
        }
        let updated = self
            .automation_store
            .list_runs(Some(&automation_id))
            .into_iter()
            .find(|item| item.id == run_id);
        Ok(json!({"run": updated}))
    }

    pub(super) async fn list_automation_runs(&self, payload: Value) -> Result<Value, AppIpcError> {
        let automation_id = string_field(&payload, "automationId")
            .or_else(|| string_field(&payload, "automation_id"));
        Ok(json!({
            "items": self.automation_store.list_runs(automation_id.as_deref())
        }))
    }

    pub(super) fn start_automation_scheduler(&self) {
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let handler = self.clone();
        handle.spawn(async move {
            let period = Duration::from_secs(AUTOMATION_SCHEDULER_INTERVAL_SECONDS);
            let mut interval =
                tokio::time::interval_at(tokio::time::Instant::now() + period, period);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                let due = match handler.automation_store.due(Utc::now()) {
                    Ok(due) => due,
                    Err(error) => {
                        log_executor_event("automation scheduler store error", &[("error", error)]);
                        continue;
                    }
                };
                for (automation, run) in due {
                    let run_handler = handler.clone();
                    tokio::spawn(async move {
                        run_handler.execute_automation(automation, run).await;
                    });
                }
            }
        });
    }

    async fn execute_automation(
        &self,
        automation: Automation,
        run: crate::runtime_work::automations::AutomationRun,
    ) {
        if let Some(configuration) = automation
            .task_payload
            .get("projectWorkflowAutomation")
            .cloned()
        {
            self.execute_project_workflow_automation(automation, run, configuration)
                .await;
            return;
        }
        let mut payload = match automation.conversation_mode {
            ConversationMode::Independent => automation.task_payload.clone(),
            ConversationMode::ContinueThread => automation
                .continuation_payload
                .clone()
                .unwrap_or_else(|| automation.task_payload.clone()),
        };
        let task_id = match automation.conversation_mode {
            ConversationMode::Independent => {
                let task_id = format!(
                    "automation-{}-{}",
                    automation.id.chars().take(8).collect::<String>(),
                    Utc::now().timestamp_millis()
                );
                set_payload_string(&mut payload, "taskId", &task_id);
                task_id
            }
            ConversationMode::ContinueThread => string_field(&payload, "taskId")
                .or_else(|| string_field(&payload, "task_id"))
                .unwrap_or_else(|| format!("automation-{}", automation.id)),
        };
        set_payload_string(&mut payload, "message", &automation.prompt);
        add_automation_context(&mut payload, &automation.id, &run.id, run.scheduled_for);

        let result = match automation.conversation_mode {
            ConversationMode::Independent => self.create_task(payload).await,
            ConversationMode::ContinueThread => self.send_message(payload).await,
        };
        match result {
            Ok(response) if response.get("accepted").and_then(Value::as_bool) != Some(false) => {
                let response_task_id = string_field(&response, "taskId").unwrap_or(task_id);
                let _ = self
                    .automation_store
                    .mark_running(&run.id, response_task_id);
                self.emit_automation_runs_changed(&automation.id, &run.id);
            }
            Ok(response) => {
                let error = string_field(&response, "error")
                    .unwrap_or_else(|| "automation task was rejected".to_owned());
                let _ = self.automation_store.mark_failed(&run.id, error);
                self.emit_automation_runs_changed(&automation.id, &run.id);
            }
            Err(error) => {
                let _ = self
                    .automation_store
                    .mark_failed(&run.id, error.message.clone());
                self.emit_automation_runs_changed(&automation.id, &run.id);
            }
        }
    }

    async fn execute_project_workflow_automation(
        &self,
        automation: Automation,
        run: crate::runtime_work::automations::AutomationRun,
        configuration: Value,
    ) {
        let result = async {
            let project_id = required_configuration_string(&configuration, "projectId")?;
            let workflow_id = required_configuration_string(&configuration, "workflowId")?;
            let user_id = configuration
                .get("userId")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let task_template = configuration
                .get("taskTemplate")
                .cloned()
                .unwrap_or_else(|| json!({"title": automation.name}));
            let task = serde_json::from_value::<TaskCreate>(task_template)
                .map_err(|error| format!("invalid workflow automation task template: {error}"))?;
            let execution_target = serde_json::from_value::<ExecutionTargetRef>(
                configuration
                    .get("executionTarget")
                    .cloned()
                    .unwrap_or_else(|| {
                        json!({
                            "type": "registered_device",
                            "id": self.device_id,
                        })
                    }),
            )
            .map_err(|error| format!("invalid workflow automation execution target: {error}"))?;
            let repository_binding_id = configuration
                .get("repositoryBindingId")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned);
            let workspace_mode = configuration
                .get("workspaceMode")
                .and_then(Value::as_str)
                .unwrap_or("git_worktree")
                .to_owned();
            let runtime = TaskRuntime::from_env().map_err(|error| error.to_string())?;
            let task = runtime
                .create_task(&project_id, task)
                .await
                .map_err(|error| error.to_string())?;
            runtime
                .upsert_workflow_task_binding(
                    &project_id,
                    &task.id,
                    user_id,
                    TaskBindingInput {
                        version: None,
                        actor: None,
                        workflow_id: Some(workflow_id),
                        repository_binding_id,
                        execution_target,
                        workspace_mode,
                        start_after_save: false,
                    },
                )
                .map_err(|error| error.to_string())?;
            let workflow_run = runtime
                .start_workflow_run(
                    &project_id,
                    &task.id,
                    user_id,
                    &format!("automation:{}:{}", automation.id, run.id),
                    None,
                )
                .map_err(|error| error.to_string())?;
            Ok::<_, String>((task.id, workflow_run.id))
        }
        .await;

        match result {
            Ok((task_id, workflow_run_id)) => {
                let _ = self.automation_store.mark_project_workflow_succeeded(
                    &run.id,
                    task_id,
                    workflow_run_id,
                );
                self.emit_automation_runs_changed(&automation.id, &run.id);
            }
            Err(error) => {
                let _ = self.automation_store.mark_failed(&run.id, error);
                self.emit_automation_runs_changed(&automation.id, &run.id);
            }
        }
    }

    pub(super) fn finish_automation_run(
        &self,
        local_task_id: &str,
        status: AutomationRunStatus,
        error: Option<String>,
    ) {
        if let Some(automation_id) =
            self.automation_store
                .complete_task(local_task_id, status, error)
        {
            self.emit_automation_runs_changed(&automation_id, "");
        }
    }

    fn emit_automations_changed(&self, automation_id: &str, action: &str) {
        let Some(sender) = &self.event_tx else {
            return;
        };
        let _ = sender.send(json!({
            "type": "event",
            "event": "runtime.automations.changed",
            "payload": {
                "event_type": "runtime.automations.changed",
                "automationId": automation_id,
                "action": action,
                "deviceId": self.device_id,
            }
        }));
    }

    fn emit_automation_runs_changed(&self, automation_id: &str, run_id: &str) {
        let Some(sender) = &self.event_tx else {
            return;
        };
        let _ = sender.send(json!({
            "type": "event",
            "event": "runtime.automation_runs.changed",
            "payload": {
                "event_type": "runtime.automation_runs.changed",
                "automationId": automation_id,
                "runId": run_id,
                "deviceId": self.device_id,
            }
        }));
    }
}

fn automation_from_payload(payload: &Value) -> Result<Automation, AppIpcError> {
    let value = payload
        .get("automation")
        .cloned()
        .unwrap_or_else(|| payload.clone());
    serde_json::from_value(value)
        .map_err(|error| AppIpcError::new("bad_request", format!("invalid automation: {error}")))
}

fn automation_id(payload: &Value) -> Result<String, AppIpcError> {
    string_field(payload, "automationId")
        .or_else(|| string_field(payload, "automation_id"))
        .or_else(|| string_field(payload, "id"))
        .ok_or_else(|| AppIpcError::new("bad_request", "automationId is required"))
}

fn automation_store_error(error: String) -> AppIpcError {
    let code = if error.contains("not found") {
        "not_found"
    } else if error.contains("version conflict") {
        "conflict"
    } else {
        "bad_request"
    };
    AppIpcError::new(code, error)
}

fn required_configuration_string(configuration: &Value, key: &str) -> Result<String, String> {
    configuration
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| format!("{key} is required"))
}

fn set_payload_string(payload: &mut Value, key: &str, value: &str) {
    if let Some(object) = payload.as_object_mut() {
        object.insert(key.to_owned(), Value::String(value.to_owned()));
    }
}

fn add_automation_context(
    payload: &mut Value,
    automation_id: &str,
    run_id: &str,
    scheduled_for: chrono::DateTime<Utc>,
) {
    let Some(object) = payload.as_object_mut() else {
        return;
    };
    let execution_request = if object.contains_key("executionRequest") {
        object.get_mut("executionRequest")
    } else {
        object.get_mut("execution_request")
    };
    let Some(execution_request) = execution_request.and_then(Value::as_object_mut) else {
        return;
    };
    execution_request.insert(
        "automation_info".to_owned(),
        json!({
            "automationId": automation_id,
            "runId": run_id,
            "scheduledFor": scheduled_for.to_rfc3339(),
        }),
    );
}
