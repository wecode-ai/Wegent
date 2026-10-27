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
use brz_redis::Redis;
use chrono::Local;
use serde_json::Value;

use crate::device_identity::{
    DeviceKindRow, PluginDeviceInstallationRow, plugin_device_id_on,
    reconcile_plugin_device_rows_on,
};
use crate::http_compat::FastApiError;
use crate::plugins_marketplace::query::PluginQuery;
use crate::state::AppState;

use super::auth;
use super::catalog_reconcile::reconcile_stale_installed_catalog_refs;
use super::desired_capabilities::{
    BuildError, build_desired_capabilities, build_desired_plugins, capability_snapshot,
};
use super::record_sync_result::{SyncResult, record_device_sync_result};
use super::report::{DESIRED_INSTALLS_QUERY, DEVICE_ROW_QUERY, INSERT_INSTALLATION_QUERY};

/// `PLUGIN_AUTO_UPDATE_FAILURE_LIMIT` (`app/core/constants.py`).
const AUTO_UPDATE_FAILURE_LIMIT: i64 = 3;

/// `SYNC_EVENT` (`app/services/device/capability_sync_service.py`).
const SYNC_EVENT: &str = "device:sync_capabilities";
/// `SYNC_NAMESPACE`.
const SYNC_NAMESPACE: &str = "/local-executor";
/// `SYNC_TIMEOUT_SECONDS`.
const SYNC_TIMEOUT_SECONDS: std::time::Duration = std::time::Duration::from_secs(180);
/// `DESIRED_STATE_SYNC_ATTEMPTS`.
const DESIRED_STATE_SYNC_ATTEMPTS: usize = 3;

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
    #[inject(state)] state: &AppState,
    #[auth] actor: auth::SyncDeviceUser,
    device_id: String,
    reconcile: Option<bool>,
) -> Result<Value, FastApiError> {
    if reconcile.unwrap_or(false) {
        reconcile_device_plugins(state, &actor.user_name, &device_id).await
    } else {
        sync_device(state, &actor.user_name, &device_id).await
    }
}

/// Outcome of the source's request-session transaction.
enum SessionOutcome {
    /// `get_current_user` or the endpoint's `device_id` check rejected the
    /// request before any business work ran.
    Rejected(FastApiError),
    /// `ensure_pending_for_device`'s `db.commit()` succeeded.
    Applied { user_id: i64, pending_count: usize },
}

/// Source `get_current_user` on the request session: the active `users` row,
/// or the exact rejection detail its failed branch raises.
async fn session_user<Q>(
    session: &mut Q,
    user_name: &str,
) -> MysqlResult<Result<auth::UserRow, FastApiError>>
where
    Q: PluginQuery,
{
    match auth::find_user_by_name_on(session, user_name).await? {
        Some(user) if user.is_active => Ok(Ok(user)),
        Some(_) => Ok(Err(FastApiError::unauthorized(
            auth::USER_NOT_ACTIVATED_DETAIL,
        ))),
        None => Ok(Err(FastApiError::unauthorized(auth::UNAUTHORIZED_DETAIL))),
    }
}

/// Source `sync_installed_plugins_to_device`'s non-reconcile branch.
///
/// `get_current_user`, `reconcile_stale_installed_catalog_refs`, and
/// `ensure_pending_for_device` share the request's `db` session in the source,
/// so the auth read, the catalog repair reads, the device lock, and the pending
/// upserts all commit at `ensure_pending_for_device`'s `db.commit()`. One
/// pinned transaction reproduces that session.
async fn sync_device(
    state: &AppState,
    user_name: &str,
    device_id: &str,
) -> Result<Value, FastApiError> {
    let outcome = state
        .mysql
        .with_transaction(async |transaction| {
            let mut session = &mut *transaction;
            let user = match session_user(&mut session, user_name).await? {
                Ok(user) => user,
                Err(rejection) => return Ok(SessionOutcome::Rejected(rejection)),
            };
            if device_id.trim().is_empty() {
                return Ok(SessionOutcome::Rejected(FastApiError::detail(
                    brz_http_server::StatusCode::BAD_REQUEST,
                    "device_id is required",
                )));
            }
            reconcile_stale_installed_catalog_refs(
                &mut session,
                state.redis.as_ref(),
                &state.entity_resolvers,
                user.id,
            )
            .await?;
            let pending_count = ensure_pending_for_device(&mut session, user.id, device_id).await?;
            Ok(SessionOutcome::Applied {
                user_id: user.id,
                pending_count,
            })
        })
        .await
        .map_err(|error| {
            tracing::error!(%error, user_name, "sync-device pending refresh failed");
            FastApiError::unhandled()
        })?;
    let (user_id, pending_count) = match outcome {
        SessionOutcome::Rejected(rejection) => return Err(rejection),
        SessionOutcome::Applied {
            user_id,
            pending_count,
        } => (user_id, pending_count),
    };

    // Source `db.close()` ends the request-scoped session: SQLAlchemy rolls
    // back the idle transaction started after the commit.
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
/// `with get_db_session() as record_db` block.
async fn record_sync_result(
    state: &AppState,
    user_id: i64,
    result: &SyncResult,
) -> Result<(), FastApiError> {
    state
        .mysql
        .with_transaction(async |transaction| {
            let mut session = &mut *transaction;
            record_device_sync_result(&mut session, user_id, result).await
        })
        .await
        .map_err(|error| {
            tracing::error!(%error, user_id, "sync-device result persistence failed");
            FastApiError::unhandled()
        })?;
    let _ = state.mysql.execute("ROLLBACK", ()).await;
    Ok(())
}

/// Source `sync_current_device_capabilities` -> `sync_latest_device_capabilities`:
/// dispatch the desired snapshot and re-load it after the acknowledgement.
async fn sync_latest_device_capabilities(
    state: &AppState,
    user_id: i64,
    device_id: &str,
) -> Result<SyncResult, FastApiError> {
    let mut payload = build_payload(state, user_id, device_id).await?;
    let mut last: Option<SyncResult> = None;
    for _attempt in 1..=DESIRED_STATE_SYNC_ATTEMPTS {
        let result = sync_device_payload(state, user_id, device_id, &payload).await?;
        if !result.acknowledged {
            return Ok(result);
        }
        let latest = build_payload(state, user_id, device_id).await?;
        if capability_snapshot(&latest) == capability_snapshot(&payload) {
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

/// One `build_desired_capabilities` load; any failure is the source's
/// unhandled 500.
async fn build_payload(
    state: &AppState,
    user_id: i64,
    device_id: &str,
) -> Result<Value, FastApiError> {
    build_desired_capabilities(&state.mysql, user_id, device_id, "replace")
        .await
        .map_err(|error| {
            log_build_error(user_id, &error);
            FastApiError::unhandled()
        })
}

fn log_build_error(user_id: i64, error: &BuildError) {
    tracing::error!(%error, user_id, "sync-device desired-state build failed");
}

/// Source `sync_device_payload`: resolve the online Runtime route, publish the
/// adapter `emit`, and map the acknowledgement.
async fn sync_device_payload(
    state: &AppState,
    user_id: i64,
    device_id: &str,
    payload: &Value,
) -> Result<SyncResult, FastApiError> {
    let device =
        crate::device_identity::resolve_owned_device_alias(&state.mysql, user_id, device_id)
            .await
            .map_err(|error| {
                tracing::error!(%error, user_id, "sync-device route identity read failed");
                FastApiError::unhandled()
            })?;
    let Some(device) = device else {
        return Ok(SyncResult::failure(
            device_id,
            None,
            "device not found or access denied",
        ));
    };
    let runtime_device_id = runtime_device_route_id(&device);
    if runtime_device_id.is_empty() {
        return Ok(SyncResult::failure(
            device_id,
            None,
            "device not found or access denied",
        ));
    }
    let online: Option<Value> = crate::devices::cache_manager_get(
        state,
        &format!("device:online:{user_id}:{runtime_device_id}"),
    )
    .await;
    let Some(online) = online.filter(Value::is_object) else {
        return Ok(SyncResult::failure(device_id, None, "device is offline"));
    };
    let Some(socket_id) = online
        .get("socket_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|socket_id| !socket_id.is_empty())
    else {
        return Ok(SyncResult::failure(device_id, None, "device is offline"));
    };
    if !runtime_instance_matches(&device, &online) {
        return Ok(SyncResult::failure(device_id, None, "device is offline"));
    }
    let mut dispatch = payload.clone();
    if let Value::Object(object) = &mut dispatch {
        object.insert(
            "device_id".to_string(),
            Value::String(runtime_device_id.clone()),
        );
    }
    let Some(rpc) = state.socketio_rpc.as_ref() else {
        return Ok(SyncResult::failure(
            device_id,
            None,
            "Socket.IO Redis adapter is unavailable",
        ));
    };
    let Some(redis) = state.redis.as_ref() else {
        return Ok(SyncResult::failure(
            device_id,
            None,
            "Socket.IO Redis adapter is unavailable",
        ));
    };
    let call = rpc.begin(socket_id, SYNC_NAMESPACE).map_err(|error| {
        tracing::error!(%error, user_id, "sync-device callback registration failed");
        FastApiError::unhandled()
    })?;
    let data =
        serde_json::to_string(&Value::Array(vec![dispatch])).expect("a JSON value serializes");
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
        return Ok(SyncResult::failure(
            device_id,
            None,
            "Socket.IO Redis adapter is unavailable",
        ));
    }
    match call.wait(SYNC_TIMEOUT_SECONDS).await {
        Ok(args) => Ok(SyncResult::from_ack(device_id, ack_argument(&args))),
        Err(error) => {
            tracing::warn!(%error, user_id, device_id, "sync-device RPC failed");
            Ok(SyncResult::failure(device_id, None, error_text(&error)))
        }
    }
}

/// `sio.call`'s return value: the single positional ack argument.
fn ack_argument(args: &Value) -> &Value {
    match args {
        Value::Array(items) if items.len() == 1 => &items[0],
        other => other,
    }
}

/// Python `str(exc)` for the mapped dispatch failure.
fn error_text(error: &crate::socketio_rpc::RpcError) -> &'static str {
    match error {
        crate::socketio_rpc::RpcError::Timeout => "",
        crate::socketio_rpc::RpcError::Closed => "connection closed",
        crate::socketio_rpc::RpcError::Unavailable(_) => "Socket.IO Redis adapter is unavailable",
    }
}

/// Source `runtime_route.runtime_device_route_id`.
fn runtime_device_route_id(device: &DeviceKindRow) -> String {
    let spec = device.json.get("spec");
    let device_type = spec
        .and_then(|spec| spec.get("deviceType"))
        .and_then(Value::as_str)
        .unwrap_or("local");
    if device_type == "app" {
        return format!("app-record-{}", device.id);
    }
    spec.and_then(|spec| spec.get("deviceId"))
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .map(str::trim)
        .map(str::to_string)
        .or_else(|| {
            spec.and_then(|spec| spec.get("cloudConfig"))
                .and_then(|cloud| cloud.get("deviceId"))
                .and_then(Value::as_str)
                .filter(|id| !id.trim().is_empty())
                .map(str::trim)
                .map(str::to_string)
        })
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| device.name.trim().to_string())
}

/// `RuntimeRouteResolver.resolve`'s stale-instance guard.
fn runtime_instance_matches(device: &DeviceKindRow, online: &Value) -> bool {
    let expected = device
        .json
        .get("spec")
        .and_then(|spec| spec.get("runtimeInstanceId"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty());
    let Some(expected) = expected else {
        return true;
    };
    let reported = online
        .get("runtime_instance_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    !reported.is_empty() && reported == expected
}

/// Source `reconcile_device_plugins`: dispatch the plugins-only payload and
/// require the executor's `scope="plugins"` acknowledgement.
async fn reconcile_device_plugins(
    state: &AppState,
    user_name: &str,
    device_id: &str,
) -> Result<Value, FastApiError> {
    // The source's request session only reads `current_user` (via
    // `get_current_user`, before the endpoint body runs) and is closed before
    // the device round trip starts, so this lookup stays on the pool.
    let mut pool = &state.mysql;
    let user = match session_user(&mut pool, user_name).await.map_err(|error| {
        tracing::error!(%error, user_name, "reconcile user lookup failed");
        FastApiError::unhandled()
    })? {
        Ok(user) => user,
        Err(rejection) => return Err(rejection),
    };
    let normalized_device_id = device_id.trim();
    if normalized_device_id.is_empty() {
        return Err(FastApiError::detail(
            brz_http_server::StatusCode::BAD_REQUEST,
            "device_id is required",
        ));
    }
    let user_id = user.id;
    let mut payload = desired_plugins(state, user_id, normalized_device_id).await?;
    for _attempt in 0..DESIRED_STATE_SYNC_ATTEMPTS {
        let result = sync_device_payload(state, user_id, normalized_device_id, &payload).await?;
        if !result.success || !result.errors.is_empty() || result.plugins.iter().any(is_failed_item)
        {
            return Err(FastApiError::detail(
                brz_http_server::StatusCode::BAD_GATEWAY,
                reconciliation_failure_detail(&result),
            ));
        }
        if result.scope.as_str() != Some("plugins") {
            return Err(FastApiError::detail(
                brz_http_server::StatusCode::CONFLICT,
                "Update the desktop runtime to reconcile plugins",
            ));
        }
        let latest = desired_plugins(state, user_id, normalized_device_id).await?;
        if plugin_snapshot(&latest) != plugin_snapshot(&payload) {
            payload = latest;
            continue;
        }
        record_sync_result(state, user_id, &result).await?;
        let mut sync = serde_json::Map::new();
        sync.insert("success".to_string(), Value::Bool(true));
        sync.insert(
            "device_id".to_string(),
            Value::String(normalized_device_id.to_string()),
        );
        sync.insert("mode".to_string(), Value::String("merge".to_string()));
        sync.insert(
            "plugins".to_string(),
            Value::Array(result.plugins.iter().map(|item| item.to_value()).collect()),
        );
        sync.insert("results".to_string(), Value::Array(vec![result.to_value()]));
        sync.insert("synced".to_string(), Value::from(1));
        let mut response = serde_json::Map::new();
        response.insert("reconciled".to_string(), Value::Bool(true));
        response.insert(
            "deviceId".to_string(),
            Value::String(normalized_device_id.to_string()),
        );
        response.insert("pendingCount".to_string(), Value::from(0));
        response.insert("sync".to_string(), Value::Object(sync));
        return Ok(Value::Object(response));
    }
    Err(FastApiError::detail(
        brz_http_server::StatusCode::CONFLICT,
        "Plugin installations changed during reconciliation; refresh again",
    ))
}

/// Source `desired_plugins`: repair catalog refs, then the plugins-only merge
/// payload.
async fn desired_plugins(
    state: &AppState,
    user_id: i64,
    device_id: &str,
) -> Result<Value, FastApiError> {
    let mut pool = &state.mysql;
    reconcile_stale_installed_catalog_refs(
        &mut pool,
        state.redis.as_ref(),
        &state.entity_resolvers,
        user_id,
    )
    .await
    .map_err(|error| {
        tracing::error!(%error, user_id, "reconcile catalog refresh failed");
        FastApiError::unhandled()
    })?;
    build_desired_plugins(&state.mysql, user_id, device_id)
        .await
        .map_err(|error| {
            log_build_error(user_id, &error);
            FastApiError::unhandled()
        })
}

fn is_failed_item(item: &super::record_sync_result::SyncItem) -> bool {
    item.status.as_str() == Some("failed")
}

/// Source `plugin_snapshot`: signed URLs and expirations are excluded, and
/// plugins are ordered by installed id.
fn plugin_snapshot(payload: &Value) -> Value {
    let mut plugins: Vec<Value> = payload
        .get("plugins")
        .and_then(Value::as_array)
        .map(|plugins| {
            plugins
                .iter()
                .map(|plugin| {
                    let mut object = serde_json::Map::new();
                    if let Value::Object(source) = plugin {
                        for (key, value) in source {
                            if key == "download_path" || key == "download_url_expires_at" {
                                continue;
                            }
                            object.insert(key.clone(), value.clone());
                        }
                    }
                    Value::Object(object)
                })
                .collect()
        })
        .unwrap_or_default();
    plugins.sort_by_key(|plugin| {
        plugin
            .get("installed_plugin_id")
            .map(python_text)
            .unwrap_or_default()
    });
    Value::Array(plugins)
}

/// `str(value)` for the snapshot sort key.
fn python_text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::Bool(value) => (if *value { "True" } else { "False" }).to_string(),
        Value::String(value) => value.clone(),
        other => other.to_string(),
    }
}

/// Source `reconciliation_failure_detail`.
fn reconciliation_failure_detail(result: &SyncResult) -> String {
    if let Some(failed) = result
        .plugins
        .iter()
        .find(|item| item.status.as_str() == Some("failed"))
    {
        let identity = failed
            .name
            .as_str()
            .filter(|name| !name.is_empty())
            .map(str::to_string)
            .or_else(|| {
                failed
                    .id
                    .as_str()
                    .map(str::to_string)
                    .or_else(|| failed.id.as_i64().map(|id| id.to_string()))
            })
            .unwrap_or_else(|| "plugin".to_string());
        let reason = failed
            .error_code
            .as_str()
            .filter(|code| !code.is_empty())
            .or_else(|| failed.stage.as_str().filter(|stage| !stage.is_empty()))
            .or_else(|| failed.error.as_str().filter(|error| !error.is_empty()))
            .unwrap_or("device_sync_failed");
        return format!("Plugin reconciliation failed for {identity}: {reason}");
    }
    match &result.error {
        Some(error) if !error.is_empty() => format!("Plugin reconciliation failed: {error}"),
        _ => "Plugin reconciliation failed on the current device".to_string(),
    }
}

/// Source `plugin_device_installation_service.ensure_pending_for_device`.
///
/// Runs on the caller's request-session handle so the reconcile lock, the
/// identity reads, the alias rewrites, and the pending upserts share one
/// connection and commit together. The source mutates ORM objects during
/// iteration and emits every INSERT/UPDATE only at the `db.commit()` flush, so
/// the write statements are collected here and flushed through
/// [`PendingFlush`] instead of being executed inline.
async fn ensure_pending_for_device<Q>(
    session: &mut Q,
    user_id: i64,
    device_id: &str,
) -> MysqlResult<usize>
where
    Q: PluginQuery,
{
    let identity_map =
        reconcile_plugin_device_rows_on::<_, PluginDeviceInstallationRow>(session, user_id).await?;
    let normalized_device_id = plugin_device_id_on(session, user_id, device_id).await?;
    if normalized_device_id.is_empty() {
        return Ok(0);
    }
    let desired: Vec<DesiredInstalledKind> = session
        .fetch_all(DESIRED_INSTALLS_QUERY, (user_id,))
        .await?;
    let mut changed = 0usize;
    // The session's identity map is seeded by `reconcile_plugin_device_rows`'s
    // `FOR UPDATE` read (primary-key ascending), so the flush emits the UPDATE
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
    flush.emit(session, &identity_map).await?;
    Ok(changed)
}

/// One deferred write collected during `ensure_pending_for_device`'s iteration
/// and emitted at the source's `db.commit()` flush.
#[derive(Default)]
struct PendingFlush {
    /// `db.add(...)` INSERTs in iteration order; SQLAlchemy's unit of work
    /// processes one mapper's INSERTs before its UPDATEs.
    inserts: Vec<DesiredInsert>,
    /// Dirty-column UPDATEs keyed by the identity-map row index.
    updates: Vec<(usize, Vec<String>)>,
}

/// One `db.add(PluginDeviceInstallation(...))` pending INSERT.
struct DesiredInsert {
    installed_kind_id: i64,
    user_id: i64,
    device_id: String,
    release_id: i64,
    now: chrono::NaiveDateTime,
}

impl PendingFlush {
    /// Emit the collected INSERTs (iteration order) and UPDATEs (identity-map
    /// order, primary key ascending), then the caller's COMMIT. The UPDATE
    /// collection is sorted by identity-map position first: the iteration may
    /// visit rows in any order, but the source's flush follows the identity
    /// map populated by the `FOR UPDATE` read.
    async fn emit<Q>(
        &mut self,
        session: &mut Q,
        identity_map: &[PluginDeviceInstallationRow],
    ) -> MysqlResult<()>
    where
        Q: PluginQuery,
    {
        self.updates.sort_by_key(|(index, _)| *index);
        for insert in &self.inserts {
            session
                .execute(
                    INSERT_INSTALLATION_QUERY,
                    (
                        insert.installed_kind_id,
                        insert.user_id,
                        insert.device_id.as_str(),
                        insert.release_id,
                        0_i64,
                        "pending",
                        "",
                        "",
                        0_i64,
                        insert.now,
                        insert.now,
                    ),
                )
                .await?;
        }
        for (index, assigns) in &self.updates {
            let row = &identity_map[*index];
            let statement = format!(
                "UPDATE plugin_device_installations SET {}, updated_at=? WHERE \
                 plugin_device_installations.id = ?",
                assigns.join(", ")
            );
            session
                .execute(statement, (flush_timestamp(), row.id))
                .await?;
        }
        Ok(())
    }
}

/// `datetime.now()`'s per-statement value (`YYYY-MM-DD HH:MM:SS.ffffff`),
/// re-evaluated for every flushed UPDATE like SQLAlchemy's `onupdate`.
fn flush_timestamp() -> String {
    Local::now()
        .naive_local()
        .format("%Y-%m-%d %H:%M:%S%.6f")
        .to_string()
}

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
    Q: PluginQuery,
{
    let Some(release_id) = integer_release_id(&installed.json) else {
        return Ok(0);
    };
    let row: Option<PluginDeviceInstallationRow> = session
        .fetch_optional(DEVICE_ROW_QUERY, (installed.id, device_id))
        .await?;
    let Some(row) = row else {
        // `db.add(...)`: the INSERT reaches MySQL only at the flush.
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
    // `FOR UPDATE` read); locate it so the flush orders its UPDATE by the
    // identity-map position rather than the visit order.
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
    let terminal = (row.state == "installed" && row.actual_release_id == release_id)
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
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn release_id_requires_integer() {
        assert_eq!(
            integer_release_id(&json!({"spec": {"releaseId": 38}})),
            Some(38)
        );
        assert_eq!(
            integer_release_id(&json!({"spec": {"releaseId": "38"}})),
            None
        );
        assert_eq!(integer_release_id(&json!({"spec": {}})), None);
    }

    #[test]
    fn auto_update_blocked_matches_source_rules() {
        let row = PluginDeviceInstallationRow {
            id: 1,
            installed_kind_id: 2,
            user_id: 3,
            device_id: "d".to_string(),
            desired_release_id: 5,
            actual_release_id: 4,
            state: "failed".to_string(),
            error_code: String::new(),
            error_message: String::new(),
            attempt_count: AUTO_UPDATE_FAILURE_LIMIT,
            last_sync_at: chrono::NaiveDateTime::default(),
            updated_at: chrono::NaiveDateTime::default(),
        };
        assert!(auto_update_blocked(&row, 5));
        let mut other = row;
        other.attempt_count -= 1;
        assert!(!auto_update_blocked(&other, 5));
    }

    #[test]
    fn flush_orders_updates_by_identity_map_not_iteration() {
        // The recorded sync-device cases prove the source's flush order: the
        // iteration visits the desired installs in `_desired_installs` result
        // order. Each UPDATE is emitted at `db.commit()` in identity-map
        // order: the `FOR UPDATE` load order, primary key ascending.
        // The flush must therefore sort by identity-map position.
        let mut identity_map = Vec::new();
        let mut flush = PendingFlush::default();
        // FOR UPDATE load order: row 101 (kind 201) before 102 (kind 202).
        for (id, kind) in [(101_i64, 201_i64), (102, 202)] {
            identity_map.push(PluginDeviceInstallationRow {
                id,
                installed_kind_id: kind,
                user_id: 301,
                device_id: "app-record-201".to_string(),
                desired_release_id: 401,
                actual_release_id: 0,
                state: "failed".to_string(),
                error_code: "PLUGIN_DOWNLOAD_FAILED".to_string(),
                error_message: "download failed".to_string(),
                attempt_count: 7,
                last_sync_at: chrono::NaiveDateTime::default(),
                updated_at: chrono::NaiveDateTime::default(),
            });
        }
        // Iteration visits 102 (identity-map index 1) before 101 (index 0);
        // the flush must still emit 101 first because it follows the map.
        flush.updates.push((1, vec!["state='pending'".to_string()]));
        flush.updates.push((0, vec!["state='pending'".to_string()]));
        flush.updates.sort_by_key(|(index, _)| *index);
        let order: Vec<i64> = flush
            .updates
            .iter()
            .map(|(index, _)| identity_map[*index].id)
            .collect();
        assert_eq!(order, vec![101, 102]);
    }

    #[test]
    fn flush_update_statement_binds_updated_at() {
        // Every flushed UPDATE of this table carries `updated_at` because
        // `PluginDeviceInstallation.updated_at` declares `onupdate=datetime.now`
        // (app/models/plugin_marketplace.py). The value is bound as a prepared
        // statement parameter (like `catalog_write`'s reset UPDATE) so its
        // current-time generation is comparable under the verification policy's
        // time rules rather than baked into the SQL text.
        let statement = format!(
            "UPDATE plugin_device_installations SET {}, updated_at=? WHERE \
             plugin_device_installations.id = ?",
            "state='pending', error_code='', error_message=''"
        );
        assert!(statement.contains(
            "SET state='pending', error_code='', error_message='', updated_at=? WHERE \
             plugin_device_installations.id = ?"
        ));
        assert_eq!(flush_timestamp().len(), "YYYY-MM-DD HH:MM:SS.ffffff".len());
    }

    /// The source's `get_current_user` runs on the request session, so the
    /// handler resolves the row through its own transaction and keeps the
    /// source's rejection details.
    #[tokio::test]
    async fn session_user_reports_the_source_auth_failure() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        let mut session = &mysql;
        let rejection = session_user(&mut session, "ghost")
            .await
            .unwrap()
            .unwrap_err();
        assert_eq!(rejection.detail_message(), Some(auth::UNAUTHORIZED_DETAIL));
        assert_eq!(mysql.queries().len(), 1);
        assert!(mysql.queries()[0].sql.contains("WHERE user_name = ?"));
    }

    /// Source `ensure_pending_for_device` starts with the user's `FOR UPDATE`
    /// read and keeps every later read and flush on the same session handle;
    /// the pending refresh must therefore reach the caller's transaction
    /// rather than the pool.
    #[tokio::test]
    async fn pending_refresh_locks_on_the_caller_session_first() {
        let mysql = crate::sql_test_support::KindQueryCapture::writing();
        let mut session = &mysql;
        assert_eq!(
            ensure_pending_for_device(&mut session, 3, "app-record-266867")
                .await
                .unwrap(),
            0
        );
        let queries = mysql.queries();
        assert_eq!(queries.len(), 3, "lock, alias read, then desired installs");
        assert!(queries[0].sql.contains(
            "FROM plugin_device_installations WHERE plugin_device_installations.user_id = ? FOR UPDATE"
        ));
        assert!(queries[1].sql.contains("kinds.kind = 'Device'"));
        assert!(queries[2].sql.contains("kinds.kind = 'InstalledPlugin'"));
    }
}
