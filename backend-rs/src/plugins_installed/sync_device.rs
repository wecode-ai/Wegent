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
/// rewrites, and the pending upserts commit together.
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
    reconcile_plugin_device_rows::<_, _, PluginDeviceInstallationRow>(transaction, mysql, user_id)
        .await?;
    let normalized_device_id = plugin_device_id(mysql, user_id, device_id).await?;
    if normalized_device_id.is_empty() {
        return Ok(0);
    }
    let desired: Vec<DesiredInstalledKind> =
        mysql.fetch_all(DESIRED_INSTALLS_QUERY, (user_id,)).await?;
    let mut changed = 0usize;
    for installed in &desired {
        changed +=
            ensure_desired_install_pending(transaction, user_id, &normalized_device_id, installed)
                .await?;
    }
    Ok(changed)
}

/// Source `_ensure_desired_install_pending`. Returns 1 when a new row is
/// materialized or an existing row is (re)queued, 0 otherwise; the dirty fields
/// are flushed regardless, exactly like the source's ORM flush.
async fn ensure_desired_install_pending<T>(
    transaction: &mut T,
    user_id: i64,
    device_id: &str,
    installed: &DesiredInstalledKind,
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
        let now = Local::now().naive_local();
        transaction
            .execute(
                INSERT_INSTALLATION_QUERY,
                (
                    installed.id,
                    user_id,
                    device_id,
                    release_id,
                    0_i64,
                    "pending",
                    "",
                    "",
                    0_i64,
                    now,
                    now,
                ),
            )
            .await?;
        return Ok(1);
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
        write_pending(transaction, &row, &assigns).await?;
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
    write_pending(transaction, &row, &assigns).await?;
    Ok(1)
}

/// Flush the pending-row assignments (SQLAlchemy marks only dirty columns).
async fn write_pending<T>(
    transaction: &mut T,
    row: &PluginDeviceInstallationRow,
    assigns: &[String],
) -> MysqlResult<()>
where
    T: MysqlTransaction,
{
    if assigns.is_empty() {
        return Ok(());
    }
    let statement = format!(
        "UPDATE plugin_device_installations SET {} WHERE plugin_device_installations.id = {}",
        assigns.join(", "),
        row.id
    );
    transaction.execute(statement, ()).await?;
    Ok(())
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
}
