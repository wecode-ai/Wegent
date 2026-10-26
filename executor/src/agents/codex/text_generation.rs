use super::*;

pub(super) fn configure_text_generation(config: &mut CodexLaunchConfig) {
    configure_no_execution_tools(config);
    // A text-only auxiliary turn must not inherit workspace or connector capabilities.
    config.user_developer_instructions.clear();
    config
        .thread_config
        .retain(|key, _| !key.starts_with("mcp_servers"));
    config
        .config_overrides
        .retain(|entry| !entry.starts_with("mcp_servers"));
    config.config_overrides.extend(
        [
            "mcp_servers={}",
            "web_search=\"disabled\"",
            "project_doc_max_bytes=0",
            "include_environment_context=false",
            "include_apps_instructions=false",
            "tools.update_plan.enabled=false",
            "tools.experimental_request_user_input.enabled=false",
        ]
        .into_iter()
        .map(str::to_owned),
    );
    if let Some(registration) = config.local_proxy_registration.as_deref() {
        local_model_proxy::set_text_only(&registration.0);
    }
}

pub(super) fn configure_no_execution_tools(config: &mut CodexLaunchConfig) {
    for feature in [
        "shell_tool",
        "unified_exec",
        "apply_patch_freeform",
        "apps",
        "plugins",
        "tool_suggest",
        "js_repl",
        "code_mode",
        "code_mode_only",
        "multi_agent",
        "multi_agent_v2",
        "image_generation",
        "request_permissions_tool",
        "default_mode_request_user_input",
        "memories",
    ] {
        config
            .config_overrides
            .push(format!("features.{feature}=false"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_generation_removes_workspace_and_connector_capabilities() {
        let mut config = CodexLaunchConfig {
            user_developer_instructions: "workspace-specific instructions".to_owned(),
            ..Default::default()
        };
        config.thread_config.insert(
            "mcp_servers.private".to_owned(),
            json!({"command": "private"}),
        );
        config
            .config_overrides
            .push("mcp_servers.private.enabled=true".to_owned());
        configure_text_generation(&mut config);
        assert!(config.user_developer_instructions.is_empty());
        assert!(config.thread_config.is_empty());
        assert!(!config
            .config_overrides
            .iter()
            .any(|entry| entry == "mcp_servers.private.enabled=true"));
        let mut params = Map::new();
        append_thread_launch_params(&mut params, &config);
        assert_eq!(params["config"]["mcp_servers"], json!({}));
        assert_eq!(params["config"]["features.shell_tool"], json!(false));
        assert_eq!(params["config"]["web_search"], json!("disabled"));
        let request: ExecutionRequest = serde_json::from_value(json!({
            "enable_tools": false, "ephemeral": true,
            "system_prompt": "Unrelated workspace instructions"
        }))
        .unwrap();
        let params = thread_start_params(&request, &config);
        assert_eq!(params["environments"], json!([]));
        assert_eq!(params["ephemeral"], true);
        assert!(!params["developerInstructions"]
            .as_str()
            .unwrap()
            .contains("Unrelated workspace instructions"));
    }
}
