// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `DELETE /api/devices/records/{record_id}`: record-scoped removal of one
//! owned Device registration.
//! The admin route resolves the owner by record ID and always requires the
//! device to be offline and idle.
//!
//! Mirrors `app.api.endpoints.devices.delete_device_by_record`, which runs
//! `app.services.device.record_operations.delete_device_record` inside
//! `app.services.device.record_operations.device_identity_lock`:
//!
//! 1. the Redis identity lock `device:identity-lock:{user_id}` covering the
//!    database-to-online transition — `redis.asyncio` `Lock` with
//!    `timeout=30`, `blocking_timeout=10`, acquired with
//!    `SET key <owner-token> PX 30000 NX` and released through the redis-py
//!    `Lock.LUA_RELEASE_SCRIPT` by SHA1;
//! 2. `lock_device_owner` — `SELECT users.id ... FOR UPDATE`, serializing
//!    registration and deletion without a new schema constraint;
//! 3. the owned active `Device` Kind row, selected `FOR UPDATE`;
//! 4. for a non-cloud registration, `_require_offline_and_idle`: the two
//!    `device:online:{user_id}:{route}` reads plus
//!    `subtask_store.has_active_by_executor_names`;
//! 5. `is_active = False`, then `db.commit()`.
//!
//! The endpoint maps `DeviceIdentityConflictError` to 409, a `RedisError` to
//! 503, an absent record to 404, and renders
//! `{"message": "Device registration removed"}` on success. The delete runs on
//! one transaction connection because the `FOR UPDATE` row lock has to span
//! the `UPDATE` that ends it.

use brz_mysql::{MysqlError, MysqlTransaction};
use brz_redis::{Redis, RedisBytes};
use chrono::Utc;
use serde_json::Value;

use crate::admin_service_keys::AdminUser;
use crate::auth::SessionUser;
use crate::device_identity::{DeviceKindRow, device_connection_route_id, runtime_device_id};
use crate::device_identity_lock::{IDENTITY_LOCK_BODY_TIMEOUT, IdentityLock};
use crate::devices::{internal_error, online_key};
use crate::http_compat::FastApiError;
use crate::state::AppState;

/// `DeviceType.CLOUD.value` (`app.schemas.device`).
const CLOUD_DEVICE_TYPE: &str = "cloud";

/// The endpoint's success body.
const REMOVED_MESSAGE: &str = "Device registration removed";

/// `DeviceIdentityConflictError`'s message for a registration that is still
/// online or busy.
const IDENTITY_CONFLICT_MESSAGE: &str = "Device is online or busy; disconnect it before removal";

/// `lock_device_owner` (`identity.lock_device_owner`): the owner row lock that
/// serializes registration against deletion. Shared by the delete endpoint and
/// the `/local-executor` registration path.
pub(crate) const LOCK_DEVICE_OWNER_QUERY: &str = "SELECT users.id AS users_id \n\
     FROM users \n\
     WHERE users.id = ? \n LIMIT 1 FOR UPDATE";

/// The owned active Device record the delete acts on
/// (`db.query(Kind).filter_by(...).with_for_update().one_or_none()`): every
/// mapped `Kind` column with its SQLAlchemy `kinds_<column>` alias.
const DEVICE_RECORD_FOR_UPDATE_QUERY: &str = "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
     kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
     kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
     kinds.updated_at AS kinds_updated_at FROM kinds \
     WHERE kinds.id = ? AND kinds.user_id = ? AND kinds.namespace = 'default' \
     AND kinds.kind = 'Device' AND kinds.is_active = true FOR UPDATE";

const DEVICE_RECORD_OWNER_QUERY: &str = "SELECT user_id FROM kinds \
     WHERE id = ? AND namespace = 'default' AND kind = 'Device' AND is_active = true";

#[derive(brz_mysql::FromMysqlRow)]
struct DeviceRecordOwner {
    user_id: i32,
}

/// Probe each physical subtask table when the deployment shards by task ID.
const ACTIVE_SUBTASK_BY_EXECUTOR_QUERY: &str = "SELECT subtasks.id AS subtasks_id \n\
     FROM {table} AS subtasks \n\
     WHERE subtasks.user_id = ? \
     AND subtasks.executor_name IN (?, ?) \
     AND subtasks.status IN ('PENDING', 'RUNNING') \n LIMIT 1";

async fn has_active_project_execution(
    transaction: &mut impl MysqlTransaction,
    user_id: i64,
    device: &DeviceKindRow,
) -> Result<bool, MysqlError> {
    let statuses = crate::socketio::execution_aggregate::CAPACITY_STATUSES;
    let route = runtime_device_id(device);
    let connection = device_connection_route_id(device);
    let instance = device.json["spec"]["runtimeInstanceId"]
        .as_str()
        .unwrap_or_default();
    let row: Option<(i64,)> = transaction
        .fetch_optional(
            format!(
                "SELECT id FROM loop_item_executions WHERE executor_owner_user_id = ? \
            AND runtime_device_id IN (?, ?) AND runtime_device_id <> '' \
            AND (runtime_instance_id = '' OR ? = '' OR runtime_instance_id = ?) \
            AND status IN ({statuses}) LIMIT 1"
            ),
            (
                user_id,
                route.as_str(),
                connection.as_str(),
                instance,
                instance,
            ),
        )
        .await?;
    Ok(row.is_some())
}

pub(crate) async fn lock_device_owner(
    transaction: &mut impl MysqlTransaction,
    user_id: i64,
) -> Result<(), MysqlError> {
    let _owner: Option<LockOwnerRow> = transaction
        .fetch_optional(LOCK_DEVICE_OWNER_QUERY, (user_id,))
        .await?;
    Ok(())
}

pub(crate) async fn lock_online_device_for_binding<T: MysqlTransaction>(
    transaction: &mut T,
    redis: &impl Redis,
    user_id: i64,
    device_id: &str,
) -> Result<Option<DeviceKindRow>, MysqlError> {
    lock_device_owner(transaction, user_id).await?;
    let mut query = &mut *transaction;
    let Some(device) =
        crate::device_identity::resolve_device_for_binding_on(&mut query, user_id, device_id)
            .await?
    else {
        return Ok(None);
    };
    let route = device_connection_route_id(&device);
    let online = crate::device_online_state::read_online_state_with(redis, user_id, &route)
        .await
        .map_err(|()| MysqlError::InvalidQuery {
            reason: "Device online state is unavailable".into(),
        })?;
    Ok(online
        .filter(|value| matches_online_registration(&device, value))
        .map(|_| device))
}

fn matches_online_registration(device: &DeviceKindRow, online: &Value) -> bool {
    let spec = &device.json["spec"];
    let runtime = spec["runtimeInstanceId"]
        .as_str()
        .filter(|id| !id.is_empty());
    online.as_object().is_some_and(|info| !info.is_empty())
        && match runtime {
            Some(id) => online["runtime_instance_id"].as_str() == Some(id),
            None => !crate::device_identity::is_app_device(device),
        }
}

/// `db.commit()`'s flush of the dirty `Kind` row: `is_active` and the
/// Python-side `onupdate` `updated_at`.
const UPDATE_DEVICE_INACTIVE_QUERY: &str =
    "UPDATE kinds SET is_active=0, updated_at=? WHERE kinds.id = ?";

/// The endpoint's success body (`{"message": "Device registration removed"}`).
#[derive(serde::Serialize)]
struct DeviceRecordRemoved {
    message: &'static str,
}

/// DELETE /api/devices/records/{record_id}: the delete free function,
/// injecting the process-lifetime application state.
#[brz_http_server::delete("/api/devices/records/:record_id")]
async fn delete_device_by_record(
    #[inject(state)] state: &AppState,
    record_id: i64,
    #[auth] user: SessionUser,
) -> Result<DeviceRecordRemoved, FastApiError> {
    delete_device_record(state, i64::from(user.id), record_id, false).await
}

#[brz_http_server::delete("/api/admin/device-monitor/devices/records/:record_id")]
async fn delete_admin_device_record(
    #[inject(state)] state: &AppState,
    record_id: i64,
    #[auth] admin: AdminUser,
) -> Result<DeviceRecordRemoved, FastApiError> {
    let owner: DeviceRecordOwner = state
        .mysql
        .with_transaction(async |transaction| {
            transaction
                .fetch_optional(DEVICE_RECORD_OWNER_QUERY, (record_id,))
                .await
        })
        .await
        .map_err(|error| {
            tracing::error!(%error, record_id, "device record owner lookup failed");
            internal_error()
        })?
        .ok_or_else(record_not_found)?;
    let removed = delete_device_record(state, i64::from(owner.user_id), record_id, true).await?;
    tracing::info!(
        admin_id = admin.0.id,
        owner_id = owner.user_id,
        record_id,
        "admin removed device registration"
    );
    Ok(removed)
}

#[tracing::instrument(name = "device.record.delete", skip(state))]
async fn delete_device_record(
    state: &AppState,
    user_id: i64,
    record_id: i64,
    offline_only: bool,
) -> Result<DeviceRecordRemoved, FastApiError> {
    // `cache_manager._get_client()` needs the application Redis service; the
    // endpoint renders every Redis failure as its 503.
    let Some(redis) = state.redis.as_ref() else {
        tracing::error!("device identity lock unavailable: no Redis service");
        return Err(status_unavailable());
    };
    let lock = match IdentityLock::acquire(redis, user_id).await {
        Ok(Some(lock)) => lock,
        // `Lock.__aenter__` raises `LockError` when the blocking budget
        // expires, and `acquire` propagates a request failure unchanged.
        Ok(None) => {
            tracing::warn!(user_id, "device identity lock is held by another worker");
            return Err(status_unavailable());
        }
        Err(error) => {
            tracing::error!(%error, user_id, "device identity lock acquisition failed");
            return Err(status_unavailable());
        }
    };

    let subtask_tables = state.task_store.subtask_tables();
    let outcome = tokio::time::timeout(
        IDENTITY_LOCK_BODY_TIMEOUT,
        state.mysql.with_transaction(async |transaction| {
            delete_record_in(
                transaction,
                redis,
                user_id,
                record_id,
                offline_only,
                &subtask_tables,
            )
            .await
        }),
    )
    .await;

    // Preserve the owner endpoint's error mapping. Report a committed admin
    // removal as successful even if releasing the lease fails.
    if let Err(error) = lock.release().await {
        tracing::error!(%error, user_id, "device identity lock release failed");
        if !offline_only || !matches!(&outcome, Ok(Ok(RecordDeletion::Deleted))) {
            return Err(status_unavailable());
        }
    }

    let outcome = outcome.map_err(|_| {
        tracing::warn!(user_id, record_id, "device record deletion timed out");
        status_unavailable()
    })?;

    match outcome {
        Ok(RecordDeletion::Deleted) => Ok(DeviceRecordRemoved {
            message: REMOVED_MESSAGE,
        }),
        Ok(RecordDeletion::NotFound) => Err(record_not_found()),
        Ok(RecordDeletion::Conflict) => Err(FastApiError::detail(
            brz_http_server::StatusCode::CONFLICT,
            IDENTITY_CONFLICT_MESSAGE,
        )),
        Ok(RecordDeletion::StatusUnavailable) => Err(status_unavailable()),
        Ok(RecordDeletion::Undecodable) => {
            // The source's `json.loads` of an online-state payload surfaces an
            // unhandled `ValueError` through the framework's 500 handler.
            tracing::error!(user_id, "device online-state payload is not JSON");
            Err(internal_error())
        }
        Err(error) => {
            tracing::error!(%error, "device record deletion dependency failure");
            Err(internal_error())
        }
    }
}

/// The three observable results of the guarded delete, plus the two failure
/// modes whose responses the endpoint owns.
enum RecordDeletion {
    /// `delete_device_record` returned `True`.
    Deleted,
    /// `one_or_none()` found no owned active record.
    NotFound,
    /// `DeviceIdentityConflictError`: the registration is online or busy.
    Conflict,
    /// A Redis read failed inside the guard.
    StatusUnavailable,
    /// An online-state payload could not be decoded.
    Undecodable,
}

/// The transaction body: everything the source runs between acquiring the
/// identity lock and `db.commit()`.
async fn delete_record_in<T, R>(
    transaction: &mut T,
    redis: &R,
    user_id: i64,
    record_id: i64,
    offline_only: bool,
    subtask_tables: &[String],
) -> Result<RecordDeletion, MysqlError>
where
    T: MysqlTransaction,
    R: Redis,
{
    lock_device_owner(transaction, user_id).await?;

    let Some(device) = transaction
        .fetch_optional::<_, _, DeviceKindRow>(DEVICE_RECORD_FOR_UPDATE_QUERY, (record_id, user_id))
        .await?
    else {
        // `db.rollback(); return False`.
        return Ok(RecordDeletion::NotFound);
    };

    if offline_only || device.json["spec"]["deviceType"].as_str() != Some(CLOUD_DEVICE_TYPE) {
        match require_offline_and_idle(transaction, redis, user_id, &device, subtask_tables).await?
        {
            GuardDecision::Offline => {}
            GuardDecision::Online => return Ok(RecordDeletion::Conflict),
            GuardDecision::Unavailable => return Ok(RecordDeletion::StatusUnavailable),
            GuardDecision::Undecodable => return Ok(RecordDeletion::Undecodable),
        }
        if has_active_project_execution(transaction, user_id, &device).await? {
            return Ok(RecordDeletion::Conflict);
        }
    }

    // `device.is_active = False; db.commit()`.
    let updated_at = Utc::now()
        .naive_utc()
        .format("%Y-%m-%d %H:%M:%S%.6f")
        .to_string();
    transaction
        .execute(UPDATE_DEVICE_INACTIVE_QUERY, (updated_at, device.id))
        .await?;
    Ok(RecordDeletion::Deleted)
}

/// `_require_offline_and_idle`'s decision.
enum GuardDecision {
    /// Nothing reports the registration as online or busy.
    Offline,
    /// Online, running, or matched by the legacy online payload.
    Online,
    /// The online-state read failed.
    Unavailable,
    /// An online-state payload is not JSON.
    Undecodable,
}

/// An older running server may still publish under the logical
/// device name, so both the record-scoped route and the name are read.
async fn require_offline_and_idle<T, R>(
    transaction: &mut T,
    redis: &R,
    user_id: i64,
    device: &DeviceKindRow,
    subtask_tables: &[String],
) -> Result<GuardDecision, MysqlError>
where
    T: MysqlTransaction,
    R: Redis,
{
    let route_id = device_connection_route_id(device);
    let keys = vec![
        online_key(user_id, &route_id),
        online_key(user_id, &device.name),
    ];
    let values = match redis.mget::<_, RedisBytes>(keys).await {
        Ok(values) => values,
        Err(error) => {
            // "Read strictly: a cache failure is not evidence that deletion is
            // safe." The endpoint maps the `RedisError` to 503.
            tracing::error!(%error, user_id, "device online-state read failed");
            return Ok(GuardDecision::Unavailable);
        }
    };
    let online = match decode_online_document(values.first().and_then(Option::as_ref)) {
        Ok(value) => value,
        Err(()) => return Ok(GuardDecision::Undecodable),
    };
    let legacy = match decode_online_document(values.get(1).and_then(Option::as_ref)) {
        Ok(value) => value,
        Err(()) => return Ok(GuardDecision::Undecodable),
    };
    let runtime = device.json["spec"].get("runtimeInstanceId");

    let online_reported = online.as_ref().is_some_and(python_truthy);
    // `legacy.get("runtime_instance_id")` names this record's Runtime, or the
    // legacy document predates the field (`not runtime`).
    let legacy_conflict = legacy
        .as_ref()
        .filter(|value| python_truthy(value))
        .is_some_and(|legacy| legacy_matches_runtime(legacy, runtime));
    if online_reported || legacy_conflict {
        return Ok(GuardDecision::Online);
    }
    for table in subtask_tables {
        if active_subtask_by_executor(transaction, table, user_id, &route_id, &device.name).await? {
            return Ok(GuardDecision::Online);
        }
    }
    Ok(GuardDecision::Offline)
}

/// `legacy and (not runtime or legacy.get("runtime_instance_id") == runtime)`.
fn legacy_matches_runtime(legacy: &Value, runtime: Option<&Value>) -> bool {
    match runtime {
        Some(runtime) if python_truthy(runtime) => {
            legacy.get("runtime_instance_id") == Some(runtime)
        }
        _ => true,
    }
}

/// `subtask_store.has_active_by_executor_names`: whether the user has a
/// pending or running subtask on either identity of the device.
async fn active_subtask_by_executor<T: MysqlTransaction>(
    transaction: &mut T,
    table: &str,
    user_id: i64,
    route_id: &str,
    name: &str,
) -> Result<bool, MysqlError> {
    let executor_names = [format!("device-{route_id}"), format!("device-{name}")];
    let row: Option<ActiveSubtaskRow> = transaction
        .fetch_optional(
            ACTIVE_SUBTASK_BY_EXECUTOR_QUERY.replace("{table}", table),
            (
                user_id,
                executor_names[0].as_str(),
                executor_names[1].as_str(),
            ),
        )
        .await?;
    Ok(row.is_some())
}

/// `json.loads(value)`: `None` for a missing key, the decoded document
/// otherwise. A payload that is not JSON is the `ValueError` the source does
/// not catch.
fn decode_online_document(value: Option<&RedisBytes>) -> Result<Option<Value>, ()> {
    let Some(value) = value else {
        return Ok(None);
    };
    serde_json::from_slice(value.as_ref())
        .map(Some)
        .map_err(|_| ())
}

/// Python truthiness of a decoded JSON value (`bool(value)`).
use brz_json::adapters::python_truthy;

fn record_not_found() -> FastApiError {
    FastApiError::detail(
        brz_http_server::StatusCode::NOT_FOUND,
        "Device record not found",
    )
}

/// The endpoint's 503 (`HTTPException(503, "Device status is temporarily
/// unavailable")`).
fn status_unavailable() -> FastApiError {
    FastApiError::detail(
        brz_http_server::StatusCode::SERVICE_UNAVAILABLE,
        "Device status is temporarily unavailable",
    )
}

/// The `users` row lock `lock_device_owner` takes; only its presence matters.
#[derive(brz_mysql::FromMysqlRow)]
pub(crate) struct LockOwnerRow {
    #[allow(dead_code, reason = "the row's presence is the whole answer")]
    #[mysql(rename = "users_id")]
    pub(crate) users_id: i32,
}

/// The `subtasks` probe row; only its presence matters.
#[derive(brz_mysql::FromMysqlRow)]
struct ActiveSubtaskRow {
    #[allow(dead_code, reason = "the row's presence is the whole answer")]
    #[mysql(rename = "subtasks_id")]
    subtasks_id: i64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn device_online_match_accepts_legacy_local_but_requires_app_runtime() {
        let mut device = DeviceKindRow {
            id: 1,
            name: "device".into(),
            json: json!({"spec": {"deviceType": "local", "runtimeInstanceId": ""}}),
        };
        let online = json!({"socket_id": "sid"});
        assert!(matches_online_registration(&device, &online));
        device.json["spec"]["deviceType"] = json!("app");
        assert!(!matches_online_registration(&device, &online));
        device.json["spec"]["runtimeInstanceId"] = json!("runtime");
        assert!(!matches_online_registration(&device, &online));
        assert!(matches_online_registration(
            &device,
            &json!({"socket_id": "sid", "runtime_instance_id": "runtime"}),
        ));
    }

    #[test]
    fn admin_delete_is_registered_and_selected_by_the_gateway() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml");
        let table = crate::RouteTable::compile(crate::load_routes_config(&path).unwrap()).unwrap();
        assert!(table.matches(
            &http::Method::DELETE,
            "/api/admin/device-monitor/devices/records/123"
        ));
        assert!(!table.matches(
            &http::Method::GET,
            "/api/admin/device-monitor/devices/records/123"
        ));

        const DELETE: u16 = 1;
        let registered = brz_http_server::__private::inventory::iter::<
            crate::__http_registry_http_apis::Entry,
        >()
        .flat_map(|entry| (entry.0.routes)())
        .any(|route| {
            route.path == "/api/admin/device-monitor/devices/records/:record_id"
                && route.methods & DELETE != 0
        });
        assert!(registered);
    }

    #[test]
    fn python_truthiness_follows_the_source_booleans() {
        assert!(!python_truthy(&Value::Null));
        assert!(!python_truthy(&json!(false)));
        assert!(!python_truthy(&json!(0)));
        assert!(!python_truthy(&json!(0.0)));
        assert!(!python_truthy(&json!("")));
        assert!(!python_truthy(&json!([])));
        assert!(!python_truthy(&json!({})));
        assert!(python_truthy(&json!(true)));
        assert!(python_truthy(&json!(1)));
        assert!(python_truthy(&json!("x")));
        assert!(python_truthy(&json!(["x"])));
        assert!(python_truthy(&json!({"a": 1})));
    }

    #[test]
    fn legacy_online_document_conflicts_on_the_same_runtime() {
        // `not runtime`: a pre-`runtimeInstanceId` record always conflicts.
        assert!(legacy_matches_runtime(&json!({}), None));
        assert!(legacy_matches_runtime(&json!({}), Some(&Value::Null)));
        // A different installation's live registration does not.
        assert!(!legacy_matches_runtime(
            &json!({"runtime_instance_id": "other"}),
            Some(&json!("mine"))
        ));
        assert!(legacy_matches_runtime(
            &json!({"runtime_instance_id": "mine"}),
            Some(&json!("mine"))
        ));
    }

    #[test]
    fn online_payloads_decode_or_report_the_source_value_error() {
        let bytes = RedisBytes::from(b"{\"status\": \"online\"}".to_vec());
        assert_eq!(
            decode_online_document(Some(&bytes)),
            Ok(Some(json!({"status": "online"})))
        );
        assert_eq!(decode_online_document(None), Ok(None));
        let broken = RedisBytes::from(b"not-json".to_vec());
        assert_eq!(decode_online_document(Some(&broken)), Err(()));
    }

    /// The recorded statement shapes: every `kinds`/`users`/`subtasks`
    /// projection keeps its SQLAlchemy `<table>_<column>` alias, and the
    /// delete's row locks and write match the source rendering.
    #[test]
    fn statements_keep_the_source_sqlalchemy_rendering() {
        assert!(
            LOCK_DEVICE_OWNER_QUERY.starts_with("SELECT users.id AS users_id"),
            "{LOCK_DEVICE_OWNER_QUERY}"
        );
        assert!(LOCK_DEVICE_OWNER_QUERY.ends_with("LIMIT 1 FOR UPDATE"));
        assert!(DEVICE_RECORD_FOR_UPDATE_QUERY.contains("kinds.json AS kinds_json"));
        assert!(DEVICE_RECORD_FOR_UPDATE_QUERY.contains("kinds.is_active = true"));
        assert!(DEVICE_RECORD_FOR_UPDATE_QUERY.contains("kinds.kind = 'Device'"));
        assert!(DEVICE_RECORD_FOR_UPDATE_QUERY.ends_with("FOR UPDATE"));
        assert!(!DEVICE_RECORD_FOR_UPDATE_QUERY.contains("LIMIT"));
        assert_eq!(
            UPDATE_DEVICE_INACTIVE_QUERY,
            "UPDATE kinds SET is_active=0, updated_at=? WHERE kinds.id = ?"
        );
        assert!(
            ACTIVE_SUBTASK_BY_EXECUTOR_QUERY.contains("subtasks.executor_name IN (?, ?)"),
            "{ACTIVE_SUBTASK_BY_EXECUTOR_QUERY}"
        );
        assert!(
            ACTIVE_SUBTASK_BY_EXECUTOR_QUERY.contains("subtasks.status IN ('PENDING', 'RUNNING')"),
            "{ACTIVE_SUBTASK_BY_EXECUTOR_QUERY}"
        );
    }

    #[test]
    fn success_body_matches_the_recorded_response() {
        assert_eq!(
            serde_json::to_string(&DeviceRecordRemoved {
                message: REMOVED_MESSAGE
            })
            .unwrap(),
            "{\"message\":\"Device registration removed\"}"
        );
    }

    #[test]
    fn unavailable_body_matches_the_source_503() {
        let error = status_unavailable();
        assert_eq!(
            error.status(),
            brz_http_server::StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(
            error.detail_message(),
            Some("Device status is temporarily unavailable")
        );
    }
}
