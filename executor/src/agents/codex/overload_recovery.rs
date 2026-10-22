// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::oneshot;

use super::{message_params, CodexRunState, CODEX_APP_SERVER_TURN_CANCELLED};

const RETRY_DELAYS: [u64; 5] = [5, 10, 20, 40, 60];

#[derive(Default)]
pub(super) struct OverloadRecovery {
    retries: usize,
    pending_error: Option<Value>,
}

pub(super) enum RecoveryAction {
    Forward,
    AwaitCompletion,
    Retry {
        delay: Duration,
        notification: Value,
    },
}

impl OverloadRecovery {
    pub(super) fn observe(&mut self, message: &Value, state: &CodexRunState) -> RecoveryAction {
        let params = message_params(message);
        if state.is_subagent_message(params)
            || params
                .get("turn")
                .is_some_and(|turn| state.is_subagent_message(turn))
            || self.retries == RETRY_DELAYS.len()
        {
            return RecoveryAction::Forward;
        }
        match message.get("method").and_then(Value::as_str) {
            Some("error") if is_terminal_overload(params) => {
                // A native error precedes turn/completed. Do not start another turn
                // until Codex has settled the failed turn and saved its tool history.
                self.pending_error = Some(message.clone());
                RecoveryAction::AwaitCompletion
            }
            Some("turn/completed") => {
                let turn = params.get("turn").unwrap_or(params);
                if turn.get("status").and_then(Value::as_str) != Some("failed") {
                    self.pending_error = None;
                    return RecoveryAction::Forward;
                }
                let error = self.pending_error.take().or_else(|| {
                    is_terminal_overload(turn).then(|| {
                        json!({"method": "error", "params": {
                            "threadId": params.get("threadId"),
                            "turnId": turn.get("id"),
                            "error": turn.get("error"),
                        }})
                    })
                });
                let Some(mut notification) = error else {
                    return RecoveryAction::Forward;
                };
                let delay = Duration::from_secs(RETRY_DELAYS[self.retries]);
                self.retries += 1;
                notification["params"]["willRetry"] = json!(true);
                notification["params"]["error"]["additionalDetails"] = json!(format!(
                    "Retrying overloaded model in {}s ({}/{}).",
                    delay.as_secs(),
                    self.retries,
                    RETRY_DELAYS.len()
                ));
                super::log_executor_event(
                    "codex overloaded turn recovery",
                    &[
                        (
                            "thread_id",
                            params
                                .get("threadId")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_owned(),
                        ),
                        ("retry", self.retries.to_string()),
                        ("max_retries", RETRY_DELAYS.len().to_string()),
                        ("delay_ms", delay.as_millis().to_string()),
                    ],
                );
                RecoveryAction::Retry {
                    delay,
                    notification,
                }
            }
            _ => RecoveryAction::Forward,
        }
    }
}

#[cfg(test)]
#[path = "overload_recovery_tests.rs"]
mod tests;

fn is_terminal_overload(params: &Value) -> bool {
    params
        .get("willRetry")
        .or_else(|| params.get("will_retry"))
        .and_then(Value::as_bool)
        != Some(true)
        && params
            .pointer("/error/codexErrorInfo")
            .and_then(Value::as_str)
            == Some("serverOverloaded")
}

pub(super) fn continuation_params(mut params: Value) -> Value {
    // Empty native input resumes the saved history without replaying the task,
    // attachments, user-message identity, or already merged additional context.
    let object = params
        .as_object_mut()
        .expect("turn/start parameters must be an object");
    object.insert("input".to_owned(), json!([]));
    object.remove("clientUserMessageId");
    object.remove("additionalContext");
    params
}

pub(super) async fn wait_for_retry(
    delay: Duration,
    cancellation: &mut Option<oneshot::Receiver<()>>,
) -> Result<(), String> {
    if let Some(cancel_rx) = cancellation.as_mut() {
        tokio::select! {
            biased;
            _ = cancel_rx => Err(CODEX_APP_SERVER_TURN_CANCELLED.to_owned()),
            _ = tokio::time::sleep(delay) => Ok(()),
        }
    } else {
        tokio::time::sleep(delay).await;
        Ok(())
    }
}
