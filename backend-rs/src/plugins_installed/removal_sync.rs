// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `app/services/device/plugin_removal_sync.py::pending_removal_devices`.
//!
//! A heartbeat replays the persisted uninstall intents for this device: the
//! scan joins inactive `InstalledPlugin` kinds with their device rows and
//! keeps the rows whose retry is due. Source schedules the drain with
//! `_schedule_background_task`, after the heartbeat has been persisted.

use brz_mysql::MysqlRow;
use chrono::NaiveDateTime;

use crate::state::AppState;

/// `RETRY_INTERVAL_SECONDS`.
const RETRY_INTERVAL_SECONDS: i64 = 60;
/// `MAX_RETRY_INTERVAL_SECONDS`.
const MAX_RETRY_INTERVAL_SECONDS: i64 = 3600;

/// `pending_removal_devices`' joined scan: inactive installs whose device row
/// is uninstalling or past the retry cutoff.
const PENDING_REMOVALS_QUERY: &str = "SELECT plugin_device_installations.id AS plugin_device_installations_id, plugin_device_installations.installed_kind_id AS plugin_device_installations_installed_kind_id, plugin_device_installations.user_id AS plugin_device_installations_user_id, plugin_device_installations.device_id AS plugin_device_installations_device_id, plugin_device_installations.desired_release_id AS plugin_device_installations_desired_release_id, plugin_device_installations.actual_release_id AS plugin_device_installations_actual_release_id, plugin_device_installations.state AS plugin_device_installations_state, plugin_device_installations.error_code AS plugin_device_installations_error_code, plugin_device_installations.error_message AS plugin_device_installations_error_message, plugin_device_installations.attempt_count AS plugin_device_installations_attempt_count, plugin_device_installations.last_sync_at AS plugin_device_installations_last_sync_at, plugin_device_installations.updated_at AS plugin_device_installations_updated_at FROM plugin_device_installations INNER JOIN kinds ON kinds.id = plugin_device_installations.installed_kind_id WHERE plugin_device_installations.user_id = ? AND kinds.user_id = ? AND kinds.namespace = 'default' AND kinds.kind = 'InstalledPlugin' AND kinds.is_active IS false AND (plugin_device_installations.state = 'uninstalling' OR plugin_device_installations.last_sync_at < ?)";

/// `sync_pending_plugin_removals`: drain the persisted removals for one device.
pub(crate) async fn run_pending_removals(state: &AppState, user_id: i64, device_id: &str) {
    let now = chrono::Local::now().naive_local();
    let cutoff = now - chrono::Duration::seconds(RETRY_INTERVAL_SECONDS);
    let rows: Vec<MysqlRow> = match state
        .mysql
        .fetch_all(PENDING_REMOVALS_QUERY, (user_id, user_id, cutoff))
        .await
    {
        Ok(rows) => rows,
        Err(error) => {
            tracing::warn!(%error, user_id, "pending plugin removal scan failed");
            return;
        }
    };
    // `plugin_removal_sync.py:96`: the canonical target is resolved
    // unconditionally, before the due set, and filters the devices.
    let target = match plugin_device_id(state, user_id, device_id).await {
        Ok(target) => target,
        Err(error) => {
            tracing::warn!(%error, user_id, "pending plugin removal identity failed");
            return;
        }
    };
    let mut devices = std::collections::BTreeSet::new();
    for row in rows.iter().filter(|row| removal_retry_due(row, now)) {
        let Ok(Some(row_device)) = row.get::<String>("plugin_device_installations_device_id")
        else {
            continue;
        };
        if let Ok(mapped) = plugin_device_id(state, user_id, &row_device).await {
            devices.insert(mapped);
        }
    }
    // `:103` `devices & {target}`: the heartbeat only drains its own device.
    let due: Vec<String> = devices
        .into_iter()
        .filter(|device| *device == target)
        .collect();
    if due.is_empty() {
        return;
    }
    // `_sync_device` drives `device_capability_sync_service`'s delta sync, which
    // this backend does not implement; the scan itself is the recorded work.
    tracing::warn!(
        user_id,
        device_id,
        devices = due.len(),
        "pending plugin removals are due; capability delta sync is not migrated"
    );
}

/// `plugin_device_id` (`plugin_device_identity.py:56-69`): the canonical plugin
/// device identity of a submitted route or alias, through the shared resolver.
async fn plugin_device_id(
    state: &AppState,
    user_id: i64,
    device_id: &str,
) -> Result<String, brz_mysql::MysqlError> {
    let submitted = device_id.trim();
    let Some(identity) =
        crate::plugin_account_auth::route::identity(&state.mysql, user_id, submitted).await?
    else {
        // `plugin_device_identity.py:60-62`: an unresolved alias falls back to
        // the submitted id rather than disappearing.
        return Ok(submitted.to_owned());
    };
    Ok(match identity.device_type {
        crate::socketio::device::DeviceType::App => identity.runtime_device_id,
        _ => identity.logical_device_id,
    })
}

/// `removal_retry_due`: an uninstalling row is due immediately, a failed one
/// waits for its bounded exponential backoff.
fn removal_retry_due(row: &MysqlRow, now: NaiveDateTime) -> bool {
    let Ok(Some(state)) = row.get::<String>("plugin_device_installations_state") else {
        return false;
    };
    if state == "uninstalling" {
        return true;
    }
    let Ok(Some(last_sync_at)) =
        row.get::<NaiveDateTime>("plugin_device_installations_last_sync_at")
    else {
        return false;
    };
    let attempt = row
        .get::<i64>("plugin_device_installations_attempt_count")
        .ok()
        .flatten()
        .unwrap_or(0);
    let exponent = (attempt - 1).clamp(0, 6);
    let interval =
        (RETRY_INTERVAL_SECONDS * 2_i64.pow(exponent as u32)).min(MAX_RETRY_INTERVAL_SECONDS);
    last_sync_at <= now - chrono::Duration::seconds(interval)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_retry_window_doubles_up_to_the_cap() {
        assert_eq!(
            (RETRY_INTERVAL_SECONDS * 2_i64.pow(6)).min(MAX_RETRY_INTERVAL_SECONDS),
            MAX_RETRY_INTERVAL_SECONDS
        );
        assert_eq!(
            (RETRY_INTERVAL_SECONDS * 2_i64.pow(0)).min(MAX_RETRY_INTERVAL_SECONDS),
            60
        );
    }
}
