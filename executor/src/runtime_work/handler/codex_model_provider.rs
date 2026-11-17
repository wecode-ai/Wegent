use super::*;

#[derive(Clone, Debug)]
pub(super) struct CodexModelProviderInfo {
    pub(super) id: String,
    pub(super) display_name: String,
    pub(super) kind: &'static str,
    pub(super) current: bool,
}

pub(super) fn current_codex_model_provider_from_config(
    config_response: &Value,
) -> Result<CodexModelProviderInfo, AppIpcError> {
    let provider = inference_provider_from_snapshot(config_response)?;
    Ok(model_provider_info(config_response, provider))
}

fn inference_provider_from_snapshot(config_response: &Value) -> Result<String, AppIpcError> {
    let config = config_response["config"]
        .as_object()
        .ok_or_else(|| invalid_snapshot("missing_config"))?;
    let effective = provider_field(config)?;
    if let Some(provider) = effective
        .as_ref()
        .filter(|provider| !internal_provider(provider))
    {
        return Ok(provider.clone());
    }
    let Some(layers) = config_response.get("layers") else {
        return if effective.is_none() {
            Ok(CODEX_OFFICIAL_PROVIDER_ID.to_owned())
        } else {
            Err(invalid_snapshot("missing_layers"))
        };
    };
    // Codex returns layers in descending priority, including profiles and projects.
    // Resolve the inference provider beneath its session-local router override from
    // this same snapshot, rather than reading a separately changing config file.
    for layer in layers
        .as_array()
        .filter(|layers| !layers.is_empty())
        .ok_or_else(|| invalid_snapshot("invalid_layers"))?
    {
        match layer.get("disabledReason") {
            Some(Value::String(_)) => continue,
            None | Some(Value::Null) => {}
            _ => return Err(invalid_snapshot("invalid_disabled_reason")),
        }
        let config = layer["config"]
            .as_object()
            .ok_or_else(|| invalid_snapshot("invalid_layer_config"))?;
        if let Some(provider) = provider_field(config)?.filter(|value| !internal_provider(value)) {
            return Ok(provider);
        }
    }
    Ok(CODEX_OFFICIAL_PROVIDER_ID.to_owned())
}

fn provider_field(config: &Map<String, Value>) -> Result<Option<String>, AppIpcError> {
    match config
        .get("model_provider")
        .or_else(|| config.get("modelProvider"))
    {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(provider)) if !provider.trim().is_empty() => {
            Ok(Some(provider.trim().to_owned()))
        }
        _ => Err(invalid_snapshot("invalid_provider")),
    }
}

fn internal_provider(provider: &str) -> bool {
    provider == "wework-catalog"
        || provider == crate::server::codex_model_catalog::PROVIDER_ID
        || provider == crate::server::codex_model_catalog::LEGACY_PROVIDER_ID
}

fn invalid_snapshot(reason: &str) -> AppIpcError {
    log_executor_event(
        "runtime model provider snapshot invalid",
        &[("reason", reason.to_owned())],
    );
    AppIpcError::new(
        "codex_models_unavailable",
        "The native Codex configuration snapshot is invalid; refresh the model catalog",
    )
}

fn model_provider_info(
    config_response: &Value,
    current_provider: String,
) -> CodexModelProviderInfo {
    let config = config_response
        .get("config")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let display_name = config
        .get("model_providers")
        .or_else(|| config.get("modelProviders"))
        .and_then(Value::as_object)
        .and_then(|providers| providers.get(&current_provider))
        .and_then(Value::as_object)
        .and_then(|provider| string_from_map(provider, "name"))
        .unwrap_or_else(|| {
            if current_provider == CODEX_OFFICIAL_PROVIDER_ID {
                CODEX_OFFICIAL_PROVIDER_NAME.to_owned()
            } else {
                current_provider.clone()
            }
        });
    let kind = if current_provider == CODEX_OFFICIAL_PROVIDER_ID {
        "official"
    } else {
        "provider"
    };
    CodexModelProviderInfo {
        id: current_provider,
        display_name,
        kind,
        current: true,
    }
}

#[cfg(test)]
#[path = "codex_model_provider_tests.rs"]
mod tests;
