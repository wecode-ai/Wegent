// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Process-local pending skill-request registry.
//!
//! Source: `chat_shell/chat_shell/tools/pending_requests.py`.
//! `PendingRequestRegistry.register` creates an awaited future and
//! `PendingRequestRegistry.resolve` completes it exactly once with the complete
//! `{"success", "result", "error"}` document. The backend's `on_skill_response`
//! is the resolve side; only a skill running in the *same* process registers.
//!
//! The Rust backend owns no chat_shell execution yet, so no production caller
//! registers a request today. This module still implements the real one-shot
//! lifecycle rather than a preset value: a future caller awaits
//! [`register`]'s receiver, and [`resolve`] delivers the response (success or
//! error) exactly once.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use serde_json::Value;
use tokio::sync::oneshot;

/// The process-wide registry, keyed by `request_id`.
static PENDING: LazyLock<Mutex<HashMap<String, oneshot::Sender<Value>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// `PendingRequestRegistry.register`: install one awaited request and return
/// the receiver its skill awaits. A later [`resolve`] completes it.
pub fn register(request_id: impl Into<String>) -> oneshot::Receiver<Value> {
    let (sender, receiver) = oneshot::channel();
    PENDING
        .lock()
        .expect("pending request registry lock")
        .insert(request_id.into(), sender);
    receiver
}

/// `PendingRequestRegistry.resolve`: complete one pending request exactly once.
///
/// Returns `false` when no request is pending or the awaiting skill already
/// dropped its receiver, matching the source's `False` branches.
pub fn resolve(request_id: &str, result: Value) -> bool {
    let Some(sender) = PENDING
        .lock()
        .expect("pending request registry lock")
        .remove(request_id)
    else {
        return false;
    };
    sender.send(result).is_ok()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[tokio::test]
    async fn a_registered_request_receives_the_complete_result_once() {
        let receiver = register("request-1");
        assert!(resolve(
            "request-1",
            json!({"success": true, "result": {"svg": "<svg/>"}, "error": null})
        ));
        assert_eq!(
            receiver.await.expect("the pending request completes"),
            json!({"success": true, "result": {"svg": "<svg/>"}, "error": null})
        );
        assert!(!resolve("request-1", json!({})));
    }

    #[test]
    fn an_unknown_request_resolves_nothing() {
        assert!(!resolve("missing-request", json!({})));
    }
}
