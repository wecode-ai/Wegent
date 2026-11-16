//! Evidence-only scheduled memory turns must not inherit general execution tools.
use super::*;

pub(super) fn applies(request: &ExecutionRequest) -> bool {
    request.extra.get("origin").is_some_and(|origin| {
        origin["type"] == "stand_in_schedule" && origin["memoryReview"] == true
    })
}

pub(super) fn configure(config: &mut CodexLaunchConfig) -> Result<(), String> {
    super::text_generation::configure_no_execution_tools(config);
    // Native Code Mode composes the allowed MCP calls; it is not a shell.
    config
        .config_overrides
        .extend(codex_tool_orchestration_overrides());
    config.user_developer_instructions.clear();
    let allowed = "mcp_servers.wework_stand_in.";
    let mut servers = json!({});
    // Native thread overrides are a HashMap: a parent reset and dotted children
    // have no defined application order. Send the complete endpoint atomically.
    for entry in config
        .thread_config
        .iter()
        .map(|(key, value)| format!("{key}={}", toml_json_value(value)))
        .chain(config.config_overrides.iter().cloned())
    {
        if entry.starts_with(allowed) {
            let value = toml_edit::de::from_str::<Value>(&entry)
                .map_err(|_| "Invalid memory review MCP configuration".to_owned())?;
            merge_endpoint(&mut servers, &value["mcp_servers"]);
        }
    }
    config
        .thread_config
        .retain(|key, _| !key.starts_with("mcp_servers"));
    config
        .config_overrides
        .retain(|entry| !entry.starts_with("mcp_servers"));
    // Only this run-bound endpoint's reviewed evidence capabilities may execute
    // unattended. Unknown tools stay excluded and default to native prompting.
    if let Some(endpoint) = servers.get_mut("wework_stand_in") {
        let allowed = crate::task_runtime::memory_policy::MEMORY_REVIEW_TOOLS;
        endpoint["enabled_tools"] = json!(allowed);
        endpoint["default_tools_approval_mode"] = json!("prompt");
        endpoint["tools"] = json!({});
        for name in allowed {
            endpoint["tools"][*name] = json!({"approval_mode":"approve"});
        }
    }
    config
        .config_overrides
        .push(format!("mcp_servers={}", toml_json_value(&servers)));
    config.config_overrides.extend([
        "web_search=\"disabled\"".into(),
        "skills.include_instructions=false".into(),
        "project_doc_max_bytes=0".into(),
        "include_environment_context=false".into(),
        "include_apps_instructions=false".into(),
        "tools.update_plan.enabled=false".into(),
    ]);
    Ok(())
}

fn merge_endpoint(target: &mut Value, source: &Value) {
    if let (Some(target), Some(source)) = (target.as_object_mut(), source.as_object()) {
        for (key, value) in source {
            merge_endpoint(target.entry(key.clone()).or_insert(Value::Null), value);
        }
    } else {
        *target = source.clone();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_review_boundary_only_approves_explicit_evidence_tools() {
        let mut config = CodexLaunchConfig {
            user_developer_instructions: "Use the workspace shell".into(),
            config_overrides: vec![
                "mcp_servers.external.url=\"http://unrelated\"".into(),
                "mcp_servers.wework_stand_in.url=\"http://bound\"".into(),
                "mcp_servers.wework_stand_in.default_tools_approval_mode=\"writes\"".into(),
                "mcp_servers.wework_stand_in.tools.external_write.approval_mode=\"approve\"".into(),
                "mcp_servers.wework_stand_in.env_http_headers.Authorization=\"HOST_AUTH_ENV\""
                    .into(),
            ],
            ..Default::default()
        };
        config
            .thread_config
            .insert("mcp_servers.external.enabled".into(), json!(true));
        config.thread_config.insert(
            "mcp_servers.wework_stand_in.http_headers.X-Task".into(),
            json!("review"),
        );
        configure(&mut config).unwrap();
        let mut params = Map::new();
        append_thread_launch_params(&mut params, &config);
        assert!(config.user_developer_instructions.is_empty());
        let servers = &params["config"]["mcp_servers"];
        assert_eq!(servers.as_object().unwrap().len(), 1);
        assert!(params["config"]
            .as_object()
            .unwrap()
            .keys()
            .all(|key| !key.starts_with("mcp_servers.")));
        assert!(params["config"]
            .get("mcp_servers.external.enabled")
            .is_none());
        assert!(params["config"].get("mcp_servers.external.url").is_none());
        assert_eq!(servers["wework_stand_in"]["url"], "http://bound");
        assert_eq!(
            servers["wework_stand_in"]["http_headers"]["X-Task"],
            "review"
        );
        assert_eq!(
            servers["wework_stand_in"]["default_tools_approval_mode"],
            "prompt"
        );
        let allowed = crate::task_runtime::memory_policy::MEMORY_REVIEW_TOOLS;
        assert_eq!(servers["wework_stand_in"]["enabled_tools"], json!(allowed));
        assert_eq!(
            servers["wework_stand_in"]["tools"]
                .as_object()
                .unwrap()
                .len(),
            allowed.len()
        );
        for name in allowed {
            assert_eq!(
                servers["wework_stand_in"]["tools"][*name]["approval_mode"],
                "approve"
            );
        }
        assert!(servers["wework_stand_in"]["tools"]
            .get("external_write")
            .is_none());
        assert_eq!(
            servers["wework_stand_in"]["env_http_headers"]["Authorization"],
            "HOST_AUTH_ENV"
        );
        for feature in [
            "shell_tool",
            "unified_exec",
            "plugins",
            "apps",
            "multi_agent",
            "apply_patch_freeform",
        ] {
            assert_eq!(params["config"][format!("features.{feature}")], false);
        }
        assert_eq!(params["config"]["skills.include_instructions"], false);
        assert_eq!(params["config"]["features.code_mode_host"], true);
        assert_eq!(params["config"]["features.code_mode_only"], true);
        assert_eq!(
            params["config"]["features.code_mode_only_strict_3p_tools"],
            true
        );
        assert_eq!(params["config"]["web_search"], "disabled");
    }

    #[test]
    fn memory_review_boundary_rejects_invalid_endpoint_without_echoing_values() {
        let mut config = CodexLaunchConfig {
            config_overrides: vec!["mcp_servers.wework_stand_in.url=invalid-secret-value".into()],
            ..Default::default()
        };
        assert_eq!(
            configure(&mut config).unwrap_err(),
            "Invalid memory review MCP configuration"
        );
    }

    #[test]
    fn memory_review_boundary_requires_the_exact_scheduled_origin() {
        for (kind, memory, expected) in [
            ("stand_in_schedule", true, true),
            ("stand_in_schedule", false, false),
            ("stand_in_identity", true, false),
            ("ordinary", true, false),
        ] {
            let request =
                serde_json::from_value(json!({"origin":{"type":kind,"memoryReview":memory}}))
                    .unwrap();
            assert_eq!(applies(&request), expected);
        }
    }
}
