// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

pub(super) fn configure_task_mcp(
    request: &ExecutionRequest,
    launch: &mut CodexLaunchConfig,
) -> Result<(), String> {
    if super::super::instance_home::request_home(request).is_none() {
        let overrides = global_mcp_config_overrides(&mut launch.thread_config)?;
        launch.config_overrides.extend(overrides);
    }
    for (overrides, environment) in [
        cdp_browser_mcp_config_overrides(request)?,
        computer_use_mcp_config_overrides(),
        managed_wework_mcp_config_overrides(request)?,
        runtime_capabilities::request_mcp_config_overrides(request, &mut launch.thread_config)?,
    ] {
        launch.config_overrides.extend(overrides);
        launch.env.extend(environment);
    }
    if crate::runtime_work::stand_in_requires_confirmation(request)
        && !external_work::applies(request)
    {
        let home =
            super::super::instance_home::request_home(request).unwrap_or_else(wework_codex_home);
        launch
            .config_overrides
            .extend(stand_in_mcp_approval_overrides(
                request,
                &home,
                &launch.config_overrides,
                &launch.thread_config,
            )?);
    }
    super::stand_in_approval::configure_identity_review(request, launch);
    Ok(())
}

impl CodexAppServerClient {
    pub(crate) async fn resume_thread_for_action(
        &self,
        request: &ExecutionRequest,
        mut params: Map<String, Value>,
    ) -> Result<Value, String> {
        ensure_codex_mcp_endpoints().await?;
        let mut launch = CodexLaunchConfig {
            thread_config: task_identity_thread_config(request),
            ..CodexLaunchConfig::default()
        };
        configure_task_mcp(request, &mut launch)?;
        // Cold resume may immediately continue an active Goal. Its MCP pool must
        // be task-scoped before resume, without replacing persisted model settings.
        append_thread_launch_params(&mut params, &launch);
        let params = Value::Object(params);
        let mut fields = task_fields(&request.task_id, &request.subtask_id);
        fields.push((
            "thread_id",
            string_value(&params, "threadId").unwrap_or_default(),
        ));
        fields.extend(mcp_thread_config_fields(&params));
        log_executor_event("codex task action thread resume", &fields);
        self.request_for_launch_config("thread/resume", params, &launch)
            .await
    }
}
