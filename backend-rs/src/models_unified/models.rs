// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Unified model aggregation, ported from
//! `app/services/model_aggregation_service.py` and
//! `app/services/adapters/public_model.py`.
use crate::json_compat::raw_json;
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
    pub model_capabilities: Option<crate::json_compat::OpaqueJson>,
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
            model_capabilities: self.model_capabilities.as_ref().map(|value| {
                serde_json::value::to_raw_value(value).expect("capabilities serialize")
            }),
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
    model_capabilities: Option<Box<serde_json::value::RawValue>>,
    runtime: ModelRuntimeResponse,
    config: Box<serde_json::value::RawValue>,
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
        model_capabilities: None,
    }
}

fn str_field(map: &JsonMap<String, Json>, key: &str) -> Option<String> {
    map.get(key).and_then(Json::as_str).map(ToOwned::to_owned)
}

fn int_field(map: &JsonMap<String, Json>, key: &str) -> Option<i64> {
    match map.get(key) {
        Some(Json::Number(number)) => number.as_i64(),
        _ => None,
    }
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
        .unwrap_or("llm")
        .to_string();

    let mut config: JsonMap<String, Json> = model_config
        .iter()
        .filter(|(key, _)| key.as_str() != "modelCapabilities")
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();

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
        if let Some(video_config) = spec.get("videoConfig")
            && let Some(dumped) = dump_exclude_none(video_config)
        {
            config.insert("videoConfig".into(), dumped);
        }
        if let Some(protocol) = str_field(spec, "protocol") {
            config.insert("protocol".into(), Json::String(protocol));
        }
    } else if model_category_type == "image" {
        if let Some(image_config) = spec.get("imageConfig")
            && let Some(dumped) = dump_exclude_none(image_config)
        {
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
        context_window: int_field(&model_config, "context_window"),
        max_output_tokens: int_field(&model_config, "max_output_tokens"),
        cost_index: str_field(spec, "costIndex"),
        model_capabilities,
    }
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
    let input = crate::json_compat::JsonProjection::<Input>::from(value).value?;
    let capabilities = ModelCapabilities {
        supports_image: input.supports_image,
        supports_video: input.supports_video,
    };
    (capabilities.supports_image.is_some() || capabilities.supports_video.is_some())
        .then_some(capabilities)
}

impl From<ModelCapabilities> for crate::json_compat::OpaqueJson {
    fn from(value: ModelCapabilities) -> Self {
        serde_json::to_value(value)
            .expect("capabilities serialize")
            .into()
    }
}

/// Recursively remove null fields, mirroring pydantic `exclude_none=True`.
fn dump_exclude_none(value: &Json) -> Option<Json> {
    match value {
        Json::Object(map) => {
            let mut out = JsonMap::new();
            for (key, item) in map {
                if matches!(item, Json::Null) {
                    continue;
                }
                out.insert(key.clone(), dump_exclude_none(item)?);
            }
            Some(Json::Object(out))
        }
        Json::Array(items) => {
            let mut out = Vec::with_capacity(items.len());
            for item in items {
                if matches!(item, Json::Null) {
                    out.push(Json::Null);
                    continue;
                }
                out.push(dump_exclude_none(item)?);
            }
            Some(Json::Array(out))
        }
        other => Some(other.clone()),
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
    provider: Option<&str>,
    shell_type: &str,
    support_model: &[String],
    config: &JsonMap<String, Json>,
) -> bool {
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
