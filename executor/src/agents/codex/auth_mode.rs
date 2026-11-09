// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

/// Rejects incompatible launches until the current process can change authentication safely.
pub(super) async fn apply_auth_mode(
    state: &mut CodexAppServerSharedState,
    requested: Option<CodexAuthMode>,
    pending_request_count: usize,
) -> Result<(), String> {
    let Some(requested) = requested.filter(|mode| *mode != state.auth_mode) else {
        return Ok(());
    };
    if !state.active_threads.is_empty() || pending_request_count > 0 {
        return Err(format!(
            "Codex authentication mode is busy (current={:?}, requested={requested:?}, \
             active_turns={}, pending_requests={pending_request_count}); \
             retry after active turns and requests finish",
            state.auth_mode,
            state.active_threads.values().sum::<usize>(),
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
        let mut client = CodexAppServerClient::new("auth-mode-concurrency");
        client.state = Arc::new(Mutex::new(CodexAppServerSharedState::default()));
        let mut child = super::super::tests::spawn_idle_app_server_child();
        let stdin = child.stdin.take().unwrap();
        let mut state = client.state.lock().await;
        state.auth_mode = CodexAuthMode::WeworkRouter;
        state.process_environment = client.process_environment(&BTreeMap::new(), &BTreeMap::new());
        state.process = Some(CodexAppServerProcess {
            child,
            stdin: Arc::new(Mutex::new(stdin)),
            pending: Arc::new(Mutex::new(HashMap::new())),
            notifications: CodexNotificationHub::new(),
            reader_task: tokio::spawn(std::future::pending()),
        });
        drop(state);
        client
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
