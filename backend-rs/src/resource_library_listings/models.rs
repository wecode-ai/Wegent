// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Typed input, response, and `kinds.json` models for
//! `GET /api/resource-library/listings`.
//!
//! The source endpoint is `app.api.endpoints.resource_library.list_resource_library`
//! with the `ResourceLibraryDiscoveryList` response schema and the
//! `resource_library_service.list_public` projection. Field presence follows the
//! pydantic models: optional members stay present as JSON null.

use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};

/// `RESOURCE_KIND_BY_TYPE`: capability-center resource type to CRD Kind.
pub const RESOURCE_TYPE_KINDS: [(&str, &str); 5] = [
    ("agent", "Team"),
    ("skill", "Skill"),
    ("model", "Model"),
    ("shell", "Shell"),
    ("retriever", "Retriever"),
];

/// `list(RESOURCE_TYPE_BY_KIND)` iteration order, used when no
/// `resource_type` filter is supplied.
pub const ALL_KINDS: [&str; 5] = ["Team", "Skill", "Model", "Shell", "Retriever"];

/// `RESOURCE_TYPE_BY_KIND[kind]`.
#[must_use]
pub fn resource_type_for_kind(kind: &str) -> Option<&'static str> {
    RESOURCE_TYPE_KINDS
        .iter()
        .find(|(_, candidate)| *candidate == kind)
        .map(|(resource_type, _)| *resource_type)
}

/// `RESOURCE_KIND_BY_TYPE[resource_type]`: the endpoint's own value and the
/// CRD Kind it selects.
#[must_use]
pub fn resource_type_entry(resource_type: &str) -> Option<(&'static str, &'static str)> {
    RESOURCE_TYPE_KINDS
        .iter()
        .find(|(candidate, _)| *candidate == resource_type)
        .map(|(candidate, kind)| (*candidate, *kind))
}

/// Raw query parameters. Values stay strings so the handler can reproduce
/// FastAPI's decoding and validation before the service runs.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct DiscoveryQuery {
    pub resource_type: Option<String>,
    pub system_only: Option<String>,
    pub featured_only: Option<String>,
    pub keyword: Option<String>,
    pub tags: Option<String>,
    pub target_namespace: Option<String>,
    pub cursor: Option<String>,
    pub limit: Option<String>,
}

/// Validated `list_resource_library` arguments.
///
/// `resource_type` keeps the endpoint's own value (`agent`, `skill`, ...) as
/// the source does, because the published scan compares
/// `marketplace_resources.resource_type` against it directly;
/// `resource_kind` is the `RESOURCE_KIND_BY_TYPE[resource_type]` CRD Kind the
/// two scans use for `kinds.kind IN (...)`.
#[derive(Debug, Clone)]
pub struct DiscoveryParams {
    pub resource_type: Option<&'static str>,
    pub resource_kind: Option<&'static str>,
    pub system_only: bool,
    pub featured_only: bool,
    pub keyword: Option<String>,
    pub tags: Vec<String>,
    pub target_namespace: String,
    pub cursor: Option<String>,
    pub limit: i64,
}

/// `_parse_tags`: comma-separated, trimmed, empty entries dropped.
#[must_use]
pub fn parse_tags(tags: Option<&str>) -> Vec<String> {
    tags.unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

/// `ResourceLibraryDiscoveryList`.
#[derive(Debug, Serialize)]
pub struct DiscoveryList {
    pub items: Vec<Listing>,
    pub has_more: bool,
    pub next_cursor: Option<String>,
    pub limit: i64,
}

/// `ResourceLibraryListing`.
#[derive(Debug, Serialize)]
pub struct Listing {
    pub id: i64,
    pub resource_type: String,
    pub name: String,
    pub display_name: String,
    pub description: Option<String>,
    pub icon: Option<String>,
    pub tags: Vec<String>,
    pub feature_tags: Vec<String>,
    pub publisher_user_id: i64,
    pub publisher_user_name: Option<String>,
    pub publisher_namespace: String,
    pub status: String,
    pub current_version_id: i64,
    pub current_version: Version,
    pub install_count: i64,
    pub is_installed: bool,
    pub example_conversations: Vec<ExampleConversation>,
    pub bind_modes: Vec<String>,
    pub allow_personal_install: bool,
    pub allow_group_install: bool,
    pub target_groups: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// `ResourceLibraryVersion`.
#[derive(Debug, Serialize)]
pub struct Version {
    pub id: i64,
    pub listing_id: i64,
    pub version: String,
    pub changelog: Option<String>,
    pub package_url: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// `MarketplaceExampleConversation`.
#[derive(Debug, Serialize)]
pub struct ExampleConversation {
    pub title: String,
    pub url: String,
}

/// Pydantic v2 naive-datetime serialization: `YYYY-MM-DDTHH:MM:SS`, plus
/// six-digit microseconds when the stored value has a fractional part.
#[must_use]
pub fn format_datetime(value: NaiveDateTime) -> String {
    if value.and_utc().timestamp_subsec_nanos() == 0 {
        value.format("%Y-%m-%dT%H:%M:%S").to_string()
    } else {
        format!(
            "{}.{:06}",
            value.format("%Y-%m-%dT%H:%M:%S"),
            value.and_utc().timestamp_subsec_micros()
        )
    }
}

/// Python `str(value)` for a JSON scalar. Objects and arrays are not scalars
/// and are rejected by the projection that uses this type.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum JsonScalar {
    Bool(bool),
    Int(i64),
    Float(f64),
    Text(String),
}

impl JsonScalar {
    /// Python truthiness for scalars: `False`, `0`, `0.0` and `""` are falsy.
    #[must_use]
    pub fn is_falsy(&self) -> bool {
        match self {
            Self::Bool(value) => !*value,
            Self::Int(value) => *value == 0,
            Self::Float(value) => *value == 0.0,
            Self::Text(value) => value.is_empty(),
        }
    }

    /// Python `str(value)` for the scalar kinds this projection keeps.
    #[must_use]
    pub fn text(&self) -> String {
        match self {
            Self::Bool(value) => {
                if *value {
                    "True".to_owned()
                } else {
                    "False".to_owned()
                }
            }
            Self::Int(value) => value.to_string(),
            Self::Float(value) => format_float(*value),
            Self::Text(value) => value.clone(),
        }
    }
}

/// Python `str(float)`: integral floats keep a `.0` suffix, larger values use
/// the shortest round-trip form.
fn format_float(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1e16 {
        format!("{value:.1}")
    } else {
        value.to_string()
    }
}

/// `kinds.json` projection: only the members the discovery listing reads.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct KindPayload {
    pub metadata: KindMetadata,
    pub spec: KindSpec,
}

/// `kinds.json.metadata`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct KindMetadata {
    #[serde(rename = "displayName")]
    pub display_name: Option<JsonScalar>,
}

/// `kinds.json.spec`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct KindSpec {
    #[serde(rename = "displayName")]
    pub display_name: Option<JsonScalar>,
    pub description: Option<JsonScalar>,
    pub icon: Option<JsonScalar>,
    pub tags: Option<Vec<JsonScalar>>,
    pub version: Option<JsonScalar>,
    pub visible: Option<JsonScalar>,
    #[serde(rename = "bind_mode")]
    pub bind_mode: Option<Vec<JsonScalar>>,
    /// SkillBinding members (`_is_user_default_binding`).
    #[serde(rename = "targetType")]
    pub target_type: Option<JsonScalar>,
    #[serde(rename = "targetId")]
    pub target_id: Option<JsonScalar>,
    #[serde(rename = "skillRef")]
    pub skill_ref: Option<SkillRef>,
    pub capability: Option<Capability>,
}

/// `kinds.json.spec.skillRef`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct SkillRef {
    #[serde(rename = "skillId")]
    pub skill_id: Option<JsonScalar>,
    #[serde(rename = "skill_id")]
    pub skill_id_snake: Option<JsonScalar>,
}

/// `kinds.json.spec.capability`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Capability {
    pub visibility: Option<JsonScalar>,
    #[serde(rename = "publishStatus")]
    pub publish_status: Option<JsonScalar>,
    #[serde(rename = "displayName")]
    pub display_name: Option<JsonScalar>,
    pub description: Option<JsonScalar>,
    pub icon: Option<JsonScalar>,
    pub tags: Option<Vec<JsonScalar>>,
    pub version: Option<JsonScalar>,
    #[serde(rename = "publishedBy")]
    pub published_by: Option<JsonScalar>,
    #[serde(rename = "allowPersonalInstall")]
    pub allow_personal_install: Option<JsonScalar>,
    #[serde(rename = "allowGroupInstall")]
    pub allow_group_install: Option<JsonScalar>,
    #[serde(rename = "targetGroups")]
    pub target_groups: Option<Vec<JsonScalar>>,
    pub marketplace: Option<MarketplaceConfig>,
}

impl Capability {
    /// Python `if capability:` for the `spec.capability` mapping. A mapping
    /// that carries no recognized member behaves like the empty mapping the
    /// service replaces with its defaults.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.visibility.is_none()
            && self.publish_status.is_none()
            && self.display_name.is_none()
            && self.description.is_none()
            && self.icon.is_none()
            && self.tags.is_none()
            && self.version.is_none()
            && self.published_by.is_none()
            && self.allow_personal_install.is_none()
            && self.allow_group_install.is_none()
            && self.target_groups.is_none()
            && self.marketplace.is_none()
    }
}

/// `kinds.json.spec.capability.marketplace`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct MarketplaceConfig {
    #[serde(rename = "exampleConversations")]
    pub example_conversations: Option<Vec<ExampleConversationInput>>,
}

/// One stored `exampleConversations` entry.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct ExampleConversationInput {
    pub title: Option<JsonScalar>,
    pub url: Option<JsonScalar>,
}

/// One decoded discovery cursor payload
/// (`_encode_discovery_cursor` / `_decode_discovery_cursor`).
#[derive(Debug, Deserialize)]
pub struct CursorPayload {
    pub updated_at: String,
    pub kind_id: CursorInt,
    #[serde(default)]
    pub recommendation_score: Option<CursorInt>,
}

/// Python `int(value)` for the cursor's numeric members.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum CursorInt {
    Int(i64),
    Float(f64),
    Text(String),
}

impl CursorInt {
    /// Python `int(value)`; unsupported text is `None`.
    #[must_use]
    pub fn to_i64(&self) -> Option<i64> {
        match self {
            Self::Int(value) => Some(*value),
            Self::Float(value) => Some(*value as i64),
            Self::Text(value) => value.trim().parse().ok(),
        }
    }
}
