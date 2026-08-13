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
    emitter::{EventEnvelope, ResponsesEventBuilder},
    runner::{AgentEngine, EventSink, ExecutionOutcome},
};

use super::*;

#[derive(Clone)]
struct ClaudeRuntimeEventSink {
    handler: RuntimeWorkRpcHandler,
    local_task_id: String,
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
    ) -> Result<(), AppIpcError> {
        self.spawn_turn(SpawnTurnRequest {
            local_task_id,
            runtime: "claude_code".to_owned(),
            request,
            direct_thread_id: None,
            fork_thread_id: None,
            fork_thread_path: None,
            resume_thread_id: None,
            initial_thread_name: None,
            initial_thread_goal: None,
        })
        .await
    }

    pub(super) fn start_claude_turn(&self, local_task_id: String, request: ExecutionRequest) {
        let (cancel_tx, cancel_rx) = oneshot::channel();
        let (stopped_tx, stopped_rx) = oneshot::channel();
        let execution_id =
            self.start_local_task_execution(local_task_id.clone(), cancel_tx, stopped_rx);
        let handler = self.clone();
        tokio::spawn(async move {
            let _scheduled_turn_guard = ScheduledTurnGuard::new(handler.clone());
            let (request, model_proxy_token) = prepare_claude_model_proxy(request);
            let model = string_field(&request.model_config, "model_id").unwrap_or_default();
            let builder = ResponsesEventBuilder::new(&request.task_id, &request.subtask_id, model);
            let transcript = Arc::new(Mutex::new(ClaudeTurnTranscript::default()));
            let sink = ClaudeRuntimeEventSink {
                handler: handler.clone(),
                local_task_id: local_task_id.clone(),
                request: request.clone(),
                transcript: Arc::clone(&transcript),
            };
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
                    handler.finish_local_task(&local_task_id, execution_id, None, "done");
                    let _ = sink.send(builder.response_completed(content)).await;
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
                    handler.finish_local_task(&local_task_id, execution_id, None, "done");
                    let _ = sink
                        .send(builder.response_waiting_for_user_input(stop_reason))
                        .await;
                }
                ExecutionOutcome::Failed { message } => {
                    handler.persist_claude_assistant_message(
                        &local_task_id,
                        &request,
                        "",
                        Vec::new(),
                        "failed",
                        Some(message),
                    );
                    handler.finish_local_task(&local_task_id, execution_id, None, "failed");
                    let _ = sink.send(builder.error(message, "runtime_error")).await;
                }
                ExecutionOutcome::Cancelled { message } => {
                    handler.persist_claude_assistant_message(
                        &local_task_id,
                        &request,
                        "",
                        Vec::new(),
                        "cancelled",
                        Some(message),
                    );
                    handler.finish_local_task(&local_task_id, execution_id, None, "cancelled");
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
            let _ = stopped_tx.send(());
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
    (request, Some(token))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_transcript_merges_streamed_block_updates() {
        let mut transcript = ClaudeTurnTranscript::default();
        transcript.record(&EventEnvelope {
            event_type: "response.block.created".to_owned(),
            task_id: "task-1".to_owned(),
            subtask_id: "turn-1".to_owned(),
            data: json!({
                "block": {
                    "id": "block-1",
                    "type": "tool",
                    "status": "running",
                },
            }),
            message_id: None,
            executor_name: None,
            executor_namespace: None,
            validation_id: None,
        });
        transcript.record(&EventEnvelope {
            event_type: "response.block.updated".to_owned(),
            task_id: "task-1".to_owned(),
            subtask_id: "turn-1".to_owned(),
            data: json!({
                "block_id": "block-1",
                "updates": {
                    "status": "completed",
                    "output": "done",
                },
            }),
            message_id: None,
            executor_name: None,
            executor_namespace: None,
            validation_id: None,
        });

        assert_eq!(
            transcript.blocks(),
            vec![json!({
                "id": "block-1",
                "type": "tool",
                "status": "completed",
                "output": "done",
            })]
        );
    }

    #[test]
    fn claude_goal_uses_native_print_mode_command_and_persists_state() {
        let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
        let link = RuntimeTaskLink::new_pending_with_runtime(
            "claude-task-1".to_owned(),
            "/tmp/project".to_owned(),
            "Goal task".to_owned(),
            "claude_code",
        );
        handler.upsert_local_task(link);
        let mut request = ExecutionRequest {
            prompt: Value::String("original visible message".to_owned()),
            ..ExecutionRequest::default()
        };

        handler.prepare_claude_goal(
            "claude-task-1",
            &mut request,
            &json!({
                "initialGoal": {
                    "objective": "all focused tests pass",
                    "status": "active",
                },
            }),
        );

        assert_eq!(request.prompt, json!("/goal all focused tests pass"));
        assert!(is_claude_goal_invocation(&request));
        let stored = handler
            .local_task_link("claude-task-1")
            .expect("stored Claude task");
        assert_eq!(stored.goal_status.as_deref(), Some("active"));
        assert_eq!(
            stored.runtime_handle["goal"]["objective"],
            "all focused tests pass"
        );
    }

    #[test]
    fn claude_goal_status_update_preserves_objective() {
        let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
        let mut link = RuntimeTaskLink::new_pending_with_runtime(
            "claude-task-1".to_owned(),
            "/tmp/project".to_owned(),
            "Goal task".to_owned(),
            "claude_code",
        );
        link.runtime_handle["goal"] = claude_goal_value(
            "claude-task-1",
            &json!({"status": "active"}),
            Some("finish the migration".to_owned()),
        );
        handler.upsert_local_task(link.clone());

        let updated = handler.set_claude_goal(&link, &json!({"status": "paused"}));

        assert_eq!(updated["objective"], "finish the migration");
        assert_eq!(updated["status"], "paused");
        let stored = handler
            .local_task_link("claude-task-1")
            .expect("stored Claude task");
        assert_eq!(stored.goal_status.as_deref(), Some("paused"));
    }
}
