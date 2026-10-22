use super::*;

impl RuntimeWorkRpcHandler {
    pub(super) async fn runner_catalog(&self) -> Result<Value, AppIpcError> {
        let mut models = Vec::new();
        let mut runtimes = Vec::new();
        let mut errors = Vec::new();
        match self
            .list_codex_models(json!({"includeHidden": false}))
            .await
        {
            Ok(catalog) => {
                runtimes.push("codex");
                for model in catalog
                    .get("data")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    let Some(id) = model
                        .get("model")
                        .or_else(|| model.get("id"))
                        .and_then(Value::as_str)
                    else {
                        continue;
                    };
                    let Some(provider) = model.get("providerId").and_then(Value::as_str) else {
                        continue;
                    };
                    if model.get("hidden").and_then(Value::as_bool) == Some(true) {
                        continue;
                    }
                    models.push(json!({
                        "runtime": "codex", "provider": provider, "model_id": id,
                        "local_model_id": id,
                        "label": model.get("displayName").and_then(Value::as_str).unwrap_or(id),
                        "account_label": model.get("providerName").and_then(Value::as_str).unwrap_or(provider),
                        "is_default": model.get("isDefault").and_then(Value::as_bool).unwrap_or(false),
                    }));
                }
            }
            Err(_) => errors.push("codex_catalog_unavailable"),
        }
        let path = std::env::var_os("WEGENT_CLAUDE_HOME")
            .filter(|value| !value.is_empty())
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".claude"))
            .join("settings.json");
        match fs::read_to_string(&path) {
            Ok(contents) => match serde_json::from_str::<Value>(&contents) {
                Ok(settings) => match claude_runner_models(&settings) {
                    Ok(claude_models) => {
                        runtimes.push("claude_code");
                        models.extend(claude_models);
                    }
                    Err(_) => errors.push("claude_provider_required"),
                },
                Err(_) => errors.push("claude_catalog_invalid"),
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => errors.push("claude_catalog_unreadable"),
        }
        Ok(json!({"models": models, "runtimes": runtimes, "errors": errors}))
    }
}

fn claude_runner_models(settings: &Value) -> Result<Vec<Value>, AppIpcError> {
    let env = settings.get("env").unwrap_or(&Value::Null);
    let provider = env.get("WEGENT_CLAUDE_PROVIDER_ID").and_then(Value::as_str);
    if provider.is_none() && env.get("ANTHROPIC_BASE_URL").is_some() {
        return Err(AppIpcError::new(
            "runner_provider_required",
            "Set WEGENT_CLAUDE_PROVIDER_ID for a custom Claude provider",
        ));
    }
    let provider = provider.unwrap_or("anthropic");
    let default = settings
        .get("model")
        .or_else(|| env.get("ANTHROPIC_MODEL"))
        .and_then(Value::as_str);
    let mut ids = std::collections::BTreeSet::new();
    if let Some(id) = default {
        ids.insert(id);
    }
    for key in [
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
    ] {
        if let Some(id) = env.get(key).and_then(Value::as_str) {
            ids.insert(id);
        }
    }
    Ok(ids
        .into_iter()
        .filter(|id| !id.is_empty())
        .map(|id| {
            json!({
                "runtime": "claude_code", "provider": provider, "model_id": id,
                "local_model_id": id, "label": id, "account_label": provider,
                "is_default": default == Some(id),
            })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_catalog_exposes_only_model_metadata() {
        let models = claude_runner_models(&json!({"model": "model-a", "env": {
            "ANTHROPIC_AUTH_TOKEN": "private-token", "ANTHROPIC_DEFAULT_SONNET_MODEL": "model-b"
        }}))
        .unwrap();
        assert_eq!(models.len(), 2);
        assert!(!serde_json::to_string(&models)
            .unwrap()
            .contains("private-token"));
        assert_eq!(models[0]["is_default"], true);
    }

    #[test]
    fn custom_claude_provider_requires_stable_identity() {
        assert!(claude_runner_models(
            &json!({"env": {"ANTHROPIC_BASE_URL": "https://example.com"}})
        )
        .is_err());
    }
}
