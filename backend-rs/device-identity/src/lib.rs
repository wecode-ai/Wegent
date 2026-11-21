// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Shared owned-device identity and runtime-route resolution.
//!
//! Source: `app/services/device/identity.py`,
//! `app/services/device/runtime_route.py`, and
//! `app/services/plugin_device_identity.py`. Resolves a submitted device id to
//! its canonical identity and runtime route.
//! Used by plugin APIs and project session bindings.

#![forbid(unsafe_code)]

use brz_mysql::{FromMysqlRow, Mysql, MysqlResult};
use serde::Deserialize;
use std::collections::HashSet;

use wegent_backend_persistence::mysql_query::MysqlQuery;

mod snapshot;
pub use snapshot::DeviceIdentitySnapshot;

/// `lock_device_owner` (`identity.lock_device_owner`): the owner row lock that
/// serializes registration against deletion. Shared by the delete endpoint and
/// the `/local-executor` registration path.
pub const LOCK_DEVICE_OWNER_QUERY: &str = "SELECT users.id AS users_id \n\
     FROM users \n\
     WHERE users.id = ? \n LIMIT 1 FOR UPDATE";

pub async fn lock_device_owner(
    transaction: &mut impl brz_mysql::MysqlTransaction,
    user_id: i64,
) -> MysqlResult<()> {
    let _owner: Option<LockOwnerRow> = transaction
        .fetch_optional(LOCK_DEVICE_OWNER_QUERY, (user_id,))
        .await?;
    Ok(())
}

/// The `users` row lock `lock_device_owner` takes; only its presence matters.
#[derive(brz_mysql::FromMysqlRow)]
struct LockOwnerRow {
    #[allow(dead_code, reason = "the row's presence is the whole answer")]
    #[mysql(rename = "users_id")]
    users_id: i32,
}

/// Prefix for the App device transport route
/// (`app/services/device/identity.py::RECORD_ROUTE_PREFIX`).
const RECORD_ROUTE_PREFIX: &str = "app-record-";

/// Active devices in the owner's default namespace.
pub const KINDS_DEVICE_QUERY: &str = "SELECT kinds.id AS kinds_id, \
     kinds.name AS kinds_name, kinds.json AS kinds_json FROM kinds \
     WHERE kinds.user_id = ? AND kinds.kind = 'Device' \
     AND kinds.namespace = 'default' AND kinds.is_active = true";

/// The device identity and Runtime configuration consumed by alias resolution.
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
    /// `remote_control_is_enabled`: unknown explicit types never gain controls.
    pub fn remote_control_enabled(&self) -> bool {
        match self
            .json
            .get("spec")
            .and_then(|spec| spec.get("deviceType"))
        {
            None => true,
            Some(serde_json::Value::String(kind)) => {
                matches!(kind.as_str(), "local" | "cloud" | "remote")
            }
            Some(_) => false,
        }
    }

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
pub fn record_id_from_route(device_id: &str) -> Option<i64> {
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

/// Source `app/services/device/identity.py::device_kind_type`.
pub fn is_app_device(device: &DeviceKindRow) -> bool {
    DeviceType::from_spec(&device.spec()) == DeviceType::App
}

/// `device_connection_route_id`: the transport identity used by the device's
/// heartbeat connection (`app/services/device/identity.py:57`).
pub fn device_connection_route_id(device: &DeviceKindRow) -> String {
    if DeviceType::from_spec(&device.spec()) == DeviceType::Cloud {
        let spec = device.spec();
        let cloud = spec
            .cloud_config
            .as_ref()
            .and_then(|config| config.device_id.clone());
        return spec
            .device_id
            .filter(|value| !value.is_empty())
            .or_else(|| cloud.filter(|value| !value.is_empty()))
            .unwrap_or_else(|| device.name.clone());
    }
    record_route_id(device)
}

/// Source `app/services/device/identity.py::record_route_id`.
pub fn record_route_id(device: &DeviceKindRow) -> String {
    if DeviceType::from_spec(&device.spec()) == DeviceType::App {
        format!("{RECORD_ROUTE_PREFIX}{}", device.id)
    } else {
        device.name.clone()
    }
}

/// Source `app/services/device/identity.py::device_identity_ids`.
pub fn device_identity_ids(device: &DeviceKindRow) -> Vec<String> {
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
pub fn resolve_device_alias<'a>(
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
pub async fn resolve_owned_device_alias<M>(
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
pub async fn resolve_owned_device_alias_on<Q>(
    query: &mut Q,
    user_id: i64,
    device_id: &str,
) -> MysqlResult<Option<DeviceKindRow>>
where
    Q: MysqlQuery,
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

/// Resolve dispatch addresses by transport route, then by their logical aliases.
pub async fn resolve_device_for_binding_on<Q: MysqlQuery>(
    query: &mut Q,
    user_id: i64,
    device_id: &str,
) -> MysqlResult<Option<DeviceKindRow>> {
    let submitted = device_id.trim();
    if record_id_from_route(submitted).is_some() {
        return resolve_owned_device_alias_on(query, user_id, submitted).await;
    }
    let devices: Vec<DeviceKindRow> = query.fetch_all(KINDS_DEVICE_QUERY, (user_id,)).await?;
    Ok(resolve_device_for_binding(&devices, submitted).cloned())
}

fn resolve_device_for_binding<'a>(
    devices: &'a [DeviceKindRow],
    submitted: &str,
) -> Option<&'a DeviceKindRow> {
    if submitted.is_empty() {
        return None;
    }
    let mut exact = devices
        .iter()
        .filter(|device| device_connection_route_id(device) == submitted);
    match exact.next() {
        Some(device) if exact.next().is_none() => Some(device),
        Some(_) => None,
        None => resolve_device_alias(devices, submitted),
    }
}

/// Match the connection route before considering any logical aliases.
pub async fn active_device_connection_on<Q: MysqlQuery>(
    query: &mut Q,
    user_id: i64,
    route_id: &str,
    instance: Option<&str>,
) -> MysqlResult<bool> {
    if let Some(record_id) = record_id_from_route(route_id) {
        let sql = format!("{KINDS_DEVICE_QUERY} AND kinds.id = ?");
        let device: Option<DeviceKindRow> = query.fetch_optional(sql, (user_id, record_id)).await?;
        return Ok(
            device.is_some_and(|device| matches_device_connection(&device, route_id, instance))
        );
    }
    let devices: Vec<DeviceKindRow> = query.fetch_all(KINDS_DEVICE_QUERY, (user_id,)).await?;
    Ok(devices
        .iter()
        .any(|device| matches_device_connection(device, route_id, instance)))
}

fn matches_device_connection(
    device: &DeviceKindRow,
    route_id: &str,
    instance: Option<&str>,
) -> bool {
    device_connection_route_id(device) == route_id
        && device.json["spec"]["runtimeInstanceId"]
            .as_str()
            .filter(|id| !id.is_empty())
            == instance.filter(|id| !id.is_empty())
}

/// Return aliases that unambiguously identify the same user-owned device.
/// Unknown or ambiguous input retains its existing exact-address semantics.
pub async fn owned_device_identity_ids<M>(
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

pub fn unambiguous_device_identity_ids(devices: &[DeviceKindRow], device_id: &str) -> Vec<String> {
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
    /// The local executor identity reported by an App installation.
    pub app_device_id: Option<String>,
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
    let mut query = mysql;
    resolve_runtime_route_identity_on(&mut query, user_id, submitted_device_id).await
}

/// `resolve_runtime_route_identity` on a borrowed session handle: the shared
/// pool for read-only callers, or the request-session transaction.
pub async fn resolve_runtime_route_identity_on<Q>(
    query: &mut Q,
    user_id: i64,
    submitted_device_id: &str,
) -> MysqlResult<Option<RuntimeRouteIdentity>>
where
    Q: MysqlQuery,
{
    let Some(device) = resolve_owned_device_alias_on(query, user_id, submitted_device_id).await?
    else {
        return Ok(None);
    };
    Ok(identity_from_device(&device))
}

/// Source `app/services/device/runtime_route.py::_identity_from_device`.
pub fn identity_from_device(device: &DeviceKindRow) -> Option<RuntimeRouteIdentity> {
    let runtime_device_id = runtime_device_id(device);
    // `if not runtime_device_id: return None`.
    if runtime_device_id.is_empty() {
        return None;
    }
    Some(RuntimeRouteIdentity {
        logical_device_id: record_route_id(device),
        device_type: DeviceType::from_spec(&device.spec()),
        runtime_device_id,
        app_device_id: device
            .spec()
            .app_device_id
            .filter(|id| !id.trim().is_empty()),
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
pub fn runtime_device_id(device: &DeviceKindRow) -> String {
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

/// Source `app/services/plugin_device_identity.py::resolve_plugin_runtime_device_id`:
/// resolve an owned plugin target, including registered cloud socket aliases.
///
/// The leading read lists the owner's active devices to detect a cloud route;
/// the identity then resolves through `resolve_runtime_route_identity` exactly
/// like the source's second read.
/// `resolve_plugin_runtime_device_id` on a borrowed session handle: the shared
/// pool for read-only callers, or the request-session transaction.
pub async fn resolve_plugin_runtime_device_id_on<Q>(
    query: &mut Q,
    user_id: i64,
    device_id: &str,
) -> MysqlResult<Option<String>>
where
    Q: MysqlQuery,
{
    let submitted = device_id.trim();
    let devices: Vec<DeviceKindRow> = query.fetch_all(KINDS_DEVICE_QUERY, (user_id,)).await?;
    let cloud_matches: Vec<&DeviceKindRow> = devices
        .iter()
        .filter(|device| {
            DeviceType::from_spec(&device.spec()) == DeviceType::Cloud
                && runtime_device_id(device) == submitted
        })
        .collect();
    if cloud_matches.is_empty() {
        let identity = resolve_runtime_route_identity_on(query, user_id, submitted).await?;
        return Ok(identity.map(|identity| identity.logical_device_id));
    }
    let mut matches: HashSet<i64> = devices
        .iter()
        .filter(|device| device_identity_ids(device).iter().any(|id| id == submitted))
        .map(|device| device.id)
        .collect();
    matches.extend(cloud_matches.iter().map(|device| device.id));
    if matches.len() != 1 {
        return Ok(None);
    }
    let identity =
        resolve_runtime_route_identity_on(query, user_id, cloud_matches[0].name.as_str()).await?;
    match identity {
        Some(identity)
            if identity.device_type == DeviceType::Cloud
                && identity.runtime_device_id == submitted =>
        {
            Ok(Some(identity.logical_device_id))
        }
        _ => Ok(None),
    }
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
pub async fn plugin_device_id_on<Q>(
    query: &mut Q,
    user_id: i64,
    device_id: &str,
) -> MysqlResult<String>
where
    Q: MysqlQuery,
{
    Ok(
        match resolve_owned_device_alias_on(query, user_id, device_id).await? {
            Some(device) => canonical_device_id(&device),
            None => device_id.trim().to_string(),
        },
    )
}

#[cfg(test)]
mod tests;
