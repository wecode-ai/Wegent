// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Response models for `GET /api/plugins/marketplace`.
//!
//! Field order and defaults mirror `PluginMarketplaceItem` and nested models
//! in `app/schemas/installed_plugin.py`, because FastAPI serializes the
//! response model and the API consumers observe that exact shape.
use serde::Serialize;
use serde_json::value::RawValue;

/// Optional Wework workbench runtime contribution of a plugin.
#[derive(Debug, Serialize)]
pub struct WorkbenchPluginComponent {
    #[serde(rename = "apiVersion")]
    pub api_version: String,
    pub required: bool,
    #[serde(rename = "pinnedToClientVersion")]
    pub pinned_to_client_version: bool,
    #[serde(rename = "clientVersion")]
    pub client_version: Option<String>,
    pub frontend: Option<Box<RawValue>>,
    pub desktop: Option<Box<RawValue>>,
}

/// Optional opaque fields are populated by presence: explicit JSON null is
/// retained, while missing keys are omitted.
#[derive(Debug, Serialize)]
pub struct PathComponent {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<Box<RawValue>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<Box<RawValue>>,
}
#[derive(Debug, Serialize)]
pub struct SkillComponent {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<Box<RawValue>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<Box<RawValue>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<Box<RawValue>>,
}
#[derive(Debug, Serialize)]
pub struct McpComponent {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<Box<RawValue>>,
    pub server: Box<RawValue>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorComponent {
    pub slug: String,
    pub auth_policy: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_auth: Option<LocalAuthComponent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_auth: Option<AccountAuthComponent>,
}

/// A declaration of adapter support (`PluginAccountAuthDefinition`). The
/// optional `oauth2`, `exportMode`, and `localEnvironment` members are
/// omitted when absent (the source `model_serializer` drops them).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountAuthComponent {
    pub protocol_version: i64,
    pub credential_type: String,
    pub adapter: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oauth2: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub export_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_environment: Option<Box<RawValue>>,
}
/// The legacy normalizer passes these values through without type coercion.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalAuthComponent {
    pub kind: Box<RawValue>,
    pub health: Box<RawValue>,
    pub start: Box<RawValue>,
    pub poll: Box<RawValue>,
    pub logout: Box<RawValue>,
    pub tool: Box<RawValue>,
    pub qr_field: Box<RawValue>,
    pub status_field: Box<RawValue>,
    pub ok_values: Box<RawValue>,
    pub poll_interval_seconds: Box<RawValue>,
    pub timeout_seconds: Box<RawValue>,
    pub logout_on_uninstall: Box<RawValue>,
}

/// Normalized `components` object of a marketplace item.
///
/// Built by re-serializing the release scan report through the source's
/// component models, which drops unknown fields and adds model defaults.
#[derive(Debug, Serialize)]
pub struct Components {
    pub skills: Vec<SkillComponent>,
    pub commands: Vec<PathComponent>,
    pub agents: Vec<PathComponent>,
    pub hooks: Vec<PathComponent>,
    pub mcps: Vec<McpComponent>,
    pub connectors: Vec<ConnectorComponent>,
    pub lsps: Vec<PathComponent>,
    pub monitors: Vec<PathComponent>,
    pub bins: Vec<PathComponent>,
    pub settings: Option<Box<RawValue>>,
    pub workbench: Option<WorkbenchPluginComponent>,
}

/// UI-facing interface metadata of a marketplace item.
#[derive(Debug, Serialize)]
pub struct PluginInterface {
    #[serde(rename = "displayName")]
    pub display_name: Option<String>,
    #[serde(rename = "shortDescription")]
    pub short_description: Option<String>,
    #[serde(rename = "longDescription")]
    pub long_description: Option<String>,
    #[serde(rename = "developerName")]
    pub developer_name: Option<String>,
    pub category: Option<String>,
    pub capabilities: Vec<String>,
    #[serde(rename = "websiteUrl")]
    pub website_url: Option<String>,
    #[serde(rename = "privacyPolicyUrl")]
    pub privacy_policy_url: Option<String>,
    #[serde(rename = "termsOfServiceUrl")]
    pub terms_of_service_url: Option<String>,
    #[serde(rename = "defaultPrompt")]
    pub default_prompt: Option<Vec<String>>,
    #[serde(rename = "brandColor")]
    pub brand_color: Option<String>,
    #[serde(rename = "composerIcon")]
    pub composer_icon: Option<String>,
    pub logo: Option<String>,
    #[serde(rename = "logoDark")]
    pub logo_dark: Option<String>,
    pub screenshots: Vec<String>,
}

/// Device-specific installation state of a marketplace item.
#[derive(Debug, Serialize)]
pub struct DeviceInstallationItem {
    #[serde(rename = "deviceId")]
    pub device_id: String,
    #[serde(rename = "desiredReleaseId")]
    pub desired_release_id: i64,
    #[serde(rename = "actualReleaseId")]
    pub actual_release_id: Option<i64>,
    pub state: String,
    #[serde(rename = "errorCode")]
    pub error_code: Option<String>,
    #[serde(rename = "errorMessage")]
    pub error_message: Option<String>,
    #[serde(rename = "attemptCount")]
    pub attempt_count: i64,
    #[serde(rename = "lastSyncAt")]
    pub last_sync_at: Option<String>,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

/// One entry in the marketplace listing response.
#[derive(Debug, Serialize)]
pub struct MarketplaceItem {
    pub id: i64,
    #[serde(rename = "catalogNamespace")]
    pub catalog_namespace: String,
    #[serde(rename = "originPersonalPluginId")]
    pub origin_personal_plugin_id: Option<i64>,
    #[serde(rename = "remotePluginId")]
    pub remote_plugin_id: String,
    pub name: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    pub description: String,
    pub version: Option<String>,
    pub author: Option<String>,
    pub visibility: String,
    pub featured: bool,
    pub installed: bool,
    #[serde(rename = "installedPluginId")]
    pub installed_plugin_id: Option<i64>,
    pub enabled: bool,
    #[serde(rename = "sourceType")]
    pub source_type: String,
    pub interface: Option<PluginInterface>,
    pub components: Components,
    pub manifest: Box<RawValue>,
    #[serde(rename = "ownerUserId")]
    pub owner_user_id: i64,
    #[serde(rename = "ownerDisplayName")]
    pub owner_display_name: String,
    #[serde(rename = "accessRole")]
    pub access_role: String,
    #[serde(rename = "allowCopy")]
    pub allow_copy: bool,
    #[serde(rename = "grantUserCount")]
    pub grant_user_count: i64,
    #[serde(rename = "grantNamespaceCount")]
    pub grant_namespace_count: i64,
    #[serde(rename = "latestReleaseId")]
    pub latest_release_id: Option<i64>,
    #[serde(rename = "listingType")]
    pub listing_type: String,
    pub origin: String,
    #[serde(rename = "sourceProvider")]
    pub source_provider: String,
    #[serde(rename = "sourceLabel")]
    pub source_label: String,
    #[serde(rename = "updateAvailable")]
    pub update_available: bool,
    #[serde(rename = "currentDeviceInstallation")]
    pub current_device_installation: Option<DeviceInstallationItem>,
}

/// Response body for `GET /api/plugins/marketplace`.
#[derive(Debug, Serialize)]
pub struct MarketplaceListResponse {
    pub items: Vec<MarketplaceItem>,
}

/// Mapping helpers from DB sentinels to API nulls.
pub fn unset_id(value: i64) -> Option<i64> {
    if value == 0 { None } else { Some(value) }
}

/// Map DB empty-string sentinel to API null.
pub fn unset_str(value: &str) -> Option<String> {
    if value.is_empty() {
        None
    } else {
        Some(value.to_owned())
    }
}
