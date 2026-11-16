use super::*;
use sha2::{Digest, Sha256};

impl RuntimeWorkRpcHandler {
    pub(super) fn replace_local_runner_models(&self, payload: Value) -> Result<Value, AppIpcError> {
        let models = payload["models"]
            .as_array()
            .ok_or_else(|| AppIpcError::new("bad_request", "Local runner models are required"))?;
        let mut identities = std::collections::HashSet::new();
        for model in models {
            let id = model["model_id"].as_str().unwrap_or_default();
            let provider = model["provider"].as_str().unwrap_or_default();
            if model["runtime"] != "codex"
                || !id.starts_with("local-model:")
                || !provider.starts_with("local-")
                || model["local_model_id"] != id
                || !model["modelConfig"].is_object()
                || model["modelConfig"]["model_provider"] != provider
                || !identities.insert((id.to_owned(), provider.to_owned()))
            {
                return Err(AppIpcError::new(
                    "bad_request",
                    "Invalid local runner model identity",
                ));
            }
        }
        let mut models = models.clone();
        for model in &mut models {
            let local_model_id = model["model_id"].clone();
            let config = &mut model["modelConfig"];
            config["wework_local_model_id"] = local_model_id;
            if config["codex_catalog_model_id"].is_null() {
                config["codex_catalog_model_id"] = json!(config["model_id"]
                    .as_str()
                    .and_then(crate::server::codex_model_catalog::catalog_model_id_for_upstream)
                    .unwrap_or_else(|| "wework-gpt-6.1-sol".into()));
            }
        }
        *self
            .local_runner_models
            .lock()
            .expect("local runner models lock") = models;
        Ok(json!({"updated":true}))
    }

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
                    let mut entry = json!({
                        "runtime": "codex", "provider": provider, "model_id": id,
                        "local_model_id": id,
                        "label": model.get("displayName").and_then(Value::as_str).unwrap_or(id),
                        "account_label": model.get("providerName").and_then(Value::as_str).unwrap_or(provider),
                        "is_default": model.get("isDefault").and_then(Value::as_bool).unwrap_or(false),
                    });
                    if let Some(effort) =
                        model.get("defaultReasoningEffort").and_then(Value::as_str)
                    {
                        entry["default_reasoning_effort"] = json!(effort);
                    }
                    if let Some(efforts) = model
                        .get("supportedReasoningEfforts")
                        .and_then(Value::as_array)
                    {
                        entry["supported_reasoning_efforts"] = json!(efforts
                            .iter()
                            .filter_map(|effort| {
                                effort
                                    .as_str()
                                    .or_else(|| effort["reasoningEffort"].as_str())
                            })
                            .collect::<Vec<_>>());
                    }
                    models.push(entry);
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
        models.extend(self.public_local_runner_models());
        if models.iter().any(|model| model["runtime"] == "codex") && !runtimes.contains(&"codex") {
            runtimes.push("codex");
        }
        Ok(json!({"models": models, "runtimes": runtimes, "errors": errors}))
    }

    fn public_local_runner_models(&self) -> Vec<Value> {
        self.local_runner_models
            .lock()
            .expect("local runner models lock")
            .iter()
            .map(|model| {
                json!({"runtime":model["runtime"],"provider":model["provider"],
                "model_id":model["model_id"],"local_model_id":model["local_model_id"],
                "label":model["label"],"account_label":model["account_label"],"is_default":false})
            })
            .collect()
    }

    pub(super) fn materialize_local_runner_models(
        &self,
        payload: &mut Value,
    ) -> Result<(), AppIpcError> {
        if let Some(model) = payload.pointer("/runnerRouting/model") {
            if model["source"] != "cloud"
                && model["model_id"]
                    .as_str()
                    .is_some_and(|id| id.starts_with("local-model:"))
            {
                let config = self
                    .local_runner_models
                    .lock()
                    .expect("local runner models lock")
                    .iter()
                    .find(|candidate| {
                        ["runtime", "provider", "model_id"]
                            .iter()
                            .all(|key| candidate[*key] == model[*key])
                    })
                    .map(|candidate| candidate["modelConfig"].clone())
                    .ok_or_else(|| {
                        AppIpcError::new(
                            "RUNNER_MODEL_UNAVAILABLE",
                            "The selected local model is unavailable on this device",
                        )
                    })?;
                payload["modelConfig"] =
                    with_request_model_options(&config, &payload["modelConfig"]);
                for key in ["executionRequest", "execution_request"] {
                    if let Some(request) = payload.get_mut(key).filter(|value| value.is_object()) {
                        request["model_config"] =
                            with_request_model_options(&config, &request["model_config"]);
                    }
                }
            }
        }
        if let Some(profiles) = payload["memberRuntimeProfiles"].as_array_mut() {
            for profile in profiles {
                self.materialize_local_runner_models(&mut profile["runtimePayload"])?;
                if let Some(variants) = profile["modelRuntimeProfiles"].as_array_mut() {
                    for variant in variants {
                        self.materialize_local_runner_models(&mut variant["runtimePayload"])?;
                    }
                }
            }
        }
        Ok(())
    }

    pub(super) fn resolve_local_model_reference(
        &self,
        request: &mut ExecutionRequest,
        local_task_id: &str,
    ) -> Result<(), AppIpcError> {
        if self.resolve_submitted_interface(request, local_task_id)? {
            return Ok(());
        }
        let config = &request.model_config;
        let identity = config
            .get("wework_local_model_id")
            .unwrap_or(&config["model_id"]);
        let saved_selection = (config["wework_model_kind"] == "model-interface")
            .then(|| self.store.get_task(local_task_id))
            .flatten()
            .map(|link| link.runtime_handle["modelSelection"].clone())
            .filter(|selection| {
                selection["modelType"] == "runtime"
                    && selection["options"]["runnerModelProvider"] == config["model_provider"]
            });
        let identity = saved_selection
            .as_ref()
            .map(|selection| &selection["modelName"])
            .filter(|_| {
                !identity
                    .as_str()
                    .is_some_and(|id| id.starts_with("local-model:"))
            })
            .unwrap_or(identity);
        if !identity
            .as_str()
            .is_some_and(|id| id.starts_with("local-model:"))
        {
            if config["wework_model_kind"] == "model-interface" {
                return Err(AppIpcError::new(
                    "RUNNER_MODEL_UNAVAILABLE",
                    "The saved local model reference is missing; select the model again",
                ));
            }
            return Ok(());
        }
        let resolved = self
            .local_runner_models
            .lock()
            .expect("local runner models lock")
            .iter()
            .find(|model| {
                model["model_id"] == *identity && model["provider"] == config["model_provider"]
            })
            .map(|model| model["modelConfig"].clone())
            .ok_or_else(|| {
                AppIpcError::new(
                    "RUNNER_MODEL_UNAVAILABLE",
                    "The selected local model is unavailable on this device",
                )
            })?;
        request.model_config = with_request_model_options(&resolved, &request.model_config);
        Ok(())
    }
}

fn with_request_model_options(authoritative: &Value, requested: &Value) -> Value {
    let mut config = authoritative.clone();
    // Credentials, endpoints and model identity remain device-owned. Per-turn
    // reasoning and service tier are validated by the runtime before execution.
    for key in ["reasoning", "service_tier"] {
        if let Some(value) = requested.get(key).filter(|value| !value.is_null()) {
            config[key] = value.clone();
        }
    }
    config
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

    fn local_model(secret: &str) -> Value {
        json!({"runtime":"codex","provider":"local-company","model_id":"local-model:company",
            "local_model_id":"local-model:company","label":"Company","account_label":"Company","is_default":false,
            "modelConfig":{"model_id":"upstream","wework_model_kind":"model-interface","model_provider":"local-company","api_key":secret,
                "responses_url":"https://model.example/v1/messages","upstream_api_format":"anthropic-messages",
                "codex_catalog_model_id":"wework-custom-company","runtime_config":{"codex":{"use_user_config":false}}}})
    }

    #[test]
    fn local_interface_preserves_per_turn_reasoning_without_accepting_configuration_overrides() {
        let handler = RuntimeWorkRpcHandler::new("device", "unused");
        let mut model = local_model("current-secret");
        model["modelConfig"]["reasoning"] = json!({"effort":"medium"});
        model["modelConfig"]["service_tier"] = json!("default");
        handler
            .replace_local_runner_models(json!({"models":[model]}))
            .unwrap();
        for (effort, speed) in [("low", "fast"), ("high", "flex")] {
            let mut request = ExecutionRequest {
                model_config: json!({"model_id":"local-model:company","model_provider":"local-company",
                    "reasoning":{"effort":effort,"summary":"concise"},
                    "api_key":"untrusted-secret","responses_url":"https://untrusted.example"}),
                ..Default::default()
            };
            super::super::creation::apply_creation_options(
                &mut request,
                &json!({"modelOptions":{"speed":speed}}),
            )
            .unwrap();
            handler
                .resolve_local_model_reference(&mut request, "work")
                .unwrap();
            assert_eq!(
                request.model_config["reasoning"],
                json!({"effort":effort,"summary":"concise"})
            );
            assert_eq!(request.model_config["api_key"], "current-secret");
            assert_eq!(request.model_config["service_tier"], speed);
            assert_eq!(
                request.model_config["responses_url"],
                "https://model.example/v1/messages"
            );
            assert_eq!(request.model_config["model_id"], "upstream");
        }
    }

    #[test]
    fn local_interface_restores_selected_model_credentials_after_restart() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("work.json");
        let mut original = RuntimeWorkRpcHandler::new("device", "unused");
        original.store = RuntimeWorkStore::new(path.clone());
        original
            .replace_local_runner_models(json!({"models":[local_model("old-secret")]}))
            .unwrap();
        let mut request = ExecutionRequest {
            task_id: "background-work".into(),
            model_config: json!({"model_id":"local-model:company","model_provider":"local-company"}),
            ..Default::default()
        };
        original
            .resolve_local_model_reference(&mut request, "background-work")
            .unwrap();
        let mut link = RuntimeTaskLink::new_pending(
            "background-work".into(),
            "workspace".into(),
            "Report".into(),
        );
        store_runtime_execution_request(&mut link.runtime_handle, &request);
        link.runtime_handle["modelSelection"] = json!({"modelName":"local-model:company","modelType":"runtime","options":{"runnerModelProvider":"local-company"}});
        original.store.upsert_task(link);
        let persisted = fs::read_to_string(&path).unwrap();
        assert!(!persisted.contains("old-secret"));
        let mut restored = RuntimeWorkRpcHandler::new("device", "unused");
        restored.store = RuntimeWorkStore::new(path);
        restored
            .replace_local_runner_models(json!({"models":[local_model("rotated-secret")]}))
            .unwrap();
        let saved = restored.store.get_task("background-work").unwrap();
        let mut resumed: ExecutionRequest =
            serde_json::from_value(saved.runtime_handle["executionRequest"].clone()).unwrap();
        resumed.task_id = "background-work".into();
        restored
            .resolve_local_model_reference(&mut resumed, "background-work")
            .unwrap();
        assert_eq!(resumed.model_config["api_key"], "rotated-secret");
        assert_eq!(resumed.model_config["model_provider"], "local-company");
        assert_eq!(resumed.model_config["model_id"], "upstream");
        // Existing saved tasks identify their model through the persisted selection.
        resumed
            .model_config
            .as_object_mut()
            .unwrap()
            .remove("wework_local_model_id");
        resumed
            .model_config
            .as_object_mut()
            .unwrap()
            .remove("api_key");
        resumed.task_id.clear();
        assert_eq!(
            restored
                .resolve_local_model_reference(&mut resumed, "unrelated-work")
                .unwrap_err()
                .code,
            "RUNNER_MODEL_UNAVAILABLE"
        );
        restored
            .resolve_local_model_reference(&mut resumed, "background-work")
            .unwrap();
        assert_eq!(resumed.model_config["api_key"], "rotated-secret");
        restored
            .replace_local_runner_models(json!({"models":[]}))
            .unwrap();
        assert_eq!(
            restored
                .resolve_local_model_reference(&mut resumed, "background-work")
                .unwrap_err()
                .code,
            "RUNNER_MODEL_UNAVAILABLE"
        );
    }

    #[test]
    fn local_interface_replacement_rejects_duplicates_and_foreign_provider_without_changing_state()
    {
        let handler = RuntimeWorkRpcHandler::new("device", "unused");
        let model = local_model("private");
        handler
            .replace_local_runner_models(json!({"models":[model]}))
            .unwrap();
        assert!(handler
            .replace_local_runner_models(json!({"models":[model,model]}))
            .is_err());
        let mut wrong = model.clone();
        wrong["provider"] = json!("openai");
        assert!(handler
            .replace_local_runner_models(json!({"models":[wrong]}))
            .is_err());
        assert_eq!(handler.public_local_runner_models().len(), 1);
        let mut followup = ExecutionRequest {
            model_config: json!({"model_id":"local-model:company","model_provider":"local-other"}),
            ..Default::default()
        };
        assert_eq!(
            handler
                .resolve_local_model_reference(&mut followup, "background-work")
                .unwrap_err()
                .code,
            "RUNNER_MODEL_UNAVAILABLE"
        );
    }

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
