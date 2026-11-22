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
mod auto_update;
mod catalog_reconcile;
mod catalog_write;
mod desired_capabilities;
mod download;
mod handler;
mod item;
mod list;
#[cfg(test)]
pub(crate) mod test_support;
pub use list::enrich_installed_list;
pub(crate) mod local_sync;

pub fn local_sync_enabled() -> bool {
    local_sync::enabled()
}
mod online_route;
pub(crate) mod plugin_sync_protocol;
pub(crate) mod record_sync_result;
pub(crate) mod registration_sync;
pub(crate) mod removal_sync;
mod report;
mod sync_device;
// Shared with `plugin_account_auth`, which drives the same owner lease and
// policy-revision CAS for plugin-auth exchanges.
pub(crate) mod write_coordination;
use brz_mysql::{FromMysqlRow, Mysql, MysqlResult};
use chrono::NaiveDateTime;
pub use item::kind_to_item;
use serde_json::{Map, Value};

pub use registration_sync::{
    CapabilityDispatch, DispatchOutcome, PluginPreparation, prepare_plugins_for_registered_device,
    record_registration_sync_result, sync_registration_capabilities,
};

use wegent_plugin_store::DeviceRow;

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

impl DeviceRow for DeviceInstallationRow {
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

/// Minimal marketplace projection for batched latest-release comparison.
#[derive(Debug, FromMysqlRow)]
pub struct PluginRow {
    pub id: i64,
    pub latest_release_id: i64,
}

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

async fn list_plugins_by_ids<M>(mysql: &M, mut plugin_ids: Vec<i64>) -> MysqlResult<Vec<PluginRow>>
where
    M: Mysql,
{
    plugin_ids.sort_unstable();
    plugin_ids.dedup();
    if plugin_ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = vec!["?"; plugin_ids.len()].join(", ");
    mysql
        .fetch_all(
            format!("SELECT id, latest_release_id FROM plugins WHERE id IN ({placeholders})"),
            plugin_ids,
        )
        .await
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
}

#[cfg(test)]
mod batch_mysql_tests;
