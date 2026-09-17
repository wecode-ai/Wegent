// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Response models for `GET /api/connector-runtime/tools`.
//!
//! Mirrors `ConnectorTool` and `ConnectorToolListResponse` in
//! `app/schemas/connector.py`. Pydantic serializes these models without
//! aliases, so the wire names are the snake_case field names, and fields
//! without `exclude_none` (here `title` and `annotations`) serialize an absent
//! value as JSON `null`.
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::json_compat::OpaqueJson;

/// The `annotations` object of one upstream MCP tool
/// (`mcp.types.ToolAnnotations`).
///
/// The source keeps the SDK's parsed annotations model and re-serializes it
/// with `model_dump(mode="json", by_alias=True, exclude_none=True)`: known
/// hint members appear only when present, and because the SDK model declares
/// `extra="allow"` any other member the upstream server sent is carried
/// through. A missing or `null` `annotations` member stays `None`, which the
/// response renders as `null`.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct ToolAnnotations {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(
        default,
        rename = "readOnlyHint",
        skip_serializing_if = "Option::is_none"
    )]
    pub read_only_hint: Option<bool>,
    #[serde(
        default,
        rename = "destructiveHint",
        skip_serializing_if = "Option::is_none"
    )]
    pub destructive_hint: Option<bool>,
    #[serde(
        default,
        rename = "idempotentHint",
        skip_serializing_if = "Option::is_none"
    )]
    pub idempotent_hint: Option<bool>,
    #[serde(
        default,
        rename = "openWorldHint",
        skip_serializing_if = "Option::is_none"
    )]
    pub open_world_hint: Option<bool>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, OpaqueJson>,
}

impl ToolAnnotations {
    /// `_risk_hints` `destructive` value:
    /// `bool(annotations.get("destructiveHint") or annotations.get("destructive"))`.
    #[must_use]
    pub fn destructive(&self) -> bool {
        self.destructive_hint.unwrap_or(false) || self.extra_truthy("destructive")
    }

    /// `_risk_hints` `open_world` value:
    /// `bool(annotations.get("openWorldHint") or annotations.get("open_world"))`.
    #[must_use]
    pub fn open_world(&self) -> bool {
        self.open_world_hint.unwrap_or(false) || self.extra_truthy("open_world")
    }

    /// Drop extra members whose value is JSON `null`, matching the SDK dump's
    /// `exclude_none=True`.
    pub fn drop_null_extras(&mut self) {
        self.extra.retain(|_, value| !value.is_null());
    }

    fn extra_truthy(&self, key: &str) -> bool {
        self.extra.get(key).is_some_and(is_truthy)
    }
}

/// Python truthiness (`bool(value)`) of one opaque JSON value.
fn is_truthy(value: &OpaqueJson) -> bool {
    match value.to_value() {
        serde_json::Value::Null => false,
        serde_json::Value::Bool(value) => value,
        serde_json::Value::Number(number) => number.as_f64() != Some(0.0),
        serde_json::Value::String(value) => !value.is_empty(),
        serde_json::Value::Array(values) => !values.is_empty(),
        serde_json::Value::Object(object) => !object.is_empty(),
    }
}

/// `ConnectorTool.risk_hints`.
///
/// `_risk_hints` returns `{}` when the upstream tool carries no annotations
/// and otherwise always both derived booleans, so the fields are omitted
/// together only in the annotation-less case.
#[derive(Debug, Default, Serialize)]
pub struct RiskHints {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destructive: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub open_world: Option<bool>,
}

/// `ConnectorTool` (`app/schemas/connector.py`).
#[derive(Debug, Serialize)]
pub struct ConnectorTool {
    pub name: String,
    pub title: Option<String>,
    pub description: String,
    pub input_schema: OpaqueJson,
    pub annotations: Option<ToolAnnotations>,
    pub connector_id: String,
    pub connector_slug: String,
    pub connector_name: String,
    pub raw_tool_name: String,
    pub model_visible: bool,
    pub risk_hints: RiskHints,
    pub source_transport: String,
    pub app_id: i64,
    pub app_slug: String,
    pub app_name: String,
}

/// `ConnectorToolListResponse`.
#[derive(Debug, Serialize)]
pub struct ConnectorToolListResponse {
    pub tools: Vec<ConnectorTool>,
}

/// `_tool_from_upstream` fallback for a tool without an `inputSchema`:
/// `{"type": "object", "properties": {}}`.
#[derive(Debug, Serialize)]
struct EmptyInputSchema {
    #[serde(rename = "type")]
    schema_type: &'static str,
    properties: BTreeMap<String, OpaqueJson>,
}

pub fn default_input_schema() -> OpaqueJson {
    OpaqueJson::from_serializable(EmptyInputSchema {
        schema_type: "object",
        properties: BTreeMap::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn annotations(raw: &str) -> ToolAnnotations {
        serde_json::from_str(raw).expect("recorded annotations decode")
    }

    #[test]
    fn annotations_render_present_hints_only() {
        let recorded = annotations(
            r#"{"readOnlyHint":true,"destructiveHint":false,"idempotentHint":false,"openWorldHint":false}"#,
        );
        assert_eq!(
            serde_json::to_string(&recorded).unwrap(),
            r#"{"readOnlyHint":true,"destructiveHint":false,"idempotentHint":false,"openWorldHint":false}"#
        );
        assert!(!recorded.destructive());
        assert!(!recorded.open_world());
    }

    #[test]
    fn annotations_keep_extra_members_and_legacy_hints() {
        let mut legacy = annotations(r#"{"destructive":true,"open_world":"yes","vendor":null}"#);
        legacy.drop_null_extras();
        assert_eq!(
            serde_json::to_string(&legacy).unwrap(),
            r#"{"destructive":true,"open_world":"yes"}"#
        );
        assert!(legacy.destructive());
        assert!(legacy.open_world());
    }

    #[test]
    fn risk_hints_match_source_shapes() {
        let without = RiskHints::default();
        assert_eq!(serde_json::to_string(&without).unwrap(), "{}");
        let with = RiskHints {
            destructive: Some(true),
            open_world: Some(false),
        };
        assert_eq!(
            serde_json::to_string(&with).unwrap(),
            r#"{"destructive":true,"open_world":false}"#
        );
    }

    #[test]
    fn default_input_schema_matches_source_fallback() {
        assert_eq!(
            default_input_schema().to_raw_value().get(),
            r#"{"type":"object","properties":{}}"#
        );
    }

    #[test]
    fn tool_serializes_absent_optionals_as_null() {
        let tool = ConnectorTool {
            name: "wegent-sites__get_capabilities".to_string(),
            title: None,
            description: String::new(),
            input_schema: default_input_schema(),
            annotations: None,
            connector_id: "wegent-sites".to_string(),
            connector_slug: "wegent-sites".to_string(),
            connector_name: "Wegent Sites".to_string(),
            raw_tool_name: "get_capabilities".to_string(),
            model_visible: true,
            risk_hints: RiskHints::default(),
            source_transport: "streamable-http".to_string(),
            app_id: 266184,
            app_slug: "wegent-sites".to_string(),
            app_name: "Wegent Sites".to_string(),
        };
        assert_eq!(
            serde_json::to_string(&tool).unwrap(),
            r#"{"name":"wegent-sites__get_capabilities","title":null,"description":"","input_schema":{"type":"object","properties":{}},"annotations":null,"connector_id":"wegent-sites","connector_slug":"wegent-sites","connector_name":"Wegent Sites","raw_tool_name":"get_capabilities","model_visible":true,"risk_hints":{},"source_transport":"streamable-http","app_id":266184,"app_slug":"wegent-sites","app_name":"Wegent Sites"}"#
        );
    }
}
