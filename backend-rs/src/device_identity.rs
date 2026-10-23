// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Shared owned-device identity and runtime-route resolution.
//!
//! Source: `app/services/device/identity.py`,
//! `app/services/device/runtime_route.py`, and
//! `app/services/plugin_device_identity.py`. Resolves a submitted device id to
//! its canonical identity and coalesces `plugin_device_installations` rows.
//! Used by plugin APIs and project session bindings.

use brz_mysql::{FromMysqlRow, Mysql, MysqlResult, MysqlTransaction};
use chrono::NaiveDateTime;
use serde::Deserialize;
use std::collections::HashMap;

use crate::plugins_marketplace::query::PluginQuery;

/// Prefix for the App device transport route
/// (`app/services/device/identity.py::RECORD_ROUTE_PREFIX`).
const RECORD_ROUTE_PREFIX: &str = "app-record-";

/// Source `kinds` Device filter (`resolve_owned_device_alias` base query).
pub(crate) const KINDS_DEVICE_QUERY: &str = "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
     kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
     kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
     kinds.updated_at AS kinds_updated_at FROM kinds \
     WHERE kinds.user_id = ? AND kinds.kind = 'Device' \
     AND kinds.namespace = 'default' AND kinds.is_active = true";

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
    #[serde(default, rename = "runtimeInstanceId")]
    runtime_instance_id: Option<String>,
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

/// Source `app/services/device/identity.py::record_id_from_route`: extract a
/// persisted Device record id from an App transport route.
pub(crate) fn record_id_from_route(device_id: &str) -> Option<i64> {
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
pub enum DeviceType {
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

    /// `DeviceType.value`: the lowercase member value persisted on the CRD.
    #[must_use]
    pub fn value(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::App => "app",
            Self::Cloud => "cloud",
            Self::Remote => "remote",
        }
    }
}

/// Source `app/services/device/identity.py::record_route_id`.
pub(crate) fn record_route_id(device: &DeviceKindRow) -> String {
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

/// Resolve aliases inside the already owner-scoped set of active devices.
fn resolve_device_alias<'a>(
    devices: &'a [DeviceKindRow],
    device_id: &str,
) -> Option<&'a DeviceKindRow> {
    let submitted = device_id.trim();
    if submitted.is_empty() {
        return None;
    }
    if let Some(record_id) = record_id_from_route(submitted) {
        return devices.iter().find(|device| {
            device.id == record_id && DeviceType::from_spec(&device.spec()) == DeviceType::App
        });
    }
    let matches: Vec<_> = devices
        .iter()
        .filter(|device| device_identity_ids(device).iter().any(|id| id == submitted))
        .collect();
    if matches.len() == 1 {
        return Some(matches[0]);
    }
    let app_matches: Vec<_> = matches
        .into_iter()
        .filter(|device| DeviceType::from_spec(&device.spec()) == DeviceType::App)
        .collect();
    (app_matches.len() == 1).then(|| app_matches[0])
}

/// Source `app/services/device/identity.py::resolve_owned_device_alias`.
///
/// Returns the resolved device row, or `None` when no unambiguous match
/// exists. Mirrors the SQLAlchemy filter exactly: `user_id`, `kind='Device'`,
/// `namespace='default'`, `is_active=true`.
pub(crate) async fn resolve_owned_device_alias<M>(
    mysql: &M,
    user_id: i64,
    device_id: &str,
) -> MysqlResult<Option<DeviceKindRow>>
where
    M: Mysql,
{
    let mut query = mysql;
    resolve_owned_device_alias_on(&mut query, user_id, device_id).await
}

/// `resolve_owned_device_alias` on a borrowed session handle: the shared pool
/// for read-only callers, or the handler's pinned transaction when the source
/// session carries a lock or write.
pub(crate) async fn resolve_owned_device_alias_on<Q>(
    query: &mut Q,
    user_id: i64,
    device_id: &str,
) -> MysqlResult<Option<DeviceKindRow>>
where
    Q: PluginQuery,
{
    let submitted = device_id.trim();
    if submitted.is_empty() {
        return Ok(None);
    }
    if let Some(record_id) = record_id_from_route(submitted) {
        // Source `query.filter_by(id=record_id).one_or_none()`; the SQLAlchemy
        // filter appends `AND kinds.id = ?` to the base filter.
        let sql = format!("{KINDS_DEVICE_QUERY} AND kinds.id = ?");
        let row: Option<DeviceKindRow> = query.fetch_optional(sql, (user_id, record_id)).await?;
        return Ok(
            row.and_then(|d| (DeviceType::from_spec(&d.spec()) == DeviceType::App).then_some(d))
        );
    }
    let all: Vec<DeviceKindRow> = query.fetch_all(KINDS_DEVICE_QUERY, (user_id,)).await?;
    Ok(resolve_device_alias(&all, submitted).cloned())
}

/// Return aliases that unambiguously identify the same user-owned device.
/// Unknown or ambiguous input retains its existing exact-address semantics.
pub(crate) async fn owned_device_identity_ids<M>(
    mysql: &M,
    user_id: i64,
    device_id: &str,
) -> MysqlResult<Vec<String>>
where
    M: Mysql,
{
    let devices: Vec<DeviceKindRow> = mysql.fetch_all(KINDS_DEVICE_QUERY, (user_id,)).await?;
    Ok(unambiguous_device_identity_ids(&devices, device_id))
}

fn unambiguous_device_identity_ids(devices: &[DeviceKindRow], device_id: &str) -> Vec<String> {
    let mut aliases = vec![device_id.to_owned()];
    let Some(device) = resolve_device_alias(devices, device_id) else {
        return aliases;
    };
    for alias in device_identity_ids(device) {
        if resolve_device_alias(devices, &alias).map(|resolved| resolved.id) == Some(device.id)
            && !aliases.contains(&alias)
        {
            aliases.push(alias);
        }
    }
    aliases
}

/// Source `app/services/device/runtime_route.py::RuntimeRouteIdentity`, the
/// database-owned mapping between a logical device identity and its Runtime
/// route.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeRouteIdentity {
    /// `logical_device_id`: the Kind `name`, or `app-record-<id>` for App
    /// devices (`_identity_from_device` -> `record_route_id`).
    pub logical_device_id: String,
    /// `device_type`: the normalized `spec.deviceType`.
    pub device_type: DeviceType,
    /// `runtime_device_id`: the transport identity used for the Redis online
    /// key and the Socket.IO room (`_runtime_device_id`).
    pub runtime_device_id: String,
    /// `runtime_instance_id`: the pinned installation identity, when the
    /// device registered one.
    pub runtime_instance_id: Option<String>,
}

/// Source `app/services/device/runtime_route.py::resolve_runtime_route_identity`:
/// resolve one submitted device id within the owner's active devices.
///
/// `None` covers both the no-unambiguous-match result of
/// `resolve_owned_device_alias` and a row whose `runtime_device_route_id` is
/// empty (`_identity_from_device`), which the session endpoints render as
/// `DeviceSessionNotFoundError`.
pub async fn resolve_runtime_route_identity<M>(
    mysql: &M,
    user_id: i64,
    submitted_device_id: &str,
) -> MysqlResult<Option<RuntimeRouteIdentity>>
where
    M: Mysql,
{
    let Some(device) = resolve_owned_device_alias(mysql, user_id, submitted_device_id).await?
    else {
        return Ok(None);
    };
    Ok(identity_from_device(&device))
}

/// Source `app/services/device/runtime_route.py::_identity_from_device`.
fn identity_from_device(device: &DeviceKindRow) -> Option<RuntimeRouteIdentity> {
    let runtime_device_id = runtime_device_id(device);
    // `if not runtime_device_id: return None`.
    if runtime_device_id.is_empty() {
        return None;
    }
    Some(RuntimeRouteIdentity {
        logical_device_id: record_route_id(device),
        device_type: DeviceType::from_spec(&device.spec()),
        runtime_device_id,
        runtime_instance_id: runtime_instance_id(device),
    })
}

/// Source `app/services/device/runtime_route.py::_runtime_instance_id`.
fn runtime_instance_id(device: &DeviceKindRow) -> Option<String> {
    device
        .spec()
        .runtime_instance_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
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
pub async fn plugin_device_id<M>(mysql: &M, user_id: i64, device_id: &str) -> MysqlResult<String>
where
    M: Mysql,
{
    let mut query = mysql;
    plugin_device_id_on(&mut query, user_id, device_id).await
}

/// `plugin_device_id` on a borrowed session handle.
pub(crate) async fn plugin_device_id_on<Q>(
    query: &mut Q,
    user_id: i64,
    device_id: &str,
) -> MysqlResult<String>
where
    Q: PluginQuery,
{
    Ok(
        match resolve_owned_device_alias_on(query, user_id, device_id).await? {
            Some(device) => canonical_device_id(&device),
            None => device_id.trim().to_string(),
        },
    )
}

/// Row abstraction for `coalesce_plugin_device_rows`, letting the marketplace
/// and installed-plugin APIs share the source coalescing contract while each
/// keeps its own recorded column projection.
pub trait DeviceRow {
    fn user_id(&self) -> i64;
    fn device_id(&self) -> &str;
    fn installed_kind_id(&self) -> i64;
    fn last_sync_at(&self) -> NaiveDateTime;
    fn updated_at(&self) -> NaiveDateTime;
}

/// Source `app/services/device/runtime_route.py::_state_order`.
///
/// `datetime.min` is the source's fallback for null timestamps; the DB
/// columns are `NOT NULL`, so `NaiveDateTime` is always present.
fn state_order<R: DeviceRow>(row: &R, canonical_id: &str) -> (NaiveDateTime, NaiveDateTime, bool) {
    (
        row.last_sync_at(),
        row.updated_at(),
        row.device_id() == canonical_id,
    )
}

/// Source `app/services/plugin_device_identity.py::coalesce_plugin_device_rows`.
///
/// Returns `(installed_kind_id, canonical_id) -> selected_row` as an
/// insertion-ordered vector, mirroring the source's Python dict (which
/// preserves insertion order). The identity cache mirrors the source: one
/// `plugin_device_id` call per unique `(user_id, device_id)` pair.
pub async fn coalesce_plugin_device_rows<M, R>(
    mysql: &M,
    rows: Vec<R>,
) -> MysqlResult<Vec<((i64, String), R)>>
where
    M: Mysql,
    R: DeviceRow + Clone,
{
    let mut query = mysql;
    coalesce_plugin_device_rows_on(&mut query, rows).await
}

/// `coalesce_plugin_device_rows` on a borrowed session handle.
pub(crate) async fn coalesce_plugin_device_rows_on<Q, R>(
    query: &mut Q,
    rows: Vec<R>,
) -> MysqlResult<Vec<((i64, String), R)>>
where
    Q: PluginQuery,
    R: DeviceRow + Clone,
{
    let mut identities: HashMap<(i64, String), String> = HashMap::new();
    let mut selected: Vec<((i64, String), R)> = Vec::new();
    let mut seen: HashMap<(i64, String), usize> = HashMap::new();
    for row in &rows {
        let identity_key = (row.user_id(), row.device_id().to_string());
        if !identities.contains_key(&identity_key) {
            let canonical = plugin_device_id_on(query, row.user_id(), row.device_id()).await?;
            identities.insert(identity_key.clone(), canonical);
        }
        let canonical_id = identities.get(&identity_key).expect("populated").clone();
        let key = (row.installed_kind_id(), canonical_id.clone());
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

/// Full `plugin_device_installations` row used by `reconcile_plugin_device_rows`
/// (`app/models/plugin_marketplace.py::PluginDeviceInstallation`). The aliases
/// mirror SQLAlchemy's `db.query(...).with_for_update()` projection so the
/// prepared statement matches the recorded `FOR UPDATE` exchange.
#[derive(Debug, Clone, FromMysqlRow)]
pub struct PluginDeviceInstallationRow {
    #[mysql(rename = "plugin_device_installations_id")]
    pub id: i64,
    #[mysql(rename = "plugin_device_installations_installed_kind_id")]
    pub installed_kind_id: i64,
    #[mysql(rename = "plugin_device_installations_user_id")]
    pub user_id: i64,
    #[mysql(rename = "plugin_device_installations_device_id")]
    pub device_id: String,
    #[mysql(rename = "plugin_device_installations_desired_release_id")]
    pub desired_release_id: i64,
    #[mysql(rename = "plugin_device_installations_actual_release_id")]
    pub actual_release_id: i64,
    #[mysql(rename = "plugin_device_installations_state")]
    pub state: String,
    #[mysql(rename = "plugin_device_installations_error_code")]
    pub error_code: String,
    #[mysql(rename = "plugin_device_installations_error_message")]
    pub error_message: String,
    #[mysql(rename = "plugin_device_installations_attempt_count")]
    pub attempt_count: i64,
    #[mysql(rename = "plugin_device_installations_last_sync_at")]
    pub last_sync_at: NaiveDateTime,
    #[mysql(rename = "plugin_device_installations_updated_at")]
    pub updated_at: NaiveDateTime,
}

impl DeviceRow for PluginDeviceInstallationRow {
    fn user_id(&self) -> i64 {
        self.user_id
    }

    fn device_id(&self) -> &str {
        &self.device_id
    }

    fn installed_kind_id(&self) -> i64 {
        self.installed_kind_id
    }

    fn last_sync_at(&self) -> NaiveDateTime {
        self.last_sync_at
    }

    fn updated_at(&self) -> NaiveDateTime {
        self.updated_at
    }
}

/// `reconcile_plugin_device_rows` needs the primary key to delete superseded
/// alias rows and to update the retained rows' canonical `device_id`.
pub trait ReconcileRow: DeviceRow {
    fn id(&self) -> i64;
}

impl ReconcileRow for PluginDeviceInstallationRow {
    fn id(&self) -> i64 {
        self.id
    }
}

/// `db.query(PluginDeviceInstallation).filter(user_id=...).with_for_update()`:
/// every mapped column with its SQLAlchemy alias.
const RECONCILE_SELECT_QUERY: &str = "SELECT plugin_device_installations.id AS plugin_device_installations_id, \
     plugin_device_installations.installed_kind_id AS plugin_device_installations_installed_kind_id, \
     plugin_device_installations.user_id AS plugin_device_installations_user_id, \
     plugin_device_installations.device_id AS plugin_device_installations_device_id, \
     plugin_device_installations.desired_release_id AS plugin_device_installations_desired_release_id, \
     plugin_device_installations.actual_release_id AS plugin_device_installations_actual_release_id, \
     plugin_device_installations.state AS plugin_device_installations_state, \
     plugin_device_installations.error_code AS plugin_device_installations_error_code, \
     plugin_device_installations.error_message AS plugin_device_installations_error_message, \
     plugin_device_installations.attempt_count AS plugin_device_installations_attempt_count, \
     plugin_device_installations.last_sync_at AS plugin_device_installations_last_sync_at, \
     plugin_device_installations.updated_at AS plugin_device_installations_updated_at \
     FROM plugin_device_installations \
     WHERE plugin_device_installations.user_id = ? FOR UPDATE";

/// `db.delete(row)`: SQLAlchemy deletes by primary key.
const DELETE_ROW_QUERY: &str =
    "DELETE FROM plugin_device_installations WHERE plugin_device_installations.id = ?";

/// `row.device_id = canonical_id`: the flush of the rewritten canonical alias.
const UPDATE_DEVICE_ID_QUERY: &str =
    "UPDATE plugin_device_installations SET device_id=? WHERE plugin_device_installations.id = ?";

/// Source `app/services/plugin_device_identity.py::reconcile_plugin_device_rows`.
///
/// Converges legacy alias rows within the caller's write transaction. It locks
/// the user's rows `FOR UPDATE`, coalesces them to one row per
/// `(installed_kind_id, canonical device)`, deletes the superseded alias rows,
/// then rewrites each retained row's `device_id` to its canonical id. Identity
/// reads go through the pooled handle (`mysql`) because
/// `coalesce_plugin_device_rows` resolves `plugin_device_id` per unique
/// `(user_id, device_id)` pair, exactly like the source.
///
/// Returns the retained rows in `FOR UPDATE` load order. The source session's
/// identity map keeps exactly these rows in that order, and a later
/// `db.commit()` flush (e.g. `ensure_pending_for_device`'s pending UPDATEs)
/// emits its UPDATE statements in this order, not in the caller's iteration
/// order.
pub async fn reconcile_plugin_device_rows<T, M, R>(
    mut transaction: &mut T,
    mysql: &M,
    user_id: i64,
) -> MysqlResult<Vec<R>>
where
    T: MysqlTransaction,
    M: Mysql,
    R: ReconcileRow + Clone + FromMysqlRow + Send,
{
    let rows: Vec<R> = transaction
        .fetch_all(RECONCILE_SELECT_QUERY, (user_id,))
        .await?;
    let selected = coalesce_plugin_device_rows(mysql, rows.clone()).await?;
    converge_plugin_device_rows(&mut transaction, rows, &selected).await
}

/// `reconcile_plugin_device_rows` on one borrowed session handle.
///
/// The source locks, resolves, and rewrites the rows inside one request
/// session; callers that already own that session's transaction pass it here
/// so the identity reads stay on the pinned connection.
pub(crate) async fn reconcile_plugin_device_rows_on<Q, R>(
    query: &mut Q,
    user_id: i64,
) -> MysqlResult<Vec<R>>
where
    Q: PluginQuery,
    R: ReconcileRow + Clone + FromMysqlRow + Send,
{
    let rows: Vec<R> = query.fetch_all(RECONCILE_SELECT_QUERY, (user_id,)).await?;
    let selected = coalesce_plugin_device_rows_on(query, rows.clone()).await?;
    converge_plugin_device_rows(query, rows, &selected).await
}

/// Delete the superseded alias rows and rewrite each retained row's
/// `device_id`, then return the retained rows in `FOR UPDATE` load order.
async fn converge_plugin_device_rows<Q, R>(
    query: &mut Q,
    rows: Vec<R>,
    selected: &[((i64, String), R)],
) -> MysqlResult<Vec<R>>
where
    Q: PluginQuery,
    R: ReconcileRow + Clone + Send,
{
    let retained: std::collections::HashSet<i64> =
        selected.iter().map(|(_, row)| row.id()).collect();
    for row in &rows {
        if !retained.contains(&row.id()) {
            query.execute(DELETE_ROW_QUERY, (row.id(),)).await?;
        }
    }
    for ((_, canonical_id), row) in selected {
        if row.device_id() != canonical_id {
            query
                .execute(UPDATE_DEVICE_ID_QUERY, (canonical_id.as_str(), row.id()))
                .await?;
        }
    }
    // Identity-map order after the deletes and rewrites: the retained rows in
    // `FOR UPDATE` load order (primary key ascending).
    Ok(rows
        .into_iter()
        .filter(|row| retained.contains(&row.id()))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

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

    fn app_device(id: i64, app_id: &str) -> DeviceKindRow {
        DeviceKindRow {
            id,
            name: "logical-device".to_owned(),
            json: serde_json::json!({
                "spec": {
                    "deviceType": "app",
                    "deviceId": "runtime-device",
                    "appDeviceId": app_id,
                }
            }),
        }
    }

    #[test]
    fn session_aliases_resolve_both_app_and_record_addresses() {
        let devices = [app_device(7, "electron-app")];
        for submitted in ["electron-app", "app-record-7", "logical-device"] {
            let aliases = unambiguous_device_identity_ids(&devices, submitted);
            assert_eq!(aliases.first().map(String::as_str), Some(submitted));
            for expected in [
                "electron-app",
                "app-record-7",
                "logical-device",
                "runtime-device",
            ] {
                assert!(aliases.iter().any(|alias| alias == expected));
            }
            assert_eq!(aliases.len(), 4);
        }
    }

    #[test]
    fn session_aliases_exclude_shared_names_of_distinct_app_installations() {
        let devices = [
            app_device(7, "electron-first"),
            app_device(8, "electron-second"),
        ];
        assert_eq!(
            unambiguous_device_identity_ids(&devices, "app-record-7"),
            ["app-record-7", "electron-first"]
        );
        assert_eq!(
            unambiguous_device_identity_ids(&devices, "electron-second"),
            ["electron-second", "app-record-8"]
        );
        for ambiguous in ["logical-device", "runtime-device"] {
            assert_eq!(
                unambiguous_device_identity_ids(&devices, ambiguous),
                [ambiguous]
            );
        }
    }

    #[test]
    fn session_aliases_preserve_the_existing_unique_app_preference() {
        let devices = [
            app_device(7, "electron-app"),
            DeviceKindRow {
                id: 8,
                name: "logical-device".to_owned(),
                json: serde_json::json!({"spec": {"deviceType": "local"}}),
            },
        ];
        assert_eq!(
            resolve_device_alias(&devices, "logical-device").unwrap().id,
            7
        );
        assert!(
            unambiguous_device_identity_ids(&devices, "app-record-7")
                .iter()
                .any(|alias| alias == "logical-device")
        );
    }

    #[test]
    fn session_aliases_keep_unknown_and_foreign_record_addresses_exact() {
        let devices = [app_device(7, "electron-app")];
        for submitted in ["app-record-8", " unknown-device ", ""] {
            assert_eq!(
                unambiguous_device_identity_ids(&devices, submitted),
                [submitted]
            );
        }
    }

    #[tokio::test]
    async fn session_aliases_load_only_the_owners_active_default_devices() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        assert_eq!(
            owned_device_identity_ids(&mysql, 19, "electron-app")
                .await
                .unwrap(),
            ["electron-app"]
        );
        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        assert_eq!(queries[0].first_integer, Some(19));
        assert_eq!(queries[0].args, 1);
        for filter in [
            "kinds.user_id = ?",
            "kinds.kind = 'Device'",
            "kinds.namespace = 'default'",
            "kinds.is_active = true",
        ] {
            assert!(queries[0].sql.contains(filter));
        }
    }

    #[test]
    fn runtime_route_identity_reduces_the_source_members() {
        let row = DeviceKindRow {
            id: 241960,
            name: "8afb8635".to_string(),
            json: serde_json::json!({
                "spec": {
                    "deviceType": "cloud",
                    "deviceId": "8afb8635",
                    "cloudConfig": {"deviceId": "sb-1"}
                }
            }),
        };
        let identity = identity_from_device(&row).expect("cloud identity");
        assert_eq!(identity.logical_device_id, "8afb8635");
        assert_eq!(identity.device_type, DeviceType::Cloud);
        assert_eq!(identity.device_type.value(), "cloud");

        // App devices keep the record route as their logical identity.
        let app = DeviceKindRow {
            id: 268663,
            name: "local-device".to_string(),
            json: serde_json::json!({"spec": {"deviceType": "app"}}),
        };
        let identity = identity_from_device(&app).expect("app identity");
        assert_eq!(identity.logical_device_id, "app-record-268663");
        assert_eq!(identity.device_type, DeviceType::App);

        // No runtime route id means no identity, like `_identity_from_device`.
        let unroutable = DeviceKindRow {
            id: 9,
            name: String::new(),
            json: serde_json::json!({"spec": {"deviceType": "local"}}),
        };
        assert!(identity_from_device(&unroutable).is_none());
    }
}
