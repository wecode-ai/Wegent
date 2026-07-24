// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::time::Duration;

use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{ChildStdin, ChildStdout},
    time::{timeout_at, Instant},
};

use crate::runner::ExecutionOutcome;

use super::{
    codex_error_message, codex_notification_has_initial_progress,
    codex_turn_startup_timeout_seconds, json_rpc_request_id, log_codex_raw_turn_message,
    message_params, receive_mcp_server_elicitation_response, request_user_input_result,
    response_id, response_result, CodexNotificationSender, CodexRequestUserInputReceiver,
    CodexRunState,
};

pub(super) struct JsonRpcConnection {
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

impl JsonRpcConnection {
    pub(super) fn new(stdin: ChildStdin, stdout: ChildStdout) -> Self {
        Self::new_with_next_id(stdin, stdout, 1)
    }

    pub(super) fn new_with_next_id(stdin: ChildStdin, stdout: ChildStdout, next_id: u64) -> Self {
        Self {
            stdin,
            stdout: BufReader::new(stdout),
            next_id,
        }
    }

    pub(super) fn into_parts(self) -> (ChildStdin, BufReader<ChildStdout>, u64) {
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
        turn_request_id: u64,
        state: &mut CodexRunState,
        notifications: Option<CodexNotificationSender>,
        mut request_user_input_answers: Option<CodexRequestUserInputReceiver>,
    ) -> Result<ExecutionOutcome, String> {
        let mut saw_turn_response = false;
        let startup_timeout_seconds = codex_turn_startup_timeout_seconds();
        let startup_deadline = Instant::now() + Duration::from_secs(startup_timeout_seconds);
        let mut waiting_for_initial_progress = true;
        loop {
            let message = if waiting_for_initial_progress {
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
            log_codex_raw_turn_message(&message);
            if response_id(&message) == Some(turn_request_id) {
                response_result(message)?;
                saw_turn_response = true;
                continue;
            }
            if waiting_for_initial_progress
                && codex_notification_has_initial_progress(&message, state)
            {
                waiting_for_initial_progress = false;
            }
            if let Some(sender) = &notifications {
                let _ = sender.send(message.clone());
            }
            if message
                .get("method")
                .and_then(Value::as_str)
                .is_some_and(|method| method == "item/tool/requestUserInput")
            {
                self.answer_request_user_input(&message, &mut request_user_input_answers)
                    .await?;
                continue;
            }
            if message
                .get("method")
                .and_then(Value::as_str)
                .is_some_and(|method| method == "mcpServer/elicitation/request")
            {
                self.answer_mcp_server_elicitation(&message, &mut request_user_input_answers)
                    .await?;
                continue;
            }
            if let Some(outcome) = state.handle_message(&message) {
                return Ok(outcome);
            }
            if !saw_turn_response {
                continue;
            }
        }
    }

    async fn answer_request_user_input(
        &mut self,
        message: &Value,
        request_user_input_answers: &mut Option<CodexRequestUserInputReceiver>,
    ) -> Result<(), String> {
        let request_id = json_rpc_request_id(message)
            .ok_or_else(|| "request_user_input message is missing JSON-RPC id".to_owned())?;
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

    async fn answer_mcp_server_elicitation(
        &mut self,
        message: &Value,
        request_user_input_answers: &mut Option<CodexRequestUserInputReceiver>,
    ) -> Result<(), String> {
        let request_id = json_rpc_request_id(message)
            .ok_or_else(|| "mcpServer/elicitation/request is missing JSON-RPC id".to_owned())?;
        let result =
            receive_mcp_server_elicitation_response(message, request_user_input_answers.as_mut())
                .await?;
        self.write_message(json!({
            "id": request_id,
            "result": result,
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
        let message: Value = serde_json::from_str(&line)
            .map_err(|error| format!("failed to parse codex JSON-RPC message: {error}"))?;
        Ok(message)
    }
}
