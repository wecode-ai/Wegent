// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Unified model aggregation, ported from
//! `app/services/model_aggregation_service.py` and
//! `app/services/adapters/public_model.py`.
use brz_json::raw_json;
use serde_json::{Map as JsonMap, Value as Json};

pub const MODEL_TYPE_USER: &str = "user";
pub const MODEL_TYPE_GROUP: &str = "group";
pub const MODEL_TYPE_PUBLIC: &str = "public";

const ROLE_HIERARCHY: [(&str, u8); 5] = [
    ("Owner", 0),
    ("Maintainer", 1),
    ("Developer", 2),
    ("Reporter", 3),
    ("RestrictedAnalyst", 4),
];

pub fn role_level(role: &str) -> Option<u8> {
    ROLE_HIERARCHY
        .iter()
        .find(|(name, _)| *name == role)
        .map(|(_, level)| *level)
}

pub fn highest_role(roles: &[String]) -> Option<String> {
    roles
        .iter()
        .filter_map(|role| role_level(role).map(|level| (role, level)))
        .min_by_key(|(_, level)| *level)
        .map(|(role, _)| role.clone())
}

/// Query parameters of `GET /api/models/unified`.
#[derive(Debug, Default, Clone)]
pub struct UnifiedQuery {
    pub shell_type: Option<String>,
    pub include_config: bool,
    pub scope: String,
    pub group_name: Option<String>,
    pub model_category_type: Option<String>,
    pub client_origin: Option<String>,
}

/// One aggregated model entry, mirroring `UnifiedModel`.
pub struct UnifiedModel {
    pub name: String,
    pub model_type: &'static str,
    pub display_name: Option<String>,
    pub provider: Option<String>,
    pub model_id: Option<String>,
    pub config: JsonMap<String, Json>,
    pub is_active: bool,
    pub namespace: String,
    pub model_category_type: String,
    pub is_advanced: bool,
    pub model_group: Option<String>,
    pub model_sub_group: Option<String>,
    pub context_window: Option<i64>,
    pub max_output_tokens: Option<i64>,
    pub cost_index: Option<String>,
    pub capability: Option<String>,
    pub model_capabilities: Option<brz_json::OpaqueJson>,
    pub resource_id: Option<i64>,
    pub resource_user_id: Option<i64>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub is_reference: bool,
}

impl UnifiedModel {
    fn runtime_family(&self) -> Option<String> {
        let provider = self.provider.as_deref()?.trim().to_lowercase();
        if provider.is_empty() {
            return None;
        }
        let protocol = self
            .config
            .get("protocol")
            .and_then(Json::as_str)
            .map(str::trim)
            .map(str::to_lowercase)
            .filter(|value| !value.is_empty());
        match protocol {
            Some(protocol) => Some(format!("{provider}.{protocol}")),
            None => Some(provider),
        }
    }

    /// Consume the model into the API projection. Optional response fields
    /// remain explicit null except the two fields historically omitted.
    pub fn into_response(self, include_config: bool) -> UnifiedModelResponse {
        let runtime = ModelRuntimeResponse {
            family: self.runtime_family(),
            provider: self.provider.clone(),
        };
        let mut safe_config = self.config;
        safe_config.remove("env");
        safe_config.remove("modelCapabilities");
        if let Some(capabilities) = &self.model_capabilities {
            safe_config.insert(
                "modelCapabilities".into(),
                serde_json::to_value(capabilities).expect("capabilities serialize"),
            );
        }
        UnifiedModelResponse {
            name: self.name,
            model_type: self.model_type,
            display_name: self.display_name,
            provider: self.provider,
            model_id: self.model_id,
            namespace: self.namespace,
            model_category_type: self.model_category_type,
            is_advanced: self.is_advanced,
            model_group: self.model_group,
            model_sub_group: self.model_sub_group,
            context_window: self.context_window,
            max_output_tokens: self.max_output_tokens,
            cost_index: self.cost_index,
            capability: self.capability,
            model_capabilities: self
                .model_capabilities
                .as_ref()
                .map(|value| brz_json::to_raw_value(value).expect("capabilities serialize")),
            runtime,
            config: raw_json(&serde_json::Value::Object(safe_config)),
            created_at: self.created_at,
            updated_at: self.updated_at,
            is_reference: self.is_reference,
            listing_id: if self.is_reference {
                self.resource_id
            } else {
                None
            },
            resource_user_id: self.resource_user_id,
            is_active: include_config.then_some(self.is_active),
        }
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedModelResponse {
    name: String,
    #[serde(rename = "type")]
    model_type: &'static str,
    display_name: Option<String>,
    provider: Option<String>,
    model_id: Option<String>,
    namespace: String,
    model_category_type: String,
    is_advanced: bool,
    model_group: Option<String>,
    model_sub_group: Option<String>,
    context_window: Option<i64>,
    max_output_tokens: Option<i64>,
    cost_index: Option<String>,
    capability: Option<String>,
    model_capabilities: Option<brz_json::RawJson>,
    runtime: ModelRuntimeResponse,
    config: brz_json::RawJson,
    #[serde(rename = "created_at")]
    created_at: Option<String>,
    #[serde(rename = "updated_at")]
    updated_at: Option<String>,
    is_reference: bool,
    listing_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    resource_user_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    is_active: Option<bool>,
}

#[derive(serde::Serialize)]
struct ModelRuntimeResponse {
    family: Option<String>,
    provider: Option<String>,
}

/// Extracted model info, mirroring `_extract_model_info_from_crd`.
pub struct ModelInfo {
    pub provider: Option<String>,
    pub model_id: Option<String>,
    pub display_name: Option<String>,
    pub config: JsonMap<String, Json>,
    pub model_category_type: String,
    pub is_advanced: bool,
    pub is_wework_available: bool,
    pub model_group: Option<String>,
    pub model_sub_group: Option<String>,
    pub context_window: Option<i64>,
    pub max_output_tokens: Option<i64>,
    pub cost_index: Option<String>,
    pub capability: Option<String>,
    pub model_capabilities: Option<ModelCapabilities>,
}

fn default_info() -> ModelInfo {
    ModelInfo {
        provider: None,
        model_id: None,
        display_name: None,
        config: JsonMap::new(),
        model_category_type: "llm".to_string(),
        is_advanced: false,
        is_wework_available: false,
        model_group: None,
        model_sub_group: None,
        context_window: None,
        max_output_tokens: None,
        cost_index: None,
        capability: None,
        model_capabilities: None,
    }
}

fn str_field(map: &JsonMap<String, Json>, key: &str) -> Option<String> {
    map.get(key).and_then(Json::as_str).map(ToOwned::to_owned)
}

fn bool_field(map: &JsonMap<String, Json>, key: &str) -> Option<bool> {
    map.get(key).and_then(Json::as_bool)
}

/// Parse a kinds.json CRD into model info, mirroring the pydantic `Model`
/// validation with `model_dump(exclude_none=True)` for video/image configs.
pub fn extract_model_info(model_data: &Json) -> ModelInfo {
    let Some(root) = model_data.as_object() else {
        return default_info();
    };
    let Some(spec) = root.get("spec").and_then(Json::as_object) else {
        return default_info();
    };
    let model_config = spec
        .get("modelConfig")
        .and_then(Json::as_object)
        .cloned()
        .unwrap_or_default();
    let env = model_config
        .get("env")
        .and_then(Json::as_object)
        .cloned()
        .unwrap_or_default();

    let model_category_type = spec
        .get("modelType")
        .and_then(Json::as_str)
        .or_else(|| model_config.get("modelType").and_then(Json::as_str))
        .unwrap_or("llm")
        .to_string();
    if model_category_type == "decision"
        && crate::decisions::validate_spec(&Json::Object(spec.clone())).is_err()
    {
        return default_info();
    }

    let mut config: JsonMap<String, Json> = model_config
        .iter()
        .filter(|(key, _)| key.as_str() != "modelCapabilities")
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();

    // `_extract_model_info_from_crd` folds the codex catalog id into the config
    // before the catalog normalization, then appends protocol/apiFormat.
    if let Some(catalog_id) = codex_catalog_model_id_from_config(&env) {
        config.insert("codex_catalog_model_id".into(), Json::String(catalog_id));
    }
    config = wework_model_catalog_config(config);

    if let Some(protocol) = str_field(spec, "protocol") {
        config.insert("protocol".into(), Json::String(protocol));
    }
    if let Some(api_format) = str_field(spec, "apiFormat") {
        config.insert("apiFormat".into(), Json::String(api_format));
    }

    let model_capabilities = match spec.get("modelCapabilities") {
        Some(Json::Object(capabilities)) if !capabilities.is_empty() => {
            normalize_capabilities(Json::Object(capabilities.clone()))
        }
        _ => match model_config.get("modelCapabilities") {
            Some(value @ Json::Object(_)) => normalize_capabilities(value.clone()),
            _ => None,
        },
    };

    if model_category_type == "video" {
        if let Some(video_config) = spec.get("videoConfig").filter(|value| !value.is_null()) {
            // A rejected nested config makes `Model.model_validate` raise, so
            // the whole entry falls back to the error projection.
            let Ok(dumped) = super::generation_config::video_config_dump(video_config) else {
                return default_info();
            };
            config.insert("videoConfig".into(), dumped);
        }
        if let Some(protocol) = str_field(spec, "protocol") {
            config.insert("protocol".into(), Json::String(protocol));
        }
    } else if model_category_type == "image" {
        if let Some(image_config) = spec.get("imageConfig").filter(|value| !value.is_null()) {
            let Ok(dumped) = super::generation_config::image_config_dump(image_config) else {
                return default_info();
            };
            config.insert("imageConfig".into(), dumped);
        }
        if let Some(protocol) = str_field(spec, "protocol") {
            config.insert("protocol".into(), Json::String(protocol));
        }
    }

    ModelInfo {
        provider: str_field(&env, "model"),
        model_id: str_field(&env, "model_id"),
        display_name: root
            .get("metadata")
            .and_then(Json::as_object)
            .and_then(|metadata| str_field(metadata, "displayName")),
        config,
        model_category_type,
        is_advanced: bool_field(spec, "isAdvanced").unwrap_or(false),
        is_wework_available: bool_field(spec, "isWeworkAvailable").unwrap_or(false),
        model_group: str_field(spec, "modelGroup"),
        model_sub_group: str_field(spec, "modelSubGroup"),
        context_window: token_limit(&model_config, "context_window", spec.get("contextWindow")),
        max_output_tokens: token_limit(
            &model_config,
            "max_output_tokens",
            spec.get("maxOutputTokens"),
        ),
        cost_index: str_field(spec, "costIndex"),
        capability: capability_description(spec.get("capability")),
        model_capabilities,
    }
}

/// `ModelSpec.context_window` / `max_output_tokens`: the runtime `modelConfig`
/// value wins whenever the key is present, otherwise the legacy top-level
/// `spec.contextWindow` / `maxOutputTokens` is used. Only a JSON integer
/// counts; every other type yields `None`, mirroring
/// `_model_config_token_limit`.
fn token_limit(
    model_config: &JsonMap<String, Json>,
    key: &str,
    legacy: Option<&Json>,
) -> Option<i64> {
    match model_config.get(key).or(legacy)? {
        Json::Number(number) => number.as_i64(),
        _ => None,
    }
}

/// `get_model_capability_description`: read a model summary from a text value
/// or existing publication metadata (`{"description": "..."}`).
fn capability_description(capability: Option<&Json>) -> Option<String> {
    match capability? {
        Json::String(value) => Some(value.clone()),
        Json::Object(map) => map
            .get("description")
            .and_then(Json::as_str)
            .map(ToOwned::to_owned),
        _ => None,
    }
}

/// Python truthiness for the `a or b` fallback used by the catalog options.
fn json_truthy(value: &Json) -> bool {
    match value {
        Json::Null => false,
        Json::Bool(value) => *value,
        Json::Number(number) => number.as_f64().map(|value| value != 0.0).unwrap_or(true),
        Json::String(value) => !value.is_empty(),
        Json::Array(value) => !value.is_empty(),
        Json::Object(value) => !value.is_empty(),
    }
}

/// `shared.codex_model_catalog.codex_catalog_model_id_from_config`: the first
/// non-empty, trimmed string catalog id across the snake_case and camelCase
/// keys.
fn codex_catalog_model_id_from_config(env: &JsonMap<String, Json>) -> Option<String> {
    for key in ["codex_catalog_model_id", "codexCatalogModelId"] {
        if let Some(value) = env.get(key).and_then(Json::as_str) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

/// `wework_model_config.REASONING_VALUES`.
const REASONING_EFFORT_VALUES: [&str; 8] = [
    "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
];
const REASONING_SUMMARY_VALUES: [&str; 3] = ["auto", "concise", "detailed"];

/// `wework_model_config.CODEX_REQUEST_MODES`.
const CODEX_REQUEST_MODES: [&str; 3] = ["auto", "standard", "passthrough"];

/// `wework_model_config.wework_model_catalog_config`: drop an invalid
/// `codex_request_mode`, then merge the derived catalog options. The CRD itself
/// is not modified because the caller works on its own config copy.
fn wework_model_catalog_config(mut model_config: JsonMap<String, Json>) -> JsonMap<String, Json> {
    let valid_mode = matches!(
        model_config.get("codex_request_mode"),
        Some(Json::String(mode)) if CODEX_REQUEST_MODES.contains(&mode.as_str())
    );
    if !valid_mode {
        model_config.remove("codex_request_mode");
    }
    for (key, value) in wework_model_config_options(&model_config) {
        model_config.insert(key, value);
    }
    model_config
}

/// `wework_model_config.wework_model_config_options`: the supported reasoning
/// and request-policy fields derived from the model config and its env.
fn wework_model_config_options(model_config: &JsonMap<String, Json>) -> JsonMap<String, Json> {
    let env = model_config.get("env").and_then(Json::as_object);
    let mut options = JsonMap::new();

    let reasoning = env
        .and_then(|env| {
            // `env.get("thinking_config") or env.get("thinkingConfig")`: the
            // snake_case alias wins only while it is truthy, matching Python's
            // `or` rather than key presence.
            env.get("thinking_config")
                .filter(|value| json_truthy(value))
                .or_else(|| env.get("thinkingConfig"))
        })
        .and_then(Json::as_object)
        .and_then(|thinking| thinking.get("reasoning"))
        .and_then(Json::as_object);
    if let Some(reasoning) = reasoning {
        let mut safe = JsonMap::new();
        for (key, allowed) in [
            ("effort", &REASONING_EFFORT_VALUES[..]),
            ("summary", &REASONING_SUMMARY_VALUES[..]),
        ] {
            if let Some(value) = reasoning.get(key).and_then(Json::as_str) {
                let normalized = value.trim().to_lowercase();
                if allowed.contains(&normalized.as_str()) {
                    safe.insert(key.to_string(), Json::String(normalized));
                }
            }
        }
        if !safe.is_empty() {
            options.insert("reasoning".into(), Json::Object(safe));
        }
    }

    let mode = model_config
        .get("codex_request_mode")
        .and_then(Json::as_str);
    if let Some(mode) = mode
        && CODEX_REQUEST_MODES.contains(&mode)
    {
        options.insert("codex_request_mode".into(), Json::String(mode.to_string()));
    }

    for (key, alias) in [
        ("native_tool_search", "nativeToolSearch"),
        ("native_namespace_tools", "nativeNamespaceTools"),
    ] {
        for source in [Some(model_config), env] {
            let Some(source) = source else { continue };
            if let Some(Json::Bool(value)) = source.get(key).or_else(|| source.get(alias)) {
                options.insert(key.into(), Json::Bool(*value));
                break;
            }
        }
        if let Some(mode) = mode
            && matches!(mode, "standard" | "passthrough")
        {
            options.insert(key.into(), Json::Bool(mode == "passthrough"));
        }
    }

    options
}

/// Normalize capability maps to the canonical `{supportsImage, supportsVideo}`
/// shape, dropping null fields, mirroring `normalize_model_capabilities`.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCapabilities {
    #[serde(skip_serializing_if = "Option::is_none")]
    supports_image: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    supports_video: Option<bool>,
}

fn normalize_capabilities(value: Json) -> Option<ModelCapabilities> {
    #[derive(Default, serde::Deserialize)]
    #[serde(default)]
    struct Input {
        #[serde(rename = "supportsImage")]
        supports_image: Option<bool>,
        #[serde(rename = "supportsVideo")]
        supports_video: Option<bool>,
    }
    let input = brz_json::JsonProjection::<Input>::from(value).value?;
    let capabilities = ModelCapabilities {
        supports_image: input.supports_image,
        supports_video: input.supports_video,
    };
    (capabilities.supports_image.is_some() || capabilities.supports_video.is_some())
        .then_some(capabilities)
}

impl From<ModelCapabilities> for brz_json::OpaqueJson {
    fn from(value: ModelCapabilities) -> Self {
        serde_json::to_value(value)
            .expect("capabilities serialize")
            .into()
    }
}

pub fn is_custom_model(model_data: &Json) -> bool {
    model_data
        .as_object()
        .and_then(|root| root.get("spec"))
        .and_then(Json::as_object)
        .and_then(|spec| bool_field(spec, "isCustomConfig"))
        .unwrap_or(false)
}

pub fn is_public_model_visible(model_data: &Json) -> bool {
    let Some(root) = model_data.as_object() else {
        return true;
    };
    let Some(spec) = root.get("spec").and_then(Json::as_object) else {
        return true;
    };
    match spec.get("isVisible") {
        Some(Json::Bool(value)) => *value,
        _ => true,
    }
}

pub fn is_wework_available(model_data: &Json) -> bool {
    model_data
        .as_object()
        .and_then(|root| root.get("spec"))
        .and_then(Json::as_object)
        .and_then(|spec| bool_field(spec, "isWeworkAvailable"))
        .unwrap_or(false)
}

pub fn shell_provider_map(shell_type: &str) -> Option<&'static [&'static str]> {
    match shell_type {
        "Agno" => Some(&["openai", "claude", "gemini"]),
        "ClaudeCode" => Some(&["claude", "openai"]),
        _ => None,
    }
}

pub fn is_codex_compatible_config(config: &JsonMap<String, Json>) -> bool {
    let text = |key: &str| {
        config
            .get(key)
            .and_then(Json::as_str)
            .unwrap_or_default()
            .to_lowercase()
    };
    text("apiFormat") == "responses"
        || text("protocol") == "openai-responses"
        || text("wire_api") == "responses"
}

pub fn is_model_compatible_with_shell(
    category: &str,
    provider: Option<&str>,
    shell_type: &str,
    support_model: &[String],
    config: &JsonMap<String, Json>,
) -> bool {
    if category == "decision" {
        return false;
    }
    let provider = provider.unwrap_or_default();
    if !support_model.is_empty() && !support_model.iter().any(|item| item == provider) {
        return false;
    }
    if shell_type == "ClaudeCode" && provider == "openai" && !is_codex_compatible_config(config) {
        return false;
    }
    if !support_model.is_empty() {
        return true;
    }
    match shell_provider_map(shell_type) {
        Some(supported) => supported.contains(&provider),
        None => true,
    }
}

#[cfg(test)]
mod json_contract_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn unified_model_json_baseline() {
        let mut output = Vec::new();
        for populated in [false, true] {
            for optional in [None, Some(""), Some("value")] {
                for include_config in [false, true] {
                    for is_reference in [false, true] {
                        let model = UnifiedModel { name:"model".into(),model_type:"user",display_name:optional.map(str::to_owned),
                            provider:optional.map(str::to_owned),model_id:optional.map(str::to_owned),
                            config:json!({"env":{"SECRET":"hidden"},"protocol":"  HTTP ","modelCapabilities":{"old":true},"custom":null}).as_object().unwrap().clone(),
                            is_active:populated,namespace:"default".into(),model_category_type:"llm".into(),is_advanced:populated,
                            model_group:optional.map(str::to_owned),model_sub_group:optional.map(str::to_owned),
                            context_window:populated.then_some(0),max_output_tokens:populated.then_some(1024),cost_index:optional.map(str::to_owned),
                            capability:optional.map(str::to_owned),
                            model_capabilities:populated.then(|| json!({"images":true}).into()),resource_id:populated.then_some(9),resource_user_id:populated.then_some(0),
                            created_at:optional.map(str::to_owned),updated_at:optional.map(str::to_owned),is_reference };
                        output.push(
                            crate::json_contract_tests::serialized(
                                model.into_response(include_config),
                            )
                            .unwrap(),
                        );
                    }
                }
            }
        }
        crate::json_contract_tests::assert_fixture("unified_models", output);
    }
}

#[cfg(test)]
mod round_two_contracts {
    use super::*;
    use serde_json::json;

    #[test]
    fn round_two_capabilities() {
        let mut outputs = Vec::new();
        for value in [
            json!(null),
            json!(false),
            json!(0),
            json!(""),
            json!([]),
            json!({}),
            json!({"supportsImage":false}),
            json!({"supportsVideo":true}),
            json!({"supportsImage":null,"supportsVideo":"true"}),
            json!({"supportsImage":true,"supportsVideo":false,"unknown":7}),
        ] {
            outputs.push(
                crate::json_contract_tests::serialized(normalize_capabilities(value)).unwrap(),
            );
        }
        crate::json_contract_tests::assert_fixture("round_two_capabilities", outputs);
    }
}

#[cfg(test)]
mod model_spec_contracts {
    use super::*;
    use serde_json::json;

    fn spec(model_config: Json, extra: Json) -> Json {
        let mut spec = match extra {
            Json::Object(map) => map,
            _ => JsonMap::new(),
        };
        spec.insert("modelConfig".into(), model_config);
        json!({"metadata": {"name": "model"}, "spec": Json::Object(spec)})
    }

    #[test]
    fn legacy_token_limits_are_used_when_model_config_omits_them() {
        // `ModelSpec.context_window` falls back to the legacy top-level
        // `spec.contextWindow` only when `modelConfig` has no such key.
        let info = extract_model_info(&spec(
            json!({"env": {"model": "claude"}}),
            json!({"contextWindow": 1024000, "maxOutputTokens": 383985}),
        ));
        assert_eq!(info.context_window, Some(1024000));
        assert_eq!(info.max_output_tokens, Some(383985));
    }

    #[test]
    fn runtime_token_limits_win_over_legacy_fields() {
        let info = extract_model_info(&spec(
            json!({"env": {}, "context_window": 8192, "max_output_tokens": 512}),
            json!({"contextWindow": 1024000, "maxOutputTokens": 383985}),
        ));
        assert_eq!(info.context_window, Some(8192));
        assert_eq!(info.max_output_tokens, Some(512));
    }

    #[test]
    fn a_present_null_token_limit_suppresses_the_legacy_fallback() {
        let info = extract_model_info(&spec(
            json!({"env": {}, "context_window": null}),
            json!({"contextWindow": 1024000}),
        ));
        assert_eq!(info.context_window, None);
    }

    #[test]
    fn non_integer_token_limits_are_ignored() {
        let info = extract_model_info(&spec(
            json!({"env": {}}),
            json!({"contextWindow": "1024000", "maxOutputTokens": 1024.5}),
        ));
        assert_eq!(info.context_window, None);
        assert_eq!(info.max_output_tokens, None);
    }

    #[test]
    fn video_config_entries_mirror_the_pydantic_projection() {
        let info = extract_model_info(&spec(
            json!({"env": {"model": "seedance"}}),
            json!({
                "modelType": "video",
                "videoConfig": {
                    "resolution": "720p",
                    "capabilities": {
                        "video_min_duration_sec": 2,
                        "video_max_fps": 60,
                        "generation_modes": [
                            {"id": "first_last_frame", "label": "first", "first_frame_required": "true"},
                        ],
                    },
                },
            }),
        ));
        assert_eq!(info.model_category_type, "video");
        assert_eq!(
            info.config.get("videoConfig"),
            Some(&json!({
                "resolution": "720p",
                "fps": 24,
                "capabilities": {
                    "video_min_duration_sec": 2.0,
                    "video_max_fps": 60.0,
                    "generation_modes": [
                        {"id": "first_last_frame", "label": "first", "first_frame_required": true},
                    ],
                },
            }))
        );
    }

    #[test]
    fn a_rejected_video_config_falls_back_to_the_error_projection() {
        // `Model.model_validate` raises on an out-of-range capability, so the
        // whole entry collapses to the source error projection.
        let info = extract_model_info(&spec(
            json!({"env": {}}),
            json!({"modelType": "video", "videoConfig": {"capabilities": {"video_max_fps": 0}}}),
        ));
        assert_eq!(info.model_category_type, "llm");
        assert!(info.config.is_empty());
        assert_eq!(info.provider, None);
        assert_eq!(info.context_window, None);
    }

    #[test]
    fn reasoning_options_come_from_env_thinking_config() {
        // `wework_model_config_options` derives `reasoning` from
        // `env.thinking_config.reasoning`, keeping only the allowlisted keys
        // and normalizing their values.
        let info = extract_model_info(&spec(
            json!({"env": {"model": "openai", "thinking_config": {"reasoning": {"effort": "HIGH", "summary": "bogus"}}}}),
            json!({}),
        ));
        assert_eq!(
            info.config.get("reasoning"),
            Some(&json!({"effort": "high"}))
        );
    }

    #[test]
    fn thinking_config_alias_falls_back_like_a_python_or() {
        // An empty snake_case alias is falsy, so the camelCase alias wins.
        let info = extract_model_info(&spec(
            json!({"env": {"thinking_config": {}, "thinkingConfig": {"reasoning": {"summary": "auto"}}}}),
            json!({}),
        ));
        assert_eq!(
            info.config.get("reasoning"),
            Some(&json!({"summary": "auto"}))
        );
    }

    #[test]
    fn an_invalid_codex_request_mode_is_dropped() {
        // `wework_model_catalog_config` omits an unsupported request mode
        // instead of failing the whole extraction.
        let info = extract_model_info(&spec(
            json!({"env": {}, "codex_request_mode": "weird"}),
            json!({}),
        ));
        assert!(info.config.get("codex_request_mode").is_none());
    }

    #[test]
    fn capability_description_reads_text_or_publication_metadata() {
        let text = extract_model_info(&spec(json!({"env": {}}), json!({"capability": "fast"})));
        assert_eq!(text.capability.as_deref(), Some("fast"));

        let metadata = extract_model_info(&spec(
            json!({"env": {}}),
            json!({"capability": {"description": "vision"}}),
        ));
        assert_eq!(metadata.capability.as_deref(), Some("vision"));

        let absent = extract_model_info(&spec(json!({"env": {}}), json!({})));
        assert_eq!(absent.capability, None);
    }
}
