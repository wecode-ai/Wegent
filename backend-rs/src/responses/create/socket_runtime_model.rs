// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde_json::{Map, Value, json};

use super::model_config::extract_model_config;
use super::request::{BuildExecutionRequestInput, model_resolution_error};
use super::resolution;
use super::wework::models as wework_models;
use crate::{http_compat::FastApiError, state::AppState};

pub(super) async fn resolve(
    state: &AppState,
    input: &BuildExecutionRequestInput<'_>,
    options: Option<&Value>,
) -> Result<Option<Map<String, Value>>, FastApiError> {
    let labels = &input.task_json["metadata"]["labels"];
    let Some(name) = labels["modelId"].as_str().filter(|name| !name.is_empty()) else {
        return Ok(None);
    };
    if labels["forceOverrideBotModel"] != "true" || labels["forceOverrideBotModelType"] != "runtime"
    {
        return Ok(None);
    }
    resolution::check_model_override(
        &state.mysql,
        &state.entity_resolvers,
        state.redis.as_ref(),
        input.user_id,
        &input.bot.json.0["spec"],
        &input.bot.name,
        Some(name),
    )
    .await
    .map_err(model_resolution_error)?;

    let official = name == "codex-gpt-5.5";
    let mut config = Map::from_iter([
        ("model".into(), json!("openai")),
        (
            "model_id".into(),
            json!(if official { "gpt-5.5" } else { name }),
        ),
        ("api_format".into(), json!("responses")),
        ("protocol".into(), json!("openai-responses")),
    ]);
    if !official {
        match resolution::resolve_model_for_bot(
            &state.mysql,
            &state.entity_resolvers,
            state.redis.as_ref(),
            input.user_id,
            name,
        )
        .await
        {
            Ok(Some(model)) => apply_crd(&mut config, &model.json.0["spec"], name)?,
            Ok(None) => {}
            Err(error) => tracing::warn!(%error, "Codex Runtime Model lookup failed"),
        }
    }
    for (key, aliases) in [
        (
            "model_provider",
            &["codexProviderId", "codex_model_provider"][..],
        ),
        (
            "provider_name",
            &["codexProviderName", "codex_provider_name"][..],
        ),
    ] {
        if let Some(value) = options.and_then(|options| text(options, aliases)) {
            config.insert(key.into(), json!(value));
        }
    }
    let catalog = options
        .and_then(explicit_catalog_id)
        .or_else(|| config.get("codex_catalog_model_id").and_then(Value::as_str))
        .or_else(|| {
            (!official)
                .then(|| {
                    config
                        .get("model_id")
                        .and_then(Value::as_str)
                        .and_then(catalog_for_upstream)
                })
                .flatten()
        });
    if let Some(catalog) = catalog {
        config.insert("codex_catalog_model_id".into(), json!(catalog));
    }
    if config.contains_key("codex_catalog_model_id") {
        config.insert("codex_responses_compat_proxy".into(), json!(true));
    }
    Ok(Some(config))
}

fn text<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter().find_map(|key| {
        value[*key]
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
    })
}

fn apply_crd(
    config: &mut Map<String, Value>,
    spec: &Value,
    name: &str,
) -> Result<(), FastApiError> {
    let Ok(full) = extract_model_config(spec) else {
        return Ok(());
    };
    let full = Value::Object(full);
    config.insert(
        "model_id".into(),
        json!(text(&full, &["model_id"]).unwrap_or(name)),
    );
    for key in ["base_url", "api_key"] {
        config.insert(
            key.into(),
            json!(full[key].as_str().unwrap_or_default().trim()),
        );
    }
    for key in [
        "default_headers",
        "context_window",
        "max_output_tokens",
        "temperature",
        "think_config",
    ] {
        if !full[key].is_null() {
            config.insert(key.into(), full[key].clone());
        }
    }
    let env = &spec["modelConfig"]["env"];
    if let Some(id) = explicit_catalog_id(env) {
        config.insert("codex_catalog_model_id".into(), json!(id));
    }
    let upstream = match text(env, &["upstream_api_format", "upstreamApiFormat"]).or_else(|| {
        text(
            &full,
            &[
                "upstream_api_format",
                "upstreamApiFormat",
                "api_format",
                "apiFormat",
            ],
        )
    }) {
        Some("anthropic" | "claude" | "messages" | "anthropic-messages") => "anthropic-messages",
        Some("openai" | "chat/completions" | "chat_completions" | "openai-chat-completions") => {
            "openai-chat-completions"
        }
        Some("responses" | "openai-responses") => "openai-responses",
        Some(format) => format,
        None if matches!(full["model"].as_str(), Some("claude" | "anthropic"))
            || matches!(
                full["protocol"].as_str(),
                Some("claude" | "anthropic-messages")
            ) =>
        {
            "anthropic-messages"
        }
        None if full["model"] == "openai"
            || matches!(
                full["protocol"].as_str(),
                Some("openai" | "chat/completions")
            ) =>
        {
            "openai-chat-completions"
        }
        None => "openai-responses",
    };
    config.insert("upstream_api_format".into(), json!(upstream));
    if upstream == "anthropic-messages"
        && let Some(url) = text(&full, &["base_url"])
    {
        config.insert(
            "responses_url".into(),
            json!(format!("{}/v1/messages", url.trim_end_matches('/'))),
        );
    }
    config.extend(wework_models::wework_model_config_options(spec, upstream)?);
    Ok(())
}

fn explicit_catalog_id(options: &Value) -> Option<&str> {
    text(
        options,
        &[
            "weworkCloudModelCodexCatalogModelId",
            "weworkCloudModelCatalogModelId",
            "codex_catalog_model_id",
            "codexCatalogModelId",
        ],
    )
}

fn catalog_for_upstream(model: &str) -> Option<&'static str> {
    use std::sync::LazyLock;
    static CATALOG: LazyLock<Vec<Value>> = LazyLock::new(|| {
        [
            include_str!("../../../../shared/assets/codex-models/deepseek.json"),
            include_str!("../../../../shared/assets/codex-models/kimi.json"),
            include_str!("../../../../shared/assets/codex-models/openai.json"),
            include_str!("../../../../shared/assets/codex-models/wework.json"),
        ].into_iter().flat_map(|raw| {
            serde_json::from_str::<Value>(raw).expect("embedded Codex catalog is valid JSON")["models"]
                .as_array().cloned().unwrap_or_default()
        }).collect()
    });
    let model = model.trim().to_ascii_lowercase();
    if model.is_empty() {
        return None;
    }
    CATALOG.iter().find_map(|entry| {
        let matches = |value: &Value, contains: bool| {
            let compare = |value: &str| {
                let value = value.trim().to_ascii_lowercase();
                !value.is_empty()
                    && if contains {
                        model.contains(&value)
                    } else {
                        model == value
                    }
            };
            if let Some(value) = value.as_str() {
                compare(value)
            } else {
                value
                    .as_array()
                    .is_some_and(|items| items.iter().filter_map(Value::as_str).any(compare))
            }
        };
        (matches(&entry["upstream_model_id"], false)
            || matches(&entry["upstream_model_ids"], false)
            || matches(&entry["upstream_model_id_contains"], true))
        .then_some(entry["slug"].as_str())
        .flatten()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_runtime_protocol_and_explicit_anthropic_endpoint() {
        let spec = json!({"modelConfig":{"env":{
            "model": "claude", "model_id": "claude-provider", "base_url": "https://example.test/",
            "api_key": "test-key", "DEFAULT_HEADERS": {"X-Test":"value"}
        }}});
        let mut config = Map::from_iter([("protocol".into(), json!("openai-responses"))]);
        apply_crd(&mut config, &spec, "model").unwrap();
        assert_eq!(config["protocol"], "openai-responses");
        assert_eq!(config["upstream_api_format"], "anthropic-messages");
        assert_eq!(config["responses_url"], "https://example.test/v1/messages");
        assert_eq!(config["default_headers"]["X-Test"], "value");
        assert_eq!(config["model_id"], "claude-provider");
    }

    #[test]
    fn derives_catalog_only_for_known_upstream_models() {
        assert_eq!(
            catalog_for_upstream("deepseek-flash"),
            Some("wework-deepseek-v4-flash")
        );
        assert_eq!(catalog_for_upstream("my-custom-provider"), None);
    }
}
