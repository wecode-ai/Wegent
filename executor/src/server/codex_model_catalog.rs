// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Process-wide Codex model metadata extensions used by Wework custom models.
//!
//! Codex merges remote `/models` entries into its bundled catalog by slug. These
//! entries therefore add custom-model tool profiles without replacing or
//! modifying any official model metadata.

use axum::{
    extract::Query,
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    env, fs,
    path::PathBuf,
    sync::OnceLock,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;
use toml_edit::DocumentMut;

use crate::logging::log_executor_event;

pub(crate) const ROUTE: &str = "/v1/codex-router/models";
pub(crate) const PROVIDER_ID: &str = "wework-router";
pub(crate) const APPLY_PATCH_MODEL: &str = "wework-custom-apply-patch";
pub(crate) const SHELL_MODEL: &str = "wework-custom-shell";
const UPSTREAM_CACHE_TTL: Duration = Duration::from_secs(5 * 60);

#[derive(Clone)]
struct CatalogCacheEntry {
    upstream_id: String,
    catalog: Value,
    etag: Option<String>,
    refreshed_at: Instant,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ModelsQuery {
    #[serde(rename = "client_version")]
    client_version: Option<String>,
}

pub(crate) async fn handle(Query(query): Query<ModelsQuery>) -> Response {
    match upstream_catalog(query.client_version.as_deref()).await {
        Ok(Some(mut catalog)) => {
            merge_capability_models(&mut catalog);
            Json(catalog).into_response()
        }
        Ok(None) => Json(catalog()).into_response(),
        Err(error) => {
            log_executor_event(
                "codex router model catalog failed",
                &[("error", error.clone())],
            );
            Json(catalog()).into_response()
        }
    }
}

pub(crate) fn catalog() -> Value {
    json!({
        "models": models()
    })
}

pub(crate) fn models() -> Vec<Value> {
    vec![
        model_entry(APPLY_PATCH_MODEL, "Wework custom model", Some("freeform")),
        model_entry(SHELL_MODEL, "Wework custom shell model", None),
    ]
}

async fn upstream_catalog(client_version: Option<&str>) -> Result<Option<Value>, String> {
    let Some((base_url, api_key)) = configured_catalog_upstream() else {
        return Ok(None);
    };
    let upstream_id = base_url.trim_end_matches('/').to_owned();
    let mut cache = catalog_cache().lock().await;
    if let Some(entry) = cache.as_ref().filter(|entry| {
        entry.upstream_id == upstream_id && entry.refreshed_at.elapsed() < UPSTREAM_CACHE_TTL
    }) {
        return Ok(Some(entry.catalog.clone()));
    }
    let mut request = reqwest::Client::new()
        .get(format!("{upstream_id}/models"))
        .bearer_auth(api_key);
    if let Some(client_version) = client_version {
        request = request.query(&[("client_version", client_version)]);
    }
    if let Some(etag) = cache
        .as_ref()
        .filter(|entry| entry.upstream_id == upstream_id)
        .and_then(|entry| entry.etag.as_deref())
    {
        request = request.header(reqwest::header::IF_NONE_MATCH, etag);
    }
    let response = match request.send().await {
        Ok(response) => response,
        Err(error) => {
            return stale_catalog_or_error(
                cache.as_ref(),
                &upstream_id,
                format!("upstream /models request failed: {error}"),
            );
        }
    };
    let status = response.status();
    if status == reqwest::StatusCode::NOT_MODIFIED {
        if let Some(entry) = cache
            .as_mut()
            .filter(|entry| entry.upstream_id == upstream_id)
        {
            entry.refreshed_at = Instant::now();
            return Ok(Some(entry.catalog.clone()));
        }
    }
    if !status.is_success() {
        return stale_catalog_or_error(
            cache.as_ref(),
            &upstream_id,
            format!("upstream /models returned HTTP {}", status.as_u16()),
        );
    }
    let etag = response
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let bytes = match response.bytes().await {
        Ok(bytes) => bytes,
        Err(error) => {
            return stale_catalog_or_error(
                cache.as_ref(),
                &upstream_id,
                format!("upstream /models body failed: {error}"),
            );
        }
    };
    let catalog: Value = match serde_json::from_slice(&bytes) {
        Ok(catalog) => catalog,
        Err(error) => {
            return stale_catalog_or_error(
                cache.as_ref(),
                &upstream_id,
                format!("upstream /models returned invalid JSON: {error}"),
            );
        }
    };
    *cache = Some(CatalogCacheEntry {
        upstream_id,
        catalog: catalog.clone(),
        etag,
        refreshed_at: Instant::now(),
    });
    Ok(Some(catalog))
}

fn stale_catalog_or_error(
    cache: Option<&CatalogCacheEntry>,
    upstream_id: &str,
    error: String,
) -> Result<Option<Value>, String> {
    if let Some(entry) = cache.filter(|entry| entry.upstream_id == upstream_id) {
        log_executor_event(
            "codex router using stale model catalog",
            &[("error", error)],
        );
        return Ok(Some(entry.catalog.clone()));
    }
    Err(error)
}

fn catalog_cache() -> &'static Mutex<Option<CatalogCacheEntry>> {
    static CACHE: OnceLock<Mutex<Option<CatalogCacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn configured_catalog_upstream() -> Option<(String, String)> {
    let codex_home = env::var_os("WEGENT_CODEX_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)?;
    let document = fs::read_to_string(codex_home.join("config.toml"))
        .ok()?
        .parse::<DocumentMut>()
        .ok()?;
    let provider = document.get("model_provider")?.as_str()?;
    if provider == PROVIDER_ID || provider == "wework-catalog" {
        return None;
    }
    let config = document
        .get("model_providers")?
        .get(provider)?
        .as_table_like()?;
    let base_url = config.get("base_url")?.as_str()?.trim().to_owned();
    let api_key = config
        .get("experimental_bearer_token")
        .and_then(|value| value.as_str())
        .map(str::to_owned)
        .or_else(|| {
            config
                .get("env_key")
                .and_then(|value| value.as_str())
                .and_then(|key| env::var(key).ok())
        })?;
    Some((base_url, api_key))
}

fn merge_capability_models(catalog: &mut Value) {
    let Some(upstream_models) = catalog.get_mut("models").and_then(Value::as_array_mut) else {
        *catalog = json!({ "models": models() });
        return;
    };
    for capability_model in models() {
        let slug = capability_model.get("slug").and_then(Value::as_str);
        if !upstream_models
            .iter()
            .any(|model| model.get("slug").and_then(Value::as_str) == slug)
        {
            upstream_models.push(capability_model);
        }
    }
}

fn model_entry(slug: &str, display_name: &str, apply_patch_tool_type: Option<&str>) -> Value {
    let mut entry = json!({
        "slug": slug,
        "display_name": display_name,
        "description": "Wework custom model capability profile",
        "default_reasoning_level": null,
        "supported_reasoning_levels": [],
        "shell_type": "shell_command",
        "visibility": "none",
        "supported_in_api": true,
        "priority": 10_000,
        "base_instructions": "You are Codex, a coding agent. You and the user share the same workspace and collaborate to achieve the user's goals.",
        "supports_reasoning_summaries": true,
        "default_reasoning_summary": "auto",
        "support_verbosity": false,
        "truncation_policy": {"mode": "bytes", "limit": 10_000},
        "supports_parallel_tool_calls": false,
        "supports_image_detail_original": false,
        "context_window": 272_000,
        "max_context_window": 2_000_000,
        "effective_context_window_percent": 95,
        "experimental_supported_tools": [],
        "input_modalities": ["text", "image"],
        "supports_search_tool": false
    });
    if let Some(tool_type) = apply_patch_tool_type {
        entry["apply_patch_tool_type"] = Value::String(tool_type.to_owned());
    }
    entry
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_only_adds_reserved_custom_slugs() {
        let catalog = catalog();
        let models = catalog["models"].as_array().expect("models array");
        assert_eq!(models.len(), 2);
        assert!(models.iter().all(|model| model["slug"]
            .as_str()
            .is_some_and(|slug| slug.starts_with("wework-custom-"))));
        assert_eq!(models[0]["apply_patch_tool_type"], "freeform");
        assert!(models[1].get("apply_patch_tool_type").is_none());
    }
}
