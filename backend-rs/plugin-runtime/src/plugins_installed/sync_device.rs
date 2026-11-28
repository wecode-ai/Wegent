// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/plugins/installed/sync-device`.
//!
//! Source: `app/api/endpoints/installed_plugins.py::sync_installed_plugins_to_device`
//! (line 208) -> `plugin_marketplace_service.reconcile_stale_installed_catalog_refs`
//! -> `plugin_device_installation_service.ensure_pending_for_device` ->
//! `device_capability_sync_service.sync_current_device_capabilities` ->
//! `plugin_device_installation_service.record_device_sync_result`.
//!
//! The source's `sio.call("device:sync_capabilities", payload, to=socket_id,
//! namespace="/local-executor")` publishes an adapter `emit` with a callback
//! identity and awaits the device's acknowledgement on the process-wide
//! `socketio` Redis subscription. [`crate::socketio_rpc`] owns that
//! subscription for the Rust process; this handler publishes and correlates
//! the round trip.
//!
//! Unhandled failures use `FastApiError::unhandled()`, whose explicit CORS
//! decision crosses the private loopback server through the trusted gateway
//! origin. This preserves the source's outer `ServerErrorMiddleware` response:
//! no CORS headers or `Vary: Origin`. Ordinary business results keep CORS.

use brz_mysql::MysqlResult;
use brz_mysql::{MysqlError, MysqlIsolationLevel, MysqlTransactionOptions};
use brz_redis::Redis;
use chrono::Local;
use serde_json::Value;

use crate::PluginState;
use crate::device_identity::plugin_device_id_on;
use crate::http_compat::FastApiError;
use crate::user_reader::UserRecord;
use wegent_backend_persistence::mysql_query::MysqlQuery;
use wegent_plugin_store::PluginDeviceInstallationRow;

use super::EPOCH;
use super::auth;
use super::catalog_reconcile::reconcile_installed_catalog_refs;
use super::desired_capabilities::{BuildError, build_desired_capabilities, capability_snapshot};
use super::online_route::{
    OnlineRoute, OnlineRouteResolution, resolve_online_route, supports_plugin_delta,
};
use super::plugin_sync_protocol::{
    load_versioned_registration_payload, register_plugin_snapshot_intent, supports_plugin_sync_v2,
    validate_plugin_ack,
};
use super::record_sync_result::{SyncResult, record_device_sync_result_for_installs};
use super::report::{DESIRED_INSTALLS_QUERY, DEVICE_ROW_QUERY, INSERT_INSTALLATION_QUERY};
use super::write_coordination::PluginWriteLease;

/// `PLUGIN_AUTO_UPDATE_FAILURE_LIMIT` (`app/core/constants.py`).
const AUTO_UPDATE_FAILURE_LIMIT: i64 = 3;

/// `SYNC_EVENT` (`app/services/device/capability_sync_service.py`).
const SYNC_EVENT: &str = "device:sync_capabilities";
/// `SYNC_NAMESPACE`.
const SYNC_NAMESPACE: &str = "/local-executor";
/// `SYNC_TIMEOUT_SECONDS`: the API-driven capability sync deadline.
pub(super) const SYNC_TIMEOUT_SECONDS: std::time::Duration = std::time::Duration::from_secs(180);
/// `DESIRED_STATE_SYNC_ATTEMPTS`.
pub(super) const DESIRED_STATE_SYNC_ATTEMPTS: usize = 3;
/// Reason text used to roll back the reconcile request-session transaction
/// after a successful read, reproducing the source's `db.close()` ROLLBACK.
pub(super) const ROLLBACK_REASON: &str = "reconcile_request_session_rollback";

/// Roll back the reconcile request-session transaction.
///
/// `verify_api_key`, `get_current_user`, and `resolve_plugin_runtime_device_id`
/// only read, and the source ends the session with `db.close()`, whose idle
/// transaction is discarded rather than committed. `with_transaction_options`
/// commits an `Ok`, so the callback returns this error to roll the group back.
pub(super) fn request_session_rollback() -> MysqlError {
    MysqlError::InvalidQuery {
        reason: ROLLBACK_REASON.to_string(),
    }
}

/// One active `InstalledPlugin` kinds row (`_desired_installs`), projected with
/// SQLAlchemy's labeled aliases.
#[derive(Debug, brz_mysql::FromMysqlRow)]
struct DesiredInstalledKind {
    #[mysql(rename = "kinds_id")]
    id: i64,
    #[mysql(rename = "kinds_json")]
    json: Value,
}

/// POST /api/plugins/installed/sync-device: push the account's desired plugins
/// to one device (source `sync_installed_plugins_to_device`).
#[brz_http_server::post("/api/plugins/installed/sync-device")]
async fn sync_installed_plugins_to_device(
    #[inject(state)] state: &PluginState,
    #[auth] actor: auth::SyncDeviceUser,
    device_id: String,
    reconcile: Option<bool>,
) -> Result<Value, FastApiError> {
    if reconcile.unwrap_or(false) {
        reconcile_device_plugins(state, &actor, &device_id).await
    } else {
        sync_device(state, &actor, &device_id).await
    }
}

/// Source `get_current_user` on the request session: the active `users` row,
/// or the exact rejection detail its failed branch raises.
pub(super) async fn session_user<Q>(
    session: &mut Q,
    user_name: &str,
) -> MysqlResult<Result<UserRecord, FastApiError>>
where
    Q: MysqlQuery,
{
    match auth::find_user_row_by_name_on(session, user_name).await? {
        Some(user) if user.is_active => Ok(Ok(user)),
        Some(_) => Ok(Err(FastApiError::unauthorized(
            auth::USER_NOT_ACTIVATED_DETAIL,
        ))),
        None => Ok(Err(FastApiError::unauthorized(auth::UNAUTHORIZED_DETAIL))),
    }
}

/// The source's `get_current_user` read on the `get_plugin_db` request session.
///
/// `configure_plugin_session` pins that session to READ COMMITTED before its
/// first query, so this read is one short READ COMMITTED transaction that the
/// endpoint's `db.close()` then rolls back. Emitting the isolation setup here
/// keeps the recorded session shape instead of sending the `users` read as a
/// bare pool query.
async fn request_session_user(state: &PluginState, user_name: &str) -> Result<i64, FastApiError> {
    let mut slot: Option<Result<i64, FastApiError>> = None;
    let result = state
        .mysql
        .with_transaction_options(
            MysqlTransactionOptions::default()
                .with_isolation_level(MysqlIsolationLevel::ReadCommitted),
            async |transaction| {
                let mut session = &mut *transaction;
                slot = Some(match session_user(&mut session, user_name).await? {
                    Ok(user) => Ok(user.id),
                    Err(rejection) => Err(rejection),
                });
                Err(request_session_rollback())
            },
        )
        .await;
    match result {
        Err(MysqlError::InvalidQuery { reason }) if reason == ROLLBACK_REASON => {
            slot.expect("the request-session transaction recorded its outcome")
        }
        Err(error) => {
            tracing::error!(%error, user_name, "sync-device request session read failed");
            Err(FastApiError::unhandled())
        }
        Ok(()) => unreachable!("the request-session transaction always rolls back"),
    }
}

/// Source `sync_installed_plugins_to_device`'s non-reconcile branch.
///
/// The source runs this branch as two sequential sessions. `_get_plugin_sync_user`
/// -> `get_current_user` reads the `users` row on the `get_plugin_db` request
/// session, which `configure_plugin_session` pins to READ COMMITTED before its
/// first query; the endpoint then calls `db.close()` and rolls that session
/// back. `run_plugin_operation(prepare_device_plugin_sync, ...)` opens a second
/// READ COMMITTED session, and `reconcile_stale_installed_catalog_refs` plus
/// `ensure_pending_for_device` commit inside it. Both sessions therefore emit
/// the source's isolation setup before their first business statement, so each
/// is reproduced by its own `with_transaction_options(ReadCommitted)`.
async fn sync_device(
    state: &PluginState,
    actor: &auth::SyncDeviceUser,
    device_id: &str,
) -> Result<Value, FastApiError> {
    // A device key authenticates only `reconcile=true`, so this branch always
    // takes `get_current_user`'s in-session `users` read.
    let user_id = request_session_user(state, &actor.user_name).await?;
    if device_id.trim().is_empty() {
        return Err(FastApiError::detail(
            brz_http_server::StatusCode::BAD_REQUEST,
            "device_id is required",
        ));
    }
    let lease = acquire_sync_installations(state, user_id, None)
        .await
        .map_err(super::write_coordination::http_error)?;
    let pending_count = state
        .mysql
        .with_transaction_options(
            MysqlTransactionOptions::default()
                .with_isolation_level(MysqlIsolationLevel::ReadCommitted),
            async |transaction| {
                let mut session = &mut *transaction;
                let revisions = lease.read_plugin_revisions(&mut *session).await?;
                let repaired = reconcile_installed_catalog_refs(
                    &mut session,
                    state.redis.as_ref(),
                    &state.entity_resolvers,
                    user_id,
                    lease.installation_ids(),
                )
                .await?;
                lease.verify_owned().await?;
                let changed = ensure_pending_for_installs(
                    &mut session,
                    user_id,
                    device_id,
                    Some(&lease),
                    lease.installation_ids(),
                )
                .await?;
                if repaired > 0 {
                    super::plugin_sync_protocol::touch_desired_state(&mut session, user_id).await?;
                }
                lease
                    .commit_plugin_revisions(&mut *session, revisions)
                    .await?;
                Ok(changed)
            },
        )
        .await;
    lease.release().await;
    let pending_count = pending_count.map_err(|error| {
        // Source `PluginWriteError` is an `HTTPException(503, code)` raised out
        // of `run_plugin_operation`, so a busy or unavailable lease surfaces as
        // its code rather than an unhandled 500. Transport and statement
        // failures keep the unhandled mapping.
        if super::write_coordination::is_plugin_write_error(&error) {
            tracing::warn!(%error, user_name = actor.user_name, "sync-device pending refresh deferred");
            return super::write_coordination::http_error(error);
        }
        tracing::error!(%error, user_name = actor.user_name, "sync-device pending refresh failed");
        FastApiError::unhandled()
    })?;

    // Source `db.close()` ends the pending session: SQLAlchemy rolls back the
    // idle transaction started after the commit.
    let _ = state.mysql.execute("ROLLBACK", ()).await;

    let result = sync_latest_device_capabilities(state, user_id, device_id).await?;
    record_sync_result(state, user_id, &result).await?;

    let mut response = serde_json::Map::new();
    response.insert("reconciled".to_string(), Value::Bool(false));
    response.insert("deviceId".to_string(), Value::String(device_id.to_string()));
    response.insert("pendingCount".to_string(), Value::from(pending_count));
    response.insert("sync".to_string(), result.response("replace"));
    Ok(Value::Object(response))
}

/// Record the round trip in a fresh session, like the source's
/// `run_plugin_operation(record_device_sync_result, ...)` block, whose
/// `configure_plugin_session` pins the session to READ COMMITTED before its
/// first query.
async fn record_sync_result(
    state: &PluginState,
    user_id: i64,
    result: &SyncResult,
) -> Result<(), FastApiError> {
    let ids = sync_result_installation_ids(result);
    let lease = acquire_sync_installations(state, user_id, ids.as_deref())
        .await
        .map_err(super::write_coordination::http_error)?;
    let outcome = state
        .mysql
        .with_transaction_options(
            MysqlTransactionOptions::default()
                .with_isolation_level(MysqlIsolationLevel::ReadCommitted),
            async |transaction| {
                let mut session = &mut *transaction;
                let revisions = lease.read_plugin_revisions(&mut *session).await?;
                record_device_sync_result_for_installs(
                    &mut session,
                    user_id,
                    result,
                    Some(&lease),
                    lease.installation_ids(),
                )
                .await?;
                lease
                    .commit_plugin_revisions(&mut *session, revisions)
                    .await
            },
        )
        .await;
    lease.release().await;
    outcome.map_err(|error| {
        if super::write_coordination::is_plugin_write_error(&error) {
            tracing::warn!(%error, user_id, "sync-device result persistence deferred");
            return super::write_coordination::http_error(error);
        }
        tracing::error!(%error, user_id, "sync-device result persistence failed");
        FastApiError::unhandled()
    })?;
    let _ = state.mysql.execute("ROLLBACK", ()).await;
    Ok(())
}

fn sync_result_installation_ids(result: &SyncResult) -> Option<Vec<i64>> {
    let snapshot = result.desired_plugin_snapshot.as_ref()?;
    if snapshot.get("mode").and_then(Value::as_str) == Some("replace")
        || snapshot.pointer("/plugin_sync/complete") == Some(&Value::Bool(true))
    {
        return None;
    }
    Some(super::plugin_sync_protocol::payload_plugin_ids(snapshot))
}

async fn acquire_sync_installations<'a>(
    state: &'a PluginState,
    user_id: i64,
    installed_ids: Option<&[i64]>,
) -> MysqlResult<PluginWriteLease<'a, brz_redis::RedisService>> {
    super::plugin_sync_protocol::ensure_sync_state(&state.mysql, state.redis.as_ref(), user_id)
        .await?;
    PluginWriteLease::acquire_installed(&state.mysql, state.redis.as_ref(), user_id, installed_ids)
        .await
}

/// Source `sync_current_device_capabilities` -> `sync_latest_device_capabilities`:
/// dispatch the desired snapshot and re-load it after the acknowledgement.
///
/// A device that advertises the versioned plugin protocol receives a
/// `plugin_sync` snapshot for every build and reload of this round trip; every
/// other device keeps the legacy desired-state payload.
async fn sync_latest_device_capabilities(
    state: &PluginState,
    user_id: i64,
    device_id: &str,
) -> Result<SyncResult, FastApiError> {
    let versioned = supports_plugin_delta(state, user_id, device_id).await;
    let mut payload = load_capabilities_payload(state, user_id, device_id, versioned)
        .await
        .map_err(|error| {
            log_build_error(user_id, &error);
            FastApiError::unhandled()
        })?;
    let mut last: Option<SyncResult> = None;
    for _attempt in 1..=DESIRED_STATE_SYNC_ATTEMPTS {
        let result = sync_device_payload(
            state,
            user_id,
            device_id,
            &payload,
            None,
            SYNC_TIMEOUT_SECONDS,
        )
        .await?;
        if !result.acknowledged {
            return Ok(result);
        }
        let latest = match load_capabilities_payload(state, user_id, device_id, versioned).await {
            Ok(latest) => latest,
            // A concurrent plugin writer holds the account lease and will
            // deliver its own newer snapshot; the acknowledged snapshot stands.
            Err(BuildError::Mysql(error))
                if super::write_coordination::is_plugin_write_error(&error) =>
            {
                return Ok(result);
            }
            Err(error) => {
                log_build_error(user_id, &error);
                return Err(FastApiError::unhandled());
            }
        };
        if capability_snapshot(&latest) == capability_snapshot(&payload)
            && !result
                .plugins
                .iter()
                .any(|item| item.status.as_str() == Some("superseded"))
        {
            return Ok(result);
        }
        tracing::warn!(
            user_id,
            device_id,
            "capability desired state changed during sync; retrying latest snapshot"
        );
        payload = latest;
        last = Some(result);
    }
    Ok(SyncResult::failure(
        device_id,
        last,
        "Capability desired state kept changing during synchronization",
    ))
}

/// `load_payload` for `sync_current_device_capabilities`.
async fn load_capabilities_payload(
    state: &PluginState,
    user_id: i64,
    device_id: &str,
    versioned: bool,
) -> Result<Value, BuildError> {
    if versioned {
        load_versioned_registration_payload(state, user_id, device_id, true, true).await
    } else {
        build_desired_capabilities(&state.mysql, user_id, device_id, "replace").await
    }
}

pub(super) fn log_build_error(user_id: i64, error: &BuildError) {
    tracing::error!(%error, user_id, "sync-device desired-state build failed");
}

/// Source `sync_device_payload`: resolve the online Runtime route, fence and
/// publish the adapter `emit`, and map the acknowledgement.
pub(super) async fn sync_device_payload(
    state: &PluginState,
    user_id: i64,
    device_id: &str,
    payload: &Value,
    live_socket_id: Option<&str>,
    timeout: std::time::Duration,
) -> Result<SyncResult, FastApiError> {
    // `snapshot = payload if "plugins" in payload else None`: the versioned
    // recorder needs the dispatched desired state for every outcome.
    let snapshot = payload.get("plugins").is_some().then(|| payload.clone());
    let resolution = resolve_online_route(state, user_id, device_id).await?;
    let route = match resolution {
        OnlineRouteResolution::Ready(route) => route,
        OnlineRouteResolution::Unavailable(reason) => {
            return Ok(snapshot_failure(device_id, &snapshot, reason));
        }
    };
    let versioned = payload.get("plugin_sync").is_some();
    if versioned && !supports_plugin_sync_v2(route.online.get("runtime_features")) {
        return Ok(snapshot_failure(
            device_id,
            &snapshot,
            "Device plugin sync capability changed; retry synchronization",
        ));
    }
    let runtime_device_id = route.runtime_device_id.clone();
    // The register-time caller addresses the session that just wrote the online
    // document instead of the value read back from it.
    let socket_id = live_socket_id
        .map(str::trim)
        .filter(|socket_id| !socket_id.is_empty())
        .unwrap_or(&route.socket_id);
    let mut dispatch = payload.clone();
    if let Value::Object(object) = &mut dispatch {
        object.insert(
            "device_id".to_string(),
            Value::String(runtime_device_id.clone()),
        );
    }
    // `register_plugin_snapshot_intent` fences older acknowledgements before
    // this snapshot leaves for the device. A lease conflict aborts the request
    // exactly like the source's unhandled `PluginWriteError`.
    if versioned {
        register_plugin_snapshot_intent(state, user_id, device_id, payload)
            .await
            .map_err(|error| {
                tracing::error!(%error, user_id, "sync-device intent registration failed");
                FastApiError::unhandled()
            })?;
    }
    let Some(rpc) = state.socketio_rpc.as_ref() else {
        return Ok(snapshot_failure(
            device_id,
            &snapshot,
            "Socket.IO Redis adapter is unavailable",
        ));
    };
    let Some(redis) = state.redis.as_ref() else {
        return Ok(snapshot_failure(
            device_id,
            &snapshot,
            "Socket.IO Redis adapter is unavailable",
        ));
    };
    let call = rpc.begin(socket_id, SYNC_NAMESPACE).map_err(|error| {
        tracing::error!(%error, user_id, "sync-device callback registration failed");
        FastApiError::unhandled()
    })?;
    let data = serde_json::to_string(&Value::Array(vec![dispatch.clone()]))
        .expect("a JSON value serializes");
    let message = crate::socketio_emit::emit_message_with_callback(
        SYNC_EVENT,
        &data,
        SYNC_NAMESPACE,
        socket_id,
        Some((socket_id, call.id())),
    );
    if let Err(error) = redis
        .publish(crate::socketio_emit::SOCKETIO_CHANNEL, message)
        .await
    {
        tracing::error!(%error, user_id, "sync-device RPC publish failed");
        return Ok(snapshot_failure(
            device_id,
            &snapshot,
            "Socket.IO Redis adapter is unavailable",
        ));
    }
    // `call_capability_sync`: the acknowledgement is awaited while a 1-second
    // route check watches for a reconnect, and a confirmed reconnect
    // re-dispatches the same payload under the total deadline.
    let outcome = await_acknowledgement(
        state, user_id, device_id, &route, call, timeout, &dispatch, versioned,
    )
    .await;
    match outcome {
        Ok(args) => {
            let ack = ack_argument(&args);
            if versioned && let Some(error) = validate_plugin_ack(payload, ack) {
                return Ok(snapshot_failure(device_id, &snapshot, error));
            }
            let mut result = SyncResult::from_ack(device_id, ack);
            result.desired_plugin_snapshot = snapshot;
            Ok(result)
        }
        Err(error) => {
            tracing::warn!(%error, user_id, device_id, "sync-device RPC failed");
            Ok(snapshot_failure(device_id, &snapshot, error_text(&error)))
        }
    }
}

/// Source `plugin_device_installation_service.ensure_pending_for_device`.
///
/// Runs on the caller's request-session handle so the reconcile lock, the
/// identity reads, the alias rewrites, and the pending upserts share one
/// connection and commit together. The source mutates ORM objects during
/// iteration and emits every INSERT/UPDATE only at the `db.commit()` flush, so
/// the write statements are collected here and flushed through `PendingFlush`.
#[cfg(test)]
pub(super) async fn ensure_pending_for_device<Q>(
    session: &mut Q,
    user_id: i64,
    device_id: &str,
    guard: Option<&dyn wegent_plugin_store::LeaseCheck>,
) -> MysqlResult<usize>
where
    Q: MysqlQuery,
{
    ensure_pending_for_installs(session, user_id, device_id, guard, None).await
}

pub(super) async fn ensure_pending_for_installs<Q>(
    session: &mut Q,
    user_id: i64,
    device_id: &str,
    guard: Option<&dyn wegent_plugin_store::LeaseCheck>,
    installed_ids: Option<&[i64]>,
) -> MysqlResult<usize>
where
    Q: MysqlQuery,
{
    let identity_map = wegent_plugin_store::reconcile_plugin_device_rows_for_installs_on::<
        _,
        PluginDeviceInstallationRow,
    >(session, user_id, guard, installed_ids)
    .await?;
    let normalized_device_id = plugin_device_id_on(session, user_id, device_id).await?;
    if normalized_device_id.is_empty() {
        return Ok(0);
    }
    let mut desired: Vec<DesiredInstalledKind> = session
        .fetch_all(DESIRED_INSTALLS_QUERY, (user_id,))
        .await?;
    desired.retain(|row| installed_ids.is_none_or(|ids| ids.contains(&row.id)));
    let mut changed = 0usize;
    // The session's identity map is seeded by `reconcile_plugin_device_rows`'s
    // leading read (primary-key ascending), so the flush emits the UPDATE
    // statements in that load order, not in the iteration order of the desired
    // installs even when iteration visits a later identity-map row first.
    let mut identity_map = identity_map;
    let mut flush = PendingFlush::default();
    for installed in &desired {
        changed += ensure_desired_install_pending(
            session,
            user_id,
            &normalized_device_id,
            installed,
            &mut identity_map,
            &mut flush,
        )
        .await?;
    }
    // The pending row mutations flush (`before_flush` -> `_Lease.check()`)
    // before they reach the database, including rows mutated on an early
    // `return 0` branch and new-row INSERTs.
    flush
        .flush_with_guard(session, &identity_map, guard)
        .await?;
    Ok(changed)
}

#[path = "sync_device_ack.rs"]
mod sync_device_ack;
pub(crate) use sync_device_ack::ack_argument;

#[path = "sync_device_reconcile.rs"]
mod sync_device_reconcile;
#[cfg(test)]
use sync_device_ack::{MAX_ROUTE_CHANGES, ROUTE_CHECK_INTERVAL, route_changed};
use sync_device_ack::{await_acknowledgement, error_text, snapshot_failure};
use sync_device_reconcile::reconcile_device_plugins;
#[cfg(test)]
use sync_device_reconcile::reconciliation_failure_detail;

#[path = "sync_device_flush.rs"]
mod sync_device_flush;
use sync_device_flush::*;
#[cfg(test)]
use sync_device_flush::{flush_timestamp, pending_row_times};

/// Source `_ensure_desired_install_pending`. Returns 1 when a new row is
/// materialized or an existing row is (re)queued, 0 otherwise. The dirty fields
/// are collected into `flush` (emitted at the source's `db.commit()`), exactly
/// like the source's ORM flush.
#[allow(clippy::too_many_arguments)]
async fn ensure_desired_install_pending<Q>(
    session: &mut Q,
    user_id: i64,
    device_id: &str,
    installed: &DesiredInstalledKind,
    identity_map: &mut Vec<PluginDeviceInstallationRow>,
    flush: &mut PendingFlush,
) -> MysqlResult<usize>
where
    Q: MysqlQuery,
{
    let Some(release_id) = integer_release_id(&installed.json) else {
        return Ok(0);
    };
    let row: Option<PluginDeviceInstallationRow> = session
        .fetch_optional(DEVICE_ROW_QUERY, (installed.id, device_id))
        .await?;
    let Some(row) = row else {
        // `db.add(...)`: the INSERT reaches MySQL only at the flush.
        flush.assigned = true;
        flush.inserts.push(DesiredInsert {
            installed_kind_id: installed.id,
            user_id,
            device_id: device_id.to_string(),
            release_id,
            now: Local::now().naive_local(),
        });
        return Ok(1);
    };

    // The row is already in the session's identity map (materialized by the
    // read); locate it so the flush orders its UPDATE by the
    // identity-map position rather than the visit order.
    // Assigning `desired_release_id` marks the ORM object dirty even when the
    // value is unchanged, so the flush boundary exists regardless of `assigns`.
    flush.assigned = true;
    let index = match identity_map.iter().position(|known| known.id == row.id) {
        Some(index) => index,
        None => {
            identity_map.push(row.clone());
            identity_map.len() - 1
        }
    };
    let desired_changed = row.desired_release_id != release_id;
    let mut assigns: Vec<String> = Vec::new();
    if desired_changed {
        assigns.push(format!("desired_release_id={release_id}"));
        if row.attempt_count != 0 {
            assigns.push("attempt_count=0".to_string());
        }
    }
    let queued = row.state == "pending"
        && row.error_code.is_empty()
        && row.error_message.is_empty()
        && (row.actual_release_id == 0 || row.actual_release_id == release_id);
    let preserved_source = row.state == "source"
        && !desired_changed
        && super::personal_source::owned_install(session, user_id, &installed.json).await?;
    let terminal = (row.state == "installed" && row.actual_release_id == release_id)
        || preserved_source
        || row.state == "uninstalling"
        || auto_update_blocked(&row, release_id)
        || queued;
    if terminal {
        if !assigns.is_empty() {
            flush.updates.push((index, assigns));
        }
        return Ok(0);
    }
    if row.state != "pending" {
        assigns.push("state='pending'".to_string());
    }
    if !row.error_code.is_empty() {
        assigns.push("error_code=''".to_string());
    }
    if !row.error_message.is_empty() {
        assigns.push("error_message=''".to_string());
    }
    if !assigns.is_empty() {
        flush.updates.push((index, assigns));
    }
    Ok(1)
}

/// Source `PluginDeviceInstallationService._auto_update_blocked`.
fn auto_update_blocked(row: &PluginDeviceInstallationRow, desired_release_id: i64) -> bool {
    row.state == "failed"
        && row.attempt_count >= AUTO_UPDATE_FAILURE_LIMIT
        && row.actual_release_id != 0
        && row.actual_release_id != desired_release_id
        && row.desired_release_id == desired_release_id
}

/// `spec.releaseId` when it is an integer (`isinstance(release_id, int)`).
fn integer_release_id(json: &Value) -> Option<i64> {
    json.get("spec")
        .and_then(|spec| spec.get("releaseId"))
        .and_then(Value::as_i64)
}

#[cfg(test)]
#[path = "sync_device_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "sync_device_guard_tests.rs"]
mod guard_tests;
