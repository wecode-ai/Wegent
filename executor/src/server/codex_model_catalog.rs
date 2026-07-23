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
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
    sync::OnceLock,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;
use toml_edit::DocumentMut;

use crate::logging::log_executor_event;

const DEBUG_LOG_PATH: &str = "wework-apply-patch-debug";

fn debug_log(label: &str, data: Value) {
    let Some(home) = dirs::home_dir() else {
        return;
    };
    let path = home.join("Desktop").join(DEBUG_LOG_PATH);
    let line = json!({
        "ts": chrono::Utc::now().to_rfc3339(),
        "layer": "executor-catalog",
        "label": label,
        "data": data,
    })
    .to_string();
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .and_then(|mut file| writeln!(file, "{line}"));
}

pub(crate) const ROUTE: &str = "/v1/codex-router/models";
pub(crate) const PROVIDER_ID: &str = "wework-router";
pub(crate) const KIMI_K3_MODEL: &str = "wework-kimi-k3";
pub(crate) const KIMI_K27_MODEL: &str = "wework-kimi-k2-7";
const GPT_56_SOL_MODEL: &str = "gpt-5.6-sol";
const GPT_56_TERRA_MODEL: &str = "gpt-5.6-terra";
const GPT_56_LUNA_MODEL: &str = "gpt-5.6-luna";
const WEWORK_GPT_56_SOL_MODEL: &str = "wework-gpt-5.6-sol";
const WEWORK_GPT_56_TERRA_MODEL: &str = "wework-gpt-5.6-terra";
const WEWORK_GPT_56_LUNA_MODEL: &str = "wework-gpt-5.6-luna";
const UPSTREAM_CACHE_TTL: Duration = Duration::from_secs(5 * 60);
const DEFAULT_BASE_INSTRUCTIONS: &str =
    include_str!("../../../shared/assets/gptDefaultInstructions.md");

fn default_base_instructions() -> String {
    DEFAULT_BASE_INSTRUCTIONS.replace(
        "You are Codex, an agent based on GPT-5.",
        "You are Codex, a coding agent.",
    )
}

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
    let catalog = match upstream_catalog(query.client_version.as_deref()).await {
        Ok(Some(mut catalog)) => {
            merge_capability_models(&mut catalog);
            catalog
        }
        Ok(None) => catalog(),
        Err(error) => {
            log_executor_event(
                "codex router model catalog failed",
                &[("error", error.clone())],
            );
            catalog()
        }
    };
    let model_count = catalog
        .get("models")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or_default();
    let model_summaries: Vec<Value> = catalog
        .get("models")
        .and_then(Value::as_array)
        .map(|models| {
            models
                .iter()
                .map(|m| {
                    json!({
                        "id": m.get("id").and_then(Value::as_str),
                        "slug": m.get("slug").and_then(Value::as_str),
                        "apply_patch_tool_type": m.get("apply_patch_tool_type").and_then(Value::as_str),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    debug_log(
        "catalog_served",
        json!({"model_count": model_count, "models": model_summaries}),
    );
    log_executor_event(
        "codex router model catalog served",
        &[("model_count", model_count.to_string())],
    );
    Json(catalog).into_response()
}

pub(crate) fn catalog() -> Value {
    json!({
        "models": models()
    })
}

pub(crate) fn models() -> Vec<Value> {
    let mut models = vec![
        kimi_k3_model_entry(),
        kimi_k27_model_entry(),
        gpt_56_sol_model_entry(),
        gpt_56_terra_model_entry(),
        gpt_56_luna_model_entry(),
        wework_gpt_56_sol_model_entry(),
        wework_gpt_56_terra_model_entry(),
        wework_gpt_56_luna_model_entry(),
    ];
    models.extend(read_custom_models());
    models
}

pub(crate) fn write_custom_models(entries: &[Value]) -> Result<usize, String> {
    let entries = entries
        .iter()
        .cloned()
        .map(normalize_compatibility_fields)
        .collect::<Vec<_>>();
    for entry in &entries {
        validate_custom_model(entry)?;
    }
    write_custom_models_to(&custom_models_path(), &entries)?;
    Ok(entries.len())
}

pub(crate) fn custom_model_slugs() -> Vec<String> {
    read_custom_models()
        .into_iter()
        .filter_map(|entry| entry.get("slug").and_then(Value::as_str).map(str::to_owned))
        .collect()
}

pub(crate) fn invalidate_models_cache() -> Result<(), String> {
    invalidate_models_cache_at(&codex_models_cache_path())
}

fn codex_models_cache_path() -> PathBuf {
    env::var_os("WEGENT_CODEX_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            env::var_os("WEGENT_EXECUTOR_HOME")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .map(|home| home.join("codex"))
        })
        .or_else(|| dirs::home_dir().map(|home| home.join(".wegent-executor/codex")))
        .unwrap_or_else(|| PathBuf::from(".wegent-executor/codex"))
        .join("models_cache.json")
}

fn invalidate_models_cache_at(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "failed to invalidate Codex models cache at {}: {error}",
            path.display()
        )),
    }
}

fn validate_custom_model(entry: &Value) -> Result<(), String> {
    let object = entry
        .as_object()
        .ok_or_else(|| "custom model catalog entry must be an object".to_owned())?;
    let slug = object
        .get("slug")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "custom model catalog entry requires a slug".to_owned())?;
    if !slug.starts_with("wework-custom-") {
        return Err("custom model catalog slug must start with wework-custom-".to_owned());
    }
    let model = serde_json::from_value::<CodexCatalogModel>(entry.clone())
        .map_err(|error| format!("invalid custom model catalog entry: {error}"))?;
    if model.slug != slug {
        return Err("custom model catalog slug is inconsistent".to_owned());
    }
    Ok(())
}

fn custom_models_path() -> PathBuf {
    env::var_os("WEGENT_EXECUTOR_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".wegent-executor")))
        .unwrap_or_else(|| PathBuf::from(".wegent-executor"))
        .join("capabilities/model-catalog.json")
}

fn read_custom_models() -> Vec<Value> {
    let Ok(bytes) = fs::read(custom_models_path()) else {
        return Vec::new();
    };
    let Ok(entries) = serde_json::from_slice::<Vec<Value>>(&bytes) else {
        return Vec::new();
    };
    entries
        .into_iter()
        .map(normalize_compatibility_fields)
        .filter(|entry| validate_custom_model(entry).is_ok())
        .collect()
}

fn normalize_compatibility_fields(mut entry: Value) -> Value {
    let supports_reasoning_summaries = entry
        .get("supports_reasoning_summary_parameter")
        .and_then(Value::as_bool)
        .or_else(|| {
            entry
                .get("supports_reasoning_summaries")
                .and_then(Value::as_bool)
        })
        .unwrap_or(true);
    entry["supports_reasoning_summaries"] = Value::Bool(supports_reasoning_summaries);
    entry["supports_reasoning_summary_parameter"] = Value::Bool(supports_reasoning_summaries);
    entry
}

fn write_custom_models_to(path: &Path, entries: &[Value]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "custom model catalog path has no parent".to_owned())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = parent.join(format!(
        ".{}.tmp",
        path.file_name().unwrap_or_default().to_string_lossy()
    ));
    let bytes = serde_json::to_vec_pretty(entries).map_err(|error| error.to_string())?;
    fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    fs::rename(&temporary, path).map_err(|error| error.to_string())
}

#[allow(dead_code)]
#[derive(Debug, Deserialize)]
struct CodexCatalogModel {
    slug: String,
    display_name: String,
    #[serde(default)]
    supported_reasoning_levels: Vec<Value>,
    shell_type: String,
    visibility: String,
    supported_in_api: bool,
    priority: i64,
    base_instructions: String,
    supports_reasoning_summaries: bool,
    support_verbosity: bool,
    truncation_policy: Value,
    supports_parallel_tool_calls: bool,
    #[serde(default)]
    experimental_supported_tools: Vec<String>,
}

fn kimi_k3_model_entry() -> Value {
    let mut entry = model_entry(KIMI_K3_MODEL, "Kimi K3", Some("freeform"));
    entry["description"] = Value::String(
        "Kimi K3 profile for long-horizon coding, multimodal input, and deep reasoning".to_owned(),
    );
    entry["default_reasoning_level"] = Value::String("low".to_owned());
    entry["supported_reasoning_levels"] = json!([
        {"effort": "low", "description": "Fast responses with lighter reasoning"},
        {"effort": "high", "description": "Greater reasoning depth for complex work"},
        {"effort": "max", "description": "Maximum reasoning for long-horizon tasks"}
    ]);
    entry["context_window"] = Value::Number(262_144.into());
    entry["max_context_window"] = Value::Number(262_144.into());
    entry["truncation_policy"] = json!({"mode": "tokens", "limit": 10_000});
    entry
}

fn kimi_k27_model_entry() -> Value {
    let mut entry = model_entry(KIMI_K27_MODEL, "Kimi K2.7 Code", Some("freeform"));
    entry["description"] =
        Value::String("Kimi K2.7 Code profile for stable agentic coding".to_owned());
    entry["context_window"] = Value::Number(262_144.into());
    entry["max_context_window"] = Value::Number(262_144.into());
    entry
}

fn gpt_56_sol_model_entry() -> Value {
    let mut entry = model_entry(GPT_56_SOL_MODEL, "GPT 5.6 Sol", Some("freeform"));
    entry["description"] =
        Value::String("GPT 5.6 Sol profile for agentic coding".to_owned());
    entry["context_window"] = Value::Number(272_000.into());
    entry["max_context_window"] = Value::Number(272_000.into());
    entry
}

fn gpt_56_terra_model_entry() -> Value {
    let mut entry = model_entry(GPT_56_TERRA_MODEL, "GPT 5.6 Terra", Some("freeform"));
    entry["description"] =
        Value::String("GPT 5.6 Terra profile for agentic coding".to_owned());
    entry["context_window"] = Value::Number(272_000.into());
    entry["max_context_window"] = Value::Number(272_000.into());
    entry
}

fn gpt_56_luna_model_entry() -> Value {
    let mut entry = model_entry(GPT_56_LUNA_MODEL, "GPT 5.6 Luna", Some("freeform"));
    entry["description"] =
        Value::String("GPT 5.6 Luna profile for agentic coding".to_owned());
    entry["context_window"] = Value::Number(272_000.into());
    entry["max_context_window"] = Value::Number(272_000.into());
    entry
}

fn wework_gpt_56_sol_model_entry() -> Value {
    let mut entry = model_entry(WEWORK_GPT_56_SOL_MODEL, "GPT 5.6 Sol", Some("freeform"));
    entry["description"] =
        Value::String("Wework GPT 5.6 Sol compatibility profile".to_owned());
    entry["context_window"] = Value::Number(272_000.into());
    entry["max_context_window"] = Value::Number(272_000.into());
    entry
}

fn wework_gpt_56_terra_model_entry() -> Value {
    let mut entry = model_entry(WEWORK_GPT_56_TERRA_MODEL, "GPT 5.6 Terra", Some("freeform"));
    entry["description"] =
        Value::String("Wework GPT 5.6 Terra compatibility profile".to_owned());
    entry["context_window"] = Value::Number(272_000.into());
    entry["max_context_window"] = Value::Number(272_000.into());
    entry
}

fn wework_gpt_56_luna_model_entry() -> Value {
    let mut entry = model_entry(WEWORK_GPT_56_LUNA_MODEL, "GPT 5.6 Luna", Some("freeform"));
    entry["description"] =
        Value::String("Wework GPT 5.6 Luna compatibility profile".to_owned());
    entry["context_window"] = Value::Number(272_000.into());
    entry["max_context_window"] = Value::Number(272_000.into());
    entry
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
        "additional_speed_tiers": [],
        "service_tiers": [],
        "default_service_tier": null,
        "availability_nux": null,
        "upgrade": null,
        "base_instructions": default_base_instructions(),
        "model_messages": null,
        "include_skills_usage_instructions": false,
        "supports_reasoning_summaries": true,
        "supports_reasoning_summary_parameter": true,
        "default_reasoning_summary": "auto",
        "support_verbosity": false,
        "default_verbosity": null,
        "web_search_tool_type": "text",
        "truncation_policy": {"mode": "tokens", "limit": 10_000},
        "supports_parallel_tool_calls": false,
        "supports_image_detail_original": false,
        "context_window": 272_000,
        "max_context_window": 272_000,
        "auto_compact_token_limit": null,
        "comp_hash": null,
        "effective_context_window_percent": 95,
        "experimental_supported_tools": [],
        "input_modalities": ["text", "image"],
        "supports_search_tool": false,
        "use_responses_lite": false,
        "auto_review_model_override": null,
        "tool_mode": null,
        "multi_agent_version": null
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
    fn catalog_includes_verified_builtin_kimi_profiles() {
        let catalog = catalog();
        let models = catalog["models"].as_array().expect("models array");
        assert!(models.len() >= 2);
        assert_eq!(models[0]["slug"], KIMI_K3_MODEL);
        assert!(models[0]["base_instructions"]
            .as_str()
            .is_some_and(|instructions| instructions.len() > 10_000
                && !instructions.contains("based on GPT-5")));
        assert_eq!(models[0]["context_window"], 262_144);
        assert_eq!(models[0]["default_reasoning_level"], "low");
        assert_eq!(models[0]["supports_parallel_tool_calls"], false);
        assert_eq!(models[1]["slug"], KIMI_K27_MODEL);
        assert_eq!(models[1]["context_window"], 262_144);
    }

    #[test]
    fn catalog_includes_wework_gpt_56_compatibility_profiles() {
        let catalog = catalog();
        let models = catalog["models"].as_array().expect("models array");
        let slugs: Vec<&str> = models
            .iter()
            .filter_map(|model| model["slug"].as_str())
            .collect();
        assert!(slugs.contains(&WEWORK_GPT_56_SOL_MODEL));
        assert!(slugs.contains(&WEWORK_GPT_56_TERRA_MODEL));
        assert!(slugs.contains(&WEWORK_GPT_56_LUNA_MODEL));

        let sol = models
            .iter()
            .find(|model| model["slug"] == WEWORK_GPT_56_SOL_MODEL)
            .expect("wework gpt-5.6-sol entry");
        assert_eq!(sol["apply_patch_tool_type"], "freeform");
        assert_eq!(sol["supports_parallel_tool_calls"], false);
    }

    #[test]
    fn validates_complete_custom_catalog_entries_without_accepting_official_slugs() {
        let mut entry = model_entry(
            "wework-custom-registration-test",
            "Registration test",
            Some("freeform"),
        );
        entry["supports_parallel_tool_calls"] = Value::Bool(true);

        assert!(validate_custom_model(&entry).is_ok());

        entry["slug"] = Value::String("gpt-5.6-sol".to_owned());
        assert!(validate_custom_model(&entry).is_err());
    }

    #[test]
    fn normalizes_reasoning_summary_fields_for_codex_versions() {
        let mut entry = model_entry(
            "wework-custom-compatibility-test",
            "Compatibility test",
            Some("freeform"),
        );
        entry
            .as_object_mut()
            .expect("catalog entry")
            .remove("supports_reasoning_summaries");
        entry["supports_reasoning_summary_parameter"] = Value::Bool(false);

        let normalized = normalize_compatibility_fields(entry);

        assert_eq!(normalized["supports_reasoning_summaries"], false);
        assert_eq!(normalized["supports_reasoning_summary_parameter"], false);
        assert!(validate_custom_model(&normalized).is_ok());
    }

    #[test]
    fn persists_custom_catalog_entries_atomically() {
        let root = tempfile::tempdir().expect("temporary catalog directory");
        let path = root.path().join("capabilities/model-catalog.json");
        let entry = model_entry(
            "wework-custom-persistence-test",
            "Persistence test",
            Some("freeform"),
        );

        write_custom_models_to(&path, std::slice::from_ref(&entry))
            .expect("custom model catalog should be written");

        let stored: Vec<Value> = serde_json::from_slice(
            &fs::read(path).expect("custom model catalog should be readable"),
        )
        .expect("custom model catalog should contain JSON");
        assert_eq!(stored, vec![entry]);
    }

    #[test]
    fn invalidates_models_cache_and_accepts_missing_cache() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("models_cache.json");
        fs::write(&path, b"cached").expect("cache fixture");

        invalidate_models_cache_at(&path).expect("cache should be removed");
        assert!(!path.exists());
        invalidate_models_cache_at(&path).expect("missing cache should be accepted");
    }
}
