//! Apply the non-secret model options emitted by the Wework model selector.
use super::*;

pub(super) fn apply(config: &mut Value, options: &Value, runtime: &str) -> Result<(), AppIpcError> {
    for (option, field) in [
        ("weworkCloudModelContextWindow", "model_context_window"),
        ("weworkCloudModelMaxOutputTokens", "max_output_tokens"),
    ] {
        if let Some(value) = options.get(option) {
            let number = value
                .as_u64()
                .or_else(|| value.as_str()?.parse().ok())
                .filter(|value| *value > 0)
                .ok_or_else(|| creation_error("Cloud model limits must be positive integers"))?;
            config[field] = json!(number);
        }
    }
    if runtime != "codex" {
        return Ok(());
    }
    if let Some(id) = options.get("weworkCloudModelCodexCatalogModelId") {
        if id.as_str().is_none_or(|id| id.trim().is_empty()) {
            return Err(creation_error("Cloud catalog model id is required"));
        }
        config["codex_catalog_model_id"] = id.clone();
    }
    for (option, field) in [
        ("weworkCloudModelNativeToolSearch", "native_tool_search"),
        (
            "weworkCloudModelNativeNamespaceTools",
            "native_namespace_tools",
        ),
    ] {
        if let Some(value) = options.get(option) {
            let enabled = value
                .as_bool()
                .or_else(
                    || match value.as_str()?.trim().to_ascii_lowercase().as_str() {
                        "true" => Some(true),
                        "false" => Some(false),
                        _ => None,
                    },
                )
                .ok_or_else(|| creation_error("Cloud native tool options must be boolean"))?;
            config[field] = json!(enabled);
        }
    }
    if let Some(mode) = options.get("weworkCloudModelCodexRequestMode") {
        if !matches!(mode.as_str(), Some("auto" | "standard" | "passthrough"))
            || (mode == "passthrough" && config["upstream_api_format"] != "openai-responses")
        {
            return Err(creation_error(
                "Invalid request mode for the cloud model protocol",
            ));
        }
        config["codex_request_mode"] = mode.clone();
    }
    apply_vision_sidecar(config, options, runtime)
}

fn apply_vision_sidecar(
    config: &mut Value,
    options: &Value,
    runtime: &str,
) -> Result<(), AppIpcError> {
    let Some(raw) = options.get("weworkCloudVisionSidecar") else {
        return Ok(());
    };
    let sidecar: Value = serde_json::from_str(
        raw.as_str()
            .ok_or_else(|| creation_error("Invalid vision model reference"))?,
    )
    .map_err(|_| creation_error("Invalid vision model reference"))?;
    if ["modelName", "namespace"].iter().any(|field| {
        sidecar[field]
            .as_str()
            .is_none_or(|value| value.trim().is_empty())
    }) || !matches!(
        sidecar["modelType"].as_str(),
        Some("public" | "user" | "group")
    ) || sidecar["resourceUserId"].as_u64().is_none()
        || !matches!(
            sidecar["apiFormat"].as_str(),
            Some("openai-responses" | "openai-chat-completions" | "anthropic-messages")
        )
    {
        return Err(creation_error("Invalid vision model reference"));
    }
    let mut headers = config["default_headers"].clone();
    headers["X-Wegent-Model-Type"] = sidecar["modelType"].clone();
    headers["X-Wegent-Model-Namespace"] = sidecar["namespace"].clone();
    headers["X-Wegent-Model-User-Id"] = json!(sidecar["resourceUserId"].to_string());
    headers["X-Wegent-Upstream-Header-wecode-executor"] = json!(runtime);
    config["vision_sidecar"] = json!({"enabled":true,
        "request_url":format!("{}/responses",config["base_url"].as_str().unwrap_or_default().trim_end_matches('/')),
        "api_format":sidecar["apiFormat"],"api_key":config["api_key"],"model_id":sidecar["modelName"],
        "default_headers":headers,"max_descriptions_per_turn":8,"timeout_ms":45000});
    Ok(())
}
