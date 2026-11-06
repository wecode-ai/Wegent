// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

pub(super) fn mcp_thread_configuration(params: &Value) -> Map<String, Value> {
    params["config"]
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(key, _)| key.starts_with("mcp_servers."))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

pub(super) fn config_reload_resume_thread_id<'a>(
    thread_plan: &'a CodexThreadPlan,
    request: &ExecutionRequest,
    loaded: Option<&Map<String, Value>>,
) -> Option<&'a str> {
    let CodexThreadStart::Request {
        operation: "thread/resume",
        params,
    } = &thread_plan.start
    else {
        return None;
    };
    (loaded != Some(&mcp_thread_configuration(params))
        || crate::runtime_work::stand_in_requires_confirmation(request)
        || crate::runtime_work::external_work_kind(request).is_some())
    .then(|| params.get("threadId").and_then(Value::as_str))
    .flatten()
}

impl CodexAppServerClient {
    pub(super) async fn prepare_thread_admission(
        &self,
        plan: &CodexThreadPlan,
        request: &ExecutionRequest,
    ) -> Result<Option<tokio::sync::OwnedMutexGuard<()>>, String> {
        let Some(thread_id) = thread_id_to_activate_before_start(plan) else {
            return Ok(None);
        };
        let gate = self.thread_lifecycle_gate(thread_id).await;
        let changed = Arc::clone(&self.state.lock().await.thread_activity_changed);
        with_rpc_timeout("thread admission", codex_rpc_timeout_seconds(), async {
            loop {
                let notified = changed.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                let guard = Arc::clone(&gate).lock_owned().await;
                let active = self
                    .state
                    .lock()
                    .await
                    .active_threads_snapshot()
                    .get(thread_id)
                    .copied()
                    .unwrap_or(0)
                    > 0;
                if active
                    && matches!(
                        plan.start,
                        CodexThreadStart::Request {
                            operation: "thread/resume",
                            ..
                        }
                    )
                {
                    drop(guard);
                    notified.await;
                    continue;
                }
                let loaded = self
                    .state
                    .lock()
                    .await
                    .thread_mcp_configurations
                    .get(thread_id)
                    .cloned();
                if config_reload_resume_thread_id(plan, request, loaded.as_ref()).is_some() {
                    if let Err(error) = self
                        .release_thread_subscription_under_admission(thread_id, true)
                        .await
                    {
                        if !super::is_codex_cloud_config_error(&error) {
                            return Err(error);
                        }
                        // Resume owns recovery when cloud configuration prevented unloading.
                        log_executor_event(
                            "codex thread unsubscribe skipped after cloud config failure",
                            &[("thread_id", thread_id.to_owned()), ("error", error)],
                        );
                    }
                }
                self.mark_thread_active_under_admission(thread_id).await;
                return Ok(Some(guard));
            }
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resumes_reload_changed_removed_or_unknown_mcp_configuration() {
        let params = json!({"threadId":"thread-1", "config": {
            "mcp_servers.wework_space.url":"http://localhost/mcp",
            "mcp_servers.wework_space.http_headers.X-Wework-Mcp-Context":"context-1"
        }});
        let loaded = mcp_thread_configuration(&params);
        let request = ExecutionRequest::default();
        for (params, previous, expected) in [
            (params.clone(), Some(&loaded), None),
            (params.clone(), None, Some("thread-1")),
            (
                json!({"threadId":"thread-1", "config": {}}),
                Some(&loaded),
                Some("thread-1"),
            ),
            (
                json!({"threadId":"thread-1", "config": {
                    "mcp_servers.wework_space.url":"http://localhost/mcp",
                    "mcp_servers.wework_space.http_headers.X-Wework-Mcp-Context":"context-2"
                }}),
                Some(&loaded),
                Some("thread-1"),
            ),
        ] {
            let plan = CodexThreadPlan {
                start: CodexThreadStart::Request {
                    operation: "thread/resume",
                    params,
                },
                resume_requested: true,
                fork_requested: false,
            };
            assert_eq!(
                config_reload_resume_thread_id(&plan, &request, previous),
                expected
            );
        }
    }

    #[tokio::test]
    async fn stopping_a_process_forgets_loaded_mcp_configuration() {
        let mut state = CodexAppServerSharedState::default();
        state
            .thread_mcp_configurations
            .insert("thread-1".into(), Map::new());
        stop_codex_app_server_process(&mut state, None).await;
        assert!(state.thread_mcp_configurations.is_empty());
    }

    #[test]
    fn native_unload_has_no_second_idle_cache_after_the_host_releases_a_thread() {
        let launch = persistent_codex_app_server_launch_config(&CodexLaunchConfig::default());
        assert!(launch
            .config_overrides
            .contains(&"thread_unload_delay_secs=0".to_owned()));
    }

    #[tokio::test]
    async fn concurrent_resumes_keep_grants_and_active_turns_serialized() {
        use futures_util::task::noop_waker;
        use std::{future::Future, task::Context};

        let _environment = LaunchEnvironment::new();
        let _activation = crate::services::capability_activation::activate().await;
        ensure_codex_mcp_endpoints().await.unwrap();
        let mut client = CodexAppServerClient::new("mcp-concurrent-admission");
        client.state = Arc::new(Mutex::new(CodexAppServerSharedState::default()));
        let mut child = super::super::tests::spawn_idle_app_server_child();
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let notifications = CodexNotificationHub::new();
        client.state.lock().await.process = Some(CodexAppServerProcess {
            stdin: Arc::new(Mutex::new(child.stdin.take().unwrap())),
            child,
            pending: Arc::clone(&pending),
            notifications: notifications.clone(),
            reader_task: tokio::spawn(async {}),
        });
        client.state.lock().await.process_environment =
            client.process_environment(&BTreeMap::new(), &BTreeMap::new());
        let plan = |grant| CodexThreadPlan {
            start: CodexThreadStart::Request {
                operation: "thread/resume",
                params: json!({"threadId":"thread-1", "config": {
                    "mcp_servers.test.http_headers.context": grant
                }}),
            },
            resume_requested: true,
            fork_requested: false,
        };
        let first_plan = plan("first");
        let second_plan = plan("second");
        let request = ExecutionRequest::default();
        let waker = noop_waker();
        let mut context = Context::from_waker(&waker);
        let mut first = Box::pin(client.prepare_thread_admission(&first_plan, &request));
        let mut second = Box::pin(client.prepare_thread_admission(&second_plan, &request));
        assert!(first.as_mut().poll(&mut context).is_pending());
        assert!(second.as_mut().poll(&mut context).is_pending());
        let responses = std::mem::take(&mut *pending.lock().await);
        assert_eq!(responses.len(), 1);
        for (_, response) in responses {
            response
                .sender
                .send(Ok(json!({"status":"unsubscribed"})))
                .unwrap();
        }
        assert!(first.as_mut().poll(&mut context).is_pending());
        notifications
            .send(json!({"method":"thread/closed","params":{"threadId":"thread-1"}}))
            .await;
        let admission = first.await.unwrap().unwrap();
        assert!(second.as_mut().poll(&mut context).is_pending());
        client.state.lock().await.thread_mcp_configurations.insert(
            "thread-1".into(),
            mcp_thread_configuration(match &first_plan.start {
                CodexThreadStart::Request { params, .. } => params,
                _ => unreachable!(),
            }),
        );
        drop(admission);
        assert!(second.as_mut().poll(&mut context).is_pending());
        assert!(
            pending.lock().await.is_empty(),
            "Active owners must not be unsubscribed"
        );
        client.finish_thread_activity("thread-1", true).await;
        assert!(second.as_mut().poll(&mut context).is_pending());
        let responses = std::mem::take(&mut *pending.lock().await);
        assert_eq!(responses.len(), 1);
        for (_, response) in responses {
            response
                .sender
                .send(Ok(json!({"status":"unsubscribed"})))
                .unwrap();
        }
        assert!(second.as_mut().poll(&mut context).is_pending());
        notifications
            .send(json!({"method":"thread/closed","params":{"threadId":"thread-1"}}))
            .await;
        drop(second.await.unwrap().unwrap());
        client.finish_thread_activity("thread-1", true).await;
        client.restart().await;
    }

    #[tokio::test]
    async fn changed_mcp_grants_wait_for_native_close_not_only_unsubscribe_acknowledgement() {
        use futures_util::task::noop_waker;
        use std::{future::Future, task::Context};

        let _environment = LaunchEnvironment::new();
        let _activation = crate::services::capability_activation::activate().await;
        ensure_codex_mcp_endpoints().await.unwrap();
        let mut client = CodexAppServerClient::new("mcp-close-barrier");
        client.state = Arc::new(Mutex::new(CodexAppServerSharedState::default()));
        let mut child = super::super::tests::spawn_idle_app_server_child();
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let notifications = CodexNotificationHub::new();
        client.state.lock().await.process = Some(CodexAppServerProcess {
            stdin: Arc::new(Mutex::new(child.stdin.take().unwrap())),
            child,
            pending: Arc::clone(&pending),
            notifications: notifications.clone(),
            reader_task: tokio::spawn(async {}),
        });
        client.state.lock().await.process_environment =
            client.process_environment(&BTreeMap::new(), &BTreeMap::new());
        let waker = noop_waker();
        let mut context = Context::from_waker(&waker);
        let mut release = Box::pin(client.release_thread_subscription_until("thread-1", true));
        assert!(release.as_mut().poll(&mut context).is_pending());
        let responses = std::mem::take(&mut *pending.lock().await);
        assert_eq!(responses.len(), 1);
        for (_, response) in responses {
            response
                .sender
                .send(Ok(json!({"status":"unsubscribed"})))
                .unwrap();
        }
        assert!(
            release.as_mut().poll(&mut context).is_pending(),
            "An unsubscribe acknowledgement does not prove the stale MCP pool was unloaded"
        );
        notifications
            .send(json!({"method":"thread/closed","params":{"threadId":"another-thread"}}))
            .await;
        assert!(release.as_mut().poll(&mut context).is_pending());
        let mut admission = Box::pin(client.mark_thread_active("thread-1"));
        assert!(
            admission.as_mut().poll(&mut context).is_pending(),
            "A resumed turn cannot overtake Native teardown"
        );
        notifications
            .send(json!({"method":"thread/closed","params":{"threadId":"thread-1"}}))
            .await;
        release.await.unwrap();
        admission.await;
        client.restart().await;
    }
}
