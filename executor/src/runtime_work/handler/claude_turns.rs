// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::BTreeMap,
    future::{ready, Ready},
    sync::{Arc, Mutex},
};

use serde_json::{json, Value};

use crate::{
    agents::request_backend_url,
    config::device::ConnectionConfig,
    emitter::{EventEnvelope, ResponsesEventBuilder},
    runner::{AgentEngine, EventSink, ExecutionOutcome},
};

use super::*;

const CLOUD_MODEL_TYPES: [&str; 3] = ["public", "user", "group"];
const CLOUD_MODEL_NAMESPACE_OPTION: &str = "weworkCloudModelNamespace";
const CLOUD_MODEL_RESOURCE_USER_ID_OPTION: &str = "weworkCloudModelResourceUserId";
const CLOUD_MODEL_UPSTREAM_API_FORMAT_OPTION: &str = "weworkCloudModelUpstreamApiFormat";
const CLOUD_MODEL_GATEWAY_PATH: &str = "runtime-work/llm-responses-proxy";

#[derive(Debug, Clone, PartialEq, Eq)]
struct BackendSessionCredentials {
    backend_url: String,
    session_token: String,
}

impl TryFrom<&ConnectionConfig> for BackendSessionCredentials {
    type Error = String;

    fn try_from(connection: &ConnectionConfig) -> Result<Self, Self::Error> {
        let backend_url = connection.backend_url.trim();
        if backend_url.is_empty() {
            return Err("Claude Code cloud model backend URL is required".to_owned());
        }
        let session_token = connection.auth_token.trim();
        if session_token.is_empty() {
            return Err("Claude Code cloud model backend token is required".to_owned());
        }
        Ok(Self {
            backend_url: backend_url.to_owned(),
            session_token: session_token.to_owned(),
        })
    }
}

#[derive(Clone)]
struct ClaudeRuntimeEventSink {
    handler: RuntimeWorkRpcHandler,
    local_task_id: String,
    execution_id: u64,
    request: ExecutionRequest,
    transcript: Arc<Mutex<ClaudeTurnTranscript>>,
}

#[derive(Default)]
struct ClaudeTurnTranscript {
    blocks: BTreeMap<String, Value>,
}

impl ClaudeTurnTranscript {
    fn record(&mut self, event: &EventEnvelope) {
        match event.event_type.as_str() {
            "response.block.created" => {
                let Some(block) = event.data.get("block").filter(|block| block.is_object()) else {
                    return;
                };
                let Some(id) = string_field(block, "id") else {
                    return;
                };
                self.blocks.insert(id, block.clone());
            }
            "response.block.updated" => {
                let Some(id) = string_field(&event.data, "block_id") else {
                    return;
                };
                let Some(updates) = event.data.get("updates").and_then(Value::as_object) else {
                    return;
                };
                let block = self
                    .blocks
                    .entry(id.clone())
                    .or_insert_with(|| json!({"id": id, "type": "tool"}));
                let Some(block) = block.as_object_mut() else {
                    return;
                };
                for (key, value) in updates {
                    block.insert(key.clone(), value.clone());
                }
            }
            _ => {}
        }
    }

    fn blocks(&self) -> Vec<Value> {
        self.blocks.values().cloned().collect()
    }
}

impl EventSink for ClaudeRuntimeEventSink {
    type SendFuture = Ready<Result<(), String>>;

    fn send(&self, event: EventEnvelope) -> Self::SendFuture {
        let active = self
            .handler
            .active_local_executions
            .lock()
            .expect("active local execution map lock should not be poisoned");
        if !active.get(&self.local_task_id).is_some_and(|control| {
            control.execution_id == self.execution_id && !control.stop_requested
        }) {
            return ready(Ok(()));
        }
        if let Ok(mut transcript) = self.transcript.lock() {
            transcript.record(&event);
        }
        self.handler.emit_claude_runtime_event(
            &self.local_task_id,
            &self.request,
            event.event_type.as_str(),
            event.data,
        );
        ready(Ok(()))
    }
}

impl RuntimeWorkRpcHandler {
    pub(super) fn prepare_claude_goal(
        &self,
        local_task_id: &str,
        request: &mut ExecutionRequest,
        payload: &Value,
    ) {
        let Some(goal) = initial_thread_goal_from_payload(payload) else {
            return;
        };
        let Some(objective) = string_field(&goal, "objective")
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
        else {
            return;
        };
        let stored_goal = claude_goal_value(local_task_id, &goal, Some(objective.clone()));
        self.store.update_task(local_task_id, |link| {
            set_claude_goal_in_handle(&mut link.runtime_handle, Some(stored_goal));
            link.goal_status =
                Some(string_field(&goal, "status").unwrap_or_else(|| "active".to_owned()));
            link.updated_at = now_ms();
        });
        request
            .extra
            .insert("claude_goal_invocation".to_owned(), Value::Bool(true));
        request.prompt = Value::String(format!("/goal {objective}"));
    }

    pub(super) fn get_claude_goal(&self, link: &RuntimeTaskLink) -> Option<Value> {
        link.runtime_handle.get("goal").cloned()
    }

    pub(super) fn set_claude_goal(&self, link: &RuntimeTaskLink, payload: &Value) -> Value {
        let current = self.get_claude_goal(link);
        let objective = string_field(payload, "objective").or_else(|| {
            current
                .as_ref()
                .and_then(|goal| string_field(goal, "objective"))
        });
        let goal = claude_goal_value(&link.local_task_id, payload, objective);
        self.store.update_task(&link.local_task_id, |stored| {
            set_claude_goal_in_handle(&mut stored.runtime_handle, Some(goal.clone()));
            stored.goal_status = string_field(&goal, "status");
            stored.updated_at = now_ms();
        });
        goal
    }

    pub(super) fn clear_claude_goal(&self, link: &RuntimeTaskLink) -> bool {
        let mut cleared = false;
        self.store.update_task(&link.local_task_id, |stored| {
            cleared = stored.runtime_handle.get("goal").is_some();
            set_claude_goal_in_handle(&mut stored.runtime_handle, None);
            stored.goal_status = None;
            stored.updated_at = now_ms();
        });
        cleared
    }

    pub(super) fn prepare_claude_send(
        &self,
        local_task_id: &str,
        workspace_path: &str,
        request: &ExecutionRequest,
        payload: &Value,
    ) {
        let user_message = cached_user_message(local_task_id, request, payload);
        let presentation = user_message_presentation(payload);
        self.store.update_task(local_task_id, |link| {
            if let Some(message) = user_message.clone() {
                append_runtime_handle_message(&mut link.runtime_handle, message);
            }
            if let Some(presentation) = presentation.clone() {
                append_runtime_handle_user_message_presentation(
                    &mut link.runtime_handle,
                    presentation,
                );
            }
            link.workspace_path = workspace_path.to_owned();
            link.ephemeral = link.ephemeral || request.ephemeral;
            link.updated_at = now_ms();
            set_runtime_handle_model_selection(&mut link.runtime_handle, payload);
        });
    }

    pub(super) async fn spawn_claude_turn(
        &self,
        local_task_id: String,
        request: ExecutionRequest,
        force_start: bool,
    ) -> Result<(), AppIpcError> {
        let turn = SpawnTurnRequest {
            local_task_id,
            runtime: "claude_code".to_owned(),
            request,
            direct_thread_id: None,
            fork_thread_id: None,
            fork_thread_path: None,
            resume_thread_id: None,
            initial_thread_goal: None,
        };
        if force_start {
            self.spawn_forced_turn(turn).await
        } else {
            self.spawn_turn(turn).await
        }
    }

    pub(super) fn start_claude_turn(
        &self,
        local_task_id: String,
        mut request: ExecutionRequest,
        restore_startup: Option<Arc<RestoreStartupGate>>,
    ) {
        let backend_connection = match self.backend_connection_snapshot() {
            Ok(connection) => connection,
            Err(error) => {
                self.fail_local_task_execution_start(&local_task_id, &error);
                return;
            }
        };
        let backend_credentials = match backend_connection
            .as_ref()
            .map(BackendSessionCredentials::try_from)
            .transpose()
        {
            Ok(credentials) => credentials,
            Err(message) => {
                self.fail_local_task_execution_start(
                    &local_task_id,
                    &AppIpcError::new("invalid_model_configuration", message),
                );
                return;
            }
        };
        if let Err(message) =
            prepare_claude_cloud_model_route(&mut request, backend_credentials.as_ref())
        {
            self.fail_local_task_execution_start(
                &local_task_id,
                &AppIpcError::new("invalid_model_configuration", message),
            );
            return;
        }
        let (cancel_tx, cancel_rx) = oneshot::channel();
        let (stopped_tx, stopped_rx) = oneshot::channel();
        let execution_id = match self.start_local_task_execution(
            local_task_id.clone(),
            request
                .project_workspace_path
                .as_deref()
                .or_else(|| request.cwd()),
            cancel_tx,
            stopped_rx,
        ) {
            Ok(execution_id) => execution_id,
            Err(error) => {
                self.fail_local_task_execution_start(&local_task_id, &error);
                return;
            }
        };
        if let Some(restore_startup) = restore_startup.as_ref() {
            self.schedule_restore_startup_timeout(
                local_task_id.clone(),
                execution_id,
                Arc::clone(restore_startup),
            );
        }
        let handler = self.clone();
        tokio::spawn(async move {
            let _stopped_turn_guard = StoppedTurnGuard::new(stopped_tx);
            let _scheduled_turn_guard =
                ScheduledTurnGuard::new(handler.clone(), local_task_id.clone());
            let (request, model_proxy_token) = prepare_claude_model_proxy(request);
            let model = string_field(&request.model_config, "model_id").unwrap_or_default();
            let builder = ResponsesEventBuilder::new(&request.task_id, &request.subtask_id, model);
            let transcript = Arc::new(Mutex::new(ClaudeTurnTranscript::default()));
            let sink = ClaudeRuntimeEventSink {
                handler: handler.clone(),
                local_task_id: local_task_id.clone(),
                execution_id,
                request: request.clone(),
                transcript: Arc::clone(&transcript),
            };
            if let Some(restore_startup) = restore_startup.as_ref() {
                if !restore_startup.try_activate() {
                    if let Some(token) = model_proxy_token.as_deref() {
                        local_model_proxy::unregister_harness(token);
                    }
                    return;
                }
                log_executor_event(
                    "runtime restored turn reached active state",
                    &[("local_task_id", local_task_id.clone())],
                );
            }
            if !handler.is_current_local_task_execution(&local_task_id, execution_id) {
                if let Some(token) = model_proxy_token.as_deref() {
                    local_model_proxy::unregister_harness(token);
                }
                return;
            }
            let _ = sink
                .send(builder.response_created(Some("ClaudeCode")))
                .await;

            let outcome = tokio::select! {
                _ = cancel_rx => ExecutionOutcome::Cancelled {
                    message: "cancelled".to_owned(),
                },
                outcome = handler.claude_process_engine.run_with_events(
                    request.clone(),
                    sink.clone(),
                    builder.clone(),
                ) => outcome,
            };

            if let Some(session) = crate::agent_session::saved_executor_session(&request) {
                handler.store.update_task(&local_task_id, |link| {
                    link.runtime_handle["executorSession"] = session;
                });
            }
            match &outcome {
                ExecutionOutcome::Completed { content } => {
                    let blocks = transcript
                        .lock()
                        .map(|transcript| transcript.blocks())
                        .unwrap_or_default();
                    handler.persist_claude_assistant_message(
                        &local_task_id,
                        &request,
                        content,
                        blocks,
                        "done",
                        None,
                    );
                    if is_claude_goal_invocation(&request) {
                        if let Some(goal) = handler.complete_claude_goal(&local_task_id) {
                            handler.emit_claude_runtime_event(
                                &local_task_id,
                                &request,
                                "runtime.goal.updated",
                                json!({
                                    "thread_id": local_task_id,
                                    "turn_id": request.subtask_id,
                                    "goal": goal,
                                }),
                            );
                        }
                    }
                    let _ = sink.send(builder.response_completed(content)).await;
                    handler.finish_local_task(&local_task_id, execution_id, None, "done");
                }
                ExecutionOutcome::WaitingForUserInput { stop_reason } => {
                    let blocks = transcript
                        .lock()
                        .map(|transcript| transcript.blocks())
                        .unwrap_or_default();
                    handler.persist_claude_assistant_message(
                        &local_task_id,
                        &request,
                        "",
                        blocks,
                        "done",
                        None,
                    );
                    let _ = sink
                        .send(builder.response_waiting_for_user_input(stop_reason))
                        .await;
                    handler.finish_local_task(&local_task_id, execution_id, None, "done");
                }
                ExecutionOutcome::Failed { message } => {
                    handler.persist_claude_assistant_message(
                        &local_task_id,
                        &request,
                        "",
                        transcript.lock().expect("Claude transcript lock").blocks(),
                        "failed",
                        Some(message),
                    );
                    let _ = sink.send(builder.error(message, "runtime_error")).await;
                    handler.finish_local_task(&local_task_id, execution_id, None, "failed");
                }
                ExecutionOutcome::Cancelled { message } => {
                    handler.persist_claude_assistant_message(
                        &local_task_id,
                        &request,
                        "",
                        transcript.lock().expect("Claude transcript lock").blocks(),
                        "cancelled",
                        Some(message),
                    );
                    handler.settle_cancelled_local_task_execution(&local_task_id, execution_id);
                    handler.emit_claude_runtime_event(
                        &local_task_id,
                        &request,
                        "response.incomplete",
                        json!({
                            "type": "cancelled",
                            "error": {"message": message},
                        }),
                    );
                }
                ExecutionOutcome::Running => {}
            }
            if let Some(token) = model_proxy_token {
                local_model_proxy::unregister_harness(&token);
            }
            if let Some(restore_startup) = restore_startup.as_ref() {
                restore_startup.finish();
            }
        });
    }

    fn emit_claude_runtime_event(
        &self,
        local_task_id: &str,
        request: &ExecutionRequest,
        event_type: &str,
        data: Value,
    ) {
        let Some(event_tx) = &self.event_tx else {
            return;
        };
        let mut payload = json!({
            "type": "event",
            "event": event_type,
            "payload": {
                "event_type": event_type,
                "taskId": local_task_id,
                "subtaskId": request.subtask_id,
                "data": data,
                "deviceId": self.device_id,
                "runtime": "claude_code",
                "eventSeq": next_runtime_event_sequence(),
            },
        });
        if let Some(client_user_message_id) = request
            .extra
            .get("client_user_message_id")
            .or_else(|| request.extra.get("clientUserMessageId"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            payload["payload"]["clientUserMessageId"] =
                Value::String(client_user_message_id.to_owned());
        }
        if let Some(source) = request.extra.get("source") {
            payload["payload"]["source"] = source.clone();
        }
        if matches!(
            event_type,
            "response.completed" | "response.failed" | "response.incomplete" | "error"
        ) {
            if let Some(title) = runtime_task_title(request) {
                payload["payload"]["taskTitle"] = Value::String(title);
            }
        }
        let _ = event_tx.send(payload);
    }

    fn persist_claude_assistant_message(
        &self,
        local_task_id: &str,
        request: &ExecutionRequest,
        content: &str,
        blocks: Vec<Value>,
        status: &str,
        error: Option<&str>,
    ) {
        let timestamp = now_ms();
        let mut message = json!({
            "id": format!("{local_task_id}:assistant:{}", request.subtask_id),
            "taskId": local_task_id,
            "role": "assistant",
            "content": content,
            "status": status,
            "runtimeStatus": status,
            "subtaskId": request.subtask_id,
            "turnId": request.subtask_id,
            "createdAt": timestamp,
            "completedAt": timestamp,
        });
        if !blocks.is_empty() {
            message["blocks"] = Value::Array(blocks);
        }
        if let Some(error) = error {
            message["error"] = Value::String(error.to_owned());
        }
        self.store.update_task(local_task_id, |link| {
            append_runtime_handle_message(&mut link.runtime_handle, message.clone());
            link.updated_at = timestamp;
        });
    }

    fn complete_claude_goal(&self, local_task_id: &str) -> Option<Value> {
        let mut completed_goal = None;
        self.store.update_task(local_task_id, |link| {
            let Some(goal) = link
                .runtime_handle
                .get_mut("goal")
                .and_then(Value::as_object_mut)
            else {
                return;
            };
            if goal.get("status").and_then(Value::as_str) != Some("active") {
                return;
            }
            let timestamp = now_ms();
            goal.insert("status".to_owned(), Value::String("complete".to_owned()));
            goal.insert("updatedAt".to_owned(), Value::Number(timestamp.into()));
            link.goal_status = Some("complete".to_owned());
            link.updated_at = timestamp;
            completed_goal = Some(Value::Object(goal.clone()));
        });
        completed_goal
    }
}

fn claude_goal_value(local_task_id: &str, input: &Value, objective: Option<String>) -> Value {
    let timestamp = now_ms();
    let existing_created_at = timestamp_ms_field(input, "createdAt")
        .or_else(|| timestamp_ms_field(input, "created_at"))
        .unwrap_or(timestamp);
    json!({
        "threadId": local_task_id,
        "objective": objective.unwrap_or_default(),
        "status": string_field(input, "status").unwrap_or_else(|| "active".to_owned()),
        "tokenBudget": input.get("tokenBudget")
            .or_else(|| input.get("token_budget"))
            .cloned()
            .unwrap_or(Value::Null),
        "tokensUsed": input.get("tokensUsed")
            .or_else(|| input.get("tokens_used"))
            .cloned()
            .unwrap_or_else(|| json!(0)),
        "timeUsedSeconds": input.get("timeUsedSeconds")
            .or_else(|| input.get("time_used_seconds"))
            .cloned()
            .unwrap_or_else(|| json!(0)),
        "createdAt": existing_created_at,
        "updatedAt": timestamp,
    })
}

fn set_claude_goal_in_handle(runtime_handle: &mut Value, goal: Option<Value>) {
    if !runtime_handle.is_object() {
        *runtime_handle = json!({});
    }
    let object = runtime_handle
        .as_object_mut()
        .expect("runtime handle was normalized to an object");
    match goal {
        Some(goal) => {
            object.insert("goal".to_owned(), goal);
        }
        None => {
            object.remove("goal");
        }
    }
}

fn is_claude_goal_invocation(request: &ExecutionRequest) -> bool {
    request
        .extra
        .get("claude_goal_invocation")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn prepare_claude_model_proxy(mut request: ExecutionRequest) -> (ExecutionRequest, Option<String>) {
    let Some(upstream) = local_model_proxy::upstream_from_model_config(&request.model_config)
    else {
        return (request, None);
    };
    let Some(loopback) = executor_loopback_base_url() else {
        return (request, None);
    };
    let token = local_model_proxy::register_harness(
        &format!("claude-runtime:{}:{}", request.task_id, request.subtask_id),
        upstream,
    );
    let Some(model_config) = request.model_config.as_object_mut() else {
        local_model_proxy::unregister_harness(&token);
        return (request, None);
    };
    model_config.insert(
        "base_url".to_owned(),
        Value::String(format!("{loopback}/v1/harness-router/{token}")),
    );
    model_config.insert(
        "api_key".to_owned(),
        Value::String(local_model_proxy::API_KEY.to_owned()),
    );
    apply_claude_proxy_environment(
        model_config,
        &format!("{loopback}/v1/harness-router/{token}"),
    );
    (request, Some(token))
}

fn apply_claude_proxy_environment(model_config: &mut serde_json::Map<String, Value>, url: &str) {
    let env = model_config
        .entry("env".to_owned())
        .or_insert_with(|| Value::Object(Default::default()));
    if !env.is_object() {
        *env = Value::Object(Default::default());
    }
    let env = env
        .as_object_mut()
        .expect("Claude model environment should be an object");
    for (key, value) in [
        ("ANTHROPIC_API_KEY", local_model_proxy::API_KEY),
        ("ANTHROPIC_AUTH_TOKEN", local_model_proxy::API_KEY),
        ("ANTHROPIC_BASE_URL", url),
        ("CLAUDE_CODE_USE_BEDROCK", "0"),
        ("CLAUDE_CODE_USE_FOUNDRY", "0"),
        ("CLAUDE_CODE_USE_VERTEX", "0"),
    ] {
        env.insert(key.to_owned(), Value::String(value.to_owned()));
    }
}

fn prepare_claude_cloud_model_route(
    request: &mut ExecutionRequest,
    backend_credentials: Option<&BackendSessionCredentials>,
) -> Result<(), String> {
    let Some(selection) = request
        .extra
        .get("modelSelection")
        .or_else(|| request.extra.get("model_selection"))
        .filter(|value| value.is_object())
    else {
        return Ok(());
    };
    let model_type = string_field(selection, "modelType")
        .or_else(|| string_field(selection, "model_type"))
        .unwrap_or_default();
    if !CLOUD_MODEL_TYPES.contains(&model_type.as_str()) {
        return Ok(());
    }

    let model_name = string_field(selection, "modelName")
        .or_else(|| string_field(selection, "model_name"))
        .or_else(|| string_field(selection, "model"))
        .ok_or_else(|| "Claude Code cloud model name is required".to_owned())?;
    let options = selection
        .get("options")
        .and_then(Value::as_object)
        .ok_or_else(|| "Claude Code cloud model options are required".to_owned())?;
    let namespace = options
        .get(CLOUD_MODEL_NAMESPACE_OPTION)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| "Claude Code cloud model namespace is required".to_owned())?;
    let resource_user_id = options
        .get(CLOUD_MODEL_RESOURCE_USER_ID_OPTION)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Claude Code cloud model resource user ID is required".to_owned())?;
    let resource_user_id = resource_user_id
        .parse::<i64>()
        .ok()
        .filter(|value| *value >= 0)
        .map(|value| value.to_string())
        .ok_or_else(|| {
            "Claude Code cloud model resource user ID must be a non-negative integer".to_owned()
        })?;
    let upstream_api_format = options
        .get(CLOUD_MODEL_UPSTREAM_API_FORMAT_OPTION)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("openai-responses")
        .to_owned();
    let backend_url = backend_credentials
        .map(|credentials| credentials.backend_url.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .or_else(|| request_backend_url(request))
        .ok_or_else(|| "Claude Code cloud model backend URL is required".to_owned())?;
    let auth_token = backend_credentials
        .map(|credentials| credentials.session_token.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| "Claude Code cloud model backend token is required".to_owned())?;

    let model_config = request
        .model_config
        .as_object_mut()
        .ok_or_else(|| "Claude Code model configuration must be an object".to_owned())?;
    for (key, value) in [
        ("model", Value::String("openai".to_owned())),
        ("model_id", Value::String(model_name)),
        ("api_format", Value::String("responses".to_owned())),
        ("protocol", Value::String("openai-responses".to_owned())),
        ("upstream_api_format", Value::String(upstream_api_format)),
        (
            "base_url",
            Value::String(cloud_model_gateway_base_url(&backend_url)),
        ),
        ("api_key", Value::String(auth_token)),
    ] {
        model_config.insert(key.to_owned(), value);
    }
    let default_headers = model_config
        .entry("default_headers".to_owned())
        .or_insert_with(|| Value::Object(Default::default()));
    if !default_headers.is_object() {
        *default_headers = Value::Object(Default::default());
    }
    let default_headers = default_headers
        .as_object_mut()
        .expect("Claude model default headers should be an object");
    for (key, value) in [
        ("X-Wegent-Model-Type", model_type),
        ("X-Wegent-Model-Namespace", namespace),
        ("X-Wegent-Model-User-Id", resource_user_id),
        (
            "X-Wegent-Upstream-Header-wecode-executor",
            "claudecode".to_owned(),
        ),
        (
            "X-Wegent-Upstream-Header-wecode-source",
            "wegent-agent".to_owned(),
        ),
    ] {
        default_headers.insert(key.to_owned(), Value::String(value));
    }
    Ok(())
}

fn cloud_model_gateway_base_url(backend_url: &str) -> String {
    let base_url = backend_url.trim().trim_end_matches('/');
    if base_url.ends_with("/api") {
        format!("{base_url}/{CLOUD_MODEL_GATEWAY_PATH}")
    } else {
        format!("{base_url}/api/{CLOUD_MODEL_GATEWAY_PATH}")
    }
}

#[cfg(test)]
mod tests;
