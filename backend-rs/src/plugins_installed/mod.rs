// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/plugins/installed` implementation.
//!
//! Source: `app/api/endpoints/installed_plugins.py`
//! `list_installed_plugins` -> `installed_plugin_service.list_installed_plugins`
//! -> `plugin_marketplace_service.enrich_installed_list`.
//!
//! Reads the user's active `InstalledPlugin` kinds rows ordered by
//! `created_at DESC`, appends device installation status rows, then applies
//! the per-device and marketplace release enrichment that may rewrite
//! `spec.installState`.

pub mod auth;
mod handler;
use brz_mysql::{FromMysqlRow, Mysql, MysqlResult};
use chrono::NaiveDateTime;
use serde::Deserialize;
use serde_json::{Map, Value};
use std::collections::HashMap;

/// Source `plugin_marketplace.py` `EPOCH_TIME` sentinel mapped back to null.
const EPOCH: NaiveDateTime = NaiveDateTime::new(
    chrono::NaiveDate::from_ymd_opt(1970, 1, 1).expect("valid epoch date"),
    chrono::NaiveTime::from_hms_opt(0, 0, 0).expect("valid epoch time"),
);

/// One active `kinds` row (`shared/models/db/kind.py`).
#[derive(Debug, FromMysqlRow)]
pub struct KindRow {
    pub id: i64,
    pub json: serde_json::Value,
}

/// One `plugin_device_installations` row
/// (`app/models/plugin_marketplace.py`).
///
/// `user_id` is selected so `coalesce_plugin_device_rows` can resolve the
/// canonical device identity per row exactly like the source
/// (`plugin_device_id(db, row.user_id, row.device_id)`).
#[derive(Debug, Clone, FromMysqlRow)]
pub struct DeviceInstallationRow {
    #[mysql(rename = "installed_kind_id")]
    pub installed_kind_id: i64,
    #[mysql(rename = "user_id")]
    pub user_id: i64,
    #[mysql(rename = "device_id")]
    pub device_id: String,
    #[mysql(rename = "desired_release_id")]
    pub desired_release_id: i64,
    #[mysql(rename = "actual_release_id")]
    pub actual_release_id: i64,
    #[mysql(rename = "state")]
    pub state: String,
    #[mysql(rename = "error_code")]
    pub error_code: String,
    #[mysql(rename = "error_message")]
    pub error_message: String,
    #[mysql(rename = "attempt_count")]
    pub attempt_count: i64,
    #[mysql(rename = "last_sync_at")]
    pub last_sync_at: NaiveDateTime,
    #[mysql(rename = "updated_at")]
    pub updated_at: NaiveDateTime,
}

/// Minimal `plugins` projection used by enrichment (`db.get(Plugin, id)`).
#[derive(Debug, FromMysqlRow)]
pub struct PluginRow {
    #[allow(dead_code)]
    pub id: i64,
    pub latest_release_id: i64,
}

/// One active `kinds` Device row (`app/services/device/identity.py`).
///
/// Selected with the full labeled source column list so the prepared
/// statement matches the recorded exchange (`kinds.<col> AS kinds_<col>`).
#[derive(Debug, Clone, FromMysqlRow)]
pub struct DeviceKindRow {
    #[mysql(rename = "kinds_id")]
    pub id: i64,
    #[mysql(rename = "kinds_name")]
    pub name: String,
    #[mysql(rename = "kinds_json")]
    pub json: serde_json::Value,
}

/// Typed projection of the Device `spec` fields consumed by identity
/// resolution (`app/services/device/identity.py` + `runtime_route.py`).
#[derive(Debug, Default, Deserialize)]
struct DeviceSpec {
    #[serde(default, rename = "deviceType")]
    device_type: Option<String>,
    #[serde(default, rename = "deviceId")]
    device_id: Option<String>,
    #[serde(default, rename = "appDeviceId")]
    app_device_id: Option<String>,
    #[serde(default, rename = "cloudConfig")]
    cloud_config: Option<CloudConfig>,
}

#[derive(Debug, Default, Deserialize)]
struct CloudConfig {
    #[serde(default, rename = "deviceId")]
    device_id: Option<String>,
}

impl DeviceKindRow {
    /// `device.json.get("spec", {})` parsed into the typed projection.
    fn spec(&self) -> DeviceSpec {
        self.json
            .get("spec")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default()
    }
}

/// Source `kinds` Device filter (`resolve_owned_device_alias` base query).
const KINDS_DEVICE_QUERY: &str = "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
     kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
     kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
     kinds.updated_at AS kinds_updated_at FROM kinds \
     WHERE kinds.user_id = ? AND kinds.kind = 'Device' \
     AND kinds.namespace = 'default' AND kinds.is_active = true";

pub async fn list_installed_kinds<M>(mysql: &M, user_id: i64) -> MysqlResult<Vec<KindRow>>
where
    M: Mysql,
{
    mysql
        .fetch_all(
            "SELECT id, json FROM kinds \
             WHERE user_id = ? AND kind = 'InstalledPlugin' AND namespace = 'default' \
             AND is_active = true ORDER BY created_at DESC",
            (user_id,),
        )
        .await
}

pub async fn list_device_installations<M>(
    mysql: &M,
    installed_ids: &[i64],
) -> MysqlResult<Vec<DeviceInstallationRow>>
where
    M: Mysql,
{
    if installed_ids.is_empty() {
        return Ok(Vec::new());
    }
    // The source uses SQLAlchemy `in_`, which expands to a literal list on
    // the recorded wire. The service rewrites the placeholder list to match
    // the source statement shape.
    let placeholders = vec!["?"; installed_ids.len()].join(", ");
    let sql = format!(
        "SELECT installed_kind_id, user_id, device_id, desired_release_id, actual_release_id, \
         state, error_code, error_message, attempt_count, last_sync_at, updated_at \
         FROM plugin_device_installations WHERE installed_kind_id IN ({placeholders}) \
         ORDER BY device_id"
    );
    mysql.fetch_all(sql, installed_ids.to_vec()).await
}

pub async fn get_plugin<M>(mysql: &M, plugin_id: i64) -> MysqlResult<Option<PluginRow>>
where
    M: Mysql,
{
    mysql
        .fetch_optional(
            "SELECT id, latest_release_id FROM plugins WHERE id = ?",
            (plugin_id,),
        )
        .await
}

/// Prefix for the App device transport route
/// (`app/services/device/identity.py::RECORD_ROUTE_PREFIX`).
const RECORD_ROUTE_PREFIX: &str = "app-record-";

/// Source `app/services/device/identity.py::record_id_from_route`: extract a
/// persisted Device record id from an App transport route.
fn record_id_from_route(device_id: &str) -> Option<i64> {
    let suffix = device_id.strip_prefix(RECORD_ROUTE_PREFIX)?;
    if suffix.is_ascii() && suffix.bytes().all(|b| b.is_ascii_digit()) {
        let id: i64 = suffix.parse().ok()?;
        (id > 0).then_some(id)
    } else {
        None
    }
}

/// Source `app/schemas/device.py::DeviceType`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DeviceType {
    Local,
    App,
    Cloud,
    Remote,
}

impl DeviceType {
    /// `device_kind_type`: read `spec.deviceType` with a `local` default.
    fn from_spec(spec: &DeviceSpec) -> Self {
        match spec.device_type.as_deref() {
            Some("local") => Self::Local,
            Some("app") => Self::App,
            Some("cloud") => Self::Cloud,
            Some("remote") => Self::Remote,
            _ => Self::Local,
        }
    }
}

/// Source `app/services/device/identity.py::record_route_id`.
fn record_route_id(device: &DeviceKindRow) -> String {
    if DeviceType::from_spec(&device.spec()) == DeviceType::App {
        format!("{RECORD_ROUTE_PREFIX}{}", device.id)
    } else {
        device.name.clone()
    }
}

/// Source `app/services/device/identity.py::device_identity_ids`.
fn device_identity_ids(device: &DeviceKindRow) -> Vec<String> {
    let spec = device.spec();
    let mut candidates: Vec<String> = Vec::new();
    let route = record_route_id(device);
    if !route.is_empty() {
        candidates.push(route);
    }
    if !device.name.is_empty() {
        candidates.push(device.name.clone());
    }
    if let Some(device_id) = &spec.device_id {
        let trimmed = device_id.trim();
        if !trimmed.is_empty() {
            candidates.push(trimmed.to_string());
        }
    }
    if let Some(app_device_id) = &spec.app_device_id {
        let trimmed = app_device_id.trim();
        if !trimmed.is_empty() {
            candidates.push(trimmed.to_string());
        }
    }
    candidates.dedup();
    candidates
}

/// Source `app/services/device/identity.py::_unambiguous_device`.
fn unambiguous_device(matches: Vec<DeviceKindRow>) -> Option<DeviceKindRow> {
    if matches.is_empty() {
        return None;
    }
    if matches.len() == 1 {
        return Some(matches.into_iter().next().expect("one"));
    }
    let app_matches: Vec<DeviceKindRow> = matches
        .into_iter()
        .filter(|d| DeviceType::from_spec(&d.spec()) == DeviceType::App)
        .collect();
    if app_matches.len() == 1 {
        return Some(app_matches.into_iter().next().expect("one"));
    }
    None
}

/// Source `app/services/device/identity.py::resolve_owned_device_alias`.
///
/// Returns the resolved device row, or `None` when no unambiguous match
/// exists. Mirrors the SQLAlchemy filter exactly: `user_id`, `kind='Device'`,
/// `namespace='default'`, `is_active=true`.
async fn resolve_owned_device_alias<M>(
    mysql: &M,
    user_id: i64,
    device_id: &str,
) -> MysqlResult<Option<DeviceKindRow>>
where
    M: Mysql,
{
    let submitted = device_id.trim();
    if submitted.is_empty() {
        return Ok(None);
    }
    if let Some(record_id) = record_id_from_route(submitted) {
        // Source `query.filter_by(id=record_id).one_or_none()`; the SQLAlchemy
        // filter appends `AND kinds.id = ?` to the base filter.
        let sql = format!("{KINDS_DEVICE_QUERY} AND kinds.id = ?");
        let row: Option<DeviceKindRow> = mysql.fetch_optional(sql, (user_id, record_id)).await?;
        return Ok(
            row.and_then(|d| (DeviceType::from_spec(&d.spec()) == DeviceType::App).then_some(d))
        );
    }
    let all: Vec<DeviceKindRow> = mysql.fetch_all(KINDS_DEVICE_QUERY, (user_id,)).await?;
    let matches: Vec<DeviceKindRow> = all
        .into_iter()
        .filter(|d| device_identity_ids(d).iter().any(|id| id == submitted))
        .collect();
    Ok(unambiguous_device(matches))
}

/// Source `app/services/device/runtime_route.py::_runtime_device_id`.
fn runtime_device_id(device: &DeviceKindRow) -> String {
    if DeviceType::from_spec(&device.spec()) == DeviceType::App {
        return record_route_id(device);
    }
    let spec = device.spec();
    spec.device_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or_else(|| {
            spec.cloud_config
                .as_ref()
                .and_then(|c| c.device_id.as_deref())
        })
        .filter(|s| !s.is_empty())
        .or(Some(device.name.as_str()))
        .filter(|s| !s.is_empty())
        .unwrap_or("")
        .trim()
        .to_string()
}

/// Source `app/services/device/runtime_route.py::_identity_from_device` plus
/// `plugin_device_id`: resolve a submitted device id to its canonical id.
fn canonical_device_id(device: &DeviceKindRow) -> String {
    let device_type = DeviceType::from_spec(&device.spec());
    let runtime_id = runtime_device_id(device);
    if device_type == DeviceType::App {
        runtime_id
    } else {
        record_route_id(device)
    }
}

/// Source `app/services/plugin_device_identity.py::plugin_device_id`.
///
/// Resolves a submitted device id to its canonical id within one user's
/// active devices. When no owned device matches, the submitted id is returned
/// unchanged.
async fn plugin_device_id<M>(mysql: &M, user_id: i64, device_id: &str) -> MysqlResult<String>
where
    M: Mysql,
{
    Ok(
        match resolve_owned_device_alias(mysql, user_id, device_id).await? {
            Some(device) => canonical_device_id(&device),
            None => device_id.trim().to_string(),
        },
    )
}

/// Source `app/services/device/runtime_route.py::_state_order`.
///
/// `datetime.min` is the source's fallback for null timestamps; the DB
/// columns are `NOT NULL`, so `NaiveDateTime` is always present.
fn state_order(
    row: &DeviceInstallationRow,
    canonical_id: &str,
) -> (NaiveDateTime, NaiveDateTime, bool) {
    (
        row.last_sync_at,
        row.updated_at,
        row.device_id == canonical_id,
    )
}

/// Source `app/services/plugin_device_identity.py::coalesce_plugin_device_rows`.
///
/// Returns `(installed_kind_id, canonical_id) -> selected_row` as an
/// insertion-ordered vector, mirroring the source's Python dict (which
/// preserves insertion order). The identity cache mirrors the source: one
/// `plugin_device_id` call per unique `(user_id, device_id)` pair.
async fn coalesce_plugin_device_rows<M>(
    mysql: &M,
    rows: Vec<DeviceInstallationRow>,
) -> MysqlResult<Vec<((i64, String), DeviceInstallationRow)>>
where
    M: Mysql,
{
    let mut identities: HashMap<(i64, String), String> = HashMap::new();
    let mut selected: Vec<((i64, String), DeviceInstallationRow)> = Vec::new();
    let mut seen: HashMap<(i64, String), usize> = HashMap::new();
    for row in &rows {
        let identity_key = (row.user_id, row.device_id.clone());
        if !identities.contains_key(&identity_key) {
            let canonical = plugin_device_id(mysql, row.user_id, &row.device_id).await?;
            identities.insert(identity_key.clone(), canonical);
        }
        let canonical_id = identities.get(&identity_key).expect("populated").clone();
        let key = (row.installed_kind_id, canonical_id.clone());
        if let Some(&idx) = seen.get(&key) {
            if state_order(row, &canonical_id) > state_order(&selected[idx].1, &canonical_id) {
                selected[idx].1 = row.clone();
            }
        } else {
            seen.insert(key.clone(), selected.len());
            selected.push((key, row.clone()));
        }
    }
    Ok(selected)
}

/// Source `unset_id`: DB ID sentinel 0 maps back to API null.
fn unset_id(value: i64) -> Option<i64> {
    if value == 0 { None } else { Some(value) }
}

/// Source `unset_str`: DB empty-string sentinel maps back to API null.
fn unset_str(value: &str) -> Option<&str> {
    if value.is_empty() { None } else { Some(value) }
}

/// Source `unset_datetime`: DB epoch sentinel maps back to API null.
fn unset_datetime(value: NaiveDateTime) -> Option<NaiveDateTime> {
    if value == EPOCH { None } else { Some(value) }
}

/// Typed `PluginDeviceInstallationItem` model
/// (`app/schemas/installed_plugin.py`).
#[derive(Debug, serde::Serialize)]
struct PluginDeviceInstallationItem {
    #[serde(rename = "deviceId")]
    device_id: String,
    #[serde(rename = "desiredReleaseId")]
    desired_release_id: i64,
    #[serde(rename = "actualReleaseId")]
    actual_release_id: Option<i64>,
    state: String,
    #[serde(rename = "errorCode")]
    error_code: Option<String>,
    #[serde(rename = "errorMessage")]
    error_message: Option<String>,
    #[serde(rename = "attemptCount")]
    attempt_count: i64,
    #[serde(rename = "lastSyncAt")]
    last_sync_at: Option<String>,
    #[serde(rename = "updatedAt")]
    updated_at: String,
}

/// Build one device status entry exactly like `PluginDeviceInstallationItem`.
///
/// `display_device_id` is the deviceId to serialize: the request's
/// `device_id` when the caller matched the coalesced canonical id, otherwise
/// the canonical id itself (source `enrich_installed_list`).
fn device_item(row: &DeviceInstallationRow, display_device_id: &str) -> Map<String, Value> {
    let item = PluginDeviceInstallationItem {
        device_id: display_device_id.to_string(),
        desired_release_id: row.desired_release_id,
        actual_release_id: unset_id(row.actual_release_id),
        state: row.state.clone(),
        error_code: unset_str(&row.error_code).map(str::to_string),
        error_message: unset_str(&row.error_message).map(str::to_string),
        attempt_count: row.attempt_count,
        last_sync_at: unset_datetime(row.last_sync_at)
            .map(|v| v.format("%Y-%m-%dT%H:%M:%S%.6f").to_string()),
        updated_at: row.updated_at.format("%Y-%m-%dT%H:%M:%S%.6f").to_string(),
    };
    serde_json::to_value(item)
        .expect("serializable")
        .as_object()
        .expect("object")
        .clone()
}

/// Convert one kinds row to the API item exactly like
/// `_kind_to_installed_plugin` plus `InstalledPlugin.model_validate`.
///
/// The stored payload is passed through pydantic, which:
/// - injects `metadata.labels.id` from the row id;
/// - fills defaulted fields (`spec.author`, `spec.installState`,
///   `spec.enabled`, `spec.updatePolicy`, `spec.sourceProvider`,
///   `spec.sourceLabel`, `spec.visibility`, `spec.origin`) and normalizes
///   `spec.source`, `spec.components`, and `spec.interface` into their
///   model shapes; and
/// - defaults `status` to `{"state": "Available", "devices": []}`.
pub fn kind_to_item(row: &KindRow) -> Option<Value> {
    let mut payload = row.json.as_object()?.clone();
    let metadata = payload
        .entry("metadata".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    let metadata_map = metadata.as_object_mut()?;
    let labels = metadata_map
        .entry("labels".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if let Some(labels_map) = labels.as_object_mut() {
        labels_map.insert("id".to_string(), Value::String(row.id.to_string()));
    }
    normalize_spec(payload.get_mut("spec")?)?;
    Some(Value::Object(payload))
}

/// Normalize `spec` into the `InstalledPluginSpec` model shape.
fn normalize_spec(spec: &mut Value) -> Option<()> {
    let spec_map = spec.as_object_mut()?;
    // Defaulted scalars and null-optional field.
    spec_map.entry("author".to_string()).or_insert(Value::Null);
    spec_map
        .entry("installState".to_string())
        .or_insert_with(|| Value::String("installed".to_string()));
    spec_map
        .entry("enabled".to_string())
        .or_insert_with(|| Value::from(true));
    spec_map
        .entry("updatePolicy".to_string())
        .or_insert_with(|| Value::String("manual".to_string()));
    spec_map
        .entry("sourceProvider".to_string())
        .or_insert_with(|| Value::String("wegent".to_string()));
    spec_map
        .entry("sourceLabel".to_string())
        .or_insert_with(|| Value::String("Wegent 官方".to_string()));
    spec_map
        .entry("visibility".to_string())
        .or_insert_with(|| Value::String("workspace".to_string()));
    spec_map
        .entry("origin".to_string())
        .or_insert_with(|| Value::String("market".to_string()));
    normalize_source(spec_map.get_mut("source")?);
    normalize_components(spec_map);
    normalize_interface(spec_map);
    Some(())
}

/// Normalize `spec.source` into the `InstalledPluginSource` model shape.
fn normalize_source(source: &mut Value) {
    if !source.is_object() {
        *source = Value::Object(Map::new());
    }
    let map = source.as_object_mut().expect("checked object");
    map.entry("type".to_string())
        .or_insert_with(|| Value::String("upload".to_string()));
    map.entry("providerKey".to_string())
        .or_insert_with(|| Value::String("codex-local".to_string()));
    map.entry("catalogItemId".to_string())
        .or_insert(Value::Null);
    map.entry("marketplace".to_string()).or_insert(Value::Null);
}

/// Normalize `spec.components` into `InstalledPluginComponents` shape.
fn normalize_components(spec: &mut Map<String, Value>) {
    let entry = spec
        .entry("components".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !entry.is_object() {
        *entry = Value::Object(Map::new());
    }
    let components = entry.as_object_mut().expect("checked object");
    for list_field in [
        "skills",
        "commands",
        "agents",
        "hooks",
        "mcps",
        "connectors",
        "lsps",
        "monitors",
        "bins",
    ] {
        components
            .entry(list_field.to_string())
            .or_insert_with(|| Value::Array(Vec::new()));
    }
    components
        .entry("settings".to_string())
        .or_insert(Value::Null);
    components
        .entry("workbench".to_string())
        .or_insert(Value::Null);
    if let Some(connectors) = components
        .get_mut("connectors")
        .and_then(Value::as_array_mut)
    {
        for connector in connectors.iter_mut() {
            normalize_connector(connector);
        }
    }
}

/// Normalize one `spec.components.connectors` entry into the
/// `PluginConnectorComponent` model shape.
fn normalize_connector(connector: &mut Value) {
    if !connector.is_object() {
        return;
    }
    let map = connector.as_object_mut().expect("checked object");
    map.entry("authPolicy".to_string())
        .or_insert_with(|| Value::String("optional".to_string()));
    match map.get_mut("localAuth") {
        Some(local_auth) if local_auth.is_object() => {
            normalize_local_auth(local_auth);
        }
        _ => {}
    }
}

/// Normalize `localAuth` into the `PluginLocalAuthDefinition` model shape.
///
/// Missing fields are defaulted by pydantic on validation, so the API
/// response always carries them (e.g. `tool: null`, `okValues: ["ok"]`).
fn normalize_local_auth(local_auth: &mut Value) {
    let map = local_auth.as_object_mut().expect("checked object");
    map.entry("kind".to_string())
        .or_insert_with(|| Value::String("local_qr".to_string()));
    for field in ["health", "start", "poll", "logout"] {
        map.entry(field.to_string())
            .or_insert_with(|| Value::Array(Vec::new()));
    }
    map.entry("tool".to_string()).or_insert(Value::Null);
    map.entry("qrField".to_string())
        .or_insert_with(|| Value::String("qr_path".to_string()));
    map.entry("statusField".to_string())
        .or_insert_with(|| Value::String("status".to_string()));
    map.entry("okValues".to_string())
        .or_insert_with(|| Value::Array(vec![Value::String("ok".to_string())]));
    map.entry("pollIntervalSeconds".to_string())
        .or_insert_with(|| Value::from(2));
    map.entry("timeoutSeconds".to_string())
        .or_insert_with(|| Value::from(45));
    map.entry("logoutOnUninstall".to_string())
        .or_insert_with(|| Value::from(true));
    if let Some(tool) = map.get_mut("tool") {
        normalize_local_auth_tool(tool);
    }
}

/// Normalize `localAuth.tool` into the `PluginLocalAuthToolDefinition`
/// model shape when present.
fn normalize_local_auth_tool(tool: &mut Value) {
    if !tool.is_object() {
        return;
    }
    let map = tool.as_object_mut().expect("checked object");
    map.entry("version".to_string()).or_insert(Value::Null);
    map.entry("artifacts".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
}

/// Normalize `spec.interface` into `PluginInterface` shape.
fn normalize_interface(spec: &mut Map<String, Value>) {
    let Some(interface) = spec.get_mut("interface") else {
        return;
    };
    if !interface.is_object() {
        // `interface=None` stays null in the model.
        if interface.is_null() {
            return;
        }
        *interface = Value::Object(Map::new());
    }
    let interface = interface.as_object_mut().expect("checked object");
    for field in [
        "displayName",
        "shortDescription",
        "longDescription",
        "developerName",
        "category",
        "websiteUrl",
        "privacyPolicyUrl",
        "termsOfServiceUrl",
        "defaultPrompt",
        "brandColor",
        "composerIcon",
        "logo",
        "logoDark",
    ] {
        interface.entry(field.to_string()).or_insert(Value::Null);
    }
    interface
        .entry("capabilities".to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    interface
        .entry("screenshots".to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
}

/// `plugin_marketplace_service.enrich_installed_list`.
///
/// Appends device rows to each item's status, then rewrites
/// `spec.installState` for a device-filtered view and applies marketplace
/// latest-release comparison.
pub async fn enrich_installed_list<M>(
    mysql: &M,
    items: &mut [Value],
    device_id: Option<&str>,
) -> MysqlResult<()>
where
    M: Mysql,
{
    let mut items_by_id: HashMap<i64, usize> = HashMap::new();
    for (index, item) in items.iter().enumerate() {
        if let Some(id) = installed_item_id(item) {
            items_by_id.insert(id, index);
        }
    }
    let device_rows =
        list_device_installations(mysql, &items_by_id.keys().copied().collect::<Vec<_>>()).await?;
    // Source `coalesce_plugin_device_rows`: resolve canonical device ids and
    // keep the most-recently-reported row per `(installed_kind_id, canonical)`.
    let coalesced = coalesce_plugin_device_rows(mysql, device_rows).await?;
    // Source `enrich_installed_list`: the display loop and `rows_by_install`
    // comprehension each call `plugin_device_id(db, row.user_id, device_id)`
    // for every coalesced row. The result is stable for a given
    // `(user_id, device_id)` pair, but the source emits these redundant DB
    // queries to match. We replicate the same call pattern here, caching the
    // result to avoid re-resolving, while still emitting the same number of
    // `plugin_device_id` calls.
    let mut rows_by_install: HashMap<i64, DeviceInstallationRow> = HashMap::new();
    for ((_, canonical_id), row) in &coalesced {
        let Some(&index) = items_by_id.get(&row.installed_kind_id) else {
            continue;
        };
        // Source display loop: `plugin_device_id(db, row.user_id, device_id)`.
        let resolved = if let Some(device_id) = device_id {
            plugin_device_id(mysql, row.user_id, device_id).await?
        } else {
            canonical_id.clone()
        };
        let display_device_id = match device_id {
            Some(request_id) if resolved == *canonical_id => request_id,
            _ => canonical_id.as_str(),
        };
        append_device(items, index, row, display_device_id);
        // Source `rows_by_install` comprehension also calls
        // `plugin_device_id(db, row.user_id, device_id)`.
        if let Some(device_id) = device_id {
            let resolved2 = plugin_device_id(mysql, row.user_id, device_id).await?;
            if resolved2 == *canonical_id {
                rows_by_install.insert(row.installed_kind_id, row.clone());
            }
        }
    }
    for item in items.iter_mut() {
        let Some(plugin_id) = item
            .get("spec")
            .and_then(|spec| spec.get("pluginId"))
            .and_then(Value::as_i64)
        else {
            continue;
        };
        let installed_id = installed_item_id(item);
        if let (Some(_device_id), Some(installed_id)) = (device_id, installed_id) {
            let device_row = rows_by_install.get(&installed_id);
            if !device_has_materialized_release(device_row) {
                let install_state = item
                    .get_mut("spec")
                    .and_then(|spec| spec.as_object_mut())
                    .expect("items have object specs");
                let derived = match device_row.map(|row| row.state.as_str()) {
                    Some("failed") => "failed",
                    _ => "not_installed",
                };
                install_state.insert(
                    "installState".to_string(),
                    Value::String(derived.to_string()),
                );
                continue;
            }
            let device_row = device_row.expect("materialized implies present");
            let release_id = item
                .get("spec")
                .and_then(|spec| spec.get("releaseId"))
                .and_then(Value::as_i64);
            if release_id.is_some_and(|release| device_row.actual_release_id != release) {
                set_install_state(item, "update_available");
                continue;
            }
            set_install_state(item, "installed");
        }
        let release_id = item
            .get("spec")
            .and_then(|spec| spec.get("releaseId"))
            .and_then(Value::as_i64);
        if let Some(plugin) = get_plugin(mysql, plugin_id).await?
            && release_id.is_some_and(|release| plugin.latest_release_id != release)
        {
            set_install_state(item, "update_available");
        }
    }
    Ok(())
}

fn set_install_state(item: &mut Value, state: &str) {
    if let Some(spec) = item.get_mut("spec").and_then(|spec| spec.as_object_mut()) {
        spec.insert("installState".to_string(), Value::String(state.to_string()));
    }
}

fn append_device(
    items: &mut [Value],
    index: usize,
    row: &DeviceInstallationRow,
    display_device_id: &str,
) {
    let Some(status) = items
        .get_mut(index)
        .and_then(|item| item.get_mut("status"))
        .and_then(|status| status.as_object_mut())
    else {
        return;
    };
    status
        .entry("devices".to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    if let Some(devices) = status.get_mut("devices").and_then(Value::as_array_mut) {
        devices.push(Value::Object(device_item(row, display_device_id)));
    }
}

/// `_installed_item_id`: metadata.labels.id when it is a digit string.
fn installed_item_id(item: &Value) -> Option<i64> {
    let value = item.get("metadata")?.get("labels")?.get("id")?.as_str()?;
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    value.parse().ok()
}

/// `_device_has_materialized_release`: truthy `actual_release_id`.
fn device_has_materialized_release(row: Option<&DeviceInstallationRow>) -> bool {
    row.is_some_and(|row| row.actual_release_id != 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kind_row(id: i64, spec: Value) -> KindRow {
        KindRow {
            id,
            json: serde_json::json!({
                "apiVersion": "agent.example.io/v1",
                "kind": "InstalledPlugin",
                "metadata": {"name": "p", "namespace": "default"},
                "spec": spec,
                "status": {"state": "PendingSync"},
            }),
        }
    }

    #[test]
    fn kind_conversion_injects_id_and_defaults() {
        let row = kind_row(
            273373,
            serde_json::json!({
                "source": {"type": "marketplace", "pluginKey": "k", "catalogItemId": "18"},
                "displayName": "d",
                "interface": {"displayName": "d"},
            }),
        );
        let item = kind_to_item(&row).expect("conversion");
        assert_eq!(item["metadata"]["labels"]["id"].as_str(), Some("273373"));
        let spec = &item["spec"];
        assert_eq!(spec["author"], Value::Null);
        assert_eq!(spec["installState"], "installed");
        assert_eq!(spec["enabled"], true);
        assert_eq!(spec["updatePolicy"], "manual");
        assert_eq!(spec["sourceProvider"], "wegent");
        assert_eq!(spec["sourceLabel"], "Wegent 官方");
        assert_eq!(spec["visibility"], "workspace");
        assert_eq!(spec["origin"], "market");
        assert!(spec["components"]["skills"].is_array());
        assert_eq!(spec["components"]["settings"], Value::Null);
        let interface = &spec["interface"];
        assert_eq!(interface["websiteUrl"], Value::Null);
        assert_eq!(interface["screenshots"], serde_json::json!([]));
        assert_eq!(item["status"]["state"], "PendingSync");
    }

    #[test]
    fn connector_local_auth_defaults_are_filled() {
        let row = kind_row(
            1,
            serde_json::json!({
                "source": {"type": "marketplace", "pluginKey": "k"},
                "displayName": "d",
                "components": {"connectors": [{
                    "slug": "example-email",
                    "localAuth": {
                        "kind": "browser_oauth",
                        "start": ["scripts/local-auth.sh", "login"],
                        "health": ["scripts/local-auth.sh", "health"],
                        "logout": ["scripts/local-auth.sh", "logout"],
                        "timeoutSeconds": 420,
                        "logoutOnUninstall": true
                    },
                    "authPolicy": "on_install"
                }]},
            }),
        );
        let item = kind_to_item(&row).expect("conversion");
        let connector = &item["spec"]["components"]["connectors"][0];
        assert_eq!(connector["authPolicy"], "on_install");
        let local_auth = &connector["localAuth"];
        assert_eq!(local_auth["kind"], "browser_oauth");
        assert_eq!(local_auth["tool"], Value::Null);
        assert_eq!(local_auth["poll"], serde_json::json!([]));
        assert_eq!(local_auth["qrField"], "qr_path");
        assert_eq!(local_auth["statusField"], "status");
        assert_eq!(local_auth["okValues"], serde_json::json!(["ok"]));
        assert_eq!(local_auth["pollIntervalSeconds"], 2);
        assert_eq!(local_auth["timeoutSeconds"], 420);
        assert_eq!(local_auth["logoutOnUninstall"], true);
    }

    #[test]
    fn id_sentinels_map_back_to_null() {
        assert_eq!(unset_id(0), None);
        assert_eq!(unset_id(77), Some(77));
        assert_eq!(unset_str(""), None);
        assert_eq!(unset_str("x"), Some("x"));
        assert_eq!(unset_datetime(EPOCH), None);
        assert!(unset_datetime(EPOCH + chrono::Duration::seconds(1)).is_some());
    }

    #[test]
    fn installed_item_id_requires_digits() {
        let item = serde_json::json!({"metadata": {"labels": {"id": "42"}}});
        assert_eq!(installed_item_id(&item), Some(42));
        let bad = serde_json::json!({"metadata": {"labels": {"id": "4a"}}});
        assert_eq!(installed_item_id(&bad), None);
        let missing = serde_json::json!({"metadata": {}});
        assert_eq!(installed_item_id(&missing), None);
    }

    #[test]
    fn device_item_serializes_model_shape() {
        let row = DeviceInstallationRow {
            installed_kind_id: 1,
            user_id: 29,
            device_id: "dev".to_string(),
            desired_release_id: 77,
            actual_release_id: 0,
            state: "pending".to_string(),
            error_code: String::new(),
            error_message: String::new(),
            attempt_count: 0,
            last_sync_at: EPOCH,
            updated_at: NaiveDateTime::parse_from_str(
                "2026-09-01 14:06:57.933835",
                "%Y-%m-%d %H:%M:%S%.6f",
            )
            .unwrap(),
        };
        let item = Value::Object(device_item(&row, "dev"));
        assert_eq!(item["deviceId"], "dev");
        assert_eq!(item["actualReleaseId"], Value::Null);
        assert_eq!(item["errorCode"], Value::Null);
        assert_eq!(item["lastSyncAt"], Value::Null);
        assert_eq!(item["updatedAt"], "2026-09-01T14:06:57.933835");
        assert_eq!(item["desiredReleaseId"], 77);
    }

    #[test]
    fn record_id_from_route_matches_source() {
        assert_eq!(record_id_from_route("app-record-268663"), Some(268663));
        assert_eq!(record_id_from_route("app-record-0"), None);
        assert_eq!(record_id_from_route("app-record-abc"), None);
        assert_eq!(record_id_from_route("electron-abc"), None);
        assert_eq!(record_id_from_route(""), None);
    }

    #[test]
    fn app_device_canonical_id_is_record_route() {
        let row = DeviceKindRow {
            id: 268663,
            name: "local-device".to_string(),
            json: serde_json::json!({
                "spec": {"deviceType": "app", "appDeviceId": "electron-xyz"}
            }),
        };
        assert_eq!(canonical_device_id(&row), "app-record-268663");
    }

    #[test]
    fn local_device_canonical_id_is_name() {
        let row = DeviceKindRow {
            id: 239058,
            name: "3d66bfaa".to_string(),
            json: serde_json::json!({
                "spec": {"deviceType": "local", "deviceId": "3d66bfaa"}
            }),
        };
        assert_eq!(canonical_device_id(&row), "3d66bfaa");
    }

    #[test]
    fn cloud_device_canonical_id_is_name() {
        let row = DeviceKindRow {
            id: 241960,
            name: "8afb8635".to_string(),
            json: serde_json::json!({
                "spec": {"deviceType": "cloud", "deviceId": "8afb8635", "cloudConfig": {}}
            }),
        };
        assert_eq!(canonical_device_id(&row), "8afb8635");
    }
}
