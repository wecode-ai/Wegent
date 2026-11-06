// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

/// Own the subscription and thread configuration that must move together on restart.
pub(super) struct CodexTurnRequestContext {
    pub(super) notification_rx: broadcast::Receiver<CodexNotification>,
    resume_params: Value,
}

impl CodexTurnRequestContext {
    pub(super) fn new(
        notification_rx: broadcast::Receiver<CodexNotification>,
        resume_params: Value,
    ) -> Self {
        Self {
            notification_rx,
            resume_params,
        }
    }

    pub(super) async fn request(
        &mut self,
        client: &CodexAppServerClient,
        method: &str,
        params: Value,
        launch_config: &CodexLaunchConfig,
    ) -> Result<Value, String> {
        client
            .request_for_launch_config_with_recovery(method, params, launch_config, Some(self))
            .await
    }

    async fn restore(
        &mut self,
        client: &CodexAppServerClient,
        method: &str,
        launch_config: &CodexLaunchConfig,
    ) -> Result<(), String> {
        let thread_id = self.resume_params["threadId"]
            .as_str()
            .ok_or("Codex turn recovery requires a thread ID")?;
        // Resume can emit Goal turns before its RPC response. Subscribe first,
        // replacing the old stream and its queued process-exit notification.
        self.notification_rx = client
            .subscribe_thread_notifications_for_launch_config(launch_config, thread_id)
            .await?;
        if method != "thread/resume" {
            let response = client
                .request_for_launch_config_once(
                    "thread/resume",
                    self.resume_params.clone(),
                    launch_config,
                )
                .await?;
            validate_restored_permissions(&self.resume_params, &response)?;
            let resumed_id = thread_id_from_response(
                "thread/resume",
                &response,
                launch_config.model_provider.as_deref(),
            )?;
            if resumed_id != thread_id {
                return Err(format!(
                    "Codex recovery resumed thread {resumed_id} instead of {thread_id}"
                ));
            }
            client
                .state
                .lock()
                .await
                .thread_context_configurations
                .insert(
                    resumed_id,
                    mcp_reload::thread_context_configuration(&self.resume_params),
                );
        }
        Ok(())
    }
}

fn validate_restored_permissions(params: &Value, response: &Value) -> Result<(), String> {
    let Some(reviewer) = params.get("approvalsReviewer") else {
        return Ok(());
    };
    if response["approvalsReviewer"] != *reviewer
        || response["activePermissionProfile"]["id"] != params["permissions"]
    {
        return Err(
            "Codex recovery did not apply the required source permissions and reviewer".to_owned(),
        );
    }
    Ok(())
}

impl CodexAppServerClient {
    pub(super) async fn request_for_launch_config_with_recovery(
        &self,
        method: &str,
        params: Value,
        launch_config: &CodexLaunchConfig,
        recovery: Option<&mut CodexTurnRequestContext>,
    ) -> Result<Value, String> {
        let result = self
            .request_for_launch_config_once(method, params.clone(), launch_config)
            .await;
        let Err(error) = &result else {
            return result;
        };
        if !is_codex_cloud_config_error(error)
            || !self
                .degrade_auth_after_cloud_config_failure(
                    method,
                    error,
                    params.get("threadId").and_then(Value::as_str),
                    Some(launch_config),
                    recovery.is_some(),
                )
                .await?
        {
            return result;
        }
        if let Some(recovery) = recovery {
            recovery.restore(self, method, launch_config).await?;
        }
        self.request_for_launch_config_once(method, params, launch_config)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn contextless_fork_cannot_restart_its_active_source_thread() {
        let mut client = CodexAppServerClient::new("contextless-fork-recovery");
        client.state = Arc::new(Mutex::new(CodexAppServerSharedState {
            auth_mode: CodexAuthMode::LocalSubscription,
            ..CodexAppServerSharedState::default()
        }));
        client.mark_thread_active("source-thread").await;
        let degraded = client
            .degrade_auth_after_cloud_config_failure(
                "thread/fork",
                "timed out refreshing cloud config bundle",
                Some("source-thread"),
                Some(&CodexLaunchConfig::default()),
                false,
            )
            .await;
        assert_eq!(degraded, Ok(false));
        assert_eq!(
            client.state.lock().await.auth_mode,
            CodexAuthMode::LocalSubscription
        );
        client.finish_thread_activity("source-thread", false).await;
    }

    #[test]
    fn restored_source_thread_must_keep_its_permission_boundary() {
        let params = json!({
            "permissions": "wework-source-project",
            "approvalsReviewer": "auto_review",
        });
        let response = json!({
            "activePermissionProfile": {"id": "wework-source-project"},
            "approvalsReviewer": "auto_review",
        });
        assert!(validate_restored_permissions(&params, &response).is_ok());
        for field in ["activePermissionProfile", "approvalsReviewer"] {
            let mut invalid = response.clone();
            invalid[field] = Value::Null;
            assert!(validate_restored_permissions(&params, &invalid).is_err());
        }
    }
}
