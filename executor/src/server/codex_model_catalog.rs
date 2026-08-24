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
    io::ErrorKind,
    path::{Path, PathBuf},
    sync::OnceLock,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;
use toml_edit::DocumentMut;

use crate::logging::log_executor_event;

pub(crate) const ROUTE: &str = "/v1/codex-router/models";
pub(crate) const PROVIDER_ID: &str = "wework-router";
#[cfg(test)]
pub(crate) const KIMI_K3_MODEL: &str = "wework-kimi-k3";
#[cfg(test)]
pub(crate) const KIMI_K27_MODEL: &str = "wework-kimi-k2-7";
#[cfg(test)]
pub(crate) const DEEPSEEK_V4_FLASH_MODEL: &str = "wework-deepseek-v4-flash";
#[cfg(test)]
pub(crate) const DEEPSEEK_V4_PRO_MODEL: &str = "wework-deepseek-v4-pro";
pub(crate) const VISION_SIDECAR_CATALOG_SUFFIX: &str = "-vision-sidecar";
#[cfg(test)]
const GPT_56_SOL_MODEL: &str = "gpt-5.6-sol";
#[cfg(test)]
const GPT_56_TERRA_MODEL: &str = "gpt-5.6-terra";
#[cfg(test)]
const GPT_56_LUNA_MODEL: &str = "gpt-5.6-luna";
#[cfg(test)]
const WEWORK_GPT_56_SOL_MODEL: &str = "wework-gpt-5.6-sol";
#[cfg(test)]
const WEWORK_GPT_56_TERRA_MODEL: &str = "wework-gpt-5.6-terra";
#[cfg(test)]
const WEWORK_GPT_56_LUNA_MODEL: &str = "wework-gpt-5.6-luna";
const UPSTREAM_CACHE_TTL: Duration = Duration::from_secs(5 * 60);
const DEFAULT_BASE_INSTRUCTIONS: &str =
    include_str!("../../../shared/assets/gptDefaultInstructions.md");
const KIMI_CODEX_MODELS: &str = include_str!("../../../shared/assets/codex-models/kimi.json");
const DEEPSEEK_CODEX_MODELS: &str =
    include_str!("../../../shared/assets/codex-models/deepseek.json");
const OPENAI_CODEX_MODELS: &str = include_str!("../../../shared/assets/codex-models/openai.json");

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
    let mut models = base_models();
    append_vision_sidecar_models(&mut models);
    models
}

fn base_models() -> Vec<Value> {
    let mut models = builtin_model_entries();
    models.extend(read_custom_models());
    models
}

pub(crate) fn vision_sidecar_catalog_model_id(base_model_id: &str) -> String {
    if base_model_id.ends_with(VISION_SIDECAR_CATALOG_SUFFIX) {
        return base_model_id.to_owned();
    }
    format!("{base_model_id}{VISION_SIDECAR_CATALOG_SUFFIX}")
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

fn builtin_model_entries() -> Vec<Value> {
    [
        ("Kimi", KIMI_CODEX_MODELS),
        ("DeepSeek", DEEPSEEK_CODEX_MODELS),
        ("OpenAI", OPENAI_CODEX_MODELS),
    ]
    .into_iter()
    .flat_map(|(group, source)| catalog_entries_from_resource(group, source))
    .collect()
}

fn catalog_entries_from_resource(group: &str, source: &str) -> Vec<Value> {
    let catalog: Value = serde_json::from_str(source)
        .unwrap_or_else(|error| panic!("{group} catalog JSON: {error}"));
    let models = catalog["models"]
        .as_array()
        .unwrap_or_else(|| panic!("{group} catalog contains a models array"));
    models
        .iter()
        .map(|model| catalog_entry_from_resource(group, model))
        .collect()
}

fn catalog_entry_from_resource(group: &str, model: &Value) -> Value {
    let source = model
        .as_object()
        .unwrap_or_else(|| panic!("{group} catalog model is an object"));
    let slug = source
        .get("slug")
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("{group} catalog model has a slug"));
    let display_name = source
        .get("display_name")
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("{group} catalog model has a display name"));
    let mut entry = model_entry(
        slug,
        display_name,
        source.get("apply_patch_tool_type").and_then(Value::as_str),
    );
    for (key, value) in source {
        if !matches!(
            key.as_str(),
            "upstream_model_id"
                | "upstream_model_ids"
                | "upstream_model_id_contains"
                | "upstream_api_formats"
        ) {
            entry[key] = value.clone();
        }
    }
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
    let document = fs::read_to_string(crate::agents::wework_codex_home().join("config.toml"))
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
    for capability_model in base_models() {
        let slug = capability_model.get("slug").and_then(Value::as_str);
        if !upstream_models
            .iter()
            .any(|model| model.get("slug").and_then(Value::as_str) == slug)
        {
            upstream_models.push(capability_model);
        }
    }
    append_vision_sidecar_models(upstream_models);
}

fn append_vision_sidecar_models(models: &mut Vec<Value>) {
    let existing_slugs = models
        .iter()
        .filter_map(|model| model.get("slug").and_then(Value::as_str))
        .map(str::to_owned)
        .collect::<std::collections::HashSet<_>>();
    let variants = models
        .iter()
        .filter_map(vision_sidecar_catalog_model)
        .filter(|model| {
            model
                .get("slug")
                .and_then(Value::as_str)
                .is_some_and(|slug| !existing_slugs.contains(slug))
        })
        .collect::<Vec<_>>();
    models.extend(variants);
}

fn vision_sidecar_catalog_model(base: &Value) -> Option<Value> {
    let slug = base.get("slug")?.as_str()?.trim();
    if slug.is_empty() || slug.ends_with(VISION_SIDECAR_CATALOG_SUFFIX) {
        return None;
    }
    let mut model = base.clone();
    let display_name = base
        .get("display_name")
        .and_then(Value::as_str)
        .unwrap_or(slug);
    let mut input_modalities = base
        .get("input_modalities")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_else(|| vec![Value::String("text".to_owned())]);
    if !input_modalities.iter().any(|modality| modality == "text") {
        input_modalities.insert(0, Value::String("text".to_owned()));
    }
    if !input_modalities.iter().any(|modality| modality == "image") {
        input_modalities.push(Value::String("image".to_owned()));
    }
    model["slug"] = Value::String(vision_sidecar_catalog_model_id(slug));
    model["display_name"] = Value::String(format!("{display_name} with vision delegation"));
    model["description"] = Value::String(format!(
        "{display_name} routed through an explicitly configured vision sidecar"
    ));
    model["visibility"] = Value::String("none".to_owned());
    model["input_modalities"] = Value::Array(input_modalities);
    Some(model)
}

fn model_entry(slug: &str, display_name: &str, apply_patch_tool_type: Option<&str>) -> Value {
    // Codex uses this capability to keep deferred App schemas out of the initial
    // request. Wire-level compatibility is handled separately by the local proxy.
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
        "supports_search_tool": true,
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
        assert_eq!(models[0]["context_window"], 1_048_576);
        assert_eq!(models[0]["auto_compact_token_limit"], 786_432);
        assert_eq!(models[0]["default_reasoning_level"], "low");
        assert_eq!(models[0]["supports_parallel_tool_calls"], false);
        assert_eq!(models[0]["supports_search_tool"], true);
        assert_eq!(models[1]["slug"], KIMI_K27_MODEL);
        assert_eq!(models[1]["context_window"], 262_144);
        assert_eq!(models[1]["supports_search_tool"], true);
    }

    #[test]
    fn catalog_includes_native_deepseek_v4_profiles() {
        let catalog = catalog();
        let model = catalog["models"]
            .as_array()
            .expect("models array")
            .iter()
            .find(|model| model["slug"] == DEEPSEEK_V4_FLASH_MODEL)
            .expect("DeepSeek V4 Flash entry");

        assert_eq!(model["context_window"], 1_048_576);
        assert_eq!(model["default_reasoning_level"], "high");
        assert_eq!(model["apply_patch_tool_type"], "freeform");
        assert_eq!(model["supports_parallel_tool_calls"], true);
        assert_eq!(model["multi_agent_version"], "v2");
        assert_eq!(model["supports_search_tool"], true);
        assert_eq!(model["visibility"], "none");
        assert_eq!(model["input_modalities"], json!(["text"]));

        let pro_model = catalog["models"]
            .as_array()
            .expect("models array")
            .iter()
            .find(|model| model["slug"] == DEEPSEEK_V4_PRO_MODEL)
            .expect("DeepSeek V4 Pro entry");
        assert_eq!(pro_model["context_window"], 1_048_576);
        assert_eq!(pro_model["default_reasoning_level"], "high");
        assert_eq!(pro_model["apply_patch_tool_type"], "freeform");
        assert_eq!(pro_model["supports_parallel_tool_calls"], true);
        assert_eq!(pro_model["multi_agent_version"], "v2");
        assert_eq!(pro_model["supports_search_tool"], true);
        assert_eq!(pro_model["visibility"], "none");
        assert_eq!(pro_model["input_modalities"], json!(["text"]));

        for base_slug in [DEEPSEEK_V4_FLASH_MODEL, DEEPSEEK_V4_PRO_MODEL] {
            let slug = vision_sidecar_catalog_model_id(base_slug);
            let vision_model = catalog["models"]
                .as_array()
                .expect("models array")
                .iter()
                .find(|model| model["slug"] == slug.as_str())
                .expect("DeepSeek vision delegation entry");
            assert_eq!(vision_model["context_window"], 1_048_576);
            assert_eq!(vision_model["default_reasoning_level"], "high");
            assert_eq!(vision_model["apply_patch_tool_type"], "freeform");
            assert_eq!(vision_model["supports_parallel_tool_calls"], true);
            assert_eq!(vision_model["multi_agent_version"], "v2");
            assert_eq!(vision_model["visibility"], "none");
            assert_eq!(vision_model["input_modalities"], json!(["text", "image"]));
        }
    }

    #[test]
    fn catalog_derives_a_vision_variant_for_every_base_profile() {
        let catalog = catalog();
        let models = catalog["models"].as_array().expect("models array");
        let base_model = models
            .iter()
            .find(|model| model["slug"] == KIMI_K27_MODEL)
            .expect("Kimi base entry");
        let vision_slug = vision_sidecar_catalog_model_id(KIMI_K27_MODEL);
        let vision_model = models
            .iter()
            .find(|model| model["slug"] == vision_slug)
            .expect("derived Kimi vision entry");

        assert_eq!(vision_model["context_window"], base_model["context_window"]);
        assert_eq!(
            vision_model["supports_parallel_tool_calls"],
            base_model["supports_parallel_tool_calls"]
        );
        assert_eq!(vision_model["input_modalities"], json!(["text", "image"]));
        assert_eq!(vision_model["visibility"], "none");
    }

    #[test]
    fn vision_derivation_preserves_arbitrary_catalog_capabilities() {
        let mut models = vec![json!({
            "slug": "operator-model",
            "display_name": "Operator Model",
            "description": "Operator-defined capabilities",
            "visibility": "list",
            "context_window": 777_777,
            "default_reasoning_level": "max",
            "supports_parallel_tool_calls": true,
            "experimental_supported_tools": ["custom_tool"],
            "input_modalities": ["text", "audio"]
        })];

        append_vision_sidecar_models(&mut models);

        let vision_model = models
            .iter()
            .find(|model| model["slug"] == "operator-model-vision-sidecar")
            .expect("derived operator vision entry");
        assert_eq!(vision_model["context_window"], 777_777);
        assert_eq!(vision_model["default_reasoning_level"], "max");
        assert_eq!(vision_model["supports_parallel_tool_calls"], true);
        assert_eq!(
            vision_model["experimental_supported_tools"],
            json!(["custom_tool"])
        );
        assert_eq!(
            vision_model["input_modalities"],
            json!(["text", "audio", "image"])
        );
        assert_eq!(vision_model["visibility"], "none");
    }

    #[test]
    fn vision_derivation_adds_text_to_an_image_only_profile() {
        let base = json!({
            "slug": "image-only-model",
            "display_name": "Image-only Model",
            "input_modalities": ["image"]
        });

        let vision_model = vision_sidecar_catalog_model(&base).expect("derived model");

        assert_eq!(vision_model["input_modalities"], json!(["text", "image"]));
    }

    #[test]
    fn merge_derives_vision_from_the_effective_upstream_base_profile() {
        let mut catalog = json!({
            "models": [{
                "slug": GPT_56_SOL_MODEL,
                "display_name": "Upstream Sol",
                "description": "Effective upstream profile",
                "context_window": 999_999,
                "supports_parallel_tool_calls": true,
                "input_modalities": ["text"]
            }]
        });

        merge_capability_models(&mut catalog);

        let vision_slug = vision_sidecar_catalog_model_id(GPT_56_SOL_MODEL);
        let vision_model = catalog["models"]
            .as_array()
            .expect("models array")
            .iter()
            .find(|model| model["slug"] == vision_slug)
            .expect("derived upstream vision entry");
        assert_eq!(
            vision_model["display_name"],
            "Upstream Sol with vision delegation"
        );
        assert_eq!(vision_model["context_window"], 999_999);
        assert_eq!(vision_model["supports_parallel_tool_calls"], true);
        assert_eq!(vision_model["input_modalities"], json!(["text", "image"]));
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
        assert_eq!(sol["supports_search_tool"], true);
        assert_eq!(sol["visibility"], "none");
    }

    #[test]
    fn catalog_lists_official_gpt_56_models_without_exposing_internal_profiles() {
        let catalog = catalog();
        let models = catalog["models"].as_array().expect("models array");

        for (slug, priority) in [
            (GPT_56_SOL_MODEL, 1),
            (GPT_56_TERRA_MODEL, 2),
            (GPT_56_LUNA_MODEL, 3),
        ] {
            let model = models
                .iter()
                .find(|model| model["slug"] == slug)
                .unwrap_or_else(|| panic!("missing official model {slug}"));
            assert_eq!(model["visibility"], "list");
            assert_eq!(model["priority"], priority);
            assert_eq!(model["supports_search_tool"], true);
        }

        for slug in [
            KIMI_K3_MODEL,
            KIMI_K27_MODEL,
            DEEPSEEK_V4_FLASH_MODEL,
            DEEPSEEK_V4_PRO_MODEL,
            WEWORK_GPT_56_SOL_MODEL,
            WEWORK_GPT_56_TERRA_MODEL,
            WEWORK_GPT_56_LUNA_MODEL,
        ] {
            let model = models
                .iter()
                .find(|model| model["slug"] == slug)
                .unwrap_or_else(|| panic!("missing internal profile {slug}"));
            assert_eq!(model["visibility"], "none");
        }
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
