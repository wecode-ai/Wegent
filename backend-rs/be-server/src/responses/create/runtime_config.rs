// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `_apply_user_runtime_config`
//! (`app/services/chat/trigger/request_preparation.py:657-703`): the user Codex
//! runtime status the create request attaches to `model_config` so the executor
//! can route a Responses-compatible model through the caller's own `auth.json`
//! and proxy instead of the deployment's endpoint.
use serde_json::{Map, Value};

use super::model_config::python_str;

/// `CODEX_RUNTIME`: the only runtime `RUNTIME_AUTH_FILES` declares, and the key
/// `_apply_user_runtime_config` writes.
pub(crate) const CODEX_RUNTIME: &str = "codex";

/// `_is_codex_model_config`: the model's config declares the OpenAI Responses
/// wire shape, through any of the three fields the source accepts.
///
/// The source compares `str(value or "").lower()` against fixed ASCII tokens,
/// so a falsy or non-scalar value reads as `""` and never matches; the lower
/// case of `python_str` is the same comparison for every representable value.
pub(crate) fn is_codex_model_config(model_config: &Map<String, Value>) -> bool {
    let field = |key: &str| {
        model_config
            .get(key)
            .filter(|value| brz_json::adapters::python_truthy(value))
            .map(python_str)
            .unwrap_or_default()
            .to_lowercase()
    };
    field("model") == "openai"
        && (field("api_format") == "responses"
            || field("protocol") == "openai-responses"
            || field("wire_api") == "responses")
}

/// `_model_has_explicit_provider_credentials`: the config already carries its
/// own endpoint, so the user's personal auth must not shadow it.
fn has_explicit_provider_credentials(model_config: &Map<String, Value>) -> bool {
    let field = |key: &str| {
        model_config
            .get(key)
            .filter(|value| brz_json::adapters::python_truthy(value))
            .map(python_str)
            .unwrap_or_default()
    };
    !field("base_url").trim().is_empty() && !field("api_key").trim().is_empty()
}

/// `_apply_user_runtime_config` (`request_preparation.py:655-703`): attach the
/// user's runtime status so the executor can route a Responses-compatible
/// model through the caller's own `auth.json` and proxy.
///
/// The source swallows only `UserRuntimeConfigError` (an unsupported runtime,
/// unreachable for the constant below) and propagates every dependency or
/// decryption failure, which the returned result does as well.
pub(crate) async fn apply_user_runtime_config(
    state: &crate::state::AppState,
    model_config: &mut Value,
    user_id: i64,
    user_preferences: Option<&str>,
) -> Result<(), crate::http_compat::FastApiError> {
    let Some(config) = model_config.as_object() else {
        return Ok(());
    };
    if !is_codex_model_config(config) {
        return Ok(());
    }
    let status = crate::users_runtime_configs::get_execution_config(
        &state.mysql,
        user_id,
        user_preferences.unwrap_or(""),
        CODEX_RUNTIME,
    )
    .await?;
    attach_runtime_config(model_config, &status);
    Ok(())
}

/// The in-place half of `_apply_user_runtime_config`: one `codex` entry with the
/// six fields the source emits, plus the `proxy.url` the executor forwards.
fn attach_runtime_config(
    model_config: &mut Value,
    status: &crate::users_runtime_configs::ExecutionRuntimeConfig,
) {
    let Some(config) = model_config.as_object_mut() else {
        return;
    };
    // "If the selected model already carries explicit endpoint credentials
    // (base_url + api_key), keep the user's Codex auth.json synced to the
    // device for convenience but do not override the request."
    let prefer_user_config = status.use_user_config && !has_explicit_provider_credentials(config);
    // `dict(request.model_config.get("runtime_config") or {})`: an existing
    // document is updated in place, so another runtime's entry survives.
    let mut runtime_config = config
        .get("runtime_config")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    runtime_config.insert(
        CODEX_RUNTIME.to_string(),
        serde_json::json!({
            "use_user_config": prefer_user_config,
            "configured": status.configured,
            "target_path": status.target_path,
            "auth_json_sha256": status.auth_json_sha256,
            "use_proxy": status.use_proxy,
            "proxy_configured": status.proxy_configured,
        }),
    );
    if let Some(proxy_url) = status.proxy_url.as_ref() {
        let mut proxy = config
            .get("proxy")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        proxy.insert("url".to_string(), Value::String(proxy_url.clone()));
        config.insert("proxy".to_string(), Value::Object(proxy));
    }
    config.insert("runtime_config".to_string(), Value::Object(runtime_config));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::users_runtime_configs::ExecutionRuntimeConfig;
    use serde_json::json;

    /// `_is_codex_model_config`: `model == "openai"` plus any one of the three
    /// wire-shape fields. The recorded case sets all three.
    #[test]
    fn codex_model_detection_follows_the_source_predicate() {
        let detect = |config: Value| is_codex_model_config(config.as_object().expect("object"));
        assert!(detect(
            json!({"model": "openai", "api_format": "responses"})
        ));
        assert!(detect(
            json!({"model": "openai", "protocol": "openai-responses"})
        ));
        assert!(detect(json!({"model": "openai", "wire_api": "responses"})));
        assert!(detect(
            json!({"model": "OpenAI", "api_format": "Responses"})
        ));
        assert!(detect(json!({
            "model": "openai",
            "api_format": "responses",
            "protocol": "openai-responses",
        })));
        // The other provider/model shapes stay untouched.
        assert!(!detect(
            json!({"model": "anthropic", "api_format": "responses"})
        ));
        assert!(!detect(json!({"model": "openai", "api_format": "chat"})));
        assert!(!detect(json!({"model": "openai"})));
        assert!(!detect(json!({})));
        // A falsy value reads as `""`, exactly like `str(value or "")`.
        assert!(!detect(json!({"model": "openai", "api_format": null})));
        assert!(!detect(json!({"model": "openai", "api_format": false})));
        assert!(!detect(json!({"model": "openai", "api_format": []})));
    }

    #[test]
    fn explicit_provider_credentials_require_both_values() {
        let credentials =
            |config: Value| has_explicit_provider_credentials(config.as_object().expect("object"));
        assert!(credentials(json!({
            "base_url": "https://copilot.example.com/v1",
            "api_key": "sk-value",
        })));
        assert!(!credentials(
            json!({"base_url": "https://copilot.example.com/v1"})
        ));
        assert!(!credentials(json!({"api_key": "sk-value"})));
        assert!(!credentials(
            json!({"base_url": "   ", "api_key": "sk-value"})
        ));
        assert!(!credentials(json!({"base_url": "  ", "api_key": "  "})));
        assert!(!credentials(
            json!({"base_url": null, "api_key": "sk-value"})
        ));
    }

    fn status(use_user_config: bool, use_proxy: bool) -> ExecutionRuntimeConfig {
        ExecutionRuntimeConfig {
            use_user_config,
            configured: false,
            target_path: "auth.json".to_string(),
            auth_json_sha256: None,
            use_proxy,
            proxy_configured: use_proxy,
            proxy_url: use_proxy.then(|| "http://proxy.example.invalid:8080".to_string()),
        }
    }

    /// `_apply_user_runtime_config`'s emitted object: exactly six fields under
    /// the `codex` key, plus `proxy.url` only when a proxy URL was decrypted.
    #[test]
    fn the_runtime_config_entry_has_the_source_shape() {
        let mut model_config = json!({
            "model": "openai",
            "api_format": "responses",
            "base_url": "https://copilot.example.com/v1",
            "api_key": "sk-value",
        });
        attach_runtime_config(&mut model_config, &status(false, false));
        assert_eq!(
            model_config["runtime_config"],
            json!({"codex": {
                "use_user_config": false,
                "configured": false,
                "target_path": "auth.json",
                "auth_json_sha256": null,
                "use_proxy": false,
                "proxy_configured": false,
            }})
        );
        assert_eq!(
            model_config["runtime_config"]["codex"]
                .as_object()
                .expect("entry")
                .len(),
            6
        );
        assert!(model_config.get("proxy").is_none());

        let mut proxied = json!({"model": "openai", "api_format": "responses", "api_key": "sk"});
        attach_runtime_config(&mut proxied, &status(true, true));
        assert_eq!(
            proxied["runtime_config"]["codex"]["use_user_config"],
            json!(true)
        );
        assert_eq!(proxied["runtime_config"]["codex"]["use_proxy"], json!(true));
        assert_eq!(
            proxied["proxy"],
            json!({"url": "http://proxy.example.invalid:8080"})
        );
    }

    /// Explicit endpoint credentials shadow the user's personal auth, but the
    /// executor still learns the proxy it must forward.
    #[test]
    fn explicit_credentials_disable_the_user_runtime_override() {
        let mut model_config = json!({
            "model": "openai",
            "protocol": "openai-responses",
            "base_url": "https://copilot.example.com/v1",
            "api_key": "sk-value",
        });
        attach_runtime_config(&mut model_config, &status(true, true));
        assert_eq!(
            model_config["runtime_config"]["codex"]["use_user_config"],
            json!(false)
        );
        assert_eq!(
            model_config["proxy"],
            json!({"url": "http://proxy.example.invalid:8080"})
        );

        let mut without_credentials = json!({"model": "openai", "wire_api": "responses"});
        attach_runtime_config(&mut without_credentials, &status(true, false));
        assert_eq!(
            without_credentials["runtime_config"]["codex"]["use_user_config"],
            json!(true)
        );
    }

    /// An existing `runtime_config` document is updated in place, so another
    /// runtime's entry and an existing proxy document survive.
    #[test]
    fn an_existing_runtime_config_document_is_updated_in_place() {
        let mut model_config = json!({
            "model": "openai",
            "api_format": "responses",
            "runtime_config": {"claude": {"use_user_config": true}},
            "proxy": {"no_proxy": "internal"},
        });
        attach_runtime_config(&mut model_config, &status(false, true));
        assert_eq!(
            model_config["runtime_config"]["claude"],
            json!({"use_user_config": true})
        );
        assert_eq!(
            model_config["runtime_config"]["codex"]["target_path"],
            json!("auth.json")
        );
        assert_eq!(
            model_config["proxy"],
            json!({
                "no_proxy": "internal",
                "url": "http://proxy.example.invalid:8080",
            })
        );
    }
}
