// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::time::Duration;

use serde_json::{json, Value};
use tokio::{
    io::AsyncWriteExt,
    process::ChildStdin,
    time::{timeout_at, Instant},
};

use crate::runner::ExecutionOutcome;

use super::{
    codex_approval_result, codex_error_message, codex_notification_has_initial_progress,
    codex_turn_startup_timeout_seconds, debug_stdout::CodexStdout,
    is_codex_approval_request_method, is_mcp_tool_call_approval_request, json_rpc_request_id,
    mcp_tool_call_request_user_input_response, message_params,
    receive_mcp_server_elicitation_response, request_user_input_result, response_id,
    response_result, CodexNotificationSender, CodexRequestUserInputReceiver, CodexRunState,
};

pub(super) struct JsonRpcConnection {
    stdin: ChildStdin,
    stdout: CodexStdout,
    next_id: u64,
    runtime_notifications: Option<super::CodexNotificationHub>,
}

pub(super) struct TurnReadOptions {
    pub active_turn_started: Option<super::CodexActiveTurnCallback>,
    pub overload_turn_recovering: Option<super::CodexActiveTurnCallback>,
    pub overload_continuation_params: Value,
    pub notifications: Option<CodexNotificationSender>,
    pub request_user_input_answers: Option<CodexRequestUserInputReceiver>,
    pub auto_approve_mcp_tool_calls: bool,
    pub defer_interactive_forms: bool,
    pub stand_in_single_approval: bool,
}

fn notify_active_turn(
    callback: &Option<super::CodexActiveTurnCallback>,
    active_turn_id: &mut Option<String>,
    thread_id: &str,
    observed: Option<String>,
) {
    let Some(turn_id) = observed.filter(|turn_id| active_turn_id.as_ref() != Some(turn_id)) else {
        return;
    };
    if let Some(callback) = callback.as_ref() {
        callback(thread_id.to_owned(), turn_id.clone());
    }
    *active_turn_id = Some(turn_id);
}

impl JsonRpcConnection {
    pub(super) fn new(stdin: ChildStdin, stdout: CodexStdout, next_id: u64) -> Self {
        Self {
            stdin,
            stdout,
            next_id,
            runtime_notifications: None,
        }
    }

    pub(super) fn with_runtime_notifications(
        mut self,
        runtime: Option<super::CodexNotificationHub>,
    ) -> Self {
        self.runtime_notifications = runtime;
        self
    }

    pub(super) async fn publish_runtime_notification(&self, message: Value) {
        if let Some(runtime) = &self.runtime_notifications {
            runtime.send(message).await;
        }
    }

    pub(super) fn into_parts(self) -> (ChildStdin, CodexStdout, u64) {
        (self.stdin, self.stdout, self.next_id)
    }

    pub(super) async fn request(
        &mut self,
        method: &str,
        request_params: Value,
        state: &mut CodexRunState,
    ) -> Result<Value, String> {
        let request_id = self.send_request(method, request_params).await?;
        loop {
            let message = self.read_message().await?;
            if response_id(&message) == Some(request_id) {
                return response_result(message);
            }
            if let Some(outcome) = state.handle_message(&message) {
                return Err(format!(
                    "codex app-server completed before {method} response: {outcome:?}"
                ));
            }
        }
    }

    pub(super) async fn request_ignoring_notifications(
        &mut self,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        let request_id = self.send_request(method, params).await?;
        loop {
            let message = self.read_message().await?;
            if response_id(&message) == Some(request_id) {
                return response_result(message);
            }
            if message.get("method").and_then(Value::as_str) == Some("error") {
                return Err(codex_error_message(message_params(&message)));
            }
        }
    }

    pub(super) async fn send_request(
        &mut self,
        method: &str,
        params: Value,
    ) -> Result<u64, String> {
        let request_id = self.next_id;
        self.next_id += 1;
        self.write_message(json!({
            "method": method,
            "id": request_id,
            "params": params,
        }))
        .await?;
        Ok(request_id)
    }

    pub(super) async fn notify(&mut self, method: &str, params: Value) -> Result<(), String> {
        self.write_message(json!({
            "method": method,
            "params": params,
        }))
        .await
    }

    pub(super) async fn read_turn(
        &mut self,
        mut turn_request_id: u64,
        state: &mut CodexRunState,
        options: TurnReadOptions,
    ) -> Result<ExecutionOutcome, String> {
        let TurnReadOptions {
            active_turn_started,
            overload_turn_recovering,
            overload_continuation_params,
            notifications,
            mut request_user_input_answers,
            auto_approve_mcp_tool_calls,
            defer_interactive_forms,
            stand_in_single_approval,
        } = options;
        let mut saw_turn_response = false;
        let mut active_turn_id = None;
        let thread_id = overload_continuation_params["threadId"]
            .as_str()
            .unwrap_or("")
            .to_owned();
        let startup_timeout_seconds = codex_turn_startup_timeout_seconds();
        let mut startup_deadline = Instant::now() + Duration::from_secs(startup_timeout_seconds);
        let mut waiting_for_initial_progress = true;
        let mut overload_recovery = super::overload_recovery::OverloadRecovery::default();
        let mut recovering_goal = false;
        loop {
            let mut message = if waiting_for_initial_progress {
                match timeout_at(startup_deadline, self.read_message()).await {
                    Ok(result) => result?,
                    Err(_) => {
                        return Err(format!(
                            "codex app-server turn made no model or tool progress for {startup_timeout_seconds}s"
                        ));
                    }
                }
            } else {
                self.read_message().await?
            };
            if response_id(&message) == Some(turn_request_id) {
                let response = response_result(message)?;
                notify_active_turn(
                    &active_turn_started,
                    &mut active_turn_id,
                    &thread_id,
                    super::turn_start_response_id(&response),
                );
                if recovering_goal {
                    super::sync_goal_status_from_response(state, &response);
                }
                saw_turn_response = true;
                continue;
            }
            let observed =
                super::observed_active_turn_id(active_turn_id.as_deref(), None, &message, state)
                    .map(|(turn_id, _)| turn_id);
            notify_active_turn(
                &active_turn_started,
                &mut active_turn_id,
                &thread_id,
                observed,
            );
            if waiting_for_initial_progress
                && codex_notification_has_initial_progress(&message, state)
            {
                waiting_for_initial_progress = false;
            }
            match overload_recovery.observe(&message, state) {
                super::overload_recovery::RecoveryAction::Forward => {}
                super::overload_recovery::RecoveryAction::AwaitCompletion => {
                    waiting_for_initial_progress = true;
                    startup_deadline =
                        Instant::now() + Duration::from_secs(startup_timeout_seconds);
                    continue;
                }
                super::overload_recovery::RecoveryAction::Retry {
                    delay,
                    notification,
                    goal,
                } => {
                    if let Some(callback) = overload_turn_recovering.as_ref() {
                        let params = message_params(&message);
                        if let (Some(thread_id), Some(turn_id)) = (
                            params.get("threadId").and_then(Value::as_str),
                            params.pointer("/turn/id").and_then(Value::as_str),
                        ) {
                            callback(thread_id.to_owned(), turn_id.to_owned());
                        }
                    }
                    let _ = state.handle_message(&message);
                    if let Some(sender) = &notifications {
                        let _ = sender.send(notification.into());
                    }
                    tokio::time::sleep(delay).await;
                    startup_deadline =
                        Instant::now() + Duration::from_secs(startup_timeout_seconds);
                    let (method, params) = if let Some(goal) = goal {
                        let current = super::with_rpc_timeout(
                            "overload Goal snapshot",
                            super::codex_rpc_timeout_seconds(),
                            self.request(
                                "thread/goal/get",
                                json!({"threadId": goal["threadId"]}),
                                state,
                            ),
                        )
                        .await?;
                        recovering_goal = true;
                        let Some(params) =
                            super::overload_recovery::goal_resume_params(&goal, &current)?
                        else {
                            super::overload_recovery::sync_goal_snapshot(
                                state,
                                notifications.as_ref(),
                                goal["threadId"]
                                    .as_str()
                                    .ok_or("Stopped goal has no thread ID")?,
                                &current,
                            );
                            if !state.goal_is_active() {
                                return Ok(ExecutionOutcome::Cancelled {
                                    message: "Goal changed during model overload recovery"
                                        .to_owned(),
                                });
                            }
                            waiting_for_initial_progress = true;
                            continue;
                        };
                        ("thread/goal/set", params)
                    } else {
                        recovering_goal = false;
                        ("turn/start", overload_continuation_params.clone())
                    };
                    turn_request_id = super::with_rpc_timeout(
                        "overload continuation",
                        super::codex_rpc_timeout_seconds(),
                        self.send_request(method, params),
                    )
                    .await?;
                    waiting_for_initial_progress = true;
                    saw_turn_response = false;
                    continue;
                }
            }
            super::elicitation::prepare(&mut message);
            if super::prepare_runtime_notification(
                &mut message,
                auto_approve_mcp_tool_calls,
                stand_in_single_approval,
            ) {
                if let Some(sender) = &notifications {
                    let _ = sender.send(message.clone().into());
                }
            }
            if defer_interactive_forms
                && !state.is_subagent_message(message_params(&message))
                && super::mcp_form::deferred_form(&message).is_some()
            {
                // End this native turn before accepting a form answer as a new turn.
                // Wait for the interrupted turn to settle so its tool history is saved.
                super::with_rpc_timeout(
                    "defer interactive form",
                    super::codex_rpc_timeout_seconds(),
                    self.finish_deferred_form(message_params(&message)),
                )
                .await?;
                return Ok(ExecutionOutcome::WaitingForUserInput {
                    stop_reason: "tool_deferred".to_owned(),
                });
            }
            if message
                .get("method")
                .and_then(Value::as_str)
                .is_some_and(|method| method == "item/tool/requestUserInput")
            {
                self.answer_request_user_input(
                    &message,
                    &mut request_user_input_answers,
                    auto_approve_mcp_tool_calls,
                )
                .await?;
                continue;
            }
            if message
                .get("method")
                .and_then(Value::as_str)
                .is_some_and(|method| method == "mcpServer/elicitation/request")
            {
                self.answer_mcp_server_elicitation(
                    &message,
                    &mut request_user_input_answers,
                    auto_approve_mcp_tool_calls,
                    notifications.as_ref(),
                )
                .await?;
                continue;
            }
            if message
                .get("method")
                .and_then(Value::as_str)
                .is_some_and(is_codex_approval_request_method)
            {
                self.answer_approval(
                    &message,
                    &mut request_user_input_answers,
                    notifications.as_ref(),
                )
                .await?;
                continue;
            }
            if let Some(outcome) = state.handle_message(&message) {
                if super::should_wait_for_goal_continuation(&outcome, state, recovering_goal) {
                    waiting_for_initial_progress = true;
                    startup_deadline =
                        Instant::now() + Duration::from_secs(startup_timeout_seconds);
                    continue;
                }
                return Ok(outcome);
            }
            if !saw_turn_response {
                continue;
            }
        }
    }

    async fn finish_deferred_form(&mut self, params: &Value) -> Result<(), String> {
        let thread_id = params.get("threadId").ok_or("Form has no thread ID")?;
        let turn_id = params.get("turnId").ok_or("Form has no turn ID")?;
        let request_id = self
            .send_request(
                "turn/interrupt",
                json!({"threadId": thread_id, "turnId": turn_id}),
            )
            .await?;
        loop {
            let message = self.read_message().await?;
            if response_id(&message) == Some(request_id) {
                response_result(message)?;
                continue;
            }
            if message["method"] == "turn/completed"
                && message.pointer("/params/threadId") == Some(thread_id)
                && message.pointer("/params/turn/id") == Some(turn_id)
            {
                return Ok(());
            }
        }
    }

    async fn answer_request_user_input(
        &mut self,
        message: &Value,
        request_user_input_answers: &mut Option<CodexRequestUserInputReceiver>,
        auto_approve_mcp_tool_calls: bool,
    ) -> Result<(), String> {
        let request_id = json_rpc_request_id(message)
            .ok_or_else(|| "request_user_input message is missing JSON-RPC id".to_owned())?;
        if auto_approve_mcp_tool_calls {
            if let Some(response) =
                mcp_tool_call_request_user_input_response(message_params(message))
            {
                return self
                    .write_message(json!({
                        "id": request_id,
                        "result": response,
                    }))
                    .await;
            }
        }
        let Some(receiver) = request_user_input_answers else {
            return Err("request_user_input requires a runtime response channel".to_owned());
        };
        let response = receiver
            .recv()
            .await
            .ok_or_else(|| "request_user_input response channel closed".to_owned())?;
        self.write_message(json!({
            "id": request_id,
            "result": request_user_input_result(response),
        }))
        .await
    }

    async fn answer_approval(
        &mut self,
        message: &Value,
        answers: &mut Option<CodexRequestUserInputReceiver>,
        notifications: Option<&CodexNotificationSender>,
    ) -> Result<(), String> {
        let request_id =
            json_rpc_request_id(message).ok_or("approval request is missing JSON-RPC id")?;
        let (response, status) = match answers {
            Some(receiver) => {
                match tokio::time::timeout(super::elicitation::remaining(message), receiver.recv())
                    .await
                {
                    Ok(response) => (
                        response.ok_or("approval response channel closed")?,
                        "answered",
                    ),
                    Err(_) => (json!({}), "expired"),
                }
            }
            None => (json!({}), "cancelled"),
        };
        let settled = super::elicitation::settled(message, status, Some(&response));
        self.publish_runtime_notification(settled.clone()).await;
        if let Some(sender) = notifications {
            let _ = sender.send(settled.into());
        }
        self.write_message(json!({
            "id": request_id,
            "result": codex_approval_result(message, &response)?,
        }))
        .await
    }

    async fn answer_mcp_server_elicitation(
        &mut self,
        message: &Value,
        request_user_input_answers: &mut Option<CodexRequestUserInputReceiver>,
        auto_approve_mcp_tool_calls: bool,
        notifications: Option<&CodexNotificationSender>,
    ) -> Result<(), String> {
        let request_id = json_rpc_request_id(message)
            .ok_or_else(|| "mcpServer/elicitation/request is missing JSON-RPC id".to_owned())?;
        // Auto-approved requests were not forwarded to the UI and must not create
        // a settled interaction or clear another request's waiting state.
        let visible = !(auto_approve_mcp_tool_calls && is_mcp_tool_call_approval_request(message));
        let result = receive_mcp_server_elicitation_response(
            message,
            request_user_input_answers.as_mut(),
            auto_approve_mcp_tool_calls,
        )
        .await?;
        if visible {
            let settled =
                super::elicitation::settled(message, result.status, result.response.as_ref());
            self.publish_runtime_notification(settled.clone()).await;
            if let Some(sender) = notifications {
                let _ = sender.send(settled.into());
            }
        }
        self.write_message(json!({
            "id": request_id,
            "result": result.result,
        }))
        .await
    }

    pub(super) async fn write_message(&mut self, message: Value) -> Result<(), String> {
        let mut line = serde_json::to_vec(&message)
            .map_err(|error| format!("failed to encode codex JSON-RPC message: {error}"))?;
        line.push(b'\n');
        self.stdin
            .write_all(&line)
            .await
            .map_err(|error| format!("failed to write codex JSON-RPC message: {error}"))?;
        self.stdin
            .flush()
            .await
            .map_err(|error| format!("failed to flush codex JSON-RPC message: {error}"))
    }

    pub(super) async fn read_message(&mut self) -> Result<Value, String> {
        let mut line = String::new();
        let bytes_read = self
            .stdout
            .read_line(&mut line)
            .await
            .map_err(|error| format!("failed to read codex JSON-RPC message: {error}"))?;
        if bytes_read == 0 {
            return Err("codex app-server exited before completing the turn".to_owned());
        }
        let mut message: Value = serde_json::from_str(&line)
            .map_err(|error| format!("failed to parse codex JSON-RPC message: {error}"))?;
        if message.get("method").is_some() {
            message = super::external_work::project_review_notification(message);
            super::elicitation::prepare(&mut message);
            self.publish_runtime_notification(message.clone()).await;
        }
        Ok(message)
    }
}
