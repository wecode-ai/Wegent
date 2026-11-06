use super::*;
use std::io::Write;

pub(super) async fn prepare_text_model_catalog(
    request: &mut ExecutionRequest,
    generated_files: &mut Vec<PathBuf>,
) -> Result<(), String> {
    if request.extra.get("enable_tools").and_then(Value::as_bool) != Some(false) {
        return Ok(());
    }
    let model = codex_request_model(request)
        .ok_or_else(|| "Select a Codex model for text generation".to_owned())?;
    let catalog = codex_model_catalog::read_model_overrides(std::slice::from_ref(&model)).await?;
    let effective = catalog["models"]
        .as_array()
        .and_then(|models| models.iter().find(|entry| entry["slug"] == model))
        .map(|entry| &entry["effective"])
        .ok_or_else(|| "The selected text model has no capability catalog".to_owned())?;
    let catalog = text_model_catalog(effective)?;
    let mut temporary = tempfile::Builder::new()
        .prefix("wework-text-model-")
        .suffix(".json")
        .tempfile()
        .map_err(|error| error.to_string())?;
    temporary
        .write_all(&serde_json::to_vec(&catalog).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    let (file, path) = temporary.keep().map_err(|error| error.to_string())?;
    drop(file);
    request.extra.insert(
        "weworkTextModelCatalog".into(),
        json!(path.to_string_lossy()),
    );
    generated_files.push(path);
    Ok(())
}

fn text_model_catalog(model: &Value) -> Result<Value, String> {
    if !model.is_object() || !model["slug"].is_string() {
        return Err("Invalid text model capability catalog".into());
    }
    let mut model = model.clone();
    // Apply-patch exposure is a model capability, not a feature flag. Keep the
    // selected model and provider authentication while removing this capability.
    model["apply_patch_tool_type"] = Value::Null;
    if model.get("tool_mode").is_some() {
        model["tool_mode"] = json!("direct");
    }
    Ok(json!({"models":[model]}))
}

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
        "goals",
        "view_image",
        "stable_environment_tools",
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
    fn text_model_catalog_disables_a_model_owned_code_mode_override() {
        let catalog = text_model_catalog(&json!({"slug":"native", "tool_mode":"code_mode_only", "model_messages":{"instructions_template":"Provider instructions"}})).unwrap();
        assert_eq!(catalog["models"][0]["tool_mode"], "direct");
        assert_eq!(
            catalog["models"][0]["model_messages"]["instructions_template"],
            "Provider instructions"
        );
    }

    #[test]
    fn text_catalog_removes_patch_capability_without_changing_model_metadata() {
        let model = json!({"slug":"native-model","apply_patch_tool_type":"freeform","context_window":100000,"base_instructions":"Provider instructions","supports_reasoning_summaries":true});
        let catalog = text_model_catalog(&model).unwrap();
        let mut expected = model;
        expected["apply_patch_tool_type"] = Value::Null;
        assert_eq!(catalog, json!({"models":[expected]}));
    }

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
        assert_eq!(params["config"]["features.goals"], json!(false));
        assert_eq!(params["config"]["features.view_image"], json!(false));
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
        let params = turn_start_params("thread", &request, &config, Vec::new());
        assert_eq!(params["environments"], json!([]));
    }
}
