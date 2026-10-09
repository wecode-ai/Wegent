// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Typed input, response, and `kinds.json` projection models for
//! `GET /api/admin/marketplace-resources`.
//!
//! Source: `app.api.endpoints.admin.marketplace.list_marketplace_resources`
//! with the `AdminMarketplaceResourceList` / `AdminMarketplaceResource`
//! schemas and the `app.services.resource_library_service` marketplace
//! helpers. Optional response members stay present as JSON null, matching
//! pydantic's default serialization.
//!
//! The stored `kinds.json` is projected through typed structs (never a generic
//! JSON value) so unknown members stay ignored and a member of an unexpected
//! shape is absorbed per field, mirroring the source's `payload.get(...)`
//! member reads.

use serde::{Deserialize, Serialize};

use crate::json_compat::JsonField;

/// `KIND_BY_RESOURCE_TYPE` (`app.api.endpoints.admin.marketplace`): the public
/// resource type to its CRD Kind.
pub const KIND_BY_RESOURCE_TYPE: [(&str, &str); 2] = [("agent", "Team"), ("skill", "Skill")];

/// Raw query parameters. Values stay strings so the handler can reproduce
/// FastAPI's decoding and validation before the service runs.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct MarketplaceResourcesQuery {
    pub resource_type: Option<String>,
    pub page: Option<String>,
    pub limit: Option<String>,
}

/// Validated `list_marketplace_resources` arguments.
#[derive(Debug, Clone, Copy)]
pub struct ListingParams {
    /// The endpoint's own `resource_type` value (`agent` / `skill`).
    pub resource_type: &'static str,
    /// The `KIND_BY_RESOURCE_TYPE[resource_type]` CRD Kind.
    pub kind: &'static str,
    pub page: i64,
    pub limit: i64,
}

/// `AdminMarketplaceResourceList`.
#[derive(Debug, Serialize)]
pub struct AdminMarketplaceResourceList {
    pub items: Vec<AdminMarketplaceResource>,
    pub total: usize,
    pub page: i64,
    pub limit: i64,
}

/// `AdminMarketplaceResource`.
#[derive(Debug, Serialize)]
pub struct AdminMarketplaceResource {
    pub id: i64,
    pub resource_type: &'static str,
    pub name: String,
    pub display_name: String,
    pub description: Option<String>,
    pub publisher_user_name: Option<String>,
    pub is_system: bool,
    pub recommendation_score: i64,
    pub example_conversations: Vec<ExampleConversation>,
}

/// `MarketplaceExampleConversation`.
#[derive(Debug, Serialize)]
pub struct ExampleConversation {
    pub title: String,
    pub url: String,
}

/// The `kinds.json` members the listing reads (`payload`, treated as an object
/// by `JsonProjection`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct KindPayload {
    pub metadata: JsonField<KindMetadata>,
    pub spec: JsonField<KindSpec>,
}

impl KindPayload {
    /// `payload.get("metadata", {})` when it is a mapping.
    #[must_use]
    pub fn metadata(&self) -> Option<&KindMetadata> {
        self.metadata.value.as_ref()
    }

    /// `payload.get("spec", {})` when it is a mapping.
    #[must_use]
    pub fn spec(&self) -> Option<&KindSpec> {
        self.spec.value.as_ref()
    }

    /// `spec.get("capability", {})` when `spec` is a mapping and it is one.
    #[must_use]
    pub fn capability(&self) -> Option<&Capability> {
        self.spec().and_then(|spec| spec.capability.value.as_ref())
    }

    /// `_marketplace_config(source)`: `spec.capability.marketplace` when the
    /// chain is a mapping.
    #[must_use]
    pub fn marketplace(&self) -> Option<&MarketplaceConfig> {
        self.capability()
            .and_then(|capability| capability.marketplace.value.as_ref())
    }
}

/// `kinds.json.metadata`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct KindMetadata {
    #[serde(rename = "displayName")]
    pub display_name: JsonField<JsonScalar>,
}

/// `kinds.json.spec`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct KindSpec {
    #[serde(rename = "displayName")]
    pub display_name: JsonField<JsonScalar>,
    pub description: JsonField<JsonScalar>,
    pub capability: JsonField<Capability>,
}

/// `kinds.json.spec.capability`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Capability {
    #[serde(rename = "displayName")]
    pub display_name: JsonField<JsonScalar>,
    pub description: JsonField<JsonScalar>,
    pub marketplace: JsonField<MarketplaceConfig>,
}

/// `kinds.json.spec.capability.marketplace`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct MarketplaceConfig {
    #[serde(rename = "recommendationScore")]
    pub recommendation_score: JsonField<JsonScalar>,
    /// Presence is kept so a stored value of the wrong type can be reported
    /// the way the source's `list[MarketplaceExampleConversation]` field
    /// rejects it, while an absent member keeps the `[]` default.
    #[serde(rename = "exampleConversations")]
    pub example_conversations: JsonField<Vec<ConversationInput>>,
}

/// One stored `exampleConversations` entry.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct ConversationInput {
    pub title: JsonField<JsonScalar>,
    pub url: JsonField<JsonScalar>,
}

/// A JSON scalar as the legacy CRD documents store it.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum JsonScalar {
    Bool(bool),
    Int(i64),
    Float(f64),
    Text(String),
}

impl JsonScalar {
    /// Python truthiness: `False`, `0`, `0.0` and `""` are falsy.
    #[must_use]
    pub fn is_falsy(&self) -> bool {
        match self {
            Self::Bool(value) => !*value,
            Self::Int(value) => *value == 0,
            Self::Float(value) => *value == 0.0,
            Self::Text(value) => value.is_empty(),
        }
    }

    /// Python `str(value)` for a JSON scalar.
    #[must_use]
    pub fn text(&self) -> String {
        match self {
            Self::Bool(true) => "True".to_owned(),
            Self::Bool(false) => "False".to_owned(),
            Self::Int(value) => value.to_string(),
            Self::Float(value) => format_float(*value),
            Self::Text(value) => value.clone(),
        }
    }

    /// The member when it is a string, matching pydantic's `str` fields that
    /// reject non-string scalars.
    #[must_use]
    pub fn text_value(&self) -> Option<&str> {
        match self {
            Self::Text(value) => Some(value),
            Self::Bool(_) | Self::Int(_) | Self::Float(_) => None,
        }
    }

    /// Python `int(value)` for a JSON scalar.
    #[must_use]
    pub fn integer(&self) -> Option<i64> {
        match self {
            Self::Bool(value) => Some(i64::from(*value)),
            Self::Int(value) => Some(*value),
            Self::Float(value) => Some(*value as i64),
            Self::Text(value) => parse_python_int(value),
        }
    }
}

/// Python `str(float)`: integral floats keep a `.0` suffix.
fn format_float(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1e16 {
        format!("{value:.1}")
    } else {
        value.to_string()
    }
}

/// Python `int(str)`: surrounding whitespace is allowed, otherwise the text
/// must be a base-10 integer literal.
#[must_use]
pub fn parse_python_int(text: &str) -> Option<i64> {
    let trimmed = text.trim();
    let (negative, digits) = match trimmed.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, trimmed.strip_prefix('+').unwrap_or(trimmed)),
    };
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let magnitude = digits.parse::<i128>().ok()?;
    let signed = if negative { -magnitude } else { magnitude };
    i64::try_from(signed).ok()
}
