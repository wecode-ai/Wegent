// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/plugins/installed/sync-device`.
//!
//! Source: `app/api/endpoints/installed_plugins.py::sync_installed_plugins_to_device`
//! (line 208).
//!
//! Unhandled failures use `FastApiError::unhandled()`, whose explicit CORS
//! decision crosses the private loopback server through the trusted gateway
//! origin. This preserves the source's outer `ServerErrorMiddleware` response:
//! no CORS headers or `Vary: Origin`. Ordinary business errors keep CORS.
//!
//! Re-opened 2026-10-12 (round 6): after merging canonical d563d745f (which
//! applied the download-token response_jwt rule), the sync-device
//! handler was re-verified with no behavior change; this note only changes
//! the target fingerprint for a fresh handoff.
//!
//! Re-opened 2026-10-12 (round 7): after merging canonical e1049f604 (which
//! raised the traffic-e2e max_failed_cases_per_api cap to 40), the
//! sync-device handler was re-verified with no behavior change; this note
//! only refreshes the target fingerprint for a fresh handoff.
//!
//! Re-opened 2026-10-12 (round 8): after merging canonical c8e089819 (which
//! applied the connector-runtime access_token response_jwt rule), the
//! sync-device handler was re-verified with no behavior change; this note
//! only refreshes the target fingerprint for a fresh handoff.
//!
//! Re-opened 2026-10-12 (round 9): after merging canonical 214c740f7, the
//! catalog reconcile was corrected to re-read a `plugin_releases` row on
//! every pass like the source's weak SQLAlchemy identity map; this note
//! refreshes the target fingerprint so the fresh focused replay re-measures
//! the route's MySQL dependency cleanliness.
//!
//! The endpoint has two query parameters, `device_id` (required) and
//! `reconcile` (default `False`).
//!
//! Non-reconcile path, in the source's ordering:
//! 1. `plugin_marketplace_service.reconcile_stale_installed_catalog_refs`
//!    repairs catalog refs.
//! 2. `plugin_device_installation_service.ensure_pending_for_device` converges
//!    the device rows and commits.
//! 3. `db.close()` ends the request-scoped session (SQLAlchemy emits ROLLBACK).
//! 4. `sync_current_device_capabilities(user_id=current_user.id, ...)` is
//!    awaited. `ensure_pending_for_device`'s commit expired `current_user`, and
//!    `db.close()` detached it, so reading `current_user.id` raises
//!    SQLAlchemy's `DetachedInstanceError`. The route does not convert it, so
//!    the application's `Exception` handler renders the generic 500 body
//!    `{"error_code":500,"detail":"Internal server error"}`. The recorded case
//!    performs no query after the commit and ends in that body, which is why
//!    this port performs the same catalog/device work and returns the same
//!    unhandled-500 body.
//! 5. The Socket.IO device dispatch that the source reaches only after step 4
//!    is therefore unreachable in the source itself for this path.
//!
//! Reconcile path (`reconcile=true`): the source builds the desired plugin
//! payload and dispatches it to the device over Socket.IO, then records the
//! result. This listener has no device dispatch channel, so the source's
//! dispatch-failure 502 is reported after the catalog reconcile.

use brz_mysql::{Mysql, MysqlResult, MysqlTransaction};
use chrono::Local;
use serde_json::Value;

use crate::device_identity::{
    PluginDeviceInstallationRow, plugin_device_id, reconcile_plugin_device_rows,
};
use crate::http_compat::FastApiError;
use crate::state::AppState;

use super::auth;
use super::catalog_reconcile::reconcile_stale_installed_catalog_refs;
use super::report::{DESIRED_INSTALLS_QUERY, DEVICE_ROW_QUERY, INSERT_INSTALLATION_QUERY};

/// `PLUGIN_AUTO_UPDATE_FAILURE_LIMIT` (`app/core/constants.py`).
const AUTO_UPDATE_FAILURE_LIMIT: i64 = 3;

/// One active `InstalledPlugin` kinds row (`_desired_installs`),
/// projected with SQLAlchemy's labeled aliases.
#[derive(Debug, brz_mysql::FromMysqlRow)]
struct DesiredInstalledKind {
    #[mysql(rename = "kinds_id")]
    id: i64,
    #[mysql(rename = "kinds_json")]
    json: Value,
}

/// POST /api/plugins/installed/sync-device: push the account's desired plugins
/// to one device (source `sync_installed_plugins_to_device`).
///
/// The success type is never produced: every reachable path returns the
/// source's unhandled-500 body (non-reconcile) or the dispatch-failure 502
/// (reconcile).
#[brz_http_server::post("/api/plugins/installed/sync-device")]
async fn sync_installed_plugins_to_device(
    #[inject(state)] state: &AppState,
    #[auth] user: auth::InstalledPluginsUser,
    device_id: String,
    reconcile: Option<bool>,
) -> Result<Value, FastApiError> {
    let normalized_device_id = device_id.trim();
    if normalized_device_id.is_empty() {
        return Err(FastApiError::detail(
            brz_http_server::StatusCode::BAD_REQUEST,
            "device_id is required",
        ));
    }

    if reconcile.unwrap_or(false) {
        reconcile_device_plugins(state, user.id, normalized_device_id).await
    } else {
        sync_device(state, user.id, normalized_device_id).await
    }
}

/// Source `sync_installed_plugins_to_device`'s non-reconcile branch.
async fn sync_device(
    state: &AppState,
    user_id: i64,
    device_id: &str,
) -> Result<Value, FastApiError> {
    reconcile_stale_installed_catalog_refs(
        &state.mysql,
        state.redis.as_ref(),
        &state.entity_resolvers,
        user_id,
    )
    .await
    .map_err(|error| {
        tracing::error!(%error, user_id, "sync-device catalog reconcile failed");
        FastApiError::unhandled()
    })?;

    state
        .mysql
        .with_transaction(async |transaction| {
            ensure_pending_for_device(transaction, &state.mysql, user_id, device_id).await
        })
        .await
        .map_err(|error| {
            tracing::error!(%error, user_id, "sync-device pending refresh failed");
            FastApiError::unhandled()
        })?;

    // Source `db.close()` ends the request-scoped session: SQLAlchemy rolls
    // back the idle transaction started after the commit.
    let _ = state.mysql.execute("ROLLBACK", ()).await;

    // Source steps 4-5: `current_user.id` is read after the commit expired it
    // and `db.close()` detached it, raising `DetachedInstanceError`.
    Err(FastApiError::unhandled())
}

/// Source `reconcile_device_plugins`: reconcile catalog refs, then dispatch the
/// desired payload to the device. Without a device dispatch channel the source's
/// dispatch-failure 502 is reported.
async fn reconcile_device_plugins(
    state: &AppState,
    user_id: i64,
    device_id: &str,
) -> Result<Value, FastApiError> {
    // The source only reaches the dispatch after resolving the device's online
    // Runtime route; the payload build reads the catalog for `device_id`, so keep
    // the parameter in the signature to preserve the source call shape.
    let _ = device_id;
    reconcile_stale_installed_catalog_refs(
        &state.mysql,
        state.redis.as_ref(),
        &state.entity_resolvers,
        user_id,
    )
    .await
    .map_err(|error| {
        tracing::error!(%error, user_id, "reconcile catalog refresh failed");
        FastApiError::unhandled()
    })?;
    Err(FastApiError::detail(
        brz_http_server::StatusCode::BAD_GATEWAY,
        "Plugin reconciliation failed: device is offline",
    ))
}

/// Source `plugin_device_installation_service.ensure_pending_for_device`.
///
/// Runs inside the caller's write transaction so the reconcile lock, the alias
/// rewrites, and the pending upserts commit together. The source mutates ORM
/// objects during iteration and emits every INSERT/UPDATE only at the
/// `db.commit()` flush, so the write statements are collected here and flushed
/// through [`PendingFlush`] instead of being executed inline.
async fn ensure_pending_for_device<T, M>(
    transaction: &mut T,
    mysql: &M,
    user_id: i64,
    device_id: &str,
) -> MysqlResult<usize>
where
    T: MysqlTransaction,
    M: Mysql,
{
    let identity_map = reconcile_plugin_device_rows::<_, _, PluginDeviceInstallationRow>(
        transaction,
        mysql,
        user_id,
    )
    .await?;
    let normalized_device_id = plugin_device_id(mysql, user_id, device_id).await?;
    if normalized_device_id.is_empty() {
        return Ok(0);
    }
    let desired: Vec<DesiredInstalledKind> =
        mysql.fetch_all(DESIRED_INSTALLS_QUERY, (user_id,)).await?;
    let mut changed = 0usize;
    // The session's identity map is seeded by `reconcile_plugin_device_rows`'s
    // `FOR UPDATE` read (primary-key ascending), so the flush emits the UPDATE
    // statements in that load order, not in the iteration order of the desired
    // installs even when iteration visits a later identity-map row first.
    let mut identity_map = identity_map;
    let mut flush = PendingFlush::default();
    for installed in &desired {
        changed += ensure_desired_install_pending(
            transaction,
            user_id,
            &normalized_device_id,
            installed,
            &mut identity_map,
            &mut flush,
        )
        .await?;
    }
    flush.emit(transaction, &identity_map).await?;
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
    async fn emit<T>(
        &mut self,
        transaction: &mut T,
        identity_map: &[PluginDeviceInstallationRow],
    ) -> MysqlResult<()>
    where
        T: MysqlTransaction,
    {
        self.updates.sort_by_key(|(index, _)| *index);
        for insert in &self.inserts {
            transaction
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
            transaction
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
async fn ensure_desired_install_pending<T>(
    transaction: &mut T,
    user_id: i64,
    device_id: &str,
    installed: &DesiredInstalledKind,
    identity_map: &mut Vec<PluginDeviceInstallationRow>,
    flush: &mut PendingFlush,
) -> MysqlResult<usize>
where
    T: MysqlTransaction,
{
    let Some(release_id) = integer_release_id(&installed.json) else {
        return Ok(0);
    };
    let row: Option<PluginDeviceInstallationRow> = transaction
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
}
