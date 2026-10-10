// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `DELETE /api/devices/records/{record_id}`: record-scoped removal of one
//! owned Device registration.
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

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use brz_mysql::{MysqlError, MysqlTransaction};
use brz_redis::{ErrorKind, Redis, RedisBytes, RedisError, SetExpiration, SetOptions};
use chrono::Utc;
use serde_json::Value;

use crate::auth::{SessionUser, UserRow};
use crate::devices::{
    DeviceKindRow, DeviceSpecInput, DeviceType, internal_error, online_key, record_route_id, spec,
};
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
/// serializes registration against deletion.
const LOCK_DEVICE_OWNER_QUERY: &str = "SELECT users.id AS users_id \n\
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

/// `db.commit()`'s flush of the dirty `Kind` row: `is_active` and the
/// Python-side `onupdate` `updated_at`.
const UPDATE_DEVICE_INACTIVE_QUERY: &str =
    "UPDATE kinds SET is_active=0, updated_at=? WHERE kinds.id = ?";

/// `app_identity_lock`'s `Lock(timeout=30)`: the lock key's TTL.
const IDENTITY_LOCK_TIMEOUT_MS: u64 = 30_000;

/// `Lock(blocking_timeout=10)`: how long acquisition keeps retrying.
const IDENTITY_LOCK_BLOCKING_TIMEOUT: Duration = Duration::from_secs(10);

/// redis-py `Lock.sleep`: the pause between acquisition attempts.
const IDENTITY_LOCK_RETRY_INTERVAL: Duration = Duration::from_millis(100);

/// SHA1 of redis-py's `Lock.LUA_RELEASE_SCRIPT`, the script `Lock.release`
/// runs with `EVALSHA` so only the acquirer deletes the key.
const IDENTITY_LOCK_RELEASE_SHA1: &str = "c3f8721cbb97f72bc19e972846bd7aaf91901658";

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
        match require_offline_and_idle(
            transaction,
            redis,
            user_id,
            &device,
            &device_spec,
            device_type,
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

/// `_require_offline_and_idle`: only cloud registrations may be removed while
/// online or busy. An older running server may still publish under the logical
/// device name, so both the record-scoped route and the name are read.
async fn require_offline_and_idle<T, R>(
    transaction: &mut T,
    redis: &R,
    user_id: i64,
    device: &DeviceKindRow,
    device_spec: &DeviceSpecInput,
    device_type: DeviceType,
) -> Result<GuardDecision, MysqlError>
where
    T: MysqlTransaction,
    R: Redis,
{
    let route_id = record_route_id(device, device_type);
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
    let runtime = device_spec.runtime_instance_id_value();
    let running = active_subtask_by_executor(transaction, user_id, &route_id, &device.name).await?;

    let online_reported = online.as_ref().is_some_and(python_truthy);
    // `legacy.get("runtime_instance_id")` names this record's Runtime, or the
    // legacy document predates the field (`not runtime`).
    let legacy_conflict = legacy
        .as_ref()
        .filter(|value| python_truthy(value))
        .is_some_and(|legacy| legacy_matches_runtime(legacy, runtime.as_ref()));
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
) -> Result<bool, MysqlError> {
    let executor_names = [format!("device-{route_id}"), format!("device-{name}")];
    let row: Option<ActiveSubtaskRow> = transaction
        .fetch_optional(
            ACTIVE_SUBTASK_BY_EXECUTOR_QUERY,
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
fn python_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(number) => number.as_f64().is_some_and(|value| value != 0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(value) => !value.is_empty(),
        Value::Object(value) => !value.is_empty(),
    }
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
struct LockOwnerRow {
    #[allow(dead_code, reason = "the row's presence is the whole answer")]
    #[mysql(rename = "users_id")]
    users_id: i32,
}

/// The `subtasks` probe row; only its presence matters.
#[derive(brz_mysql::FromMysqlRow)]
struct ActiveSubtaskRow {
    #[allow(dead_code, reason = "the row's presence is the whole answer")]
    #[mysql(rename = "subtasks_id")]
    subtasks_id: i64,
}

/// `device:identity-lock:{user_id}` (`app_identity_lock`).
fn identity_lock_key(user_id: i64) -> String {
    format!("device:identity-lock:{user_id}")
}

/// The Redis lock `app_identity_lock` holds across the delete.
///
/// redis-py's `Lock` acquires with `SET name token NX PX timeout` and releases
/// only when the stored value still equals its token, so an expired or stolen
/// lock is never released by its former owner.
///
/// The owner token is a source-random draw, so Replay matches it through the
/// `device-record-identity-lock` dependency rule rather than as an argument:
/// the rule correlates the recorded `SET … NX … PX` with its `EVALSHA` release
/// by key, token and resource identity instead of by physical connection, so
/// this lane replays in recorded order across target connections. The release
/// is accepted only once the acquisition has been consumed.
struct IdentityLock<'a, R: Redis> {
    redis: &'a R,
    key: String,
    token: String,
}

impl<'a, R: Redis> IdentityLock<'a, R> {
    /// `Lock.acquire`: retry every 100 ms until the 10 s blocking budget
    /// expires. `Ok(None)` is redis-py's `LockError`; `Err` is the propagated
    /// request failure the endpoint also maps to 503.
    async fn acquire(redis: &'a R, user_id: i64) -> Result<Option<Self>, RedisError> {
        let key = identity_lock_key(user_id);
        let token = lock_token();
        let options = SetOptions::default()
            .with_expiration(SetExpiration::Milliseconds(IDENTITY_LOCK_TIMEOUT_MS))
            .if_absent();
        let deadline = tokio::time::Instant::now() + IDENTITY_LOCK_BLOCKING_TIMEOUT;
        loop {
            if redis
                .set_with(key.as_str(), token.as_str(), options)
                .await?
            {
                return Ok(Some(Self { redis, key, token }));
            }
            if tokio::time::Instant::now() + IDENTITY_LOCK_RETRY_INTERVAL > deadline {
                return Ok(None);
            }
            tokio::time::sleep(IDENTITY_LOCK_RETRY_INTERVAL).await;
        }
    }

    /// `Lock.release`: `EVALSHA` of the redis-py release script, which returns
    /// `1` only when this token still owns the key.
    async fn release(&self) -> Result<(), RedisError> {
        let released: i64 = self
            .redis
            .evalsha(
                IDENTITY_LOCK_RELEASE_SHA1,
                [self.key.as_str()],
                [self.token.as_str()],
            )
            .await?;
        if released == 1 {
            Ok(())
        } else {
            Err(RedisError::new(
                ErrorKind::ResponseError,
                "Cannot release a lock that's no longer owned",
            ))
        }
    }
}

/// The lock's owner token: 32 lowercase hex characters, like the
/// `uuid.uuid1().hex` redis-py stores, so only the acquirer can release the
/// key. The value is a per-acquisition random draw; nothing downstream reads
/// it.
fn lock_token() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos() as u64)
        .unwrap_or(0);
    let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let mut token = String::with_capacity(32);
    for half in 0..2u64 {
        let mut hasher = RandomState::new().build_hasher();
        hasher.write_u64(nanos);
        hasher.write_u64(sequence);
        hasher.write_u64(half);
        token.push_str(&format!("{:016x}", hasher.finish()));
    }
    token
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn identity_lock_key_matches_the_source_prefix() {
        assert_eq!(identity_lock_key(157), "device:identity-lock:157");
    }

    #[test]
    fn lock_tokens_are_unique_hex_of_the_redis_py_length() {
        let first = lock_token();
        let second = lock_token();
        assert_eq!(first.len(), 32);
        assert!(first.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(first, second);
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
