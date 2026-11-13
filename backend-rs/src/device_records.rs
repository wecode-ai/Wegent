// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Record-scoped device removal and administrator App identity changes.
//!
//! Mirrors `app.api.endpoints.devices.delete_device_by_record`, which runs
//! `app.services.device.record_operations.delete_device_record` inside
//! `app.services.device.record_operations.app_identity_lock`:
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

use brz_http_server::StatusCode;
use brz_mysql::{MysqlError, MysqlIsolationLevel, MysqlTransaction, MysqlTransactionOptions};
use brz_redis::{Redis, RedisBytes};
use chrono::Utc;
use serde_json::Value;

use crate::admin_service_keys::AdminUser;
use crate::auth::{SessionUser, UserRow};
use crate::device_identity_lock::IdentityLock;
use crate::devices::{
    DeviceKindRow, DeviceType, internal_error, online_key, record_route_id, spec,
};
use crate::http_compat::FastApiError;
use crate::socketio::device::DeviceKindRow as RegistrationRow;
use crate::socketio::device_upsert::{DEVICE_BY_NAME_QUERY, app_registration_record, spec_string};
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

/// `subtask_store.has_active_by_executor_names`. The deployment's sharded
/// subtask store does not override the base implementation, which queries the
/// default `Subtask` model, so the read always targets the base `subtasks`
/// table and never a shard.
const ACTIVE_SUBTASK_BY_EXECUTOR_QUERY: &str = "SELECT subtasks.id AS subtasks_id \n\
     FROM subtasks \n\
     WHERE subtasks.user_id = ? \
     AND subtasks.executor_name IN (?, ?) \
     AND subtasks.status IN ('PENDING', 'RUNNING') \n LIMIT 1";

// Limit the next-key locks to this owner's executor/status ranges even on
// small tables where the optimizer could otherwise choose a full scan.
const LOCK_ACTIVE_SUBTASK_BY_EXECUTOR_QUERY: &str = "SELECT id AS subtasks_id \
     FROM subtasks FORCE INDEX (ix_subtasks_user_executor_status) \
     WHERE user_id = ? AND executor_name IN (?, ?) \
     AND status IN ('PENDING', 'RUNNING') LIMIT 1 FOR UPDATE";

/// `db.commit()`'s flush of the dirty `Kind` row: `is_active` and the
/// Python-side `onupdate` `updated_at`.
const UPDATE_DEVICE_INACTIVE_QUERY: &str =
    "UPDATE kinds SET is_active=0, updated_at=? WHERE kinds.id = ?";

const REBIND_RECORD_QUERY: &str = "SELECT id AS kinds_id, name AS kinds_name, \
     json AS kinds_json, is_active AS kinds_is_active FROM kinds WHERE id = ? \
     AND user_id = ? AND namespace = 'default' AND kind = 'Device' FOR UPDATE";

#[derive(serde::Deserialize)]
struct DeviceRebind {
    runtime_instance_id: String,
    expected_app_device_id: Value,
    new_app_device_id: String,
}

impl DeviceRebind {
    fn validate(&self) -> Result<(), FastApiError> {
        let valid_id = |id: &str| !id.trim().is_empty() && id.chars().count() <= 255;
        let expected = &self.expected_app_device_id;
        if !valid_id(&self.runtime_instance_id)
            || !valid_id(&self.new_app_device_id)
            || !(expected.is_null()
                || expected
                    .as_str()
                    .is_some_and(|id| id.chars().count() <= 255))
            || expected.as_str() == Some(self.new_app_device_id.as_str())
        {
            return Err(FastApiError::detail(
                StatusCode::BAD_REQUEST,
                "Provide a Runtime ID, the current App ID (or null), and a different new App ID",
            ));
        }
        Ok(())
    }
}

#[derive(serde::Serialize)]
struct DeviceRebound {
    record_id: i64,
}

#[brz_http_server::post("/api/admin/users/:user_id/devices/records/:record_id/rebind")]
async fn rebind_device_record(
    #[inject(state)] state: &AppState,
    #[auth] admin: AdminUser,
    user_id: i64,
    record_id: i64,
    body: DeviceRebind,
) -> Result<DeviceRebound, FastApiError> {
    body.validate()?;
    if !state.unique_app_device_names {
        return Err(rebind_conflict(
            "App device rebind requires unique App device names",
        ));
    }
    let redis = state.redis.as_ref().ok_or_else(status_unavailable)?;
    let lock = IdentityLock::acquire(redis, user_id)
        .await
        .map_err(|error| {
            tracing::warn!(%error, user_id, "device rebind lock acquisition failed");
            status_unavailable()
        })?
        .ok_or_else(status_unavailable)?;
    let outcome = tokio::time::timeout(
        crate::device_identity_lock::IDENTITY_LOCK_BODY_TIMEOUT,
        state.mysql.with_transaction_options(
            MysqlTransactionOptions::default()
                .with_isolation_level(MysqlIsolationLevel::RepeatableRead),
            async |tx| rebind_record_in(tx, redis, user_id, record_id, &body).await,
        ),
    )
    .await;
    if let Err(error) = lock.release().await {
        tracing::error!(%error, user_id, "device rebind lock release failed");
        return Err(status_unavailable());
    }
    match outcome {
        Ok(Ok(Ok(()))) => {
            tracing::info!(
                admin_user_id = admin.0.id,
                user_id,
                record_id,
                "App device rebound"
            );
            Ok(DeviceRebound { record_id })
        }
        Ok(Ok(Err(error))) => Err(error),
        Ok(Err(error)) => {
            tracing::error!(%error, user_id, record_id, "device rebind database operation failed");
            Err(internal_error())
        }
        Err(_) => Err(status_unavailable()),
    }
}

fn rebind_conflict(message: &'static str) -> FastApiError {
    FastApiError::detail(StatusCode::CONFLICT, message)
}

async fn rebind_record_in<T: MysqlTransaction, R: Redis>(
    tx: &mut T,
    redis: &R,
    user_id: i64,
    record_id: i64,
    rebind: &DeviceRebind,
) -> Result<Result<(), FastApiError>, MysqlError> {
    let _owner: Option<LockOwnerRow> = tx
        .fetch_optional(LOCK_DEVICE_OWNER_QUERY, (user_id,))
        .await?;
    let Some(row) = tx
        .fetch_optional::<_, _, RegistrationRow>(REBIND_RECORD_QUERY, (record_id, user_id))
        .await?
    else {
        return Ok(Err(FastApiError::detail(
            StatusCode::NOT_FOUND,
            "Device record not found",
        )));
    };
    if !app_registration_record(&row.json)
        || spec_string(&row.json, "runtimeInstanceId") != Some(rebind.runtime_instance_id.as_str())
        || row.json["spec"]["appDeviceId"] != rebind.expected_app_device_id
    {
        return Ok(Err(rebind_conflict(
            "Stored device identity no longer matches",
        )));
    }
    let devices: Vec<RegistrationRow> = tx
        .fetch_all(DEVICE_BY_NAME_QUERY, (user_id, row.name.as_str()))
        .await?;
    if devices.iter().any(|device| device.id != row.id) {
        return Ok(Err(rebind_conflict(
            "Device name belongs to multiple records",
        )));
    }
    let route = crate::socketio::device::route_id(&row, crate::socketio::device::DeviceType::App);
    match require_offline_and_idle(tx, redis, user_id, &route, &row.name, LegacyPresence::Any)
        .await?
    {
        GuardDecision::Offline => {}
        GuardDecision::Online => {
            return Ok(Err(rebind_conflict(
                "Device is online or busy; disconnect it before rebinding",
            )));
        }
        GuardDecision::Unavailable | GuardDecision::Undecodable => {
            return Ok(Err(status_unavailable()));
        }
    }
    tx.execute(
        "UPDATE kinds SET json=JSON_SET(json, '$.spec.appDeviceId', ?), updated_at=NOW() \
         WHERE id = ? AND user_id = ? AND namespace = 'default' AND kind = 'Device'",
        (rebind.new_app_device_id.as_str(), row.id, user_id),
    )
    .await?;
    Ok(Ok(()))
}

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
    delete_device_record(state, user.0, record_id).await
}

/// Handler for `DELETE /api/devices/records/{record_id}`.
async fn delete_device_record(
    state: &AppState,
    user: UserRow,
    record_id: i64,
) -> Result<DeviceRecordRemoved, FastApiError> {
    let user_id = i64::from(user.id);
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

    let outcome = state
        .mysql
        .with_transaction(async |transaction| {
            delete_record_in(transaction, redis, user_id, record_id).await
        })
        .await;

    // `async with client.lock(...)` releases before the endpoint returns; a
    // release failure is itself a `RedisError` mapped to 503, whether or not
    // the guarded work succeeded.
    if let Err(error) = lock.release().await {
        tracing::error!(%error, user_id, "device identity lock release failed");
        return Err(status_unavailable());
    }

    match outcome {
        Ok(RecordDeletion::Deleted) => Ok(DeviceRecordRemoved {
            message: REMOVED_MESSAGE,
        }),
        Ok(RecordDeletion::NotFound) => Err(FastApiError::detail(
            brz_http_server::StatusCode::NOT_FOUND,
            "Device record not found",
        )),
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
) -> Result<RecordDeletion, MysqlError>
where
    T: MysqlTransaction,
    R: Redis,
{
    let _owner: Option<LockOwnerRow> = transaction
        .fetch_optional(LOCK_DEVICE_OWNER_QUERY, (user_id,))
        .await?;

    let Some(device) = transaction
        .fetch_optional::<_, _, DeviceKindRow>(DEVICE_RECORD_FOR_UPDATE_QUERY, (record_id, user_id))
        .await?
    else {
        // `db.rollback(); return False`.
        return Ok(RecordDeletion::NotFound);
    };

    let device_spec = spec(&device);
    let device_type = DeviceType::from_spec(&device_spec);
    // `device.json.get("spec", {}).get("deviceType") != "cloud"`.
    if device_spec.device_type_value() != Some(CLOUD_DEVICE_TYPE) {
        let route = record_route_id(&device, device_type);
        let runtime = device_spec.runtime_instance_id_value();
        match require_offline_and_idle(
            transaction,
            redis,
            user_id,
            &route,
            &device.name,
            LegacyPresence::MatchingRuntime(runtime.as_ref()),
        )
        .await?
        {
            GuardDecision::Offline => {}
            GuardDecision::Online => return Ok(RecordDeletion::Conflict),
            GuardDecision::Unavailable => return Ok(RecordDeletion::StatusUnavailable),
            GuardDecision::Undecodable => return Ok(RecordDeletion::Undecodable),
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

enum LegacyPresence<'a> {
    MatchingRuntime(Option<&'a Value>),
    Any,
}

/// `_require_offline_and_idle`: only cloud registrations may be removed while
/// online or busy. An older running server may still publish under the logical
/// device name, so both the record-scoped route and the name are read.
async fn require_offline_and_idle<T, R>(
    transaction: &mut T,
    redis: &R,
    user_id: i64,
    route: &str,
    name: &str,
    legacy_policy: LegacyPresence<'_>,
) -> Result<GuardDecision, MysqlError>
where
    T: MysqlTransaction,
    R: Redis,
{
    let keys = vec![online_key(user_id, route), online_key(user_id, name)];
    let values = match redis.mget::<_, RedisBytes>(keys).await {
        Ok(values) => values,
        Err(error) => {
            // "Read strictly: a cache failure is not evidence that deletion is
            // safe." The endpoint maps the `RedisError` to 503.
            tracing::error!(%error, user_id, "device online-state read failed");
            return Ok(GuardDecision::Unavailable);
        }
    };
    let LegacyPresence::MatchingRuntime(runtime) = legacy_policy else {
        // A locking read under REPEATABLE READ sees in-flight assignments and
        // holds the matching index ranges, including gaps, until rebind commits.
        let busy = values.iter().any(Option::is_some)
            || active_subtask_by_executor(transaction, user_id, route, name, true).await?;
        return Ok(if busy {
            GuardDecision::Online
        } else {
            GuardDecision::Offline
        });
    };
    let online = match decode_online_document(values.first().and_then(Option::as_ref)) {
        Ok(value) => value,
        Err(()) => return Ok(GuardDecision::Undecodable),
    };
    let legacy = match decode_online_document(values.get(1).and_then(Option::as_ref)) {
        Ok(value) => value,
        Err(()) => return Ok(GuardDecision::Undecodable),
    };
    let running = active_subtask_by_executor(transaction, user_id, route, name, false).await?;

    let online_reported = online.as_ref().is_some_and(python_truthy);
    // `legacy.get("runtime_instance_id")` names this record's Runtime, or the
    // legacy document predates the field (`not runtime`).
    let legacy_conflict = legacy
        .as_ref()
        .filter(|value| python_truthy(value))
        .is_some_and(|legacy| legacy_matches_runtime(legacy, runtime));
    Ok(if online_reported || running || legacy_conflict {
        GuardDecision::Online
    } else {
        GuardDecision::Offline
    })
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
    user_id: i64,
    route_id: &str,
    name: &str,
    lock_assignments: bool,
) -> Result<bool, MysqlError> {
    let query = if lock_assignments {
        LOCK_ACTIVE_SUBTASK_BY_EXECUTOR_QUERY
    } else {
        ACTIVE_SUBTASK_BY_EXECUTOR_QUERY
    };
    let executor_names = [format!("device-{route_id}"), format!("device-{name}")];
    let row: Option<ActiveSubtaskRow> = transaction
        .fetch_optional(
            query,
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
