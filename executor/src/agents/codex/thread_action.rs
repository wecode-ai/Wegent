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
    /// Model-consuming actions must apply their profile even when a thread is already loaded.
    pub(crate) async fn resume_thread_for_model_action(
        &self,
        request: &ExecutionRequest,
        thread_id: &str,
        thread_path: Option<&str>,
    ) -> Result<(String, Option<Arc<LocalProxyRegistration>>), String> {
        ensure_codex_mcp_endpoints().await?;
        let launch = build_codex_launch_config(request)?;
        let mut params = thread_resume_params(thread_id, request, &launch);
        params["excludeTurns"] = json!(true);
        if let Some(path) = thread_path {
            params["path"] = json!(path);
        }
        self.ensure_process_for_launch_config(&launch).await?;
        let gate = self.thread_lifecycle_gate(thread_id).await;
        let _admission = gate.lock().await;
        let configuration = mcp_reload::thread_context_configuration(&params);
        self.reload_model_action_context(thread_id, &configuration)
            .await?;
        // A cold resume can recover a Goal before the resume response arrives.
        bind_local_proxy_thread(&launch, thread_id)?;
        let response = self
            .request_for_launch_config("thread/resume", params, &launch)
            .await?;
        let resumed =
            thread_id_from_response("thread/resume", &response, launch.model_provider.as_deref())?;
        bind_local_proxy_thread(&launch, &resumed)?;
        self.state
            .lock()
            .await
            .thread_context_configurations
            .insert(resumed.clone(), configuration);
        log_executor_event(
            "codex model action thread resumed",
            &[
                ("thread_id", resumed.clone()),
                ("model", codex_request_model(request).unwrap_or_default()),
            ],
        );
        Ok((resumed, launch.local_proxy_registration))
    }

    async fn reload_model_action_context(
        &self,
        thread_id: &str,
        configuration: &Map<String, Value>,
    ) -> Result<(), String> {
        let state = self.state.lock().await;
        if state.thread_context_configurations.get(thread_id) == Some(configuration) {
            return Ok(());
        }
        // The caller owns one activity reference. Never unload another live action or turn.
        if state.active_threads.get(thread_id).copied().unwrap_or(0) > 1
            || state.thread_has_native_turn(thread_id)
        {
            return Err("Cannot reload model configuration while the thread is running".into());
        }
        log_executor_event(
            "codex model action reloads thread configuration",
            &[
                ("thread_id", thread_id.to_owned()),
                (
                    "previous_configuration_known",
                    state
                        .thread_context_configurations
                        .contains_key(thread_id)
                        .to_string(),
                ),
            ],
        );
        drop(state);
        let result = self
            .release_thread_subscription_under_admission(thread_id, true)
            .await;
        // Unloading retires the old subscription generation, not the owning activity.
        self.state.lock().await.renew_thread_generation(thread_id);
        result
    }

    /// Caller cancellation detaches the worker without dropping its resources.
    pub(crate) async fn run_owned_thread_action<T: Send + 'static>(
        &self,
        thread_id: String,
        action: impl Future<Output = T> + Send + 'static,
    ) -> Result<T, tokio::task::JoinError> {
        let client = self.clone();
        tokio::spawn(async move { client.run_thread_action(&thread_id, action).await }).await
    }

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
    async fn reloaded_model_action_retains_idle_subscription_cleanup() {
        use futures_util::task::noop_waker;
        use std::{future::Future, task::Context};

        let _environment = LaunchEnvironment::new();
        let _activation = crate::services::capability_activation::activate().await;
        ensure_codex_mcp_endpoints().await.unwrap();
        let mut client = CodexAppServerClient::new("model-action-idle-cleanup");
        client.state = Arc::new(Mutex::new(CodexAppServerSharedState::default()));
        let mut child = super::super::tests::spawn_idle_app_server_child();
        let pending = Arc::new(Mutex::new(HashMap::new()));
        client.state.lock().await.process = Some(CodexAppServerProcess {
            stdin: Arc::new(Mutex::new(child.stdin.take().unwrap())),
            child,
            pending: Arc::clone(&pending),
            notifications: CodexNotificationHub::new(),
            reader_task: tokio::spawn(async {}),
        });
        client.mark_thread_active("thread-1").await;
        let previous_generation = client.state.lock().await.thread_generations["thread-1"];
        let gate = client.thread_lifecycle_gate("thread-1").await;
        let admission = gate.lock().await;
        let configuration = Map::new();
        let mut reload = Box::pin(client.reload_model_action_context("thread-1", &configuration));
        let waker = noop_waker();
        assert!(reload
            .as_mut()
            .poll(&mut Context::from_waker(&waker))
            .is_pending());
        let responses = std::mem::take(&mut *pending.lock().await);
        assert_eq!(responses.len(), 1);
        for (_, response) in responses {
            response
                .sender
                .send(Ok(json!({"status":"notLoaded"})))
                .unwrap();
        }
        reload.await.unwrap();
        drop(admission);
        let idle = client.mark_thread_idle("thread-1", true).await;
        let active = client
            .state
            .lock()
            .await
            .active_threads
            .contains_key("thread-1");
        client.restart().await;

        assert!(!active);
        let (generation, overflow) = idle.expect("reloaded model actions must retain idle cleanup");
        assert!(generation > previous_generation);
        assert!(overflow.is_empty());
    }

    #[tokio::test]
    async fn model_action_never_unloads_a_concurrent_live_activity() {
        let client = CodexAppServerClient::new("unused-live-model-action");
        client
            .state
            .lock()
            .await
            .active_threads
            .insert("thread-1".into(), 2);
        let error = client
            .reload_model_action_context("thread-1", &Map::new())
            .await
            .unwrap_err();
        assert_eq!(
            error,
            "Cannot reload model configuration while the thread is running"
        );
        assert_eq!(client.state.lock().await.active_threads["thread-1"], 2);
    }

    #[tokio::test]
    async fn unchanged_model_action_context_retains_the_loaded_session() {
        let client = CodexAppServerClient::new("unused-unchanged-model-action");
        client
            .state
            .lock()
            .await
            .thread_context_configurations
            .insert("thread-1".into(), Map::new());
        client
            .reload_model_action_context("thread-1", &Map::new())
            .await
            .unwrap();
        assert!(client
            .state
            .lock()
            .await
            .thread_context_configurations
            .contains_key("thread-1"));
    }

    #[tokio::test]
    async fn cancelled_caller_keeps_owned_action_active_until_native_completion() {
        let client = CodexAppServerClient::new("codex-owned-action-caller-test");
        let (started_tx, started_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel();
        let (resource_tx, mut resource_rx) = oneshot::channel::<()>();
        let action_client = client.clone();
        let caller = tokio::spawn(async move {
            action_client
                .run_owned_thread_action("compact-thread".to_owned(), async move {
                    let _resource = resource_tx;
                    started_tx.send(()).unwrap();
                    release_rx.await.unwrap();
                })
                .await
        });
        started_rx.await.unwrap();
        caller.abort();
        assert!(caller.await.unwrap_err().is_cancelled());
        assert_eq!(
            resource_rx.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        );
        assert_eq!(client.restart_if_idle().await, Err((1, 0)));
        release_tx.send(()).unwrap();
        assert!(resource_rx.await.is_err());
        tokio::time::timeout(Duration::from_secs(1), async {
            while !client.state.lock().await.active_threads.is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("Native completion must release owned action activity");
        assert_eq!(client.restart_if_idle().await, Ok(()));
    }

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
