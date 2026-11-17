//! Keep source requests attached to the process that owns their native threads.
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use serde_json::Value;
use tokio::sync::{mpsc, oneshot, watch};

const QUEUED_REQUESTS: usize = 32;

pub(super) struct IsolatedRequest {
    pub method: String,
    pub params: Value,
    pub reply: oneshot::Sender<Result<Value, String>>,
}

#[derive(Clone)]
pub(super) struct IsolatedRpcSender {
    requests: mpsc::Sender<IsolatedRequest>,
    released: watch::Receiver<bool>,
}

impl IsolatedRpcSender {
    /// Failure here means the request was never admitted; admitted calls are never replayed.
    pub async fn start_request(
        &self,
        method: &str,
        params: Value,
    ) -> Result<oneshot::Receiver<Result<Value, String>>, String> {
        let (reply, receiver) = oneshot::channel();
        self.requests
            .send(IsolatedRequest {
                method: method.to_owned(),
                params,
                reply,
            })
            .await
            .map_err(|_| "The owning isolated app-server stopped accepting requests".to_owned())?;
        Ok(receiver)
    }

    async fn wait_for_release(&mut self, method: &str) -> Result<(), String> {
        let started = tokio::time::Instant::now();
        super::log_executor_event(
            "codex source read waiting for isolated owner release",
            &[("method", method.to_owned())],
        );
        self.released
            .wait_for(|released| *released)
            .await
            .map_err(|_| "Isolated app-server release was not observed".to_owned())?;
        super::log_executor_event(
            "codex source read isolated owner released",
            &[
                ("method", method.to_owned()),
                ("elapsed_ms", started.elapsed().as_millis().to_string()),
            ],
        );
        Ok(())
    }
}

#[derive(Clone, Default)]
pub(super) struct IsolatedRpcRegistry {
    threads: Arc<Mutex<HashMap<String, IsolatedRpcSender>>>,
}

impl IsolatedRpcRegistry {
    pub fn owner(&self) -> (IsolatedRpcOwner, mpsc::Receiver<IsolatedRequest>) {
        let (sender, receiver) = mpsc::channel(QUEUED_REQUESTS);
        let (released, release_rx) = watch::channel(false);
        let owner = IsolatedRpcOwner(Arc::new(OwnerLease {
            registry: self.clone(),
            sender: IsolatedRpcSender {
                requests: sender,
                released: release_rx,
            },
            released,
        }));
        (owner, receiver)
    }

    pub fn get(&self, thread_id: &str) -> Option<IsolatedRpcSender> {
        self.threads
            .lock()
            .expect("isolated RPC registry poisoned")
            .get(thread_id)
            .cloned()
    }
}

/// The native child retains this lease until it is reaped, including cancelled turns.
#[derive(Clone)]
pub(super) struct IsolatedRpcOwner(Arc<OwnerLease>);

impl IsolatedRpcOwner {
    pub fn bind(&self, thread_id: &str) -> Result<(), String> {
        let mut threads = self
            .0
            .registry
            .threads
            .lock()
            .expect("isolated RPC registry poisoned");
        if let Some(existing) = threads.get(thread_id) {
            if !existing.requests.same_channel(&self.0.sender.requests) {
                return Err("A different isolated process already owns this thread".to_owned());
            }
        } else {
            threads.insert(thread_id.to_owned(), self.0.sender.clone());
        }
        Ok(())
    }
}

struct OwnerLease {
    registry: IsolatedRpcRegistry,
    sender: IsolatedRpcSender,
    released: watch::Sender<bool>,
}

impl Drop for OwnerLease {
    fn drop(&mut self) {
        self.registry
            .threads
            .lock()
            .expect("isolated RPC registry poisoned")
            .retain(|_, sender| !sender.requests.same_channel(&self.sender.requests));
        self.released.send_replace(true);
    }
}

pub(super) fn is_source_read(method: &str) -> bool {
    matches!(
        method,
        "thread/read"
            | "thread/turns/list"
            | "thread/items/read"
            | "thread/items/list"
            | "thread/timeline/list"
            | "thread/goal/get"
            | "mcpServerStatus/list"
            | "mcpServer/resource/read"
            | "mcpServer/resource/list"
            | "mcpServer/resourceTemplate/list"
    )
}

impl super::CodexAppServerClient {
    pub(super) async fn request_source_read(
        &self,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        use super::CodexAppToolError::{NotDispatched, OutcomeUnknown};
        use tokio::time::{timeout, Duration};
        let registry = self.state.lock().await.isolated_rpc.clone();
        let thread = params["threadId"].as_str().map(str::to_owned);
        let Some(first_owner) = thread.as_deref().and_then(|thread| registry.get(thread)) else {
            return self
                .request_with_cloud_config_recovery(method, params)
                .await;
        };
        let mut owner = Some(first_owner);
        let seconds = super::codex_rpc_timeout_seconds();
        timeout(Duration::from_secs(seconds), async {
            while let Some(mut current) = owner.take() {
                let result = request_owner(current.clone(), method, params.clone()).await;
                if matches!(result, Err(NotDispatched(_))) && current.requests.is_closed() {
                    // No request was admitted. Keep the original deadline and
                    // wait for native reaping before resolving ownership again.
                    current.wait_for_release(method).await?;
                    owner = thread.as_deref().and_then(|thread| registry.get(thread));
                    continue;
                }
                return result.map_err(|error| match error {
                    NotDispatched(message) | OutcomeUnknown(message) => message,
                });
            }
            self.request_with_cloud_config_recovery(method, params)
                .await
        })
        .await
        .map_err(|_| format!("codex {method} timed out after {seconds}s"))?
    }

    pub(super) async fn request_isolated(
        &self,
        method: &str,
        params: Value,
    ) -> Option<Result<Value, super::CodexAppToolError>> {
        let thread = params["threadId"].as_str()?;
        let owner = self.state.lock().await.isolated_rpc.get(thread)?;
        Some(request_owner(owner, method, params).await)
    }
}

async fn request_owner(
    owner: IsolatedRpcSender,
    method: &str,
    params: Value,
) -> Result<Value, super::CodexAppToolError> {
    use super::CodexAppToolError::{NotDispatched, OutcomeUnknown};
    use tokio::time::{timeout_at, Duration, Instant};
    let seconds = super::codex_rpc_timeout_seconds();
    let deadline = Instant::now() + Duration::from_secs(seconds);
    let expired = || format!("codex {method} timed out after {seconds}s");
    let response = timeout_at(deadline, owner.start_request(method, params))
        .await
        .map_err(|_| NotDispatched(expired()))?
        .map_err(NotDispatched)?;
    timeout_at(deadline, response)
        .await
        .map_err(|_| OutcomeUnknown(expired()))?
        .map_err(|_| OutcomeUnknown("The owning app-server response channel closed".to_owned()))?
        .map_err(OutcomeUnknown)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn requests_reach_only_the_native_owner() {
        let registry = IsolatedRpcRegistry::default();
        let (first, mut first_requests) = registry.owner();
        let (second, mut second_requests) = registry.owner();
        first.bind("one").unwrap();
        second.bind("two").unwrap();
        let result = registry
            .get("one")
            .unwrap()
            .start_request("thread/read", json!({"threadId":"one"}))
            .await
            .unwrap();
        let request = first_requests.recv().await.unwrap();
        assert_eq!(request.method, "thread/read");
        assert_eq!(request.params["threadId"], "one");
        assert!(matches!(
            second_requests.try_recv(),
            Err(mpsc::error::TryRecvError::Empty)
        ));
        request.reply.send(Ok(json!({"owner":"one"}))).unwrap();
        assert_eq!(result.await.unwrap().unwrap()["owner"], "one");
    }

    #[tokio::test]
    async fn a_stopping_owner_remains_authoritative_until_its_child_releases_the_lease() {
        let registry = IsolatedRpcRegistry::default();
        let (owner, requests) = registry.owner();
        owner.bind("thread").unwrap();
        let child_lease = owner.clone();
        drop(owner);
        drop(requests);
        assert!(registry
            .get("thread")
            .unwrap()
            .start_request("thread/read", json!({}))
            .await
            .is_err());
        let (replacement, _requests) = registry.owner();
        assert!(replacement.bind("thread").is_err());
        drop(child_lease);
        assert!(registry.get("thread").is_none());
        replacement.bind("thread").unwrap();
    }

    #[test]
    fn thread_registration_is_idempotent_but_cannot_take_another_process_owner() {
        let registry = IsolatedRpcRegistry::default();
        let (owner, _requests) = registry.owner();
        owner.bind("thread").unwrap();
        owner.bind("thread").unwrap();
        owner.bind("child-thread").unwrap();
        let (other, _other_requests) = registry.owner();
        assert!(other.bind("thread").is_err());
        drop(other);
        assert!(registry.get("thread").is_some());
        drop(owner);
        assert!(registry.get("thread").is_none());
        assert!(registry.get("child-thread").is_none());
    }
}

#[cfg(all(test, unix))]
#[path = "isolated_rpc_process_tests.rs"]
mod process_tests;
