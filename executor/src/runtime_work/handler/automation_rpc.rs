// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use chrono::Utc;

use super::*;
use crate::runtime_work::automations::{Automation, ConversationMode};

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
        let gate = self.task_send_gate(&format!("automation-operation:{}", automation.id));
        let _guard = gate.lock().await;
        let automation = self
            .automation_store
            .update(automation)
            .map_err(automation_store_error)?;
        self.emit_automations_changed(&automation.id, "updated");
        Ok(json!({"automation": automation}))
    }

    pub(super) async fn delete_automation(&self, payload: Value) -> Result<Value, AppIpcError> {
        let automation_id = automation_id(&payload)?;
        let gate = self.task_send_gate(&format!("automation-operation:{automation_id}"));
        let _guard = gate.lock().await;
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
        let gate = self.task_send_gate(&format!("automation-operation:{automation_id}"));
        let _guard = gate.lock().await;
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
            self.handoff_automation(automation, run).await;
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
                if let Err(error) = handler.ensure_memory_review_arrangements() {
                    log_executor_event(
                        "memory review provisioning failed",
                        &[("code", error.code)],
                    );
                }
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
                        run_handler.handoff_automation(automation, run).await;
                    });
                }
            }
        });
    }

    async fn handoff_automation(
        &self,
        automation: Automation,
        run: crate::runtime_work::automations::AutomationRun,
    ) {
        if automation.task_request["standInOwner"].is_object() {
            if run.coordination.is_none() {
                let _ = self.automation_store.mark_needs_attention(
                    &run.id,
                    "The arrangement has no valid execution identity".into(),
                );
            }
            self.emit_automation_runs_changed(&automation.id, &run.id);
            return;
        }
        self.execute_unowned_automation(automation, run).await;
    }

    async fn execute_unowned_automation(
        &self,
        automation: Automation,
        run: crate::runtime_work::automations::AutomationRun,
    ) {
        let operation_gate =
            self.task_send_gate(&format!("automation-operation:{}", automation.id));
        let _operation_guard = operation_gate.lock().await;
        let payload = if automation.task_request["type"] == "wework_control" {
            self.control_automation_payload(&automation).await
        } else {
            let mut payload = match automation.conversation_mode {
                ConversationMode::Independent => automation.task_payload.clone(),
                ConversationMode::ContinueThread => automation
                    .continuation_payload
                    .clone()
                    .unwrap_or_else(|| automation.task_payload.clone()),
            };
            self.refresh_automation_model(&mut payload)
                .await
                .map(|()| payload)
        };
        let mut payload = match payload {
            Ok(payload) => payload,
            Err(error) => {
                let _ = self.automation_store.mark_failed(&run.id, error.message);
                self.emit_automation_runs_changed(&automation.id, &run.id);
                return;
            }
        };
        let task_id = match automation.conversation_mode {
            ConversationMode::Independent => {
                let task_id = format!(
                    "automation-{}-{}",
                    automation.id.chars().take(8).collect::<String>(),
                    Utc::now().timestamp_millis()
                );
                set_payload_string(&mut payload, "taskId", &task_id);
                set_payload_string(&mut payload, "title", &automation.name);
                task_id
            }
            ConversationMode::ContinueThread => string_field(&payload, "taskId")
                .or_else(|| string_field(&payload, "task_id"))
                .unwrap_or_else(|| format!("automation-{}", automation.id)),
        };
        if automation.task_request["type"] == "wework_control" {
            payload["executionRequest"]["task_id"] = json!(task_id);
            payload["executionRequest"]["new_session"] = json!(matches!(
                automation.conversation_mode,
                ConversationMode::Independent
            ));
            if matches!(automation.conversation_mode, ConversationMode::Independent) {
                if let Some(extra) = payload["executionRequest"]["extra"].as_object_mut() {
                    for key in [
                        "origin",
                        "cloudProjectId",
                        "cloud_project_id",
                        "automation_info",
                    ] {
                        extra.remove(key);
                    }
                }
            }
        }
        set_payload_string(&mut payload, "message", &automation.prompt);
        add_automation_context(&mut payload, &automation.id, &run.id, run.scheduled_for);
        let _ = self.automation_store.mark_running(&run.id, task_id.clone());

        let result = match automation.conversation_mode {
            ConversationMode::Independent => self.create_task(payload).await,
            ConversationMode::ContinueThread => self.send_message(payload).await,
        };
        match result {
            Ok(response)
                if response.get("accepted").and_then(Value::as_bool) != Some(false)
                    && response.get("success").and_then(Value::as_bool) != Some(false) =>
            {
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

    async fn refresh_automation_model(&self, payload: &mut Value) -> Result<(), AppIpcError> {
        let Some(selection) = creation::normalized_selection(payload)? else {
            return Ok(());
        };
        if !matches!(
            selection["modelType"].as_str(),
            Some("public" | "user" | "group")
        ) {
            return Ok(());
        }
        let runtime = payload["runtime"].as_str().unwrap_or("codex");
        // A persisted model identity is reusable; its access token is not.
        let current = self
            .creation_model_config(runtime, &selection, &Value::Null)
            .await?;
        for key in ["modelConfig", "executionRequest", "execution_request"] {
            if !payload[key].is_object() {
                continue;
            }
            let config = if key == "modelConfig" {
                &mut payload[key]
            } else {
                &mut payload[key]["model_config"]
            };
            if !config.is_object() {
                *config = current.clone();
            } else {
                for field in ["api_key", "base_url", "default_headers"] {
                    config[field] = current[field].clone();
                }
            }
        }
        Ok(())
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

    pub(super) fn emit_automations_changed(&self, automation_id: &str, action: &str) {
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

    pub(super) fn emit_automation_runs_changed(&self, automation_id: &str, run_id: &str) {
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

fn set_payload_string(payload: &mut Value, key: &str, value: &str) {
    if let Some(object) = payload.as_object_mut() {
        object.insert(key.to_owned(), Value::String(value.to_owned()));
    }
}

pub(super) fn add_automation_context(
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn scheduled_cloud_models_refresh_rotated_credentials_and_reject_revoked_access() {
        use axum::{http::HeaderMap, routing::get, Json, Router};

        let router = Router::new().route(
            "/api/models/unified",
            get(|headers: HeaderMap| async move {
                let authorized = headers["authorization"] == "Bearer current-token";
                Json(json!({"data": if authorized { vec![json!({
                    "name":"shared-model","type":"public","namespace":"default",
                    "resourceUserId":0,"config":{"protocol":"openai-responses"}
                })] } else { vec![] }}))
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let backend_url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let connection = Arc::new(Mutex::new(Some(ConnectionConfig {
            backend_url: backend_url.clone(),
            auth_token: "current-token".into(),
            ..Default::default()
        })));
        let mut handler = RuntimeWorkRpcHandler::new("device", "/bin/false");
        handler.backend_connection = connection.clone();
        for request_key in ["executionRequest", "execution_request"] {
            let mut payload = json!({
                "schemaVersion":2,"runtime":"codex","message":"Run the scheduled work",
                "modelId":"shared-model","modelType":"public",
                "modelOptions":{"weworkCloudModelNamespace":"default","weworkCloudModelResourceUserId":"0"}
            });
            payload[request_key] = json!({"model_config":{
                "api_key":"expired-token","reasoning":{"effort":"high"},
                "native_tool_search":true,"codex_request_mode":"passthrough"
            }});
            crate::runtime_work::task_create_contract::validate_runtime_task_create_v2(&payload)
                .unwrap();
            handler
                .refresh_automation_model(&mut payload)
                .await
                .unwrap();
            assert_eq!(
                payload[request_key]["model_config"]["api_key"],
                "current-token"
            );
            assert!(payload.get("modelConfig").is_none());
            crate::runtime_work::task_create_contract::validate_runtime_task_create_v2(&payload)
                .unwrap();
            assert_eq!(
                payload[request_key]["model_config"]["native_tool_search"],
                true
            );
            assert_eq!(
                payload[request_key]["model_config"]["codex_request_mode"],
                "passthrough"
            );
            assert_eq!(
                payload[request_key]["model_config"]["reasoning"]["effort"],
                "high"
            );
            assert_eq!(
                payload[request_key]["model_config"]["base_url"],
                format!("{backend_url}/api/runtime-work/llm-responses-proxy")
            );
            payload["schemaVersion"] = json!(1);
            payload["modelConfig"] = json!({"api_key":"expired-token"});
            handler
                .refresh_automation_model(&mut payload)
                .await
                .unwrap();
            assert_eq!(payload["modelConfig"]["api_key"], "current-token");
        }
        connection.lock().unwrap().as_mut().unwrap().auth_token = "revoked-token".into();
        let mut payload = json!({"modelSelection":{"modelName":"shared-model","modelType":"public",
            "options":{"weworkCloudModelNamespace":"default","weworkCloudModelResourceUserId":"0"}},
            "executionRequest":{"model_config":{"api_key":"expired-token"}}});
        assert!(handler
            .refresh_automation_model(&mut payload)
            .await
            .is_err());
        assert_eq!(
            payload["executionRequest"]["model_config"]["api_key"],
            "expired-token"
        );
        let directory = tempfile::tempdir().unwrap();
        handler.automation_store = AutomationStore::new(directory.path().join("automations.json"));
        for mode in ["independent", "continue_thread"] {
            let automation = serde_json::from_value(json!({
                "id":mode,"version":0,"name":"Revoked model","prompt":"Run the scheduled work",
                "schedule":{"type":"interval","value":1,"unit":"hours"},
                "conversationMode":mode,"taskPayload":payload,"continuationPayload":payload
            }))
            .unwrap();
            let automation = handler.automation_store.create(automation).unwrap();
            let (automation, run) = handler
                .automation_store
                .start_manual_run(&automation.id)
                .unwrap();
            handler.handoff_automation(automation, run).await;
            let runs = handler.automation_store.list_runs(Some(mode));
            assert_eq!(runs.len(), 1);
            assert_eq!(runs[0].status, AutomationRunStatus::Failed);
            assert!(runs[0].task_id.is_none());
            assert!(runs[0]
                .error
                .as_deref()
                .unwrap()
                .contains("no longer authorized"));
        }
        server.abort();
    }

    #[tokio::test]
    async fn scheduled_native_models_keep_their_provider_credentials() {
        let handler = RuntimeWorkRpcHandler::new("device", "/bin/false");
        let mut payload = json!({"modelId":"native-model","modelType":"runtime",
            "executionRequest":{"model_config":{"api_key":"provider-key"}}});
        let original = payload.clone();
        handler
            .refresh_automation_model(&mut payload)
            .await
            .unwrap();
        assert_eq!(payload, original);
    }
}
