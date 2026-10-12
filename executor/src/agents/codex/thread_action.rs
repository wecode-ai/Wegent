// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

struct ThreadActionActivity {
    client: CodexAppServerClient,
    thread_id: Option<String>,
}

impl ThreadActionActivity {
    async fn finish(mut self) {
        if let Some(thread_id) = self.thread_id.as_deref() {
            self.client.finish_thread_activity(thread_id, true).await;
        }
        self.thread_id = None;
    }
}

impl Drop for ThreadActionActivity {
    fn drop(&mut self) {
        let Some(thread_id) = self.thread_id.take() else {
            return;
        };
        let client = self.client.clone();
        // IPC timeouts drop the action future before its normal cleanup runs.
        tokio::spawn(async move {
            client.finish_thread_activity(&thread_id, true).await;
        });
    }
}

impl CodexAppServerClient {
    /// Keep multi-RPC actions active between requests, just like ordinary turns.
    pub(crate) async fn run_thread_action<T>(
        &self,
        thread_id: &str,
        action: impl Future<Output = T>,
    ) -> T {
        self.mark_thread_active(thread_id).await;
        let activity = ThreadActionActivity {
            client: self.clone(),
            thread_id: Some(thread_id.to_owned()),
        };
        let result = action.await;
        activity.finish().await;
        result
    }

    pub(super) async fn finish_thread_activity(&self, thread_id: &str, retain_subscription: bool) {
        let Some((generation, overflow)) =
            self.mark_thread_idle(thread_id, retain_subscription).await
        else {
            return;
        };
        if !retain_subscription {
            return;
        }
        self.unsubscribe_thread_in_background(
            thread_id.to_owned(),
            generation,
            IDLE_CODEX_THREAD_SUBSCRIPTION_TTL,
            "ttl",
            MAX_IDLE_CODEX_THREAD_UNSUBSCRIBE_RETRIES,
        );
        for (thread_id, generation) in overflow {
            self.unsubscribe_thread_in_background(
                thread_id,
                generation,
                Duration::ZERO,
                "capacity",
                MAX_IDLE_CODEX_THREAD_UNSUBSCRIBE_RETRIES,
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancelled_thread_action_releases_its_active_thread() {
        let client = CodexAppServerClient::new("codex-cancelled-thread-action-test");
        let (started_tx, started_rx) = oneshot::channel();
        let action_client = client.clone();
        let action = tokio::spawn(async move {
            action_client
                .run_thread_action("compact-thread", async {
                    started_tx.send(()).unwrap();
                    std::future::pending::<()>().await;
                })
                .await
        });
        started_rx.await.unwrap();
        action.abort();
        assert!(action.await.unwrap_err().is_cancelled());
        tokio::time::timeout(Duration::from_secs(1), async {
            while !client.state.lock().await.active_threads.is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("Cancelled actions must release their active thread");
        assert_eq!(client.restart_if_idle().await, Ok(()));
    }

    #[tokio::test]
    async fn thread_action_blocks_idle_mutation_between_rpcs_and_releases_after_failure() {
        let client = CodexAppServerClient::new("codex-thread-action-lifecycle-test");
        let (started_tx, started_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel();
        let action_client = client.clone();
        let action = tokio::spawn(async move {
            action_client
                .run_thread_action("compact-thread", async {
                    started_tx.send(()).unwrap();
                    release_rx.await.unwrap();
                    Err::<(), _>("provider rejected compaction")
                })
                .await
        });
        started_rx.await.unwrap();
        assert_eq!(client.restart_if_idle().await, Err((1, 0)));
        assert_eq!(
            client
                .mutate_configuration_if_idle(|| async { Ok((true, true)) })
                .await,
            Err(CodexIdleMutationError::Busy {
                active_turn_count: 1,
                pending_request_count: 0,
            })
        );
        release_tx.send(()).unwrap();
        assert_eq!(action.await.unwrap(), Err("provider rejected compaction"));
        assert_eq!(client.restart_if_idle().await, Ok(()));
    }
}
