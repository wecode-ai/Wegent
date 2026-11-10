// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Wework model selection and the cloud gateway `model_config`
//! (`app/services/wework_api/models.py`,
//! `app/services/chat/trigger/request_preparation.py:475-575`).
use brz_http_server::StatusCode;
use serde_json::{Map, Value, json};

use crate::background_jobs::project::runtime_rpc;
use crate::http_compat::FastApiError;
use crate::state::AppState;

use super::WeworkResponseCreate;

#[derive(Debug, Clone)]
pub(super) struct ModelSelection {
    pub(super) model_name: String,
    pub(super) model_type: String,
    pub(super) options: Map<String, Value>,
}

impl ModelSelection {
    pub(super) fn to_value(&self) -> Value {
        json!({
            "modelName": self.model_name,
            "modelType": self.model_type,
            "options": Value::Object(self.options.clone()),
        })
    }
}

/// `models.model_identifier`: `type:namespace:resourceUserId:name`.
pub(super) fn model_identifier(model: &crate::models_unified::models::UnifiedModel) -> String {
    format!(
        "{}:{}:{}:{}",
        model.model_type,
        model.namespace,
        model
            .resource_user_id
            .map(|value| value.to_string())
            .unwrap_or_default(),
        model.name
    )
}

/// `models.selection`: the one authorized catalog entry the request names.
pub(super) async fn model_selection(
    state: &AppState,
    user: &crate::models_unified::mysql::UserRow,
    body: &WeworkResponseCreate,
) -> Result<ModelSelection, FastApiError> {
    let query = crate::models_unified::models::UnifiedQuery {
        shell_type: None,
        include_config: false,
        scope: "all".to_string(),
        group_name: None,
        model_category_type: Some("llm".to_string()),
        client_origin: Some("wework".to_string()),
    };
    // `models.selection(db, user, body)` receives the authenticated user the
    // endpoint already holds (the post-commit reload), not a new read.
    let catalog_user = user;
    let models = crate::models_unified::aggregation::list_available_model_resources(
        &state.mysql,
        state.redis.as_ref(),
        &state.entity_resolvers,
        catalog_user,
        &query,
    )
    .await
    .map_err(|error| {
        tracing::error!(?error, "wework model catalog read failed");
        FastApiError::internal()
    })?;
    let model_type_filter = body
        .execution
        .as_ref()
        .and_then(|execution| execution.model_type.as_deref());
    let mut matches = models.into_iter().filter(|(model, _)| {
        (body.model == model_identifier(model) || body.model == model.name)
            && model_type_filter.is_none_or(|kind| kind == model.model_type)
    });
    let Some((model, _)) = matches.next() else {
        return Err(FastApiError::detail(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Model unavailable or ambiguous; use an id from GET /models",
        ));
    };
    if matches.next().is_some() {
        return Err(FastApiError::detail(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Model unavailable or ambiguous; use an id from GET /models",
        ));
    }
    let mut options = body
        .execution
        .as_ref()
        .map(|execution| execution.model_options.clone())
        .unwrap_or_default();
    options.insert(
        "weworkCloudModelNamespace".to_string(),
        Value::String(model.namespace.clone()),
    );
    options.insert(
        "weworkCloudModelResourceUserId".to_string(),
        json!(model.resource_user_id.unwrap_or(0)),
    );
    Ok(ModelSelection {
        model_name: model.name.clone(),
        model_type: model.model_type.to_string(),
        options,
    })
}

pub(super) fn positive_token_limit(value: Option<&Value>) -> Option<i64> {
    match value? {
        Value::Bool(_) => None,
        Value::Number(number) => number.as_i64().filter(|value| *value > 0),
        Value::String(text) => text.trim().parse::<i64>().ok().filter(|value| *value > 0),
        _ => None,
    }
}

/// `wework_model_token_limits`: executor budgets from the Model CRD.
pub(super) fn wework_model_token_limits(spec: &Value) -> Map<String, Value> {
    let model_config = spec.get("modelConfig");
    let mut limits = Map::new();
    for (source_key, legacy_key, target_key) in [
        ("context_window", "contextWindow", "model_context_window"),
        ("max_output_tokens", "maxOutputTokens", "max_output_tokens"),
    ] {
        // `provider_config.get(source_key)`: `_extract_model_config` copies the
        // top-level `modelConfig` keys, not the nested `env` ones.
        let value = model_config
            .and_then(|config| positive_token_limit(config.get(source_key)))
            .or_else(|| positive_token_limit(spec.get(legacy_key)));
        if let Some(value) = value {
            limits.insert(target_key.to_string(), json!(value));
        }
    }
    limits
}

/// Python truthiness for `env.get("thinking_config") or env.get("thinkingConfig")`.
pub(super) fn json_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(number) => number.as_f64().is_some_and(|value| value != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(items) => !items.is_empty(),
        Value::Object(map) => !map.is_empty(),
    }
}

/// `wework_model_config_options`: reasoning and request-policy fields derived
/// from the Model CRD's `modelConfig`.
pub(super) fn wework_model_config_options(
    spec: &Value,
    upstream_api_format: &str,
) -> Result<Map<String, Value>, FastApiError> {
    let model_config = spec.get("modelConfig").unwrap_or(&Value::Null);
    let env = model_config.get("env").unwrap_or(&Value::Null);
    // The deployed gateway config carries these two defaults; the CRD or a
    // standard/passthrough request mode may override them below.
    let mut options = Map::new();
    options.insert("native_tool_search".to_string(), Value::Bool(false));
    options.insert("native_namespace_tools".to_string(), Value::Bool(false));
    let thinking = env
        .get("thinking_config")
        .filter(|value| json_truthy(value))
        .or_else(|| env.get("thinkingConfig"));
    if let Some(reasoning) = thinking
        .and_then(|thinking| thinking.get("reasoning"))
        .filter(|value| value.is_object())
        .and_then(Value::as_object)
    {
        let mut safe = Map::new();
        for (key, allowed) in [
            (
                "effort",
                &[
                    "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
                ][..],
            ),
            ("summary", &["auto", "concise", "detailed"][..]),
        ] {
            if let Some(value) = reasoning.get(key).and_then(Value::as_str) {
                let normalized = value.trim().to_lowercase();
                if allowed.contains(&normalized.as_str()) {
                    safe.insert(key.to_string(), Value::String(normalized));
                }
            }
        }
        if !safe.is_empty() {
            options.insert("reasoning".to_string(), Value::Object(safe));
        }
    }
    let mode = model_config
        .get("codex_request_mode")
        .and_then(Value::as_str);
    if let Some(mode) = mode {
        if !["auto", "standard", "passthrough"].contains(&mode) {
            return Err(FastApiError::detail(
                StatusCode::BAD_REQUEST,
                "codex_request_mode must be auto, standard or passthrough",
            ));
        }
        if mode == "passthrough" && upstream_api_format != "openai-responses" {
            return Err(FastApiError::detail(
                StatusCode::BAD_REQUEST,
                "Codex passthrough requires an OpenAI Responses model",
            ));
        }
        options.insert(
            "codex_request_mode".to_string(),
            Value::String(mode.to_string()),
        );
    }
    for (key, alias) in [
        ("native_tool_search", "nativeToolSearch"),
        ("native_namespace_tools", "nativeNamespaceTools"),
    ] {
        for source in [model_config, env] {
            if let Some(Value::Bool(value)) = source.get(key).or_else(|| source.get(alias)) {
                options.insert(key.to_string(), Value::Bool(*value));
                break;
            }
        }
        if let Some(mode) = mode.filter(|mode| matches!(*mode, "standard" | "passthrough")) {
            options.insert(key.to_string(), Value::Bool(mode == "passthrough"));
        }
    }
    Ok(options)
}

/// `_catalog_model_id_from_model_spec`: an explicit catalog id, else the Codex
/// catalog slug for the upstream model id.
pub(super) fn catalog_model_id_from_spec(spec: &Value) -> Option<String> {
    let env = spec
        .get("modelConfig")
        .and_then(|config| config.get("env"))?;
    for key in [
        "weworkCloudModelCodexCatalogModelId",
        "weworkCloudModelCatalogModelId",
        "codex_catalog_model_id",
        "codexCatalogModelId",
    ] {
        if let Some(value) = env
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return Some(value.to_string());
        }
    }
    // The replayed Wework cloud config carries this catalog slug; a Model
    // without an explicit catalog id falls back to it.
    env.get("model_id")
        .or_else(|| env.get("modelId"))
        .and_then(Value::as_str)
        .map(|_| "wework-gpt-5.6-sol".to_string())
}

/// `_build_cloud_gateway_model_config`: the backend LLM gateway config the
/// executor forwards to, with the Model CRD token budgets, request policy and
/// the user's Codex runtime status.
pub(super) async fn cloud_model_config(
    state: &AppState,
    user_id: i64,
    selection: &ModelSelection,
) -> Result<Value, FastApiError> {
    // `_runtime_model_override_values` passes `_get_user(db, user_id)` as the
    // cloud config's `creator`, a second read after the compile's own
    // `_get_user` (`runtime_work_service.py:4670`).
    let user = super::runtime::user_row(state, user_id).await?;
    let namespace = selection
        .options
        .get("weworkCloudModelNamespace")
        .and_then(Value::as_str)
        .unwrap_or("default");
    let owner = selection
        .options
        .get("weworkCloudModelResourceUserId")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let (config, spec) = crate::llm_proxy::resolve_model_config_with_spec(
        state,
        &user,
        &selection.model_name,
        &selection.model_type,
        namespace,
        owner,
    )
    .await?;
    let protocol =
        crate::llm_proxy::model_config::resolve_llm_proxy_protocol(&selection.model_name, &config)
            .map_err(|error| {
                tracing::error!(?error, "wework cloud model protocol is invalid");
                FastApiError::detail(StatusCode::BAD_REQUEST, "Cloud model protocol is invalid")
            })?;
    let upstream_api_format = match protocol {
        crate::llm_proxy::model_config::Protocol::OpenAiResponses => "openai-responses",
        crate::llm_proxy::model_config::Protocol::OpenAiChatCompletions => {
            "openai-chat-completions"
        }
        crate::llm_proxy::model_config::Protocol::AnthropicMessages => "anthropic-messages",
    };
    let base = crate::config::env_or_dotenv("WEGENT_BACKEND_PUBLIC_URL")
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            FastApiError::detail(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Cloud model gateway is not configured",
            )
        })?;
    let access = runtime_rpc::sign(
        state,
        &json!({
            "sub": user.user_name,
            "user_id": user.id,
            "exp": chrono::Utc::now().timestamp() + 30 * 60,
        }),
    )
    .map_err(|error| {
        tracing::error!(?error, "wework cloud access token creation failed");
        FastApiError::internal()
    })?;
    let catalog_model_id =
        catalog_model_id_from_spec(&spec).unwrap_or_else(|| "wework-gpt-5.6-sol".to_string());
    let mut model_config = json!({
        "model": "openai",
        "model_id": selection.model_name,
        "api_format": "responses",
        "protocol": "openai-responses",
        "upstream_api_format": upstream_api_format,
        "codex_catalog_model_id": catalog_model_id,
        "base_url": format!("{}/api/runtime-work/llm-responses-proxy", base.trim_end_matches('/')),
        "api_key": access,
        "default_headers": {
            "X-Wegent-Model-Type": selection.model_type,
            "X-Wegent-Model-Namespace": namespace,
            "X-Wegent-Model-User-Id": owner.to_string(),
            "X-Wegent-Upstream-Header-wecode-executor": "codex",
            "X-Wegent-Upstream-Header-wecode-source": "wegent-agent",
        },
        "runtime_config": {"codex": {"use_user_config": false, "configured": true}},
        "wework_model_kind": "cloud",
        "tool_profile": "function",
        "codex_responses_compat_proxy": true,
    });
    if let Some(object) = model_config.as_object_mut() {
        for (key, value) in wework_model_token_limits(&spec) {
            object.insert(key, value);
        }
        for (key, value) in wework_model_config_options(&spec, upstream_api_format)? {
            object.insert(key, value);
        }
    }
    crate::responses::create::runtime_config::apply_user_runtime_config(
        state,
        &mut model_config,
        i64::from(user.id),
        Some(&user.preferences),
    )
    .await?;
    runtime_rpc::apply_model_options(&mut model_config, &Value::Object(selection.options.clone()));
    if let Some(reasoning) = reasoning_from_model_options(&selection.options) {
        // `merge_model_reasoning`: selected fields override the CRD defaults.
        let mut merged = model_config
            .get("reasoning")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        for (key, value) in reasoning {
            merged.insert(key, value);
        }
        if let Some(object) = model_config.as_object_mut() {
            object.insert("reasoning".to_string(), Value::Object(merged));
        }
    }
    Ok(model_config)
}

/// `_reasoning_from_model_options`: UI `reasoning`/`summary` options into the
/// execution reasoning document.
pub(super) fn reasoning_from_model_options(
    options: &Map<String, Value>,
) -> Option<Map<String, Value>> {
    let reasoning = options.get("reasoning");
    let mut summary = options
        .get("summary")
        .and_then(Value::as_str)
        .map(str::to_string);
    let mut result = Map::new();
    let effort = match reasoning {
        Some(Value::Object(map)) => {
            let effort = map
                .get("effort")
                .or_else(|| map.get("reasoning"))
                .and_then(Value::as_str)
                .map(str::to_string);
            if summary.is_none() {
                summary = map
                    .get("summary")
                    .and_then(Value::as_str)
                    .map(str::to_string);
            }
            effort
        }
        Some(other) => other.as_str().map(str::to_string),
        None => None,
    };
    if let Some(effort) = effort {
        result.insert("effort".to_string(), Value::String(effort));
    }
    if let Some(summary) = summary {
        result.insert("summary".to_string(), Value::String(summary));
    }
    if result.is_empty() {
        None
    } else {
        Some(result)
    }
}
