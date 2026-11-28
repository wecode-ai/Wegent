// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

impl CodexAppServerClient {
    /// Wait for admitted reads without interrupting them or replaying any RPC.
    pub(super) async fn state_for_auth_mode(
        &self,
        requested: Option<CodexAuthMode>,
    ) -> Result<tokio::sync::MutexGuard<'_, CodexAppServerSharedState>, String> {
        let changed = Arc::clone(&self.state.lock().await.thread_activity_changed);
        with_rpc_timeout(
            "authentication mode admission",
            codex_rpc_timeout_seconds(),
            async {
                let mut waiting = false;
                loop {
                    let notified = changed.notified();
                    tokio::pin!(notified);
                    notified.as_mut().enable();
                    let mut state = self.state.lock().await;
                    if state
                        .process
                        .as_mut()
                        .is_some_and(|process| process.has_exited())
                    {
                        stop_codex_app_server_process(&mut state, None).await;
                    }
                    if !requested.is_some_and(|mode| mode != state.auth_mode) {
                        return Ok(state);
                    }
                    let (pending_count, only_reads, pending_methods) = match state.process.as_ref()
                    {
                        Some(process) => {
                            let pending = process.pending.lock().await;
                            let methods = pending
                                .values()
                                .map(|request| request.method.as_str())
                                .collect::<BTreeSet<_>>();
                            (
                                pending.len(),
                                methods.iter().all(|method| request_is_read_only(method)),
                                methods.into_iter().collect::<Vec<_>>().join("|"),
                            )
                        }
                        None => (0, true, String::new()),
                    };
                    let active_threads = state.active_threads_snapshot();
                    let admission_fields = [
                        ("current", format!("{:?}", state.auth_mode)),
                        ("requested", format!("{requested:?}")),
                        (
                            "active_turns",
                            active_threads.values().sum::<usize>().to_string(),
                        ),
                        ("pending_requests", pending_count.to_string()),
                        ("pending_methods", pending_methods),
                    ];
                    if active_threads.is_empty() && pending_count > 0 && only_reads {
                        if !waiting {
                            log_executor_event(
                                "codex auth change waiting for read requests",
                                &admission_fields,
                            );
                            waiting = true;
                        }
                        drop(state);
                        notified.await;
                        continue;
                    }
                    if !active_threads.is_empty() || pending_count > 0 {
                        log_executor_event("codex auth mode admission blocked", &admission_fields);
                    }
                    apply_auth_mode(&mut state, requested, pending_count).await?;
                    return Ok(state);
                }
            },
        )
        .await
    }

    /// Bind login completion to the process that accepted it, including a fast exit.
    pub(crate) async fn start_account_login(
        &self,
        login_type: &str,
    ) -> Result<(Value, u64), String> {
        let method = "account/login/start";
        let params = json!({"type":login_type});
        let (request_id, handle, response_rx) = self
            .prepare_request_with_process(true, None, method, &params)
            .await?;
        let generation = handle.notifications.process_generation;
        // Login is a mutation; never replay it after an uncertain transport outcome.
        let result = Self::send_request_and_wait(
            method,
            params,
            codex_rpc_timeout_seconds(),
            request_id,
            handle,
            response_rx,
        )
        .await?;
        Ok((result, generation))
    }
}

fn request_is_read_only(method: &str) -> bool {
    matches!(
        method,
        "account/read"
            | "account/rateLimits/read"
            | "thread/list"
            | "thread/read"
            | "thread/turns/list"
            | "thread/timeline/list"
            | "thread/items/list"
            | "thread/items/read"
            | "thread/goal/get"
            | "config/read"
            | "model/list"
    )
}

/// Rejects incompatible launches until the current process can change authentication safely.
pub(super) async fn apply_auth_mode(
    state: &mut CodexAppServerSharedState,
    requested: Option<CodexAuthMode>,
    pending_request_count: usize,
) -> Result<(), String> {
    let Some(requested) = requested.filter(|mode| *mode != state.auth_mode) else {
        return Ok(());
    };
    if !state.active_threads_snapshot().is_empty() || pending_request_count > 0 {
        return Err(format!(
            "Codex authentication mode is busy (current={:?}, requested={requested:?}, \
             active_turns={}, pending_requests={pending_request_count}); \
             retry after active turns and requests finish",
            state.auth_mode,
            state.active_threads_snapshot().values().sum::<usize>(),
        ));
    }
    log_executor_event(
        "codex auth mode changed",
        &[
            ("from", format!("{:?}", state.auth_mode)),
            ("to", format!("{requested:?}")),
        ],
    );
    stop_codex_app_server_process(state, None).await;
    state.auth_mode = requested;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn router_client() -> CodexAppServerClient {
        router_client_with_child(super::super::tests::spawn_idle_app_server_child()).await
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn shared_transport_expires_mcp_approval_without_a_turn_observer() {
        let mut command = Command::new("sh");
        command.args(["-c", r#"
            IFS= read -r start || exit 1
            printf '%s\n' '{"id":17,"method":"mcpServer/elicitation/request","params":{"threadId":"thread","turnId":"turn","mode":"form","serverName":"node_repl","requestedSchema":{"type":"object","properties":{}},"_meta":{"codex_approval_kind":"mcp_tool_call"},"expiresAtUnixMs":1}}'
            IFS= read -r reply || exit 1
            if test "$reply" != '{"id":17,"result":{"action":"cancel"}}'; then exit 2; fi
            printf '%s\n' '{"method":"turn/completed","params":{"threadId":"thread","turn":{"id":"turn","status":"completed"}}}'
            cat >/dev/null
        "#]);
        configure_codex_app_server_process_group(&mut command);
        let child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let client = router_client_with_child(child.into()).await;
        let transport = client.existing_process().await.unwrap();
        let mut runtime = transport.notifications.subscribe_runtime();
        transport
            .write_message(json!({"method":"test/start"}))
            .await
            .unwrap();
        timeout(Duration::from_secs(3), async {
            while let Some(message) = runtime.recv().await {
                if message["method"] == "turn/completed" {
                    assert_eq!(message["params"]["turn"]["id"], "turn");
                    return;
                }
            }
            panic!("native process did not finish after MCP cancellation");
        })
        .await
        .expect("an unanswered approval must not hold the native turn");
        assert!(!transport
            .answer_server_interaction(&json!(17), json!({"action":"accept"}))
            .await
            .unwrap());
    }

    async fn router_client_with_child(mut child: CodexAppServerChild) -> CodexAppServerClient {
        let mut client = CodexAppServerClient::new("auth-mode-concurrency");
        client.state = Arc::new(Mutex::new(CodexAppServerSharedState::default()));
        let stdin = Arc::new(Mutex::new(child.stdin.take().unwrap()));
        let stdout = child.stdout.take().unwrap();
        let mut state = client.state.lock().await;
        state.auth_mode = CodexAuthMode::WeworkRouter;
        state.process_environment = client.process_environment(&BTreeMap::new(), &BTreeMap::new());
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let notifications = CodexNotificationHub::for_runtime(
            Arc::clone(&state.runtime_notifications),
            Arc::clone(&state.thread_activity_changed),
        );
        state.process = Some(CodexAppServerProcess {
            child,
            stdin: Arc::clone(&stdin),
            pending: Arc::clone(&pending),
            notifications: notifications.clone(),
            reader_task: tokio::spawn(read_persistent_codex_app_server_stdout(
                CodexStdout::new(stdout, None),
                CodexAppServerHandle {
                    stdin,
                    pending,
                    notifications,
                },
            )),
        });
        drop(state);
        client
    }

    #[cfg(unix)]
    async fn echo_router_client() -> CodexAppServerClient {
        let mut command = Command::new("sh");
        command.args(["-c", "cat"]);
        configure_codex_app_server_process_group(&mut command);
        let child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        router_client_with_child(child.into()).await
    }

    #[tokio::test]
    async fn official_launch_is_rejected_while_router_turn_is_active() {
        let _environment = LaunchEnvironment::new();
        let _activation = crate::services::capability_activation::activate().await;
        let client = router_client().await;
        client.mark_thread_active("cloud-thread").await;
        let launch = CodexLaunchConfig {
            auth_mode: Some(CodexAuthMode::LocalSubscription),
            ..CodexLaunchConfig::default()
        };
        let process_id = client
            .state
            .lock()
            .await
            .process
            .as_ref()
            .unwrap()
            .child
            .id();
        let launch_result = client.ensure_process_for_launch_config(&launch).await;
        let request_result = client
            .prepare_request_with_process(true, Some(&launch), "model/list", &json!({}))
            .await;
        assert!(
            matches!(launch_result, Err(ref error) if error.contains("authentication mode is busy"))
        );
        assert!(
            matches!(request_result, Err(ref error) if error.contains("authentication mode is busy"))
        );
        let state = client.state.lock().await;
        assert_eq!(state.auth_mode, CodexAuthMode::WeworkRouter);
        assert_eq!(state.process.as_ref().unwrap().child.id(), process_id);
        assert!(state
            .process
            .as_ref()
            .unwrap()
            .pending
            .lock()
            .await
            .is_empty());
        drop(state);
        client.finish_thread_activity("cloud-thread", true).await;
        client.restart().await;
    }

    #[tokio::test]
    async fn official_launch_waits_for_an_in_flight_account_read() {
        let _environment = LaunchEnvironment::new();
        let _activation = crate::services::capability_activation::activate().await;
        let client = router_client().await;
        let (request_id, handle, _response) = client
            .prepare_request_with_process(true, None, "account/rateLimits/read", &Value::Null)
            .await
            .unwrap();
        let launch = CodexLaunchConfig {
            auth_mode: Some(CodexAuthMode::LocalSubscription),
            ..CodexLaunchConfig::default()
        };
        let admission = client.ensure_process_for_launch_config(&launch);
        tokio::pin!(admission);

        assert!(futures_util::poll!(&mut admission).is_pending());
        assert_eq!(
            client.state.lock().await.auth_mode,
            CodexAuthMode::WeworkRouter
        );
        assert!(handle.pending.lock().await.contains_key(&request_id));

        let request =
            client.prepare_request_with_process(true, Some(&launch), "model/list", &Value::Null);
        tokio::pin!(request);
        assert!(futures_util::poll!(&mut request).is_pending());

        handle.remove_pending(request_id).await;
        client.restart().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn auth_admission_preserves_a_read_response_before_switching() {
        let _environment = LaunchEnvironment::new();
        let _activation = crate::services::capability_activation::activate().await;
        let client = echo_router_client().await;
        let (request_id, handle, response_rx) = client
            .prepare_request_with_process(true, None, "account/rateLimits/read", &Value::Null)
            .await
            .unwrap();
        let admission = client.state_for_auth_mode(Some(CodexAuthMode::LocalSubscription));
        tokio::pin!(admission);
        assert!(futures_util::poll!(&mut admission).is_pending());

        handle
            .write_message(json!({"id":request_id,"result":{"rateLimits":{}}}))
            .await
            .unwrap();
        let state = timeout(Duration::from_secs(5), admission)
            .await
            .unwrap()
            .unwrap();

        assert_eq!(response_rx.await.unwrap(), Ok(json!({"rateLimits": {}})));
        assert_eq!(state.auth_mode, CodexAuthMode::LocalSubscription);
        assert!(state.process.is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn auth_admission_drains_paginated_history_after_thread_metadata() {
        assert_history_read_drains_after_metadata("thread/turns/list").await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn auth_admission_drains_timeline_after_thread_metadata() {
        assert_history_read_drains_after_metadata("thread/timeline/list").await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn auth_admission_drains_search_items_after_thread_metadata() {
        assert_history_read_drains_after_metadata("thread/items/list").await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn auth_admission_drains_saved_invocation_after_thread_metadata() {
        assert_history_read_drains_after_metadata("thread/items/read").await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn auth_admission_drains_cold_goal_eligibility_after_thread_metadata() {
        for goal in [Value::Null, json!({"status":"complete"})] {
            assert_read_response_drains_after_metadata(
                "thread/goal/get",
                json!({"threadId":"history"}),
                json!({"goal":goal}),
            )
            .await;
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn auth_admission_does_not_turn_persisted_goal_metadata_into_work() {
        assert_read_response_drains_after_metadata(
            "thread/goal/get",
            json!({"threadId":"history"}),
            json!({"goal":{"status":"active"}}),
        )
        .await;
    }

    #[cfg(unix)]
    fn history_read_fixture(method: &str) -> (Value, Value) {
        match method {
            "thread/turns/list" => (
                json!({"threadId":"history","limit":100,"sortDirection":"desc","itemsView":"notLoaded"}),
                json!({"data":[{"id":"completed-turn","status":"completed","itemsView":"notLoaded"}],"nextCursor":null}),
            ),
            "thread/timeline/list" => (
                json!({"threadId":"history","cursor":null,"limit":100}),
                json!({"data":[{"type":"item","position":1,"turnId":"completed-turn","item":{"id":"message","type":"agentMessage","text":"Saved reply"}}],"nextCursor":null}),
            ),
            "thread/items/list" => (
                json!({"threadId":"history","turnId":"completed-turn","cursor":null,"sortDirection":"asc","limit":100}),
                json!({"data":[{"turnId":"completed-turn","item":{"id":"message","type":"agentMessage","text":"Saved reply"}}],"nextCursor":null}),
            ),
            "thread/items/read" => (
                json!({"threadId":"history","turnId":"completed-turn","itemIds":["call"]}),
                json!({"data":[{"turnId":"completed-turn","item":{"id":"call","type":"mcpToolCall","server":"saved-server"}}]}),
            ),
            _ => panic!("unsupported history fixture: {method}"),
        }
    }

    #[cfg(unix)]
    async fn assert_history_read_drains_after_metadata(method: &str) {
        let (params, response) = history_read_fixture(method);
        assert_read_response_drains_after_metadata(method, params, response).await;
    }

    #[cfg(unix)]
    async fn assert_read_response_drains_after_metadata(
        method: &str,
        params: Value,
        response: Value,
    ) {
        let _environment = LaunchEnvironment::new();
        let _activation = crate::services::capability_activation::activate().await;
        let client = echo_router_client().await;
        let (metadata_id, metadata_handle, metadata_rx) = client
            .prepare_request_with_process(
                true,
                None,
                "thread/read",
                &json!({"threadId":"history","includeTurns":false}),
            )
            .await
            .unwrap();
        let admission = client.state_for_auth_mode(Some(CodexAuthMode::LocalSubscription));
        tokio::pin!(admission);
        assert!(futures_util::poll!(&mut admission).is_pending());

        let metadata = json!({"thread":{"id":"history","historyMode":"paginated"}});
        metadata_handle
            .write_message(json!({"id":metadata_id,"result":metadata}))
            .await
            .unwrap();
        assert_eq!(metadata_rx.await.unwrap(), Ok(metadata));
        let (page_id, page_handle, page_rx) = client
            .prepare_request_with_process(true, None, method, &params)
            .await
            .unwrap();
        assert!(futures_util::poll!(&mut admission).is_pending());
        assert_eq!(
            client.state.lock().await.auth_mode,
            CodexAuthMode::WeworkRouter
        );
        assert!(page_handle.pending.lock().await.contains_key(&page_id));

        page_handle
            .write_message(json!({"id":page_id,"result":response}))
            .await
            .unwrap();
        let state = timeout(Duration::from_secs(5), admission)
            .await
            .unwrap()
            .unwrap();

        assert_eq!(page_rx.await.unwrap(), Ok(response));
        assert_eq!(state.auth_mode, CodexAuthMode::LocalSubscription);
        assert!(state.process.is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn auth_admission_rechecks_native_goal_work_after_eligibility_response() {
        let _environment = LaunchEnvironment::new();
        let _activation = crate::services::capability_activation::activate().await;
        let client = echo_router_client().await;
        let (request_id, handle, response_rx) = client
            .prepare_request_with_process(
                true,
                None,
                "thread/goal/get",
                &json!({"threadId":"history"}),
            )
            .await
            .unwrap();
        for (method, status) in [
            ("turn/started", "inProgress"),
            ("turn/completed", "completed"),
        ] {
            handle
                .notifications
                .send(json!({"method":method,"params":{
                    "threadId":"history","turn":{"id":"completed-turn","status":status}
                }}))
                .await;
        }
        let process_id = {
            let state = client.state.lock().await;
            assert!(state.active_threads.is_empty());
            assert!(state.active_threads_snapshot().is_empty());
            state.process.as_ref().unwrap().child.id()
        };
        let admission = client.state_for_auth_mode(Some(CodexAuthMode::LocalSubscription));
        tokio::pin!(admission);
        assert!(futures_util::poll!(&mut admission).is_pending());

        let response = json!({"goal":{"status":"active"}});
        handle
            .write_message(json!({"id":request_id,"result":response}))
            .await
            .unwrap();
        let error = timeout(Duration::from_secs(5), admission)
            .await
            .unwrap()
            .err()
            .unwrap();
        assert_eq!(response_rx.await.unwrap(), Ok(response));
        assert!(error.contains("active_turns=1, pending_requests=0"));
        {
            let state = client.state.lock().await;
            assert_eq!(state.auth_mode, CodexAuthMode::WeworkRouter);
            assert_eq!(state.process.as_ref().unwrap().child.id(), process_id);
            assert!(state.active_threads.is_empty());
            assert_eq!(state.active_threads_snapshot().get("history"), Some(&1));
        }
        handle
            .notifications
            .send(json!({"method":"thread/goal/cleared","params":{"threadId":"history"}}))
            .await;
        client.restart().await;
    }

    #[tokio::test]
    async fn auth_admission_keeps_native_turns_protected_before_local_tracking() {
        let _environment = LaunchEnvironment::new();
        let client = router_client().await;
        let notifications = client
            .state
            .lock()
            .await
            .process
            .as_ref()
            .unwrap()
            .notifications
            .clone();
        notifications
            .send(json!({"method":"turn/started","params":{
                "threadId":"native-thread", "turn":{"id":"native-turn","status":"inProgress"}
            }}))
            .await;
        assert!(client.state.lock().await.active_threads.is_empty());

        let error = client
            .state_for_auth_mode(Some(CodexAuthMode::LocalSubscription))
            .await
            .err()
            .unwrap();

        assert!(error.contains("active_turns=1"));
        assert_eq!(
            client.state.lock().await.auth_mode,
            CodexAuthMode::WeworkRouter
        );
        client.restart().await;
    }

    #[tokio::test]
    async fn auth_admission_keeps_pending_mutations_protected() {
        let _environment = LaunchEnvironment::new();
        let _activation = crate::services::capability_activation::activate().await;
        for method in [
            "config/batchWrite",
            "thread/goal/set",
            "thread/goal/clear",
            "unknown/read",
        ] {
            assert_pending_request_rejects_auth_change(method).await;
        }
    }

    async fn assert_pending_request_rejects_auth_change(method: &str) {
        let client = router_client().await;
        let (request_id, handle, _response) = client
            .prepare_request_with_process(true, None, method, &Value::Null)
            .await
            .unwrap();

        let error = client
            .state_for_auth_mode(Some(CodexAuthMode::LocalSubscription))
            .await
            .err()
            .unwrap();

        assert!(error.contains("authentication mode is busy"));
        assert_eq!(
            client.state.lock().await.auth_mode,
            CodexAuthMode::WeworkRouter
        );
        assert!(handle.pending.lock().await.contains_key(&request_id));
        handle.remove_pending(request_id).await;
        client.restart().await;
    }

    #[tokio::test]
    async fn unscoped_goal_recovery_does_not_remove_subscription_auth() {
        let _environment = LaunchEnvironment::new();
        let client = CodexAppServerClient::new("official-goal-recovery");
        client.mark_thread_active("official-thread").await;
        let result = client
            .degrade_auth_after_cloud_config_failure(
                "thread/goal/get",
                "timed out refreshing cloud config bundle",
                Some("official-thread"),
                None,
                false,
            )
            .await;
        assert_eq!(result, Ok(false));
        assert_eq!(
            client.state.lock().await.auth_mode,
            CodexAuthMode::LocalSubscription
        );
        client.finish_thread_activity("official-thread", true).await;
    }

    #[tokio::test]
    async fn authentication_switch_waits_for_pending_requests_then_recovers_when_idle() {
        let mut state = CodexAppServerSharedState {
            auth_mode: CodexAuthMode::WeworkRouter,
            ..CodexAppServerSharedState::default()
        };
        let requested = Some(CodexAuthMode::LocalSubscription);
        assert!(apply_auth_mode(&mut state, requested, 1).await.is_err());
        assert_eq!(state.auth_mode, CodexAuthMode::WeworkRouter);
        apply_auth_mode(&mut state, requested, 0).await.unwrap();
        assert_eq!(state.auth_mode, CodexAuthMode::LocalSubscription);
    }

    #[tokio::test]
    async fn plugin_configuration_restart_preserves_degraded_auth_mode() {
        let _environment = LaunchEnvironment::new();
        let client = router_client().await;
        client
            .state
            .lock()
            .await
            .thread_generations
            .insert("existing-thread".to_owned(), 42);

        client
            .mutate_configuration_if_idle(|| async { Ok(((), true)) })
            .await
            .unwrap();

        let state = client.state.lock().await;
        assert!(state.process.is_none());
        assert!(state.thread_generations.is_empty());
        assert_eq!(state.auth_mode, CodexAuthMode::WeworkRouter);
    }

    #[tokio::test]
    async fn explicit_account_mutation_restores_subscription_auth_mode() {
        let _environment = LaunchEnvironment::new();
        let client = router_client().await;

        client.mutate_auth_if_idle(|| Ok(())).await.unwrap();

        let state = client.state.lock().await;
        assert!(state.process.is_none());
        assert_eq!(state.auth_mode, CodexAuthMode::LocalSubscription);
    }
}
