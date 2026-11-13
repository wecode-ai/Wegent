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

/// Admission identity covers tool authority, inference profiles and native policy.
pub(super) fn thread_context_configuration(params: &Value) -> Map<String, Value> {
    use sha2::{Digest, Sha256};
    let mut configuration = mcp_thread_configuration(params);
    for key in [
        "agents.enabled",
        "features.multi_agent",
        "features.multi_agent_v2",
    ] {
        if let Some(value) = params["config"].get(key) {
            configuration.insert(key.into(), value.clone());
        }
    }
    if let Some(instructions) = params["developerInstructions"].as_str() {
        configuration.insert(
            "developerInstructions.sha256".into(),
            json!(format!("{:x}", Sha256::digest(instructions.as_bytes()))),
        );
    }
    let providers: Map<String, Value> = params["config"]
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(key, _)| key.starts_with("model_providers."))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    if !providers.is_empty() || params.get("modelProvider").is_some() {
        configuration.insert(
            "inferenceProfile.sha256".into(),
            json!(format!(
                "{:x}",
                Sha256::digest(
                    serde_json::to_vec(
                        &json!({"provider":params["modelProvider"],"profiles":providers})
                    )
                    .expect("JSON inference profiles serialize")
                )
            )),
        );
    }
    configuration
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
    (loaded != Some(&thread_context_configuration(params))
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
        launch_config: &CodexLaunchConfig,
    ) -> Result<Option<tokio::sync::OwnedMutexGuard<()>>, String> {
        if let CodexThreadStart::Direct(thread_id) = &plan.start {
            let gate = self.thread_lifecycle_gate(thread_id).await;
            let _guard = gate.lock().await;
            let desired = thread_context_configuration(&json!({"developerInstructions":
                effective_instructions::native_instructions(request, launch_config)}));
            let state = self.state.lock().await;
            if state
                .thread_context_configurations
                .get(thread_id)
                .and_then(|current| current.get("developerInstructions.sha256"))
                .is_some_and(|current| Some(current) != desired.get("developerInstructions.sha256"))
            {
                return Err("The loaded temporary session's runtime instructions changed. Open a new temporary session to apply them; the existing history was preserved.".into());
            }
            return Ok(None);
        }
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
                // Goal continuation eligibility protects idle restarts, but its
                // next turn may require this resume before it can start.
                let active = self.state.lock().await.thread_has_active_turn(thread_id);
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
                    .thread_context_configurations
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
    fn inference_profile_changes_and_removal_require_native_reload() {
        let params = json!({"threadId":"thread-1","modelProvider":"~", "config":{
            "model_providers.~":{"name":"OpenAI","base_url":"http://localhost/discovery","experimental_bearer_token":"synthetic"}
        }});
        let loaded = thread_context_configuration(&params);
        assert!(!serde_json::to_string(&loaded)
            .unwrap()
            .contains("synthetic"));
        assert!(!serde_json::to_string(&loaded)
            .unwrap()
            .contains("localhost"));
        let mut native = params.clone();
        native["config"]["model_providers.~"] =
            json!({"name":"OpenAI","requires_openai_auth":true});
        let mut different_provider = params.clone();
        different_provider["modelProvider"] = json!("another");
        for desired in [native, different_provider, json!({"threadId":"thread-1"})] {
            let plan = CodexThreadPlan {
                start: CodexThreadStart::Request {
                    operation: "thread/resume",
                    params: desired,
                },
                resume_requested: true,
                fork_requested: false,
            };
            assert_eq!(
                config_reload_resume_thread_id(&plan, &ExecutionRequest::default(), Some(&loaded)),
                Some("thread-1")
            );
        }
        assert_eq!(loaded, thread_context_configuration(&params));
    }

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
            .thread_context_configurations
            .insert("thread-1".into(), Map::new());
        stop_codex_app_server_process(&mut state, None).await;
        assert!(state.thread_context_configurations.is_empty());
    }

    #[test]
    fn collaboration_changes_reload_the_native_agent_family_before_resume() {
        let mut loaded = json!({"threadId":"thread-1", "config":{
            "agents.enabled":false, "features.multi_agent":false, "features.multi_agent_v2":false
        }});
        let previous = thread_context_configuration(&loaded);
        let request = ExecutionRequest::default();
        for key in [
            "agents.enabled",
            "features.multi_agent",
            "features.multi_agent_v2",
        ] {
            loaded["config"][key] = json!(true);
            let plan = CodexThreadPlan {
                start: CodexThreadStart::Request {
                    operation: "thread/resume",
                    params: loaded.clone(),
                },
                resume_requested: true,
                fork_requested: false,
            };
            assert_eq!(
                config_reload_resume_thread_id(&plan, &request, Some(&previous)),
                Some("thread-1")
            );
            let current = thread_context_configuration(&loaded);
            assert_eq!(
                config_reload_resume_thread_id(&plan, &request, Some(&current)),
                None
            );
            loaded["config"][key] = json!(false);
        }
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
        let launch = CodexLaunchConfig::default();
        let mut first = Box::pin(client.prepare_thread_admission(&first_plan, &request, &launch));
        let mut second = Box::pin(client.prepare_thread_admission(&second_plan, &request, &launch));
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
        client
            .state
            .lock()
            .await
            .thread_context_configurations
            .insert(
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

#[cfg(test)]
mod policy_tests {
    use super::*;

    #[test]
    fn policy_changes_reload_resume_even_when_mcp_authority_is_unchanged() {
        let previous = json!({"threadId":"thread","developerInstructions":"Previous runtime policy","config":{"mcp_servers.tools.url":"http://localhost/mcp"}});
        let current = json!({"threadId":"thread","developerInstructions":"Current runtime policy","config":{"mcp_servers.tools.url":"http://localhost/mcp"}});
        let loaded = thread_context_configuration(&previous);
        let request = ExecutionRequest::default();
        let unchanged = CodexThreadPlan {
            start: CodexThreadStart::Request {
                operation: "thread/resume",
                params: previous,
            },
            resume_requested: true,
            fork_requested: false,
        };
        assert!(config_reload_resume_thread_id(&unchanged, &request, Some(&loaded)).is_none());
        let changed = CodexThreadPlan {
            start: CodexThreadStart::Request {
                operation: "thread/resume",
                params: current,
            },
            resume_requested: true,
            fork_requested: false,
        };
        assert_eq!(
            config_reload_resume_thread_id(&changed, &request, Some(&loaded)),
            Some("thread")
        );
    }

    #[tokio::test]
    async fn a_known_direct_policy_change_stops_without_rebuilding_or_blocking_legacy_unknown_threads(
    ) {
        let client = CodexAppServerClient::new("unused");
        let launch = CodexLaunchConfig::default();
        let mut request = ExecutionRequest {
            system_prompt: "Original policy".into(),
            ..Default::default()
        };
        let plan = codex_thread_plan(Some("temporary"), None, None, None, &request, &launch);
        assert!(client
            .prepare_thread_admission(&plan, &request, &launch)
            .await
            .unwrap()
            .is_none());
        let saved = thread_context_configuration(
            &json!({"developerInstructions":effective_instructions::native_instructions(&request,&launch)}),
        );
        client
            .state
            .lock()
            .await
            .thread_context_configurations
            .insert("temporary".into(), saved);
        assert!(client
            .prepare_thread_admission(&plan, &request, &launch)
            .await
            .unwrap()
            .is_none());
        request.system_prompt = "Changed policy".into();
        let error = client
            .prepare_thread_admission(&plan, &request, &launch)
            .await
            .unwrap_err();
        assert!(error.contains("runtime instructions changed"));
        assert!(client.state.lock().await.process.is_none());
    }
}
