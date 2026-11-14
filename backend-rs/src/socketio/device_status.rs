// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `device:status` and `device:upgrade_status` inbound events.
//!
//! Source: `app/api/ws/device_namespace.py::on_device_status` (line 2458) and
//! `on_device_upgrade_status` (line 2507). Both validate the reported device
//! against the connection session and then broadcast through the user's chat
//! rooms; `device:status` additionally rewrites the Redis online document.

use std::sync::Arc;

use brz_mysql::FromMysqlRow;
use serde_json::{Map, Value, json};

use crate::socketio::device;
use crate::socketio::device_lifecycle::publish_chat_event;
use crate::socketio::runtime::SocketRuntime;
use crate::socketio::session::SessionSnapshot;
use crate::state::AppState;

/// `DeviceStatusEnum`.
const DEVICE_STATUSES: [&str; 3] = ["online", "offline", "busy"];

/// `_broadcast_device_upgrade_status`'s admin audience
/// (`users.role == "admin" AND users.is_active == true`).
const ADMIN_IDS_QUERY: &str = "SELECT users.id AS users_id \nFROM users \nWHERE users.role = \
     'admin' AND users.is_active = true";

#[derive(FromMysqlRow)]
struct AdminIdRow {
    #[mysql(rename = "users_id")]
    id: i64,
}

/// `on_device_status`: validate, rewrite the Redis online document, broadcast.
pub async fn status(
    state: &AppState,
    runtime: &Arc<SocketRuntime>,
    snapshot: &SessionSnapshot,
    socket_id: &str,
    data: &Value,
) -> Value {
    let Some(object) = data.as_object() else {
        return invalid("payload must be an object");
    };
    let Some(reported_device_id) = object.get("device_id").and_then(Value::as_str) else {
        return invalid("device_id is required");
    };
    let Some(status) = object.get("status").and_then(Value::as_str) else {
        return invalid("status is required");
    };
    if !DEVICE_STATUSES.contains(&status) {
        return invalid("status must be online, offline or busy");
    }
    let session_device = snapshot
        .device
        .reported_device_id
        .clone()
        .or_else(|| snapshot.device.device_id.clone());
    if session_device.as_deref() != Some(reported_device_id) {
        return json!({"error": "Device ID mismatch"});
    }
    let Some(route_id) = snapshot.device.device_id.clone() else {
        return json!({"error": "Not authenticated"});
    };
    if !device::update_online_status(state, snapshot.user_id, &route_id, socket_id, status).await {
        return json!({"error": "Stale device connection"});
    }

    let payload = json!({"device_id": route_id, "status": status});
    if let Err(error) = runtime
        .emitters()
        .device_status(snapshot.user_id, &payload)
        .await
    {
        tracing::warn!(%error, user_id = snapshot.user_id, "device:status local delivery failed");
    }
    publish_chat_event(state, "device:status", &payload, snapshot.user_id).await;
    json!({"success": true})
}

/// `on_device_upgrade_status`: validate, then broadcast to the owner and every
/// active admin.
pub async fn upgrade_status(
    state: &AppState,
    runtime: &Arc<SocketRuntime>,
    snapshot: &SessionSnapshot,
    _socket_id: &str,
    data: &Value,
) -> Value {
    let Some(object) = data.as_object() else {
        return invalid("payload must be an object");
    };
    let Some(reported_device_id) = object.get("device_id").and_then(Value::as_str) else {
        return invalid("device_id is required");
    };
    let Some(status) = object.get("status").and_then(Value::as_str) else {
        return invalid("status is required");
    };
    if !object.get("message").is_some_and(Value::is_string) {
        return invalid("message is required");
    }
    let session_device = snapshot
        .device
        .reported_device_id
        .clone()
        .or_else(|| snapshot.device.device_id.clone());
    if session_device.as_deref() != Some(reported_device_id) {
        return json!({"error": "Device ID mismatch"});
    }
    let Some(route_id) = snapshot.device.device_id.clone() else {
        return json!({"error": "Not authenticated"});
    };
    let payload = upgrade_payload(&route_id, status, object);

    for target_user_id in upgrade_audience(state, snapshot.user_id).await {
        if let Err(error) = runtime
            .emitters()
            .device_upgrade_status(target_user_id, &payload)
            .await
        {
            tracing::warn!(%error, user_id = target_user_id, "device:upgrade_status local delivery failed");
        }
        publish_chat_event(state, "device:upgrade_status", &payload, target_user_id).await;
    }
    json!({"success": true})
}

/// `target_user_ids = {user_id}; target_user_ids.update(admin_user_ids)`,
/// iterated in CPython `set[int]` order.
async fn upgrade_audience(state: &AppState, user_id: i64) -> Vec<i64> {
    // `_db_session()` commits after its successful read, so the admin SELECT
    // and the COMMIT stay in that order.
    let admins: Vec<AdminIdRow> = match state
        .mysql
        .with_transaction(async |transaction| admin_ids(transaction).await)
        .await
    {
        Ok(rows) => rows,
        Err(error) => {
            tracing::error!(%error, "device upgrade-status admin audience read failed");
            Vec::new()
        }
    };
    let mut audience = crate::py_set_order::SetOrder::new();
    audience.add(user_id);
    for admin in admins {
        audience.add(admin.id);
    }
    audience.order()
}

async fn admin_ids<T: brz_mysql::MysqlTransaction>(
    transaction: &mut T,
) -> brz_mysql::MysqlResult<Vec<AdminIdRow>> {
    transaction.fetch_all(ADMIN_IDS_QUERY, ()).await
}

/// `DeviceUpgradeStatusEvent.model_dump()`: declaration order, with the
/// optional members present as `null`.
fn upgrade_payload(route_id: &str, status: &str, object: &Map<String, Value>) -> Value {
    let mut payload = Map::new();
    payload.insert("device_id".into(), Value::String(route_id.to_string()));
    payload.insert("status".into(), Value::String(status.to_string()));
    for field in ["message", "old_version", "new_version", "progress", "error"] {
        payload.insert(
            field.into(),
            object.get(field).cloned().unwrap_or(Value::Null),
        );
    }
    Value::Object(payload)
}

fn invalid(detail: &str) -> Value {
    json!({"error": format!("Invalid payload: {detail}")})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upgrade_payload_keeps_the_source_field_order_and_nulls() {
        let mut object = Map::new();
        object.insert("device_id".into(), json!("reported"));
        object.insert("status".into(), json!("checking"));
        object.insert("message".into(), json!("fixture"));
        let payload = upgrade_payload("route", "checking", &object);
        assert_eq!(
            payload.to_string(),
            "{\"device_id\":\"route\",\"status\":\"checking\",\"message\":\"fixture\",\
             \"old_version\":null,\"new_version\":null,\"progress\":null,\"error\":null}"
        );
    }

    #[test]
    fn status_rejects_an_unknown_state() {
        assert!(DEVICE_STATUSES.contains(&"online"));
        assert!(!DEVICE_STATUSES.contains(&"checking"));
    }
}
