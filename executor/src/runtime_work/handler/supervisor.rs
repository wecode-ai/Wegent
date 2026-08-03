// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::runtime_work::response::{RuntimeSupervisorState, RuntimeSupervisorSuggestion};
use serde::Deserialize;
use sha2::{Digest, Sha256};

const SUPERVISOR_MODES: &[&str] = &["suggest", "auto"];
const SUPERVISOR_VISIBLE_MESSAGES: usize = 6;
const SUPERVISOR_LATEST_CONTENT_CHARS: usize = 12_000;
const SUPERVISOR_CONTEXT_CONTENT_CHARS: usize = 2_400;
const SUPERVISOR_PROMPT_VERSION: &str = "5";
const SUPERVISOR_REPEAT_CORRECTION_WINDOW_MS: i64 = 5 * 60 * 1_000;
const SUPERVISOR_DEFAULT_INTERVAL_SECONDS: u64 = 30;
const SUPERVISOR_INTERVAL_SECONDS: &[u64] = &[10, 30, 60, 300];
const SUPERVISOR_SCHEDULER_INTERVAL: Duration = Duration::from_secs(5);
const SUPERVISOR_EVALUATION_TIMEOUT: Duration = Duration::from_secs(60);

impl RuntimeWorkRpcHandler {
    pub(super) async fn get_task_supervisor(&self, payload: Value) -> Result<Value, AppIpcError> {
        let link = self.task_link_from_payload(&payload, false).await?;
        Ok(supervisor_response(&link))
    }

    pub(super) async fn set_task_supervisor(&self, payload: Value) -> Result<Value, AppIpcError> {
        let link = self.task_link_from_payload(&payload, false).await?;
        let existing = link.supervisor.clone();
        let supervisor = configured_supervisor(&payload, existing)?;
        self.store.update_task(&link.local_task_id, |task| {
            task.supervisor = Some(supervisor);
            task.updated_at = now_ms();
        });
        self.emit_supervisor_updated(&link.local_task_id);
        self.schedule_supervisor_evaluation(link.local_task_id.clone(), None);
        Ok(supervisor_response(
            &self.local_task_link(&link.local_task_id).unwrap_or(link),
        ))
    }

    pub(super) async fn clear_task_supervisor(&self, payload: Value) -> Result<Value, AppIpcError> {
        let link = self.task_link_from_payload(&payload, false).await?;
        self.store.update_task(&link.local_task_id, |task| {
            task.supervisor = None;
            task.updated_at = now_ms();
        });
        self.emit_supervisor_updated(&link.local_task_id);
        Ok(json!({
            "success": true,
            "accepted": true,
            "taskId": link.local_task_id,
            "runtime": "codex",
            "supervisor": null,
        }))
    }

    pub(super) async fn resolve_task_supervisor(
        &self,
        payload: Value,
    ) -> Result<Value, AppIpcError> {
        let link = self.task_link_from_payload(&payload, false).await?;
        let suggestion_id = string_field(&payload, "suggestionId")
            .or_else(|| string_field(&payload, "suggestion_id"))
            .ok_or_else(|| AppIpcError::new("bad_request", "suggestionId is required"))?;
        let status = string_field(&payload, "status").unwrap_or_else(|| "dismissed".to_owned());
        if !["accepted", "dismissed"].contains(&status.as_str()) {
            return Err(AppIpcError::new(
                "bad_request",
                "suggestion status must be accepted or dismissed",
            ));
        }
        self.store.update_task(&link.local_task_id, |task| {
            let Some(supervisor) = task.supervisor.as_mut() else {
                return;
            };
            if let Some(suggestion) = supervisor
                .suggestions
                .iter_mut()
                .find(|suggestion| suggestion.id == suggestion_id)
            {
                suggestion.status = status.clone();
                suggestion.resolved_at = Some(now_ms());
            }
            task.updated_at = now_ms();
        });
        self.emit_supervisor_updated(&link.local_task_id);
        Ok(supervisor_response(
            &self.local_task_link(&link.local_task_id).unwrap_or(link),
        ))
    }

    pub(super) fn schedule_supervisor_evaluation(
        &self,
        local_task_id: String,
        source_turn_id: Option<String>,
    ) {
        let enabled = self.local_task_link(&local_task_id).is_some_and(|link| {
            runtime_session_id_from_link(&link).is_some()
                && link
                    .supervisor
                    .is_some_and(|supervisor| supervisor.status != "disabled")
        });
        if !enabled {
            return;
        }
        let evaluation_started = self
            .supervisor_evaluating
            .lock()
            .expect("supervisor evaluating set lock should not be poisoned")
            .insert(local_task_id.clone());
        if !evaluation_started {
            return;
        }
        let handler = self.clone();
        tokio::spawn(async move {
            if let Err(error) = handler
                .evaluate_task_supervisor(&local_task_id, source_turn_id)
                .await
            {
                handler.record_supervisor_error(&local_task_id, error);
            }
            handler
                .supervisor_evaluating
                .lock()
                .expect("supervisor evaluating set lock should not be poisoned")
                .remove(&local_task_id);
        });
    }

    pub(super) fn start_supervisor_scheduler(&self) {
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let handler = self.clone();
        handle.spawn(async move {
            let mut interval = tokio::time::interval_at(
                tokio::time::Instant::now() + SUPERVISOR_SCHEDULER_INTERVAL,
                SUPERVISOR_SCHEDULER_INTERVAL,
            );
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                for link in handler.local_task_links(false) {
                    if supervisor_needs_scheduled_check(
                        &link,
                        handler.is_active_local_task(&link.local_task_id),
                        now_ms(),
                    ) {
                        handler.schedule_supervisor_evaluation(link.local_task_id, None);
                    }
                }
            }
        });
    }

    async fn evaluate_task_supervisor(
        &self,
        local_task_id: &str,
        source_turn_id: Option<String>,
    ) -> Result<(), String> {
        let link = self
            .local_task_link(local_task_id)
            .ok_or_else(|| "runtime task was not found".to_owned())?;
        let supervisor = link
            .supervisor
            .clone()
            .ok_or_else(|| "supervisor is disabled".to_owned())?;
        let parent_thread_id = runtime_session_id_from_link(&link)
            .ok_or_else(|| "runtime task session is not ready".to_owned())?;
        let thread = self.read_codex_thread_with_turns(&parent_thread_id).await?;
        let current_configuration = self
            .local_task_link(local_task_id)
            .and_then(|task| task.supervisor);
        if !current_configuration.as_ref().is_some_and(|current| {
            current.mode == supervisor.mode
                && current.instructions == supervisor.instructions
                && current.model_id == supervisor.model_id
                && current.interval_seconds == supervisor.interval_seconds
        }) {
            return Ok(());
        }
        let Some(visible_ai_progress) =
            visible_ai_progress(transcript_messages(&thread, &self.device_id))?
        else {
            self.store.update_task(local_task_id, |task| {
                let Some(current) = task.supervisor.as_mut() else {
                    return;
                };
                current.last_evaluated_at = Some(now_ms());
                current.last_content_hash = Some(empty_content_hash());
                current.last_error = None;
                current.status = "active".to_owned();
            });
            self.emit_supervisor_updated(local_task_id);
            return Ok(());
        };
        let content_hash = content_hash(&visible_ai_progress);
        if supervisor.last_content_hash.as_deref() == Some(content_hash.as_str()) {
            self.store.update_task(local_task_id, |task| {
                let Some(current) = task.supervisor.as_mut() else {
                    return;
                };
                current.last_evaluated_at = Some(now_ms());
                current.last_error = None;
                current.status = "active".to_owned();
            });
            return Ok(());
        }
        let snapshot_at = now_ms();
        self.store.update_task(local_task_id, |task| {
            let Some(current) = task.supervisor.as_mut() else {
                return;
            };
            current.status = "checking".to_owned();
            current.last_error = None;
            task.updated_at = now_ms();
        });
        self.emit_supervisor_updated(local_task_id);
        let visible_progress = json!({
            "task": {
                "title": link.title,
                "status": link.status,
                "running": link.running,
            },
            "latestAiContent": visible_ai_progress.latest,
            "recentAiContext": visible_ai_progress.context,
            "lastSupervisorIntervention": supervisor.suggestions.iter().rev().find(|suggestion| {
                suggestion.status == "accepted"
            }).map(|suggestion| json!({
                "message": suggestion.message,
                "createdAt": suggestion.created_at,
            })),
        });
        let visible_progress =
            serde_json::to_string(&visible_progress).map_err(|error| error.to_string())?;
        let mut request = ExecutionRequest {
            task_id: format!("supervisor:{local_task_id}"),
            subtask_id: format!("supervisor-evaluation-{}", now_ms()),
            system_prompt: supervisor_system_prompt(),
            prompt: Value::String(supervisor_prompt(&supervisor, &visible_progress)),
            project_workspace_path: Some(link.workspace_path.clone()),
            runtime_workspace_roots: link.runtime_workspace_roots.clone(),
            runtime_project_key: link.runtime_project_key.clone(),
            ephemeral: true,
            ..ExecutionRequest::default()
        };
        if let Some(model_id) = supervisor
            .model_id
            .clone()
            .or_else(|| task_model_id(&link.runtime_handle))
        {
            request.model_config = json!({"model_id": model_id});
        }
        request.extra.insert(
            "runtime_permission_profile".to_owned(),
            Value::String(":read-only".to_owned()),
        );
        request.extra.insert(
            "runtime_message_source".to_owned(),
            Value::String("supervisor-evaluator".to_owned()),
        );
        request
            .extra
            .insert("output_schema".to_owned(), supervisor_output_schema());
        let (cancel_tx, cancel_rx) = oneshot::channel();
        let timeout_task = tokio::spawn(async move {
            sleep(SUPERVISOR_EVALUATION_TIMEOUT).await;
            let _ = cancel_tx.send(());
        });
        let result = self
            .codex_app_server
            .run_turn_with_cancel(
                request,
                CodexAppServerTurnOptions {
                    cancellation: Some(cancel_rx),
                    ..CodexAppServerTurnOptions::default()
                },
            )
            .await;
        timeout_task.abort();
        let result = result.map_err(|error| {
            if error == CODEX_APP_SERVER_TURN_CANCELLED {
                format!(
                    "supervisor evaluation timed out after {} seconds",
                    SUPERVISOR_EVALUATION_TIMEOUT.as_secs()
                )
            } else {
                error
            }
        })?;
        let content = match result.outcome {
            ExecutionOutcome::Completed { content } => content,
            ExecutionOutcome::Failed { message } | ExecutionOutcome::Cancelled { message } => {
                return Err(message)
            }
            ExecutionOutcome::WaitingForUserInput { stop_reason } => return Err(stop_reason),
            ExecutionOutcome::Running => {
                return Err("supervisor evaluation did not finish".to_owned())
            }
        };
        let evaluation = parse_supervisor_evaluation(&content)?;
        let Some(current_supervisor) = self
            .local_task_link(local_task_id)
            .and_then(|task| task.supervisor)
        else {
            return Ok(());
        };
        if current_supervisor.mode != supervisor.mode
            || current_supervisor.instructions != supervisor.instructions
            || current_supervisor.model_id != supervisor.model_id
            || current_supervisor.interval_seconds != supervisor.interval_seconds
        {
            return Ok(());
        }
        self.store.update_task(local_task_id, |task| {
            let Some(current) = task.supervisor.as_mut() else {
                return;
            };
            current.last_evaluated_at = Some(snapshot_at);
            current.last_content_hash = Some(content_hash.clone());
            current.last_error = None;
            current.status = "active".to_owned();
        });
        let Some(correction) = evaluation
            .correction
            .as_deref()
            .map(str::trim)
            .filter(|correction| !correction.is_empty())
        else {
            self.emit_supervisor_updated(local_task_id);
            return Ok(());
        };
        if recently_sent_same_correction(&current_supervisor, correction, now_ms()) {
            self.emit_supervisor_updated(local_task_id);
            return Ok(());
        }
        match current_supervisor.mode.as_str() {
            "auto" => {
                self.send_supervisor_correction(local_task_id, &link, correction)
                    .await?;
                self.record_supervisor_suggestion(
                    local_task_id,
                    evaluation,
                    "accepted",
                    source_turn_id,
                );
            }
            "suggest" => self.record_supervisor_suggestion(
                local_task_id,
                evaluation,
                "pending",
                source_turn_id,
            ),
            mode => return Err(format!("unsupported supervisor mode: {mode}")),
        }
        Ok(())
    }

    fn record_supervisor_suggestion(
        &self,
        local_task_id: &str,
        evaluation: SupervisorEvaluation,
        status: &str,
        source_turn_id: Option<String>,
    ) {
        self.store.update_task(local_task_id, |task| {
            let Some(supervisor) = task.supervisor.as_mut() else {
                return;
            };
            supervisor.suggestions.push(RuntimeSupervisorSuggestion {
                id: format!("supervisor-suggestion-{}", now_ms()),
                message: evaluation.correction.clone().unwrap_or_default(),
                rationale: evaluation.rationale.clone(),
                status: status.to_owned(),
                created_at: now_ms(),
                resolved_at: (status != "pending").then(now_ms),
                source_turn_id: source_turn_id.clone(),
            });
            if supervisor.suggestions.len() > 50 {
                supervisor.suggestions.remove(0);
            }
            task.updated_at = now_ms();
        });
        self.emit_supervisor_updated(local_task_id);
    }

    async fn send_supervisor_correction(
        &self,
        local_task_id: &str,
        link: &RuntimeTaskLink,
        message: &str,
    ) -> Result<(), String> {
        let client_user_message_id = format!("supervisor-correction-{}", now_ms());
        let source = json!({
            "source": "supervisor",
            "channel_type": "task_supervisor",
            "channel_label": "分身监督",
        });
        let created_at = now_ms();
        if self.is_active_local_task(local_task_id) {
            let response = self
                .send_guidance(json!({
                    "taskId": local_task_id,
                    "message": message,
                    "clientGuidanceId": client_user_message_id,
                }))
                .await
                .map_err(|error| error.message)?;
            if response.get("accepted").and_then(Value::as_bool) == Some(true) {
                return Ok(());
            }
            if string_field(&response, "code").as_deref() != Some("no_active_turn") {
                return Err(string_field(&response, "error")
                    .unwrap_or_else(|| "supervisor guidance was rejected".to_owned()));
            }
        }
        let thread_id = runtime_session_id_from_link(link)
            .ok_or_else(|| "runtime task session is not ready".to_owned())?;
        let mut request = ExecutionRequest {
            task_id: local_task_id.to_owned(),
            subtask_id: format!("supervisor-correction-{}", now_ms()),
            prompt: Value::String(message.to_owned()),
            project_workspace_path: Some(link.workspace_path.clone()),
            runtime_workspace_roots: link.runtime_workspace_roots.clone(),
            runtime_project_key: link.runtime_project_key.clone(),
            ephemeral: link.ephemeral,
            ..ExecutionRequest::default()
        };
        if let Some(model_id) = task_model_id(&link.runtime_handle) {
            request.model_config = json!({"model_id": model_id});
        }
        request.extra.insert(
            "client_user_message_id".to_owned(),
            Value::String(client_user_message_id.clone()),
        );
        request.extra.insert(
            "runtime_message_source".to_owned(),
            Value::String("supervisor".to_owned()),
        );
        request.extra.insert(
            "runtime_generated_user_message".to_owned(),
            json!({
                "id": client_user_message_id,
                "message": message,
                "createdAt": created_at,
                "source": source.clone(),
            }),
        );
        self.mark_task_running_for_send(
            local_task_id,
            &thread_id,
            &link.workspace_path,
            &request,
            &json!({
                "clientUserMessageId": client_user_message_id,
                "message": message,
                "source": source.clone(),
            }),
        );
        self.spawn_turn(SpawnTurnRequest {
            local_task_id: local_task_id.to_owned(),
            request,
            direct_thread_id: link.ephemeral.then(|| thread_id.clone()),
            fork_thread_id: None,
            fork_thread_path: None,
            resume_thread_id: (!link.ephemeral).then_some(thread_id),
            initial_thread_name: None,
            initial_thread_goal: None,
        });
        Ok(())
    }

    fn record_supervisor_error(&self, local_task_id: &str, error: String) {
        self.store.update_task(local_task_id, |task| {
            let Some(supervisor) = task.supervisor.as_mut() else {
                return;
            };
            supervisor.status = "error".to_owned();
            supervisor.last_error = Some(error.clone());
            supervisor.last_evaluated_at = Some(now_ms());
            supervisor.last_content_hash = None;
        });
        self.emit_supervisor_updated(local_task_id);
    }

    fn emit_supervisor_updated(&self, local_task_id: &str) {
        let Some(link) = self.local_task_link(local_task_id) else {
            return;
        };
        let mut request = ExecutionRequest {
            task_id: local_task_id.to_owned(),
            subtask_id: format!("supervisor-state-{}", now_ms()),
            ..ExecutionRequest::default()
        };
        request.device_id = Some(self.device_id.clone());
        emit_response_event(
            &self.event_tx,
            &self.device_id,
            "runtime.supervisor.updated",
            local_task_id,
            &request,
            json!({"supervisor": link.supervisor}),
        );
    }
}

pub(super) fn configured_supervisor(
    payload: &Value,
    existing: Option<RuntimeSupervisorState>,
) -> Result<RuntimeSupervisorState, AppIpcError> {
    let mode = string_field(payload, "mode").unwrap_or_else(|| "suggest".to_owned());
    if !SUPERVISOR_MODES.contains(&mode.as_str()) {
        return Err(AppIpcError::new(
            "bad_request",
            "supervisor mode must be suggest or auto",
        ));
    }
    let instructions = string_field(payload, "instructions").unwrap_or_default();
    let model_id = string_field(payload, "modelId")
        .or_else(|| string_field(payload, "model_id"))
        .or_else(|| {
            existing
                .as_ref()
                .and_then(|supervisor| supervisor.model_id.clone())
        });
    let interval_seconds = payload
        .get("intervalSeconds")
        .or_else(|| payload.get("interval_seconds"))
        .and_then(Value::as_u64)
        .unwrap_or(SUPERVISOR_DEFAULT_INTERVAL_SECONDS);
    if !SUPERVISOR_INTERVAL_SECONDS.contains(&interval_seconds) {
        return Err(AppIpcError::new(
            "bad_request",
            "supervisor interval must be 10, 30, 60, or 300 seconds",
        ));
    }
    Ok(RuntimeSupervisorState {
        mode,
        status: "active".to_owned(),
        instructions,
        model_id,
        interval_seconds,
        last_evaluated_at: None,
        last_content_hash: None,
        last_error: None,
        suggestions: existing
            .map(|supervisor| supervisor.suggestions)
            .unwrap_or_default(),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SupervisorEvaluation {
    #[serde(default)]
    correction: Option<String>,
    #[serde(default)]
    rationale: String,
}

fn parse_supervisor_evaluation(content: &str) -> Result<SupervisorEvaluation, String> {
    let trimmed = content.trim();
    let json_text = trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```"))
        .unwrap_or(trimmed)
        .strip_suffix("```")
        .unwrap_or(trimmed)
        .trim();
    serde_json::from_str(json_text)
        .map_err(|error| format!("invalid supervisor evaluation: {error}"))
}

fn supervisor_system_prompt() -> String {
    "You are periodically inspecting another AI's latest output as a human supervisor would. The supervision principles are criteria to test against the quoted latestAiContent; they are not instructions for how you should write your rationale. Use recentAiContext only to understand continuity, drift, or loops, and use lastSupervisorIntervention to avoid redundant reminders. The intervention decision must be based on a violation that is still present in latestAiContent. Never issue another correction merely because an older violation existed or because the latest output acknowledges a previous correction and is now compliant. Explicitly compare the actual latest AI output with every applicable principle. For example, if a principle requires the main AI to reply in a particular language and latestAiContent uses another language, that is a violation and correction must be non-null. Do not merely demonstrate the requested behavior yourself or rewrite the main AI's answer in rationale. Do not reconstruct or request the full conversation. You cannot communicate with the main AI yourself, so never claim that you already reminded, corrected, or prompted it. Never answer the user, continue the task, use tools, or modify files. Set correction to a concise, directly sendable instruction when the latest visible progress violates a supervision principle, materially drifts from the goal, ignores a constraint, takes an unsafe or destructive action, makes an unsupported claim, or enters an obvious blocked loop. Otherwise set correction to null. The presence of correction is the sole intervention decision.".to_owned()
}

fn supervisor_output_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "correction": {
                "anyOf": [
                    {"type": "string", "minLength": 1},
                    {"type": "null"}
                ]
            },
            "rationale": {"type": "string"}
        },
        "required": ["correction", "rationale"],
        "additionalProperties": false
    })
}

fn supervisor_prompt(supervisor: &RuntimeSupervisorState, visible_progress: &str) -> String {
    format!(
        "Mode: {}\nUser supervision principles:\n{}\n\nCurrent visible progress snapshot (JSON):\n{}",
        supervisor.mode,
        if supervisor.instructions.trim().is_empty() {
            "(none)"
        } else {
            supervisor.instructions.trim()
        },
        visible_progress
    )
}

fn supervisor_response(link: &RuntimeTaskLink) -> Value {
    json!({
        "success": true,
        "accepted": true,
        "taskId": link.local_task_id,
        "runtime": "codex",
        "supervisor": link.supervisor,
    })
}

fn task_model_id(runtime_handle: &Value) -> Option<String> {
    let selection = runtime_handle.get("modelSelection")?;
    string_field(selection, "modelName")
        .or_else(|| string_field(selection, "model"))
        .or_else(|| string_field(selection, "modelId"))
}

fn supervisor_needs_scheduled_check(link: &RuntimeTaskLink, active: bool, now: i64) -> bool {
    let Some(supervisor) = link.supervisor.as_ref() else {
        return false;
    };
    if supervisor.last_evaluated_at.is_none() || supervisor.last_content_hash.is_none() {
        return true;
    }
    if active
        && supervisor
            .last_evaluated_at
            .is_some_and(|last_evaluated_at| {
                now.saturating_sub(last_evaluated_at)
                    >= i64::try_from(supervisor.interval_seconds).unwrap_or(i64::MAX) * 1_000
            })
    {
        return true;
    }
    link.completed_at
        .zip(supervisor.last_evaluated_at)
        .is_some_and(|(completed_at, evaluated_at)| completed_at > evaluated_at)
}

struct VisibleAiProgress {
    latest: String,
    context: Vec<String>,
}

fn visible_ai_progress(messages: Vec<Value>) -> Result<Option<VisibleAiProgress>, String> {
    let mut assistant_messages = messages
        .into_iter()
        .filter(|message| message.get("role").and_then(Value::as_str) == Some("assistant"))
        .rev()
        .take(SUPERVISOR_VISIBLE_MESSAGES)
        .collect::<Vec<_>>();
    let Some(latest_assistant_message) = assistant_messages.first() else {
        return Ok(None);
    };
    let latest =
        serde_json::to_string(&latest_assistant_message).map_err(|error| error.to_string())?;
    let context = assistant_messages
        .drain(1..)
        .rev()
        .map(|message| {
            serde_json::to_string(&message)
                .map(|content| truncate_visible_tail(&content, SUPERVISOR_CONTEXT_CONTENT_CHARS))
                .map_err(|error| error.to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Some(VisibleAiProgress {
        latest: truncate_visible_tail(&latest, SUPERVISOR_LATEST_CONTENT_CHARS),
        context,
    }))
}

fn content_hash(content: &VisibleAiProgress) -> String {
    let content = json!({
        "latest": content.latest,
        "context": content.context,
    });
    format!(
        "{:x}",
        Sha256::digest(format!("{SUPERVISOR_PROMPT_VERSION}:{content}").as_bytes())
    )
}

fn empty_content_hash() -> String {
    format!(
        "{:x}",
        Sha256::digest(format!("{SUPERVISOR_PROMPT_VERSION}:empty").as_bytes())
    )
}

fn recently_sent_same_correction(
    supervisor: &RuntimeSupervisorState,
    correction: &str,
    now: i64,
) -> bool {
    supervisor.suggestions.iter().rev().any(|suggestion| {
        suggestion.status == "accepted"
            && suggestion.message.trim() == correction
            && now.saturating_sub(suggestion.created_at) <= SUPERVISOR_REPEAT_CORRECTION_WINDOW_MS
    })
}

fn truncate_visible_tail(value: &str, max_chars: usize) -> String {
    let char_count = value.chars().count();
    if char_count <= max_chars {
        return value.to_owned();
    }
    value.chars().skip(char_count - max_chars).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_fenced_supervisor_json() {
        let result = parse_supervisor_evaluation(
            "```json\n{\"correction\":\"stop\",\"rationale\":\"drift\"}\n```",
        )
        .expect("evaluation should parse");
        assert_eq!(result.correction.as_deref(), Some("stop"));
    }

    #[test]
    fn parses_supervisor_pass_without_correction() {
        let result = parse_supervisor_evaluation("{\"correction\":null,\"rationale\":\"aligned\"}")
            .expect("evaluation should parse");
        assert_eq!(result.correction, None);
    }

    #[test]
    fn visible_ai_progress_separates_latest_output_from_recent_context() {
        let messages = vec![
            json!({"role": "user", "content": "private original request"}),
            json!({"role": "assistant", "content": "older progress"}),
            json!({"role": "assistant", "content": "latest progress"}),
        ];

        let progress = visible_ai_progress(messages)
            .expect("snapshot should serialize")
            .expect("assistant content should exist");

        assert!(!progress.latest.contains("private original request"));
        assert!(!progress.latest.contains("older progress"));
        assert!(progress.latest.contains("latest progress"));
        assert_eq!(progress.context.len(), 1);
        assert!(progress.context[0].contains("older progress"));
    }

    #[test]
    fn visible_tail_is_bounded_from_the_latest_content() {
        assert_eq!(truncate_visible_tail("abcdef", 3), "def");
    }

    #[test]
    fn completed_content_is_checked_even_when_the_turn_finishes_between_ticks() {
        let link = RuntimeTaskLink {
            completed_at: Some(200),
            supervisor: Some(RuntimeSupervisorState {
                mode: "auto".to_owned(),
                status: "active".to_owned(),
                instructions: String::new(),
                model_id: None,
                interval_seconds: 30,
                last_evaluated_at: Some(100),
                last_content_hash: Some("old".to_owned()),
                last_error: None,
                suggestions: Vec::new(),
            }),
            ..RuntimeTaskLink::default()
        };

        assert!(supervisor_needs_scheduled_check(&link, false, 200));
    }

    #[test]
    fn stopped_task_without_ai_content_is_not_polled_again() {
        let link = RuntimeTaskLink {
            completed_at: Some(100),
            supervisor: Some(RuntimeSupervisorState {
                mode: "auto".to_owned(),
                status: "active".to_owned(),
                instructions: String::new(),
                model_id: None,
                interval_seconds: 30,
                last_evaluated_at: Some(100),
                last_content_hash: Some(empty_content_hash()),
                last_error: None,
                suggestions: Vec::new(),
            }),
            ..RuntimeTaskLink::default()
        };

        assert!(!supervisor_needs_scheduled_check(&link, false, 200));
    }

    #[test]
    fn repeated_auto_correction_is_suppressed_for_a_short_window() {
        let supervisor = RuntimeSupervisorState {
            mode: "auto".to_owned(),
            status: "active".to_owned(),
            instructions: String::new(),
            model_id: None,
            interval_seconds: 30,
            last_evaluated_at: Some(100),
            last_content_hash: Some("hash".to_owned()),
            last_error: None,
            suggestions: vec![RuntimeSupervisorSuggestion {
                id: "suggestion-1".to_owned(),
                message: "Use Japanese".to_owned(),
                rationale: String::new(),
                status: "accepted".to_owned(),
                created_at: 1_000,
                resolved_at: Some(1_000),
                source_turn_id: None,
            }],
        };

        assert!(recently_sent_same_correction(
            &supervisor,
            "Use Japanese",
            2_000
        ));
    }
}
