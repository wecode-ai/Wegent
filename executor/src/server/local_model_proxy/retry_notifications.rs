use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
};

use serde_json::json;
use tokio::sync::mpsc::WeakUnboundedSender;

use crate::agents::{CodexNotification, CodexNotificationSender};

pub(crate) const METHOD: &str = "runtime/modelRetry";

type RetrySender = Arc<WeakUnboundedSender<CodexNotification>>;

fn listeners() -> &'static Mutex<HashMap<String, RetrySender>> {
    static LISTENERS: OnceLock<Mutex<HashMap<String, RetrySender>>> = OnceLock::new();
    LISTENERS.get_or_init(Default::default)
}

/// Bind retry diagnostics to the execution receiver, never to another task.
pub(crate) struct RetryNotificationSubscription {
    thread_id: String,
    sender: RetrySender,
}

pub(crate) fn subscribe(
    thread_id: &str,
    sender: Option<&CodexNotificationSender>,
) -> Option<RetryNotificationSubscription> {
    let sender = Arc::new(sender?.downgrade());
    listeners()
        .lock()
        .expect("model retry listeners should not be poisoned")
        .insert(thread_id.to_owned(), sender.clone());
    Some(RetryNotificationSubscription {
        thread_id: thread_id.to_owned(),
        sender,
    })
}

impl Drop for RetryNotificationSubscription {
    fn drop(&mut self) {
        let mut listeners = listeners()
            .lock()
            .expect("model retry listeners should not be poisoned");
        if listeners
            .get(&self.thread_id)
            .is_some_and(|sender| Arc::ptr_eq(sender, &self.sender))
        {
            listeners.remove(&self.thread_id);
        }
    }
}

/// A request owns its wait lifetime, including errors and cancellation.
pub(super) struct RetryWait {
    thread_id: String,
    sender: RetrySender,
    waiting: bool,
}

impl RetryWait {
    pub(super) fn for_request(body: &[u8]) -> Option<Self> {
        let identity = super::request_thread_identity(body)?;
        let listeners = listeners()
            .lock()
            .expect("model retry listeners should not be poisoned");
        let sender = listeners
            .get(&identity.thread_id)
            .or_else(|| {
                identity
                    .parent_thread_id
                    .as_ref()
                    .and_then(|parent| listeners.get(parent))
            })?
            .clone();
        Some(Self {
            thread_id: identity.thread_id,
            sender,
            waiting: false,
        })
    }

    pub(super) fn waiting(&mut self) {
        self.waiting = true;
        self.send(true);
    }

    fn send(&self, waiting: bool) {
        let Some(sender) = self.sender.upgrade() else {
            return;
        };
        let _ = sender.send(
            json!({
                "method": METHOD,
                "params": {
                    "threadId": self.thread_id,
                    "waiting": waiting,
                    "error": { "codexErrorInfo": "rateLimitExceeded" },
                },
            })
            .into(),
        );
    }
}

impl Drop for RetryWait {
    fn drop(&mut self) {
        if self.waiting {
            self.send(false);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc;

    #[test]
    fn retry_wait_is_scoped_and_cleared_on_request_drop() {
        let (sender, mut receiver) = mpsc::unbounded_channel();
        let subscription = subscribe("retry-wait-owner", Some(&sender)).unwrap();
        let body = br#"{"client_metadata":{"thread_id":"retry-wait-owner"}}"#;
        assert!(
            RetryWait::for_request(br#"{"client_metadata":{"thread_id":"retry-wait-other"}}"#)
                .is_none()
        );
        {
            let mut wait = RetryWait::for_request(body).unwrap();
            wait.waiting();
            assert_eq!(receiver.try_recv().unwrap()["params"]["waiting"], true);
        }
        assert_eq!(receiver.try_recv().unwrap()["params"]["waiting"], false);
        drop(subscription);
        assert!(RetryWait::for_request(body).is_none());
    }

    #[test]
    fn old_subscription_cannot_remove_a_new_execution_and_does_not_retain_it() {
        let (old_sender, _old_receiver) = mpsc::unbounded_channel();
        let (sender, mut receiver) = mpsc::unbounded_channel();
        let old = subscribe("retry-wait-replaced", Some(&old_sender)).unwrap();
        let current = subscribe("retry-wait-replaced", Some(&sender)).unwrap();
        let body = br#"{"client_metadata":{"thread_id":"retry-wait-replaced"}}"#;
        drop(old);
        drop(RetryWait::for_request(body).unwrap());
        assert!(
            receiver.try_recv().is_err(),
            "A normal request emitted a wait"
        );
        let mut wait = RetryWait::for_request(body).unwrap();
        wait.waiting();
        assert_eq!(receiver.try_recv().unwrap()["params"]["waiting"], true);
        drop(sender);
        assert!(receiver.is_closed(), "Proxy request retained the execution");
        drop(wait);
        drop(current);
        assert!(RetryWait::for_request(body).is_none());
    }

    #[test]
    fn subagent_retry_uses_its_parent_execution_unless_it_has_its_own() {
        let (parent_tx, mut parent_rx) = mpsc::unbounded_channel();
        let (child_tx, mut child_rx) = mpsc::unbounded_channel();
        let _parent = subscribe("retry-parent", Some(&parent_tx)).unwrap();
        let body =
            br#"{"client_metadata":{"thread_id":"retry-child","parent_thread_id":"retry-parent"}}"#;
        {
            let mut wait = RetryWait::for_request(body).unwrap();
            wait.waiting();
            let notification = parent_rx.try_recv().unwrap();
            assert_eq!(notification["params"]["threadId"], "retry-child");
            assert_eq!(notification["params"]["waiting"], true);
        }
        assert_eq!(parent_rx.try_recv().unwrap()["params"]["waiting"], false);
        let _child = subscribe("retry-child", Some(&child_tx)).unwrap();
        {
            let mut wait = RetryWait::for_request(body).unwrap();
            wait.waiting();
            assert_eq!(child_rx.try_recv().unwrap()["params"]["waiting"], true);
            assert!(parent_rx.try_recv().is_err());
        }
        assert_eq!(child_rx.try_recv().unwrap()["params"]["waiting"], false);
        assert!(RetryWait::for_request(
            br#"{"client_metadata":{"thread_id":"unrelated-child","parent_thread_id":"unrelated-parent"}}"#
        )
        .is_none());
    }
}
