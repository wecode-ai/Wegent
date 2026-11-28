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
    configure_managed_wework_mcp(request, launch)?;
    let member_request;
    let request = if launch.manager.is_some() {
        // Bot connectors bind only their own credentials. Host-owned manager
        // tokens must never enter native process arguments, environment or MCP.
        member_request = super::manager_tools::shell_request(request);
        &member_request
    } else {
        request
    };
    if !request.project_group_execution()
        && super::super::instance_home::request_home(request).is_none()
    {
        launch.mcp_unavailable = configure_global_mcps(request, &mut launch.thread_config)?;
    }
    launch
        .config_overrides
        .extend(computer_use_mcp_config_overrides(&request.task_id));
    let (overrides, environment) = cdp_browser_mcp_config_overrides(request)?;
    launch.config_overrides.extend(overrides);
    launch.env.extend(environment);
    configure_diagnostics_mcp(request, launch);
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

fn configure_diagnostics_mcp(request: &ExecutionRequest, launch: &mut CodexLaunchConfig) {
    if launch.manager.is_some()
        || crate::workbench_control::ControlContext::from_request(request).is_none()
    {
        return;
    }
    let Some((address, _)) = diagnostics_mcp_endpoint() else {
        return;
    };
    let key = toml_key_path(&["mcp_servers", "wework_diagnostics"]);
    launch.config_overrides.extend([
        format!("{key}.enabled=true"),
        format!("{key}.required=false"),
        format!("{key}.url={}", toml_value(&address)),
        format!("{key}.tool_timeout_sec=120"),
        format!(
            "{key}.env_http_headers.Authorization={}",
            toml_value(DIAGNOSTICS_MCP_AUTH_ENV)
        ),
        format!("{key}.default_tools_approval_mode={}", toml_value("writes")),
    ]);
}

pub(super) const DIAGNOSTICS_MCP_AUTH_ENV: &str = "WEGENT_CODEX_DIAGNOSTICS_MCP_AUTHORIZATION";

pub(super) fn diagnostics_mcp_endpoint() -> Option<(String, String)> {
    let path = env::var_os("WEWORK_DIAGNOSTICS_MCP_FILE")?;
    let bytes = std::fs::read(path).ok()?;
    let record: Value = serde_json::from_slice(&bytes).ok()?;
    let address = record["url"].as_str()?;
    let token = record["token"].as_str()?;
    let url = reqwest::Url::parse(address).ok()?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.path() != "/diagnostics"
        || token.is_empty()
    {
        return None;
    }
    Some((address.to_owned(), token.to_owned()))
}

impl CodexAppServerClient {
    pub(crate) async fn resume_thread_for_action(
        &self,
        request: &ExecutionRequest,
        mut params: Map<String, Value>,
    ) -> Result<Value, String> {
        // Thread resume owns the native writer lease. Concurrent resumes for the
        // same thread must queue on the shared lifecycle gate instead of each
        // retrying the native writer-busy error.
        let thread_id = params
            .get("threadId")
            .and_then(Value::as_str)
            .ok_or("thread/resume requires a thread ID")?
            .to_owned();
        let gate = self.thread_lifecycle_gate(&thread_id).await;
        let _admission = gate.lock().await;
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
