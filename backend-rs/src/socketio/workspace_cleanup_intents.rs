// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `/local-executor` `runtime.workspace_cleanup.claim` / `...accept`.
//!
//! Sources: `app/api/ws/device_namespace.py::on_runtime_workspace_cleanup_claim`
//! / `on_runtime_workspace_cleanup_accept` and
//! `app/services/workspace_cleanup_intents.py::claim` / `acknowledge`.
//!
//! `claim` linearizes cleanup with a `SELECT ... FOR UPDATE` on the writer
//! connection and commits even when the intent row is absent (the source
//! session commits on exit). `brz-mysql`'s pooled `fetch_*` rejects `FOR
//! UPDATE`, so both run through [`MysqlService::with_transaction`].

use brz_mysql::MysqlTransaction as _;
use brz_socket_io::ClientError;
use serde_json::{Value, json};

use crate::cloud_projects::LOOP_ITEMS_COLUMNS;
use crate::socketio::session::SessionSnapshot;
use crate::state::AppState;

use super::chat_support::internal_error;

/// `STATUS_EXECUTING`.
const STATUS_EXECUTING: &str = "executing";
/// `STATUS_CANCELLED`.
const STATUS_CANCELLED: &str = "cancelled";
/// `STATUS_ACKNOWLEDGED`.
const STATUS_ACKNOWLEDGED: &str = "acknowledged";
/// `EXECUTION_LEASE_SECONDS`.
const EXECUTION_LEASE_SECONDS: i64 = 5 * 60;

/// `on_runtime_workspace_cleanup_claim`.
pub(crate) async fn claim(
    state: &AppState,
    snapshot: &SessionSnapshot,
    data: &Value,
) -> Result<Value, ClientError> {
    let Some((user_id, device_id)) = registered(snapshot) else {
        return Ok(status_error("Device is not registered"));
    };
    let Some(payload) = data.as_object() else {
        return Ok(invalid("cleanup claim"));
    };
    let Some(intent_id) = payload
        .get("intent_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    else {
        return Ok(status_error("intent_id is required"));
    };
    let Some(issue_version) = payload.get("issue_version").and_then(python_int) else {
        return Ok(status_error("issue_version is required"));
    };
    let claimed = claim_intent(state, user_id, &device_id, intent_id, issue_version).await?;
    Ok(json!({"success": claimed}))
}

/// `on_runtime_workspace_cleanup_accept`.
pub(crate) async fn accept(
    state: &AppState,
    snapshot: &SessionSnapshot,
    data: &Value,
) -> Result<Value, ClientError> {
    let Some((user_id, device_id)) = registered(snapshot) else {
        return Ok(status_error("Device is not registered"));
    };
    let Some(payload) = data.as_object() else {
        return Ok(invalid("cleanup acceptance"));
    };
    let Some(intent_id) = payload
        .get("intent_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    else {
        return Ok(status_error("intent_id is required"));
    };
    let Some(issue_version) = payload.get("issue_version").and_then(python_int) else {
        return Ok(status_error("issue_version is required"));
    };
    let accepted = acknowledge_intent(state, user_id, &device_id, intent_id, issue_version).await?;
    Ok(json!({"success": accepted}))
}

/// The registered executor identity, or `None` for the source's early
/// "Device is not registered" rejection.
fn registered(snapshot: &SessionSnapshot) -> Option<(i64, String)> {
    let device_id = snapshot
        .device
        .device_id
        .clone()
        .or_else(|| snapshot.device.reported_device_id.clone())
        .unwrap_or_default();
    if snapshot.user_id == 0 || device_id.is_empty() {
        return None;
    }
    Some((snapshot.user_id, device_id))
}

/// `claim`: one `SELECT ... FOR UPDATE` and its commit on the same transaction.
async fn claim_intent(
    state: &AppState,
    user_id: i64,
    device_id: &str,
    intent_id: &str,
    issue_version: i64,
) -> Result<bool, ClientError> {
    #[derive(brz_mysql::FromMysqlRow)]
    struct Row {
        #[mysql(rename = "loop_items_id")]
        id: String,
        #[mysql(rename = "loop_items_due_at")]
        due_at: Option<chrono::NaiveDateTime>,
    }
    // The sealed #135 statement projects the full labeled `loop_items` column
    // list; the engine's `DirectSelect` rejects the FOR/LOCK tail, so this read
    // must keep the exact 59-column projection and `LIMIT 1 FOR UPDATE`.
    let statement = format!(
        "SELECT {LOOP_ITEMS_COLUMNS} \nFROM loop_items \n\
         WHERE loop_items.id = ? AND loop_items.task_user_id = ? AND loop_items.device_id = ? \
         AND loop_items.version = ? AND loop_items.status IN ('pending', 'executing') \
         AND loop_items.resource_type IN ('workspace_cleanup') \n LIMIT 1 FOR UPDATE"
    );
    state
        .mysql
        .with_transaction(async |transaction| {
            let row: Option<Row> = transaction
                .fetch_optional(&statement, (intent_id, user_id, device_id, issue_version))
                .await?;
            let now = chrono::Utc::now().naive_utc();
            let Some(row) = row else {
                return Ok(false);
            };
            let Some(due_at) = row.due_at else {
                return Ok(false);
            };
            if due_at > now {
                return Ok(false);
            }
            let lease_until = now + chrono::Duration::seconds(EXECUTION_LEASE_SECONDS);
            transaction
                .execute(
                    "UPDATE loop_items SET status = ?, due_at = ?, updated_at = ? WHERE id = ?",
                    (STATUS_EXECUTING, lease_until, now, row.id),
                )
                .await?;
            Ok(true)
        })
        .await
        .map_err(|error| {
            tracing::error!(%error, intent_id, "runtime cleanup claim failed");
            internal_error()
        })
}

/// `acknowledge`: verify the exact desired-state version, then mark it applied.
async fn acknowledge_intent(
    state: &AppState,
    user_id: i64,
    device_id: &str,
    intent_id: &str,
    issue_version: i64,
) -> Result<bool, ClientError> {
    #[derive(brz_mysql::FromMysqlRow)]
    struct Row {
        id: String,
        task_user_id: Option<i32>,
        device_id: Option<String>,
        version: i32,
        status: Option<String>,
    }
    state
        .mysql
        .with_transaction(async |transaction| {
            let row: Option<Row> = transaction
                .fetch_optional(
                    "SELECT loop_items.id AS id, loop_items.task_user_id AS task_user_id, \
                     loop_items.device_id AS device_id, loop_items.version AS version, \
                     loop_items.status AS status FROM loop_items WHERE loop_items.id = ? \
                     AND loop_items.resource_type IN ('workspace_cleanup')",
                    (intent_id,),
                )
                .await?;
            let Some(row) = row else {
                return Ok(false);
            };
            let valid = row.task_user_id.map(i64::from) == Some(user_id)
                && row.device_id.as_deref() == Some(device_id)
                && i64::from(row.version) == issue_version
                && matches!(
                    row.status.as_deref(),
                    Some(STATUS_EXECUTING) | Some(STATUS_CANCELLED)
                );
            if !valid {
                return Ok(false);
            }
            let now = chrono::Utc::now().naive_utc();
            transaction
                .execute(
                    "UPDATE loop_items SET status = ?, completed_at = ?, updated_at = ? \
                     WHERE id = ?",
                    (STATUS_ACKNOWLEDGED, now, now, row.id),
                )
                .await?;
            Ok(true)
        })
        .await
        .map_err(|error| {
            tracing::error!(%error, intent_id, "runtime cleanup acknowledge failed");
            internal_error()
        })
}

/// Python `int(value)` for the desired-state version.
fn python_int(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => number
            .as_i64()
            .or_else(|| number.as_f64().map(|v| v.trunc() as i64)),
        Value::String(text) => text.trim().parse().ok(),
        Value::Bool(value) => Some(i64::from(*value)),
        _ => None,
    }
}

fn status_error(message: &str) -> Value {
    json!({"success": false, "error": message})
}

fn invalid(label: &str) -> Value {
    status_error(&format!("Invalid {} payload", label))
}
