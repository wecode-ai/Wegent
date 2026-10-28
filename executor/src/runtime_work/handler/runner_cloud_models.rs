//! Cloud models use the current user's gateway, independently of native accounts.
use super::*;

impl RuntimeWorkRpcHandler {
    pub(super) async fn materialize_runner_cloud_models(
        &self,
        payload: &mut Value,
    ) -> Result<(), AppIpcError> {
        if !has_cloud_routing(payload) {
            return Ok(());
        }
        let connection = self
            .backend_connection_snapshot()?
            .filter(|value| !value.backend_url.is_empty() && !value.auth_token.is_empty())
            .ok_or_else(|| cloud_error("Connect to the cloud before using a cloud model"))?;
        let response = crate::agents::backend_url::backend_http_client()
            .map_err(|_| cloud_error("Cannot configure the backend connection"))?
            .get(
                crate::agents::runtime_capabilities::api_url(
                    &connection.backend_url,
                    "/api/models/unified",
                )
                .map_err(|_| cloud_error("Invalid backend API URL"))?,
            )
            .query(&[
                ("scope", "all"),
                ("include_config", "false"),
                ("model_category_type", "llm"),
                ("client_origin", "wework"),
            ])
            .bearer_auth(&connection.auth_token)
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(|_| cloud_error("Cannot load the authorized cloud model catalog"))?;
        if !response.status().is_success() {
            return Err(cloud_error(
                "Cloud model access failed; check your connection and permissions",
            ));
        }
        let catalog: Value = response
            .json()
            .await
            .map_err(|_| cloud_error("Cloud model catalog response is invalid"))?;
        let models = catalog["data"]
            .as_array()
            .ok_or_else(|| cloud_error("Cloud model catalog response is invalid"))?;
        materialize_cloud_payload(
            payload,
            models,
            &connection.backend_url,
            &connection.auth_token,
        )
    }
}

fn cloud_error(message: &str) -> AppIpcError {
    AppIpcError::new("RUNNER_MODEL_UNAVAILABLE", message)
}

fn has_cloud_routing(payload: &Value) -> bool {
    payload
        .pointer("/runnerRouting/model/source")
        .and_then(Value::as_str)
        == Some("cloud")
        || payload["memberRuntimeProfiles"]
            .as_array()
            .is_some_and(|profiles| {
                profiles.iter().any(|profile| {
                    has_cloud_routing(&profile["runtimePayload"])
                        || profile["modelRuntimeProfiles"]
                            .as_array()
                            .is_some_and(|variants| {
                                variants
                                    .iter()
                                    .any(|variant| has_cloud_routing(&variant["runtimePayload"]))
                            })
                })
            })
}

fn cloud_protocol(model: &Value) -> Option<&'static str> {
    let family = model
        .pointer("/runtime/family")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    let protocol = model
        .pointer("/config/protocol")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    let api_format = model
        .pointer("/config/apiFormat")
        .or_else(|| model.pointer("/config/api_format"))
        .or_else(|| model.pointer("/config/wire_api"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    if family.ends_with(".anthropic-messages")
        || family == "claude"
        || ["claude", "anthropic-messages"].contains(&protocol.as_str())
    {
        Some("anthropic-messages")
    } else if family.ends_with(".openai-responses")
        || protocol == "openai-responses"
        || api_format == "responses"
    {
        Some("openai-responses")
    } else if family == "openai"
        || family.ends_with(".openai-chat-completions")
        || ["openai", "openai-chat-completions"].contains(&protocol.as_str())
        || api_format == "chat/completions"
    {
        Some("openai-chat-completions")
    } else {
        None
    }
}

fn materialize_cloud_payload(
    payload: &mut Value,
    models: &[Value],
    backend_url: &str,
    token: &str,
) -> Result<(), AppIpcError> {
    if payload
        .pointer("/runnerRouting/model/source")
        .and_then(Value::as_str)
        == Some("cloud")
    {
        let identity = &payload["runnerRouting"]["model"];
        let reference = &identity["cloud_model"];
        let model = models
            .iter()
            .find(|model| {
                model["name"] == reference["name"]
                    && model["type"] == reference["type"]
                    && model["namespace"] == reference["namespace"]
                    && model["resourceUserId"] == reference["resource_user_id"]
                    && model["isActive"] != false
                    && model["compatibilityDisabled"] != true
            })
            .ok_or_else(|| {
                cloud_error("The selected cloud model is unavailable or no longer authorized")
            })?;
        let protocol = cloud_protocol(model)
            .ok_or_else(|| cloud_error("The cloud model protocol is unavailable"))?;
        let claude = identity["runtime"] == "claude_code";
        let base_url = crate::agents::runtime_capabilities::api_url(
            backend_url,
            "/api/runtime-work/llm-responses-proxy",
        )
        .map_err(|_| cloud_error("Invalid backend gateway URL"))?;
        let headers = json!({
            "X-Wegent-Model-Type": reference["type"],
            "X-Wegent-Model-Namespace": reference["namespace"],
            "X-Wegent-Model-User-Id": reference["resource_user_id"].to_string(),
            "X-Wegent-Upstream-Header-wecode-executor": if claude {"claude"} else {"codex"},
            "X-Wegent-Upstream-Header-wecode-source": "wegent-local",
        });
        let mut config = json!({"model":"openai", "model_id":reference["name"], "wework_model_kind":"cloud",
            "api_format":"responses", "protocol":"openai-responses", "upstream_api_format":protocol,
            "base_url":base_url, "api_key":token, "default_headers":headers});
        if !claude {
            config.as_object_mut().expect("config is an object").extend(
                json!({
                    "codex_catalog_model_id":model.pointer("/config/codex_catalog_model_id").and_then(Value::as_str).unwrap_or("wework-gpt-5.6-sol"),
                    "codex_responses_compat_proxy":true,"tool_profile":"custom",
                    "native_tool_search":model.pointer("/config/native_tool_search").and_then(Value::as_bool).unwrap_or(protocol=="openai-responses"),
                    "native_namespace_tools":model.pointer("/config/native_namespace_tools").and_then(Value::as_bool).unwrap_or(protocol=="openai-responses"),
                    "runtime_config":{"codex":{"use_user_config":false,"configured":true}}
                }).as_object().expect("Codex config is an object").clone()
            );
        }
        if let Some(window) = model
            .get("contextWindow")
            .and_then(Value::as_u64)
            .filter(|value| *value > 0)
        {
            config["model_context_window"] = json!(window);
        }
        if let Some(tokens) = model
            .get("maxOutputTokens")
            .and_then(Value::as_u64)
            .filter(|value| *value > 0)
        {
            config["max_output_tokens"] = json!(tokens);
        }
        payload["modelConfig"] = config.clone();
        for key in ["executionRequest", "execution_request"] {
            if let Some(request) = payload.get_mut(key).filter(|value| value.is_object()) {
                request["model_config"] = config.clone();
            }
        }
    }
    if let Some(profiles) = payload
        .get_mut("memberRuntimeProfiles")
        .and_then(Value::as_array_mut)
    {
        for profile in profiles {
            if let Some(variants) = profile
                .get_mut("modelRuntimeProfiles")
                .and_then(Value::as_array_mut)
            {
                for variant in variants {
                    materialize_cloud_payload(
                        &mut variant["runtimePayload"],
                        models,
                        backend_url,
                        token,
                    )?;
                }
            }
            materialize_cloud_payload(&mut profile["runtimePayload"], models, backend_url, token)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cloud_payload(runtime: &str) -> Value {
        json!({
            "runnerRouting": {"model": {
                "runtime": runtime,
                "source": "cloud",
                "cloud_model": {"name": "shared-model", "type": "public", "namespace": "default", "resource_user_id": 0}
            }},
            "executionRequest": {"model_config": {"model_id": "old-native-model"}}
        })
    }

    fn model(protocol: &str) -> Value {
        json!({"name": "shared-model", "type": "public", "namespace": "default", "resourceUserId": 0,
            "config": {"protocol": protocol}, "contextWindow": 100_000})
    }

    #[test]
    fn cloud_gateway_uses_connection_credentials_and_stable_resource_identity() {
        let mut payload = cloud_payload("codex");
        materialize_cloud_payload(
            &mut payload,
            &[model("openai-responses")],
            "http://test-backend",
            "current-user-token",
        )
        .unwrap();
        let config = &payload["executionRequest"]["model_config"];
        assert_eq!(config["model_id"], "shared-model");
        assert_eq!(config["api_key"], "current-user-token");
        assert_eq!(config["model_context_window"], 100_000);
        assert_eq!(config["default_headers"]["X-Wegent-Model-User-Id"], "0");
        assert_eq!(config["default_headers"]["X-Wegent-Model-Type"], "public");
    }

    #[test]
    fn cloud_gateway_rejects_removed_models_and_same_name_from_another_owner() {
        let mut payload = cloud_payload("codex");
        assert!(
            materialize_cloud_payload(&mut payload, &[], "http://test-backend", "token").is_err()
        );
        let mut other_owner = model("openai-responses");
        other_owner["resourceUserId"] = json!(7);
        assert!(materialize_cloud_payload(
            &mut payload,
            &[other_owner],
            "http://test-backend",
            "token"
        )
        .is_err());
        assert_eq!(
            payload["executionRequest"]["model_config"]["model_id"],
            "old-native-model"
        );
    }

    #[test]
    fn claude_cloud_models_preserve_protocol_for_the_executor_bridge() {
        for protocol in [
            "openai-responses",
            "openai-chat-completions",
            "anthropic-messages",
        ] {
            let mut payload = cloud_payload("claude_code");
            materialize_cloud_payload(
                &mut payload,
                &[model(protocol)],
                "http://test-backend",
                "current-user-token",
            )
            .unwrap();
            let config = &payload["executionRequest"]["model_config"];
            assert_eq!(config["api_key"], "current-user-token");
            assert_eq!(
                config["base_url"],
                "http://test-backend/api/runtime-work/llm-responses-proxy"
            );
            assert_eq!(config["upstream_api_format"], protocol);
            assert_eq!(config["default_headers"]["X-Wegent-Model-User-Id"], "0");
            assert_eq!(
                config["default_headers"]["X-Wegent-Upstream-Header-wecode-executor"],
                "claude"
            );
        }
    }
}
