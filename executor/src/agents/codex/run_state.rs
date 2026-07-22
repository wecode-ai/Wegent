// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde_json::Value;

use super::diagnostics::{
    json_object_keys, json_scalar_field, json_string_field, nested_json_string_field,
    raw_log_preview, serialized_json_len, truncate_text,
};
use super::{codex_error_message, extract_text, message_params};
use crate::{
    codex_phase::{codex_phase_is_process, CodexAgentMessagePhaseTracker},
    logging::log_executor_event,
    runner::ExecutionOutcome,
    runtime_work::codex_stream_debug_enabled,
};

#[derive(Default)]
pub(super) struct CodexRunState {
    final_text: String,
    saw_delta: bool,
    agent_message_phases: CodexAgentMessagePhaseTracker,
    root_thread_id: Option<String>,
    goal_status: Option<String>,
}

impl CodexRunState {
    pub(super) fn set_root_thread_id(&mut self, thread_id: impl Into<String>) {
        self.root_thread_id = Some(thread_id.into());
    }

    pub(super) fn set_goal_status(&mut self, status: impl Into<String>) {
        self.goal_status = Some(status.into().to_ascii_lowercase());
    }

    pub(super) fn goal_is_active(&self) -> bool {
        self.goal_status
            .as_deref()
            .is_some_and(|status| status.eq_ignore_ascii_case("active"))
    }

    pub(super) fn reset_turn_output(&mut self) {
        self.final_text.clear();
        self.saw_delta = false;
        self.agent_message_phases = CodexAgentMessagePhaseTracker::default();
    }

    pub(super) fn handle_message(&mut self, message: &Value) -> Option<ExecutionOutcome> {
        match message.get("method").and_then(Value::as_str) {
            Some("thread/started") => {
                if self.root_thread_id.is_none() {
                    if let Some(thread_id) = stream_thread_id(message_params(message)) {
                        self.root_thread_id = Some(thread_id);
                    }
                }
                None
            }
            Some("turn/started") => {
                if !self.is_subagent_message(message_params(message)) {
                    self.reset_turn_output();
                }
                None
            }
            Some("thread/goal/updated") => {
                if let Some(status) = message_params(message)
                    .get("goal")
                    .and_then(|goal| goal.get("status"))
                    .and_then(Value::as_str)
                {
                    self.set_goal_status(status);
                }
                None
            }
            Some("thread/goal/cleared") => {
                self.goal_status = None;
                None
            }
            Some("item/started") => {
                if self.is_subagent_message(message_params(message)) {
                    return None;
                }
                self.agent_message_phases
                    .observe_item(message_params(message));
                None
            }
            Some("item/agentMessage/delta") => {
                if self.is_subagent_message(message_params(message)) {
                    return None;
                }
                self.append_delta(message_params(message));
                None
            }
            Some("item/completed") => {
                let params = message_params(message);
                if self.is_subagent_message(params) {
                    return None;
                }
                self.append_completed_message(params);
                self.agent_message_phases.forget_item(params);
                None
            }
            Some("turn/completed")
                if !self.is_subagent_message(message_params(message))
                    && is_root_codex_turn_event(message_params(message)) =>
            {
                Some(self.completed(message_params(message)))
            }
            Some("turn/completed") => None,
            Some("error") => {
                let params = message_params(message);
                log_codex_run_state_error(params);
                if codex_error_will_retry(params) {
                    return None;
                }
                Some(ExecutionOutcome::Failed {
                    message: codex_error_message(params),
                })
            }
            _ => None,
        }
    }

    pub(super) fn is_subagent_message(&self, params: &Value) -> bool {
        codex_agent_path(params)
            .or_else(|| params.get("item").and_then(codex_agent_path))
            .is_some_and(|agent_path| agent_path != "/root")
            || self
                .root_thread_id
                .as_deref()
                .is_some_and(|root_thread_id| {
                    stream_thread_id(params).is_some_and(|thread_id| thread_id != root_thread_id)
                })
    }

    fn append_delta(&mut self, params: &Value) {
        let text = params.get("delta").and_then(Value::as_str).unwrap_or("");
        let phase = self.agent_message_phases.phase_for_delta(params);
        if codex_phase_is_process(phase.as_deref()) {
            log_codex_run_state_text(
                "delta",
                "skip_process",
                phase.as_deref(),
                params,
                params,
                text,
            );
            return;
        }
        if let Some(delta) = params.get("delta").and_then(Value::as_str) {
            log_codex_run_state_text(
                "delta",
                "append_final",
                phase.as_deref(),
                params,
                params,
                delta,
            );
            self.final_text.push_str(delta);
            self.saw_delta = true;
        }
    }

    fn append_completed_message(&mut self, params: &Value) {
        let phase = self.agent_message_phases.phase_for_item(params);
        if self.saw_delta {
            log_codex_run_state_text(
                "completed",
                "skip_after_delta",
                phase.as_deref(),
                params,
                params,
                "",
            );
            return;
        }
        let item = params.get("item").unwrap_or(params);
        let item_type = item
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .replace('_', "")
            .to_ascii_lowercase();
        if item_type == "plan" {
            let text = extract_text(item).unwrap_or_default();
            log_codex_run_state_text(
                "completed",
                "skip_plan",
                phase.as_deref(),
                params,
                item,
                &text,
            );
            return;
        }
        if !matches!(item_type.as_str(), "agentmessage" | "message") {
            log_codex_run_state_text("completed", "skip_non_message", None, params, item, "");
            return;
        }
        if codex_phase_is_process(phase.as_deref()) {
            let text = extract_text(item).unwrap_or_default();
            log_codex_run_state_text(
                "completed",
                "skip_process",
                phase.as_deref(),
                params,
                item,
                &text,
            );
            return;
        }
        if item
            .get("role")
            .and_then(Value::as_str)
            .is_some_and(|role| role != "assistant")
        {
            log_codex_run_state_text(
                "completed",
                "skip_non_assistant",
                phase.as_deref(),
                params,
                item,
                "",
            );
            return;
        }
        if let Some(text) = extract_text(item) {
            log_codex_run_state_text(
                "completed",
                "set_final",
                phase.as_deref(),
                params,
                item,
                &text,
            );
            self.final_text = text;
            self.saw_delta = true;
        }
    }

    fn completed(&self, params: &Value) -> ExecutionOutcome {
        let status = params
            .get("turn")
            .and_then(|turn| turn.get("status"))
            .or_else(|| params.get("status"))
            .and_then(Value::as_str)
            .unwrap_or("completed")
            .to_ascii_lowercase();
        match status.as_str() {
            "completed" | "complete" | "succeeded" => ExecutionOutcome::Completed {
                content: self.final_text.clone(),
            },
            "cancelled" | "canceled" | "interrupted" => {
                ExecutionOutcome::Cancelled { message: status }
            }
            other => ExecutionOutcome::Failed {
                message: format!("codex turn ended with status {other}"),
            },
        }
    }
}

fn codex_error_will_retry(params: &Value) -> bool {
    params
        .get("willRetry")
        .or_else(|| params.get("will_retry"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn is_root_codex_turn_event(params: &Value) -> bool {
    let turn = params.get("turn").unwrap_or(params);
    codex_agent_path(turn)
        .or_else(|| codex_agent_path(params))
        .map_or(true, |agent_path| agent_path == "/root")
}

pub(super) fn stream_thread_id(value: &Value) -> Option<String> {
    value
        .get("threadId")
        .or_else(|| value.get("thread_id"))
        .and_then(Value::as_str)
        .or_else(|| {
            value
                .get("thread")
                .and_then(|thread| thread.get("id"))
                .and_then(Value::as_str)
        })
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn codex_agent_path(value: &Value) -> Option<String> {
    value
        .get("agent_path")
        .or_else(|| value.get("agentPath"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn log_codex_run_state_text(
    source: &str,
    action: &str,
    resolved_phase: Option<&str>,
    params: &Value,
    item: &Value,
    text: &str,
) {
    if source == "delta" && !codex_stream_debug_enabled() {
        return;
    }

    log_executor_event(
        "codex run state text classification",
        &[
            ("source", source.to_owned()),
            ("action", action.to_owned()),
            (
                "resolved_phase",
                resolved_phase.unwrap_or("<none>").to_owned(),
            ),
            ("item_id", json_string_field(params, "itemId")),
            ("params_type", json_string_field(params, "type")),
            ("params_phase", json_string_field(params, "phase")),
            ("params_channel", json_string_field(params, "channel")),
            ("item_type", json_string_field(item, "type")),
            ("item_phase", json_string_field(item, "phase")),
            ("item_channel", json_string_field(item, "channel")),
            (
                "payload_type",
                nested_json_string_field(item, "payload", "type"),
            ),
            (
                "payload_phase",
                nested_json_string_field(item, "payload", "phase"),
            ),
            (
                "payload_channel",
                nested_json_string_field(item, "payload", "channel"),
            ),
            ("text_len", text.len().to_string()),
            ("text_preview", truncate_text(text, 160)),
        ],
    );
}

fn log_codex_run_state_error(params: &Value) {
    let message = codex_error_message(params);
    let params_json = serde_json::to_string(params)
        .unwrap_or_else(|error| format!("failed to serialize codex error params: {error}"));
    log_executor_event(
        "codex run state error",
        &[
            ("message", message),
            ("code", json_string_field(params, "code")),
            ("params_len", params_json.len().to_string()),
            ("params_preview", truncate_text(&params_json, 500)),
        ],
    );
}

pub(super) fn log_codex_raw_turn_message(message: &Value) {
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    if matches!(
        method,
        "item/agentMessage/delta" | "item/reasoning/delta" | "item/reasoningSummary/delta"
    ) && !codex_stream_debug_enabled()
    {
        return;
    }

    if !matches!(
        method,
        "item/agentMessage/delta"
            | "item/reasoning/delta"
            | "item/reasoningSummary/delta"
            | "item/fileChange/patchUpdated"
            | "turn/plan/updated"
            | "item/started"
            | "item/completed"
            | "turn/completed"
            | "error"
    ) {
        return;
    }

    let params = message_params(message);
    let item = params.get("item").unwrap_or(params);
    let raw_len = serialized_json_len(message)
        .map(|length| length.to_string())
        .unwrap_or_else(|error| format!("failed to measure codex raw message: {error}"));
    let raw_preview = raw_log_preview(message);
    log_executor_event(
        "codex raw turn message",
        &[
            ("method", method.to_owned()),
            ("message_id", json_string_field(message, "id")),
            ("params_keys", json_object_keys(params)),
            ("params_type", json_string_field(params, "type")),
            ("params_phase", json_string_field(params, "phase")),
            ("params_channel", json_string_field(params, "channel")),
            ("params_item_id", json_string_field(params, "item_id")),
            ("params_message_id", json_string_field(params, "message_id")),
            (
                "params_output_index",
                json_scalar_field(params, "output_index"),
            ),
            (
                "params_content_index",
                json_scalar_field(params, "content_index"),
            ),
            ("item_keys", json_object_keys(item)),
            ("item_type", json_string_field(item, "type")),
            ("item_id", json_string_field(item, "id")),
            ("item_phase", json_string_field(item, "phase")),
            ("item_channel", json_string_field(item, "channel")),
            (
                "item_turn_id",
                nested_json_string_field(
                    item,
                    "internal_chat_message_metadata_passthrough",
                    "turn_id",
                ),
            ),
            ("raw_len", raw_len),
            ("raw_preview", raw_preview),
        ],
    );
}
