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
    pub(super) async fn reload_thread_configuration_if_needed(
        &self,
        plan: &CodexThreadPlan,
        request: &ExecutionRequest,
    ) -> Result<(), String> {
        let loaded = match &plan.start {
            CodexThreadStart::Request { params, .. } => self
                .state
                .lock()
                .await
                .thread_mcp_configurations
                .get(params["threadId"].as_str().unwrap_or_default())
                .cloned(),
            CodexThreadStart::Direct(_) => None,
        };
        if let Some(thread_id) = config_reload_resume_thread_id(plan, request, loaded.as_ref()) {
            if let Err(error) = self.release_thread_subscription(thread_id).await {
                if !super::is_codex_cloud_config_error(&error) {
                    return Err(error);
                }
                // The app-server is already poisoned by a ChatGPT cloud-config
                // timeout. The upcoming resume/turn request owns the auth
                // fallback and app-server restart, so do not fail here.
                log_executor_event(
                    "codex thread unsubscribe skipped after cloud config failure",
                    &[("thread_id", thread_id.to_owned()), ("error", error)],
                );
            }
        }
        Ok(())
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
}
