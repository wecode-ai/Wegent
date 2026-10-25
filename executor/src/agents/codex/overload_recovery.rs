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
    stopped_goal: Option<(String, Value)>,
    goal_invalidated: bool,
}

pub(super) enum RecoveryAction {
    Forward,
    AwaitCompletion,
    Retry {
        delay: Duration,
        notification: Value,
        goal: Option<Value>,
    },
}

impl OverloadRecovery {
    pub(super) fn observe(&mut self, message: &Value, state: &CodexRunState) -> RecoveryAction {
        let params = message_params(message);
        if state.is_subagent_message(params)
            || params
                .get("turn")
                .is_some_and(|turn| state.is_subagent_message(turn))
        {
            return RecoveryAction::Forward;
        }
        match message.get("method").and_then(Value::as_str) {
            Some("thread/goal/updated") => {
                self.goal_invalidated |= self.stopped_goal.is_some();
                // Only a turn-owned stop can belong to this error. User mutations
                // have no turn ID and must invalidate any pending restoration.
                self.stopped_goal = params.get("goal").and_then(|goal| {
                    (goal.get("status").and_then(Value::as_str) == Some("blocked"))
                        .then(|| {
                            params
                                .get("turnId")
                                .and_then(Value::as_str)
                                .map(|turn_id| (turn_id.to_owned(), goal.clone()))
                        })
                        .flatten()
                });
            }
            Some("thread/goal/cleared") => {
                self.goal_invalidated |= self.stopped_goal.is_some();
                self.stopped_goal = None;
            }
            _ => {}
        }
        if self.retries == RETRY_DELAYS.len() {
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
                if self.goal_invalidated {
                    self.pending_error = None;
                    self.goal_invalidated = false;
                    self.stopped_goal = None;
                    return RecoveryAction::Forward;
                }
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
                    goal: self.stopped_goal.take().and_then(|(turn_id, goal)| {
                        (turn.get("id").and_then(Value::as_str) == Some(turn_id.as_str()))
                            .then_some(goal)
                    }),
                }
            }
            _ => RecoveryAction::Forward,
        }
    }
}

pub(super) fn goal_resume_params(
    expected: &Value,
    response: &Value,
) -> Result<Option<Value>, String> {
    // Re-read after backoff: never resurrect a deleted, paused, replaced, or
    // otherwise edited goal. Preserve its objective, budget, and accounting.
    if response.get("goal") != Some(expected) {
        return Ok(None);
    }
    Ok(Some(json!({
        "threadId": expected.get("threadId").ok_or("Stopped goal has no thread ID")?,
        "status": "active",
        "origin": "automatic",
    })))
}

pub(super) async fn resume_goal(
    client: &super::CodexAppServerClient,
    thread_id: &str,
    expected: &Value,
) -> Result<(Value, bool), String> {
    // Codex has no conditional Goal update. Share the lifecycle gate with user
    // mutations so a pause or clear cannot land between this read and write.
    let gate = client.thread_lifecycle_gate(thread_id).await;
    let _guard = gate.lock().await;
    let current = client
        .request("thread/goal/get", json!({"threadId": thread_id}))
        .await?;
    match goal_resume_params(expected, &current)? {
        Some(params) => client
            .request("thread/goal/set", params)
            .await
            .map(|response| (response, true)),
        None => Ok((current, false)),
    }
}

pub(super) fn sync_goal_snapshot(
    state: &mut CodexRunState,
    notifications: Option<&super::CodexNotificationSender>,
    thread_id: &str,
    response: &Value,
) {
    super::sync_goal_status_from_response(state, response);
    // A changed Goal ends recovery before queued notifications can be drained.
    // Publish the authoritative snapshot so the task and composer settle together.
    if let Some(sender) = notifications {
        let goal = response.get("goal").cloned().unwrap_or(Value::Null);
        let method = if goal.is_null() {
            "thread/goal/cleared"
        } else {
            "thread/goal/updated"
        };
        let _ = sender.send(
            json!({"method": method, "params": {
                "threadId": thread_id, "turnId": null, "goal": goal,
            }})
            .into(),
        );
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
