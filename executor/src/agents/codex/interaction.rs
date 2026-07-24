// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{collections::HashMap, sync::Arc};

use serde_json::Value;
use tokio::sync::{mpsc, oneshot, Mutex};

use crate::logging::log_executor_event;

use super::diagnostics::raw_log_preview;

/// Receives user or MCP interaction answers destined for Codex requests.
pub type CodexRequestUserInputReceiver = mpsc::Receiver<Value>;

#[derive(Default)]
pub(super) struct InteractionAnswerRouterState {
    pending: HashMap<String, oneshot::Sender<Result<Value, String>>>,
    buffered: HashMap<String, Value>,
    pub(super) closed: bool,
}

/// Correlates asynchronous interaction answers with pending Codex requests.
pub(super) struct InteractionAnswerRouter {
    pub(super) state: Arc<Mutex<InteractionAnswerRouterState>>,
}

impl InteractionAnswerRouter {
    /// Starts an answer router backed by the provided response channel.
    pub(super) fn new(mut receiver: CodexRequestUserInputReceiver) -> Arc<Self> {
        let router = Arc::new(Self {
            state: Arc::new(Mutex::new(InteractionAnswerRouterState::default())),
        });
        let state = router.state.clone();
        tokio::spawn(async move {
            while let Some(answer) = receiver.recv().await {
                let mut state = state.lock().await;
                let key = interaction_answer_key(&answer).or_else(|| {
                    (state.pending.len() == 1)
                        .then(|| state.pending.keys().next().cloned())
                        .flatten()
                });
                let Some(key) = key else {
                    log_executor_event(
                        "codex interaction answer discarded",
                        &[
                            ("pending_count", state.pending.len().to_string()),
                            ("buffered_count", state.buffered.len().to_string()),
                            ("answer_preview", raw_log_preview(&answer)),
                        ],
                    );
                    continue;
                };
                if let Some(sender) = state.pending.remove(&key) {
                    let _ = sender.send(Ok(answer));
                } else {
                    state.buffered.insert(key, answer);
                }
            }
            let mut state = state.lock().await;
            state.closed = true;
            for (_, sender) in state.pending.drain() {
                let _ = sender.send(Err("request_user_input response channel closed".to_owned()));
            }
        });
        router
    }

    /// Waits for exactly one answer associated with a correlation key.
    pub(super) async fn receive(&self, key: String) -> Result<Value, String> {
        let receiver = {
            let mut state = self.state.lock().await;
            if let Some(answer) = state.buffered.remove(&key) {
                return Ok(answer);
            }
            if state.closed {
                return Err("request_user_input response router closed".to_owned());
            }
            let (sender, receiver) = oneshot::channel();
            if state.pending.contains_key(&key) {
                return Err("duplicate pending interaction correlation key".to_owned());
            }
            state.pending.insert(key, sender);
            receiver
        };
        receiver
            .await
            .map_err(|_| "request_user_input response router closed".to_owned())?
    }
}

fn interaction_answer_key(answer: &Value) -> Option<String> {
    answer
        .get("requestId")
        .or_else(|| answer.get("request_id"))
        .or_else(|| answer.get("itemId"))
        .or_else(|| answer.get("item_id"))
        .and_then(interaction_value_key)
}

/// Normalizes supported JSON correlation identifiers to strings.
pub(super) fn interaction_value_key(value: &Value) -> Option<String> {
    match value {
        Value::String(value) if !value.trim().is_empty() => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn duplicate_receive_preserves_original_waiter() {
        let (sender, receiver) = mpsc::channel(1);
        let router = InteractionAnswerRouter::new(receiver);
        let original = {
            let router = router.clone();
            tokio::spawn(async move { router.receive("request-1".to_owned()).await })
        };
        loop {
            if router.state.lock().await.pending.contains_key("request-1") {
                break;
            }
            tokio::task::yield_now().await;
        }

        let duplicate = router.receive("request-1".to_owned()).await;
        sender
            .send(serde_json::json!({
                "requestId": "request-1",
                "answers": {"choice": "original"},
            }))
            .await
            .unwrap();

        assert_eq!(
            duplicate.unwrap_err(),
            "duplicate pending interaction correlation key"
        );
        assert_eq!(
            original.await.unwrap().unwrap()["answers"]["choice"],
            "original"
        );
    }
}
