use super::*;
use sha2::{Digest, Sha256};

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
                    Err(_) => errors.push("claude_catalog_invalid"),
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
    let explicit_provider = env
        .get("WEGENT_CLAUDE_PROVIDER_ID")
        .and_then(Value::as_str)
        .filter(|provider| !provider.trim().is_empty());
    let provider = match explicit_provider {
        Some(provider) => provider.to_owned(),
        None => claude_endpoint_provider(env)?,
    };
    let account_label = explicit_provider.unwrap_or(if provider == "anthropic" {
        "anthropic"
    } else {
        "Claude"
    });
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
                "local_model_id": id, "label": id, "account_label": account_label,
                "is_default": default == Some(id),
            })
        })
        .collect())
}

fn claude_endpoint_provider(env: &Value) -> Result<String, AppIpcError> {
    let Some(endpoint) = env
        .get("ANTHROPIC_BASE_URL")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|endpoint| !endpoint.is_empty())
    else {
        return Ok("anthropic".to_owned());
    };
    let invalid_endpoint =
        || AppIpcError::new("claude_catalog_invalid", "Invalid Claude service URL");
    let mut url = url::Url::parse(endpoint).map_err(|_| invalid_endpoint())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(invalid_endpoint());
    }
    let path = url.path().trim_end_matches('/').to_owned();
    url.set_path(&path);
    url.set_fragment(None);
    url.set_username("").map_err(|_| invalid_endpoint())?;
    url.set_password(None).map_err(|_| invalid_endpoint())?;
    let endpoint = url.as_str();
    if endpoint == "https://api.anthropic.com/" {
        return Ok("anthropic".to_owned());
    }
    // Keep endpoint details out of the reported model identity and account label.
    Ok(format!("claude:{:x}", Sha256::digest(endpoint.as_bytes())))
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
    fn custom_claude_catalog_does_not_require_a_provider_id() {
        let models = claude_runner_models(&json!({"model": "model-a", "env": {
            "ANTHROPIC_BASE_URL": "https://user:private-password@gateway.example/claude?token=private-query",
            "ANTHROPIC_AUTH_TOKEN": "private-token",
            "ANTHROPIC_DEFAULT_SONNET_MODEL": "model-b"
        }}))
        .unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(models[0]["runtime"], "claude_code");
        assert_eq!(models[0]["model_id"], "model-a");
        assert_eq!(models[0]["is_default"], true);
        assert_eq!(models[1]["is_default"], false);
        assert_eq!(models[0]["provider"], models[1]["provider"]);
        assert!(models[0]["provider"]
            .as_str()
            .unwrap()
            .starts_with("claude:"));
        assert_eq!(models[0]["account_label"], "Claude");
        let report = serde_json::to_string(&models).unwrap();
        for private in [
            "gateway.example",
            "private-password",
            "private-query",
            "private-token",
        ] {
            assert!(!report.contains(private));
        }
    }

    #[test]
    fn claude_provider_identity_normalizes_equivalent_endpoints() {
        let expected = claude_endpoint_provider(&json!({
            "ANTHROPIC_BASE_URL": "https://gateway.example/claude"
        }))
        .unwrap();
        for endpoint in [
            "https://GATEWAY.EXAMPLE:443/claude",
            "https://gateway.example/claude/",
            " https://gateway.example/claude#fragment ",
        ] {
            assert_eq!(
                claude_endpoint_provider(&json!({"ANTHROPIC_BASE_URL": endpoint})).unwrap(),
                expected
            );
        }
        for endpoint in [
            "http://gateway.example/claude",
            "https://other.example/claude",
            "https://gateway.example:8443/claude",
            "https://gateway.example/other",
            "https://gateway.example/Claude",
            "https://gateway.example/claude?route=other",
        ] {
            assert_ne!(
                claude_endpoint_provider(&json!({"ANTHROPIC_BASE_URL": endpoint})).unwrap(),
                expected
            );
        }
    }

    #[test]
    fn claude_provider_identity_preserves_query_path_separators() {
        let provider =
            |endpoint| claude_endpoint_provider(&json!({"ANTHROPIC_BASE_URL": endpoint})).unwrap();
        assert_ne!(
            provider("https://gateway.example/claude?route=tenant"),
            provider("https://gateway.example/claude?route=tenant/")
        );
    }

    #[test]
    fn claude_provider_identity_excludes_url_credentials() {
        let provider =
            |endpoint| claude_endpoint_provider(&json!({"ANTHROPIC_BASE_URL": endpoint})).unwrap();
        let expected = provider("https://gateway.example/claude?route=tenant");
        for endpoint in [
            "https://user:first-password@gateway.example/claude?route=tenant",
            "https://user:rotated-password@gateway.example/claude?route=tenant",
            "https://other-user@gateway.example/claude?route=tenant",
        ] {
            assert_eq!(provider(endpoint), expected);
        }
    }

    #[test]
    fn claude_official_service_keeps_its_provider_identity() {
        for env in [
            json!({}),
            json!({"ANTHROPIC_BASE_URL": ""}),
            json!({"ANTHROPIC_BASE_URL": "https://API.ANTHROPIC.COM:443/"}),
            json!({"ANTHROPIC_BASE_URL": "https://user:password@api.anthropic.com/"}),
        ] {
            let models = claude_runner_models(&json!({"model": "model-a", "env": env})).unwrap();
            assert_eq!(models[0]["provider"], "anthropic");
        }
    }

    #[test]
    fn claude_catalog_preserves_an_explicit_provider_identity() {
        let models = claude_runner_models(&json!({"model": "model-a", "env": {
            "ANTHROPIC_BASE_URL": "https://gateway.example",
            "WEGENT_CLAUDE_PROVIDER_ID": "company-gateway"
        }}))
        .unwrap();
        assert_eq!(models[0]["provider"], "company-gateway");
        assert_eq!(models[0]["account_label"], "company-gateway");
    }

    #[test]
    fn claude_catalog_derives_an_identity_for_an_empty_provider_id() {
        for provider in ["", "   "] {
            let models = claude_runner_models(&json!({"model": "model-a", "env": {
                "ANTHROPIC_BASE_URL": "https://gateway.example",
                "WEGENT_CLAUDE_PROVIDER_ID": provider
            }}))
            .unwrap();
            assert!(models[0]["provider"]
                .as_str()
                .unwrap()
                .starts_with("claude:"));
        }
    }

    #[test]
    fn claude_catalog_still_rejects_invalid_service_urls() {
        for endpoint in [
            "invalid-url",
            "file:///tmp/claude",
            "mailto:private@example.com",
        ] {
            let error = claude_runner_models(&json!({"model": "model-a", "env": {
                "ANTHROPIC_BASE_URL": endpoint
            }}))
            .unwrap_err();
            assert_eq!(error.code, "claude_catalog_invalid");
            assert!(!error.message.contains(endpoint));
        }
    }
}
