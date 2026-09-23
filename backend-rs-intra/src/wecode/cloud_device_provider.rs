// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Cloud device records and the provider reads the cloud-device endpoints
//! consume.
//!
//! Mirrors `wecode/service/cloud_device_provider.py`: the `Kind` row lookup
//! (`_get_active_device_kind`, `get_status`), the Redis online-state and
//! executor-version reads that build the provider's device dict
//! (`_get_online_info`, `get_slot_usage`,
//! `executor_version_service.get_latest_version`), and `get_vm_status`'s
//! projection of the Nevis sandbox document.
//!
//! This module owns the `kinds` statements for cloud devices because the
//! endpoint's status lookup and `CloudDeviceIpIndexService._load_device`
//! select the same row; `nevis_ip_index` reuses them instead of keeping a
//! second projection of the same entity.
use brz_mysql::{FromMysqlRow, Mysql, MysqlError, MysqlTransaction};
use serde_json::Value;
use wegent_backend_rs::AppState;
use wegent_backend_rs::devices::{cache_manager_get, online_key};
use wegent_backend_rs::executor_version::latest_executor_version;

use super::nevis::{NevisClient, NevisClientError};

/// `DeviceType.CLOUD.value` (`app.schemas.device`).
const CLOUD_DEVICE_TYPE: &str = "cloud";

/// `CloudDeviceProvider.get_status`: one active Device of the user, resolved
/// by name. Every mapped `Kind` column is selected with its SQLAlchemy
/// `kinds_<column>` alias, which is the whole statement the source renders.
pub(crate) const DEVICE_BY_NAME_QUERY: &str = "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
     kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
     kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
     kinds.updated_at AS kinds_updated_at FROM kinds \
     WHERE kinds.user_id = ? AND kinds.kind = 'Device' \
     AND kinds.namespace = 'default' AND kinds.name = ? AND kinds.is_active = true \
     LIMIT 1";

/// `_load_device(for_update=True)`: the same lookup through
/// `populate_existing().with_for_update()`, which renders `IS true` and
/// `FOR UPDATE`.
pub(crate) const DEVICE_BY_NAME_FOR_UPDATE_QUERY: &str = "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
     kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
     kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
     kinds.updated_at AS kinds_updated_at FROM kinds \
     WHERE kinds.user_id = ? AND kinds.kind = 'Device' \
     AND kinds.namespace = 'default' AND kinds.name = ? AND kinds.is_active IS true \
     LIMIT 1 FOR UPDATE";

/// `db.commit()`'s flush of the dirty `Kind` row: the `flag_modified` `json`
/// column and the `onupdate` `updated_at`.
pub(crate) const UPDATE_DEVICE_QUERY: &str =
    "UPDATE kinds SET json = ?, updated_at = ? WHERE kinds.id = ?";

/// One active cloud device `Kind` row. Every mapped column of the source
/// `Kind` model is selected, so each field is renamed and only `id` and `json`
/// are consumed.
#[derive(Debug, FromMysqlRow)]
pub(crate) struct DeviceKindRow {
    #[mysql(rename = "kinds_id")]
    pub(crate) id: i64,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "kinds_user_id")]
    user_id: i64,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "kinds_kind")]
    kind: String,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "kinds_name")]
    name: String,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "kinds_namespace")]
    namespace: String,
    /// The CRD document. Retained as an untyped value because the IP index
    /// writes it back with every unrelated member and member order preserved.
    #[mysql(rename = "kinds_json")]
    pub(crate) json: Value,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "kinds_is_active")]
    is_active: i8,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "kinds_created_at")]
    created_at: chrono::NaiveDateTime,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "kinds_updated_at")]
    updated_at: chrono::NaiveDateTime,
}

/// `CloudDeviceProvider.get_status`'s device dict, reduced to the members the
/// status endpoint reads.
pub(crate) struct CloudDeviceStatus {
    /// `device_status["device_id"]`.
    pub(crate) device_id: String,
    /// `device_status["cloud_config"]`.
    pub(crate) cloud_config: Option<Value>,
}

/// The Redis online-state document (`_get_online_info`). The provider derives
/// its device dict fields from this payload; no member of the status response
/// depends on it, so the decode exists to issue the request-owned read.
#[allow(
    dead_code,
    reason = "decoded to mirror the source provider's online-state read"
)]
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
struct OnlineState {
    executor_version: Option<String>,
    status: Option<String>,
    last_heartbeat: Option<Value>,
    running_task_ids: Vec<Value>,
    runtime_capacity: Option<Value>,
}

/// `CloudDeviceProvider.get_status`: load the active device, reject a
/// non-cloud device, and issue the provider's remaining request-owned reads.
///
/// `None` is the missing-device (or non-cloud) result that the endpoint
/// renders as its 404.
pub(crate) async fn device_status<M: Mysql>(
    state: &AppState,
    mysql: &M,
    user_id: i64,
    device_id: &str,
) -> Result<Option<CloudDeviceStatus>, MysqlError> {
    let Some(row) = load_device(mysql, user_id, device_id).await? else {
        return Ok(None);
    };
    let document = &row.json;
    let spec = document.get("spec").unwrap_or(&Value::Null);
    // `spec.get("deviceType") != DeviceType.CLOUD.value`.
    if spec.get("deviceType").and_then(Value::as_str) != Some(CLOUD_DEVICE_TYPE) {
        return Ok(None);
    }

    // `_get_online_info`, then the second read `get_slot_usage` performs of
    // the same key, then `executor_version_service.get_latest_version()`.
    // The provider turns these into the device dict's status, slot, and
    // version fields, none of which the status response consumes, but they
    // stay request-owned dependencies of every status call.
    let key = online_key(user_id, device_id);
    let _ = cache_manager_get::<OnlineState>(state, &key).await;
    let _ = cache_manager_get::<OnlineState>(state, &key).await;
    let _ = latest_executor_version(state).await;

    Ok(Some(CloudDeviceStatus {
        device_id: device_id.to_string(),
        cloud_config: spec.get("cloudConfig").cloned(),
    }))
}

/// `db.query(Kind)` filtered to one active Device of `user_id`.
pub(crate) async fn load_device<M: Mysql>(
    mysql: &M,
    user_id: i64,
    device_id: &str,
) -> Result<Option<DeviceKindRow>, MysqlError> {
    mysql
        .fetch_optional(DEVICE_BY_NAME_QUERY, (user_id, device_id))
        .await
}

/// `_load_device(for_update=True)` used by
/// `CloudDeviceIpIndexService.persist_observation`, on its transaction
/// connection so the row lock spans the `commit()` that flushes the write.
pub(crate) async fn load_device_for_update<T: MysqlTransaction>(
    transaction: &mut T,
    user_id: i64,
    device_id: &str,
) -> Result<Option<DeviceKindRow>, MysqlError> {
    transaction
        .fetch_optional(DEVICE_BY_NAME_FOR_UPDATE_QUERY, (user_id, device_id))
        .await
}

/// The `json`/`updated_at` write of one dirty `Kind` row (`db.commit()`'s
/// flush), on the same transaction connection as the row lock.
pub(crate) async fn update_device_document<T: MysqlTransaction>(
    transaction: &mut T,
    id: i64,
    document: &str,
    updated_at: &str,
) -> Result<(), MysqlError> {
    transaction
        .execute(UPDATE_DEVICE_QUERY, (document, updated_at, id))
        .await
        .map(|_| ())
}

/// `_resolve_sandbox_id`: the sandbox id from the device's `cloudConfig`, or
/// the requested device id.
///
/// `CloudDeviceConfig.sandboxId` is a required string in the CRD schema
/// (`wecode.schemas.cloud_device.CloudDeviceConfig`), so a `cloudConfig`
/// without one falls back to the requested id exactly like the source's
/// `cloudConfig.get("sandboxId", device_id)`.
pub(crate) fn resolve_sandbox_id(device_id: &str, cloud_config: Option<&Value>) -> String {
    cloud_config
        .and_then(Value::as_object)
        .and_then(|config| config.get("sandboxId"))
        .and_then(Value::as_str)
        .unwrap_or(device_id)
        .to_string()
}

/// `get_vm_status`: the five members the endpoint's response model validates,
/// mapped from the Nevis sandbox document.
pub(crate) async fn get_vm_status(
    client: &NevisClient,
    sandbox_id: &str,
) -> Result<SandboxStatus, NevisClientError> {
    let document = client.get_sandbox(sandbox_id).await?;
    Ok(SandboxStatus {
        // `result.get("id", device_id)` and `result.get("status", "unknown")`
        // keep their defaults only when the member is absent.
        sandbox_id: document.id.unwrap_or_else(|| sandbox_id.to_string()),
        status: document.status.unwrap_or_else(|| "unknown".to_string()),
        ip_address: document.details.urls,
        vnc_url: document.details.vnc_url,
        created_at: document.created_at,
    })
}

/// `CloudDeviceProvider.get_vm_status`'s return dict.
pub(crate) struct SandboxStatus {
    pub(crate) sandbox_id: String,
    pub(crate) status: String,
    pub(crate) ip_address: Option<String>,
    pub(crate) vnc_url: Option<String>,
    pub(crate) created_at: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::super::nevis::SandboxDocument;
    use super::*;

    fn document(json: &str) -> Value {
        serde_json::from_str(json).expect("device document")
    }

    #[test]
    fn device_queries_share_the_source_labeled_projection() {
        for query in [DEVICE_BY_NAME_QUERY, DEVICE_BY_NAME_FOR_UPDATE_QUERY] {
            for column in [
                "kinds.id AS kinds_id",
                "kinds.user_id AS kinds_user_id",
                "kinds.kind AS kinds_kind",
                "kinds.name AS kinds_name",
                "kinds.namespace AS kinds_namespace",
                "kinds.json AS kinds_json",
                "kinds.is_active AS kinds_is_active",
                "kinds.created_at AS kinds_created_at",
                "kinds.updated_at AS kinds_updated_at",
            ] {
                assert!(query.contains(column), "{query} selects {column}");
            }
        }
        // `get_status` filters on `== True`; `_load_device(for_update=True)`
        // uses `.is_(True)`, which renders `IS true`.
        assert!(DEVICE_BY_NAME_QUERY.contains("kinds.is_active = true"));
        assert!(DEVICE_BY_NAME_FOR_UPDATE_QUERY.contains("kinds.is_active IS true"));
        assert!(DEVICE_BY_NAME_FOR_UPDATE_QUERY.ends_with("LIMIT 1 FOR UPDATE"));
    }

    #[test]
    fn sandbox_id_falls_back_to_the_requested_device_id() {
        assert_eq!(resolve_sandbox_id("device-1", None), "device-1");
        assert_eq!(
            resolve_sandbox_id("device-1", Some(&Value::Null)),
            "device-1"
        );
        assert_eq!(
            resolve_sandbox_id("device-1", Some(&document(r#"{"imageId": "img"}"#))),
            "device-1"
        );
        assert_eq!(
            resolve_sandbox_id("device-1", Some(&document(r#"{"sandboxId": "sandbox-1"}"#))),
            "sandbox-1"
        );
    }

    #[test]
    fn online_state_projection_tolerates_the_recorded_payload_shape() {
        let payload = r#"{
            "socket_id": "socket-1",
            "status": "online",
            "executor_version": "2.0.18",
            "running_task_ids": [],
            "runtime_capacity": {"limit": 10, "active": 0, "active_task_ids": []}
        }"#;
        let state: OnlineState = serde_json::from_str(payload).expect("online state");
        assert_eq!(state.status.as_deref(), Some("online"));
        assert_eq!(state.executor_version.as_deref(), Some("2.0.18"));
        assert!(state.running_task_ids.is_empty());

        let empty: OnlineState = serde_json::from_str("{}").expect("empty online state");
        assert_eq!(empty.status, None);
        assert_eq!(empty.executor_version, None);
    }

    #[test]
    fn get_vm_status_projection_keeps_the_source_defaults() {
        let document = serde_json::from_str::<SandboxDocument>(
            r#"{"status": "RUNNING", "details": {"urls": "192.0.2.10"}}"#,
        )
        .expect("sandbox document");
        assert_eq!(document.id, None);
        assert_eq!(document.status.as_deref(), Some("RUNNING"));
        assert_eq!(document.details.urls.as_deref(), Some("192.0.2.10"));
        assert_eq!(document.details.vnc_url, None);
        assert_eq!(document.created_at, None);
    }
}
