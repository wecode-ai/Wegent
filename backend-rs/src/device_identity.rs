// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Shared plugin device identity and runtime-route resolution.
//!
//! Source: `app/services/device/identity.py`,
//! `app/services/device/runtime_route.py`, and
//! `app/services/plugin_device_identity.py`. Resolves a submitted device id to
//! its canonical identity and coalesces `plugin_device_installations` rows.
//! Used by both the marketplace listing and installed-plugin APIs.

use brz_mysql::{FromMysqlRow, Mysql, MysqlResult};
use chrono::NaiveDateTime;
use serde::Deserialize;
use std::collections::HashMap;

/// Prefix for the App device transport route
/// (`app/services/device/identity.py::RECORD_ROUTE_PREFIX`).
const RECORD_ROUTE_PREFIX: &str = "app-record-";

/// Source `kinds` Device filter (`resolve_owned_device_alias` base query).
const KINDS_DEVICE_QUERY: &str = "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
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
pub async fn plugin_device_id<M>(mysql: &M, user_id: i64, device_id: &str) -> MysqlResult<String>
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
    let mut identities: HashMap<(i64, String), String> = HashMap::new();
    let mut selected: Vec<((i64, String), R)> = Vec::new();
    let mut seen: HashMap<(i64, String), usize> = HashMap::new();
    for row in &rows {
        let identity_key = (row.user_id(), row.device_id().to_string());
        if !identities.contains_key(&identity_key) {
            let canonical = plugin_device_id(mysql, row.user_id(), row.device_id()).await?;
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
}
