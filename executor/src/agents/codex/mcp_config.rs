// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

pub(super) fn consolidate_thread_config(config: &mut Map<String, Value>) {
    let mut servers = config.remove("mcp_servers").unwrap_or_else(|| json!({}));
    let mut keys = config
        .keys()
        .filter(|key| key.starts_with("mcp_servers."))
        .cloned()
        .collect::<Vec<_>>();
    // Apply complete definitions before their field overrides, including env.
    keys.sort();
    for key in keys {
        let path = toml_edit::Key::parse(&key).expect("generated MCP config key");
        let value = config.remove(&key).expect("collected MCP config entry");
        let mut table = &mut servers;
        for segment in &path[1..path.len() - 1] {
            table = table
                .as_object_mut()
                .expect("MCP config table")
                .entry(segment.get().to_owned())
                .or_insert_with(|| json!({}));
        }
        table
            .as_object_mut()
            .expect("MCP config table")
            .insert(path.last().unwrap().get().to_owned(), value);
    }
    // One replacement is independent of native HashMap iteration order and
    // removes services and grants omitted from the current execution.
    config.insert("mcp_servers".to_owned(), servers);
}

pub(super) fn configure_task_mcp(
    request: &ExecutionRequest,
    launch: &mut CodexLaunchConfig,
) -> Result<(), String> {
    // Saved MCP definitions are validated and rebound through thread RPC.
    // Prevent their unbound or malformed table from being loaded at child startup.
    launch.config_overrides.push("mcp_servers={}".to_owned());
    if super::super::instance_home::request_home(request).is_none() {
        launch.mcp_unavailable = configure_global_mcps(request, &mut launch.thread_config)?;
    }
    launch
        .config_overrides
        .extend(computer_use_mcp_config_overrides(&request.task_id));
    let (overrides, environment) = cdp_browser_mcp_config_overrides(request)?;
    launch.config_overrides.extend(overrides);
    launch.env.extend(environment);
    configure_managed_wework_mcp(request, launch)?;
    launch.mcp_unavailable |=
        runtime_capabilities::configure_request_mcps(request, &mut launch.thread_config)?;
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
        if super::memory_review::applies(request) {
            super::memory_review::configure(&mut launch)?;
        }
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
