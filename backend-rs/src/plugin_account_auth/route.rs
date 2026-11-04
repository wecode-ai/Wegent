// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Owned-device route identity for plugin exchanges.
//!
//! Source: `app/services/device/runtime_route.py` (`resolve_runtime_route_identity`,
//! `device_service.get_device_online_info`) and
//! `app/services/plugin_account_connections.py::_device_binding`.

use brz_mysql::{Mysql, MysqlResult};
use serde_json::{Value, json};

use crate::device_identity::{
    DeviceKindRow, KINDS_DEVICE_QUERY, record_id_from_route, record_route_id, resolve_device_alias,
    resolve_owned_device_alias,
};
use crate::devices::{cache_manager_get, online_key};
use crate::socketio::device::DeviceType;
use crate::state::AppState;

use super::{DEVICE_NOT_FOUND, DEVICE_UPGRADE_REQUIRED, EXCHANGE_FAILED};

/// `RuntimeRouteIdentity`: the persisted mapping between the logical device
/// name and its current Runtime route.
pub(crate) struct RuntimeIdentity {
    pub(crate) logical_device_id: String,
    pub(crate) runtime_device_id: String,
    pub(crate) runtime_instance_id: Option<String>,
    #[allow(
        dead_code,
        reason = "resolved for source parity; only APP changes behavior"
    )]
    pub(crate) device_type: DeviceType,
}

/// `_device_binding`: the logical id plus the binding document stored in the
/// connection and policy documents for this device.
pub(crate) struct DeviceBinding {
    pub(crate) logical_device_id: String,
    pub(crate) document: Value,
}

/// `runtime_route.py::runtime_device_route_id`.
fn runtime_device_route_id(row: &DeviceKindRow, device_type: DeviceType) -> String {
    if device_type == DeviceType::App {
        return record_route_id(row);
    }
    if let Some(device_id) = non_empty(row.json.get("spec").and_then(|spec| spec.get("deviceId"))) {
        return device_id.to_owned();
    }
    if let Some(device_id) = non_empty(
        row.json
            .get("spec")
            .and_then(|spec| spec.get("cloudConfig"))
            .and_then(|cloud| cloud.get("deviceId")),
    ) {
        return device_id.to_owned();
    }
    row.name.clone()
}

fn non_empty(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
}

fn device_type(row: &DeviceKindRow) -> DeviceType {
    match row
        .json
        .get("spec")
        .and_then(|spec| spec.get("deviceType"))
        .and_then(Value::as_str)
    {
        Some("cloud") => DeviceType::Cloud,
        Some("app") => DeviceType::App,
        Some("remote") => DeviceType::Remote,
        _ => DeviceType::Local,
    }
}

fn identity_from_row(row: &DeviceKindRow) -> Option<RuntimeIdentity> {
    let kind = device_type(row);
    let runtime_device_id = runtime_device_route_id(row, kind);
    if runtime_device_id.is_empty() {
        return None;
    }
    let logical_device_id = if kind == DeviceType::App {
        record_route_id(row)
    } else {
        row.name.clone()
    };
    Some(RuntimeIdentity {
        logical_device_id,
        runtime_device_id,
        runtime_instance_id: non_empty(
            row.json
                .get("spec")
                .and_then(|spec| spec.get("runtimeInstanceId")),
        )
        .map(str::to_owned),
        device_type: kind,
    })
}

/// `resolve_runtime_route_identity`: the owned device behind a submitted route
/// or legacy alias, or `None` when no unambiguous match exists.
pub(crate) async fn identity<M: Mysql>(
    mysql: &M,
    user_id: i64,
    device_id: &str,
) -> MysqlResult<Option<RuntimeIdentity>> {
    let Some(row) = resolve_owned_device_alias(mysql, user_id, device_id).await? else {
        return Ok(None);
    };
    Ok(identity_from_row(&row))
}

/// [`identity`] on the exchange transaction: `_exchange_sync` resolves the
/// route on its own READ COMMITTED session before dispatching.
pub(crate) async fn identity_on<T: brz_mysql::MysqlTransaction>(
    transaction: &mut T,
    user_id: i64,
    device_id: &str,
) -> MysqlResult<Option<RuntimeIdentity>> {
    let submitted = device_id.trim();
    if submitted.is_empty() {
        return Ok(None);
    }
    if let Some(record_id) = record_id_from_route(submitted) {
        let sql = format!("{KINDS_DEVICE_QUERY} AND kinds.id = ?");
        let row: Option<DeviceKindRow> = transaction
            .fetch_optional(&sql, (user_id, record_id))
            .await?;
        return Ok(row
            .filter(|row| device_type(row) == DeviceType::App)
            .and_then(|row| identity_from_row(&row)));
    }
    let rows: Vec<DeviceKindRow> = transaction
        .fetch_all(KINDS_DEVICE_QUERY, (user_id,))
        .await?;
    Ok(resolve_device_alias(&rows, submitted).and_then(identity_from_row))
}

/// [`device_binding`] on the exchange transaction.
pub(crate) async fn device_binding_on<T: brz_mysql::MysqlTransaction>(
    transaction: &mut T,
    user_id: i64,
    device_id: &str,
) -> Result<DeviceBinding, &'static str> {
    let Some(identity) = identity_on(transaction, user_id, device_id)
        .await
        .map_err(|_| EXCHANGE_FAILED)?
    else {
        return Err(DEVICE_NOT_FOUND);
    };
    let Some(instance_id) = identity.runtime_instance_id.clone() else {
        return Err(DEVICE_UPGRADE_REQUIRED);
    };
    let row: Option<DeviceKindRow> = match record_id_from_route(&identity.runtime_device_id) {
        Some(record_id) => {
            transaction
                .fetch_optional(DEVICE_BINDING_BY_ID_QUERY, (user_id, record_id))
                .await
        }
        None => {
            transaction
                .fetch_optional(
                    DEVICE_BINDING_BY_NAME_QUERY,
                    (user_id, identity.logical_device_id.as_str()),
                )
                .await
        }
    }
    .map_err(|_| EXCHANGE_FAILED)?;
    let Some(row) = row else {
        return Err(EXCHANGE_FAILED);
    };
    Ok(DeviceBinding {
        logical_device_id: identity.logical_device_id.clone(),
        document: json!({
            "deviceRowId": row.id,
            "runtimeDeviceId": identity.runtime_device_id,
            "runtimeInstanceId": instance_id,
        }),
    })
}

/// `device_service.get_device_online_info`: the `device:online` document.
pub(crate) async fn online(state: &AppState, user_id: i64, device_id: &str) -> Option<Value> {
    cache_manager_get(state, &online_key(user_id, device_id)).await
}

/// `_device_binding`'s device row read: the record id for a record route, the
/// logical name otherwise, always restricted to one active row.
const DEVICE_BINDING_BY_ID_QUERY: &str = "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
     kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
     kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
     kinds.updated_at AS kinds_updated_at FROM kinds \
     WHERE kinds.user_id = ? AND kinds.kind = 'Device' AND kinds.namespace = 'default' \
     AND kinds.id = ? AND kinds.is_active IS true";

/// [`DEVICE_BINDING_BY_ID_QUERY`] for a logical device name.
const DEVICE_BINDING_BY_NAME_QUERY: &str = "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
     kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
     kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
     kinds.updated_at AS kinds_updated_at FROM kinds \
     WHERE kinds.user_id = ? AND kinds.kind = 'Device' AND kinds.namespace = 'default' \
     AND kinds.name = ? AND kinds.is_active IS true";

#[cfg(test)]
mod tests {
    use super::*;

    fn row(spec: Value) -> DeviceKindRow {
        DeviceKindRow {
            id: 7,
            name: "local-device".into(),
            json: json!({"kind": "Device", "spec": spec}),
        }
    }

    #[test]
    fn app_records_use_the_record_route_for_both_identities() {
        let identity = identity_from_row(&row(
            json!({"deviceType": "app", "deviceId": "local-device"}),
        ))
        .expect("identity");
        assert_eq!(identity.runtime_device_id, "app-record-7");
        assert_eq!(identity.logical_device_id, "app-record-7");
        assert_eq!(identity.device_type, DeviceType::App);
    }

    #[test]
    fn other_device_types_keep_the_reported_identity() {
        let identity = identity_from_row(&row(json!({
            "deviceType": "cloud",
            "cloudConfig": {"deviceId": "sandbox-1"},
            "runtimeInstanceId": "runtime-1"
        })))
        .expect("identity");
        assert_eq!(identity.runtime_device_id, "sandbox-1");
        assert_eq!(identity.logical_device_id, "local-device");
        assert_eq!(identity.runtime_instance_id.as_deref(), Some("runtime-1"));
    }
}
