// SPDX-License-Identifier: Apache-2.0
//! Persist plugin-scoped and legacy acknowledgement fences.

use super::*;
use crate::plugins_installed::desired_capabilities::load_installed_plugins_for_ids;
use std::collections::HashMap;

/// `record_versioned_result`: materialize only the acknowledged generation of
/// a versioned snapshot.
///
/// Source: `app/services/device/plugin_sync_recording.py`. A generation below
/// the device's watermark, an item the device never acknowledged, or a desired
/// plugin that changed after dispatch never rewrites rows. Removed plugins
/// follow the acknowledgement's `remove` outcome, and the per-device watermark
/// advances to the snapshot's generation.
pub(super) async fn record_versioned_result<Q>(
    session: &mut Q,
    user_id: i64,
    device_id: &str,
    result: &SyncResult,
    payload: &Value,
    guard: Option<&dyn crate::device_identity::LeaseCheck>,
    installed_ids: Option<&[i64]>,
) -> MysqlResult<()>
where
    Q: PluginQuery,
{
    let Some(metadata) = payload.get("plugin_sync") else {
        return Ok(());
    };
    let generation = metadata
        .get("generation")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let complete = metadata.get("complete") == Some(&Value::Bool(true));
    // The recording transaction re-enters `lock_plugin_sync_state`; the
    // source's reentrant acquire checks the lease before the state read.
    if let Some(guard) = guard {
        guard.check().await?;
    }
    let scoped = metadata["version"].as_i64() == Some(3);
    let legacy_state = if scoped {
        None
    } else {
        Some(
            crate::plugins_installed::plugin_sync_protocol::lock_plugin_sync_state(
                session, user_id,
            )
            .await?,
        )
    };
    let expected = expected_plugins(payload);
    let mut removed_ids = removed_plugin_ids(payload);
    let rows: Vec<PluginDeviceInstallationRow> = session
        .fetch_all(DEVICE_ROWS_FOR_DEVICE_QUERY, (user_id, device_id))
        .await?;
    if complete {
        for row in &rows {
            if !expected.iter().any(|(id, _)| *id == row.installed_kind_id) {
                removed_ids.push(row.installed_kind_id);
            }
        }
    }
    let mut ids = expected.iter().map(|(id, _)| *id).collect::<Vec<_>>();
    ids.extend(removed_ids.iter().copied());
    ids.sort_unstable();
    ids.dedup();
    ids.retain(|id| installed_ids.is_none_or(|owned| owned.contains(id)));
    let (filter, id_arguments) = crate::sql_support::id_in_clause("kinds.id", &ids);
    let statement = format!(
        "SELECT {KIND_COLUMNS} FROM kinds WHERE kinds.user_id = ? AND kinds.kind = \
         'InstalledPlugin' AND kinds.namespace = 'default' AND {filter} ORDER BY kinds.id"
    );
    let mut arguments = vec![crate::sql_support::StatementArg::Int(user_id)];
    arguments.extend(id_arguments);
    let installs: Vec<InstalledKindRow> = session.fetch_all(&statement, arguments).await?;
    let current = load_installed_plugins_for_ids(session, user_id, device_id, &ids)
        .await
        .map_err(build_failure)?;
    let current: HashMap<i64, Value> = current
        .into_iter()
        .filter_map(|item| {
            item.get("installed_plugin_id")
                .and_then(Value::as_i64)
                .map(|id| (id, item))
        })
        .collect();
    let acknowledgements: HashMap<String, SyncItem> = result
        .plugins
        .iter()
        .map(|item| (SyncItem::text(&item.id).unwrap_or_default(), item.clone()))
        .collect();
    let now = Local::now().naive_local();
    let mut flush = PendingFlush::default();
    for installed in &installs {
        if scoped
            && metadata["intentRevisions"][installed.id.to_string()].as_i64()
                != Some(
                    crate::plugins_installed::write_coordination::business_revision(
                        &installed.json.0.to_value(),
                    )?,
                )
        {
            continue;
        }
        let scoped_state = if scoped {
            Some(
                crate::plugins_installed::state_store::ensure(
                    session,
                    user_id,
                    &installed.name,
                    installed.id,
                )
                .await?,
            )
        } else {
            None
        };
        let document = if let Some(row) = &scoped_state {
            &row.json
        } else {
            &legacy_state.as_ref().expect("legacy state").json
        };
        let generation = if scoped {
            metadata["revisions"][installed.id.to_string()]
                .as_i64()
                .filter(|v| *v > 0)
                .ok_or_else(|| {
                    crate::plugins_installed::write_coordination::coordination_error(
                        "plugin_write_conflict",
                    )
                })?
        } else {
            generation
        };
        if generation
            < crate::plugins_installed::plugin_sync_protocol::plugin_snapshot_watermark(
                document,
                device_id,
                installed.id,
            )
        {
            continue;
        }
        let item = acknowledgements.get(&installed.id.to_string()).cloned();
        if item
            .as_ref()
            .is_some_and(|item| item.status_text() == "superseded")
        {
            continue;
        }
        let desired = current.get(&installed.id);
        let previous = expected
            .iter()
            .find(|(id, _)| *id == installed.id)
            .map(|(_, item)| item);
        if let (Some(previous), Some(desired)) = (previous, desired) {
            if stable_plugin(desired) != stable_plugin(previous) {
                continue;
            }
            record_desired_install(
                session, user_id, device_id, installed, result, item, &mut flush,
            )
            .await?;
        } else if removed_ids.contains(&installed.id) && desired.is_none() {
            let Some(row) = rows
                .iter()
                .find(|row| row.installed_kind_id == installed.id)
            else {
                continue;
            };
            if result.success
                && item
                    .as_ref()
                    .is_none_or(|item| item.status_text() == "removed")
            {
                flush.push_delete(row.id);
            } else if !result.success
                || item
                    .as_ref()
                    .is_some_and(|item| item.status_text() == "failed")
            {
                let error = result
                    .error
                    .as_deref()
                    .unwrap_or("Device rejected plugin removal");
                flush.push_update(row.id, removed_failed_assignments(row, error, now));
            }
        }
        if let Some(row) = scoped_state {
            let mut document = row.json.clone();
            crate::plugins_installed::plugin_sync_protocol::advance_plugin_snapshot_watermark(
                &mut document,
                device_id,
                generation,
                false,
                &[installed.id],
            );
            if let Some(guard) = guard {
                guard.check().await?;
            }
            crate::plugins_installed::state_store::replace(session, &row, document).await?;
        }
    }
    if let Some(sync_state) = legacy_state {
        let mut document = sync_state.json.clone();
        crate::plugins_installed::plugin_sync_protocol::advance_plugin_snapshot_watermark(
            &mut document,
            device_id,
            generation,
            complete,
            &ids,
        );
        // Assigning the state document dirties the row even when every value is
        // unchanged, so the source's `before_flush` lease check runs before the
        // (possibly empty) flush.
        let changed = document != sync_state.json;
        flush.assign_state(sync_state.id, user_id, &document, changed);
    }
    flush.flush_with_guard(session, guard).await
}

/// `payload["plugins"]` keyed by `installed_plugin_id`.
fn expected_plugins(payload: &Value) -> Vec<(i64, Value)> {
    payload
        .get("plugins")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    item.get("installed_plugin_id")
                        .and_then(Value::as_i64)
                        .map(|id| (id, item.clone()))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// `{item["installed_plugin_id"] for item in payload["removed_plugins"]}`.
fn removed_plugin_ids(payload: &Value) -> Vec<i64> {
    payload
        .get("removed_plugins")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("installed_plugin_id").and_then(Value::as_i64))
                .collect()
        })
        .unwrap_or_default()
}

/// `stable_plugin`: a payload item without its signed download fields.
fn stable_plugin(plugin: &Value) -> Value {
    let Value::Object(object) = plugin else {
        return plugin.clone();
    };
    let mut projected = Map::new();
    for (key, value) in object {
        if key != "download_path" && key != "download_url_expires_at" {
            projected.insert(key.clone(), value.clone());
        }
    }
    Value::Object(projected)
}

/// The recording aborts on a non-database desired-state failure (the source
/// lets the exception escape); the transaction rolls back and the follow-up
/// logs it.
fn build_failure(
    error: crate::plugins_installed::desired_capabilities::BuildError,
) -> brz_mysql::MysqlError {
    match error {
        crate::plugins_installed::desired_capabilities::BuildError::Mysql(error) => error,
        other => {
            tracing::error!(%other, "versioned snapshot desired-state reload failed");
            crate::plugins_installed::write_coordination::coordination_error(
                "plugin_sync_desired_state_failed",
            )
        }
    }
}
