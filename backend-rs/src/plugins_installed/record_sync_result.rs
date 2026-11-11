// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Device capability sync results and their persistence.
//!
//! Source: `app/schemas/device.py::DeviceCapabilitySyncResult` /
//! `DeviceCapabilitySyncResponse`, `app/services/device/capability_sync_service.
//! py::sync_device_payload`'s result mapping, and
//! `app/services/plugin_device_installation_service.py::
//! record_device_sync_result` (line 191) with `_record_removed_installs`,
//! `_record_desired_install`, and `_device_install_state`.

use std::collections::HashMap;

use brz_mysql::MysqlResult;
use chrono::{Local, NaiveDateTime};
use serde_json::{Map, Value};

use crate::device_identity::{PluginDeviceInstallationRow, plugin_device_id_on};
use crate::plugins_marketplace::db::{InstalledKindRow, KIND_COLUMNS};
use crate::plugins_marketplace::query::PluginQuery;

use super::desired_capabilities::load_installed_plugins_for_ids;
use super::report::{DESIRED_INSTALLS_QUERY, DEVICE_ROW_QUERY, INSERT_INSTALLATION_QUERY};

/// `PLUGIN_AUTO_UPDATE_FAILURE_LIMIT` (`app/core/constants.py`).
const AUTO_UPDATE_FAILURE_LIMIT: i64 = 3;

/// Every installation row for one account and canonical device.
const DEVICE_ROWS_FOR_DEVICE_QUERY: &str = "SELECT plugin_device_installations.id AS \
     plugin_device_installations_id, plugin_device_installations.installed_kind_id AS \
     plugin_device_installations_installed_kind_id, plugin_device_installations.user_id AS \
     plugin_device_installations_user_id, plugin_device_installations.device_id AS \
     plugin_device_installations_device_id, plugin_device_installations.desired_release_id AS \
     plugin_device_installations_desired_release_id, plugin_device_installations.actual_release_id \
     AS plugin_device_installations_actual_release_id, plugin_device_installations.state AS \
     plugin_device_installations_state, plugin_device_installations.error_code AS \
     plugin_device_installations_error_code, plugin_device_installations.error_message AS \
     plugin_device_installations_error_message, plugin_device_installations.attempt_count AS \
     plugin_device_installations_attempt_count, plugin_device_installations.last_sync_at AS \
     plugin_device_installations_last_sync_at, plugin_device_installations.updated_at AS \
     plugin_device_installations_updated_at FROM plugin_device_installations WHERE \
     plugin_device_installations.user_id = ? AND plugin_device_installations.device_id = ?";

/// One `DeviceCapabilityItemResult`, serialized with every declared field.
#[derive(Debug, Clone, PartialEq)]
pub struct SyncItem {
    pub id: Value,
    pub name: Value,
    pub server_name: Value,
    pub status: Value,
    pub stage: Value,
    pub error_code: Value,
    pub retryable: Value,
    pub error: Value,
}

impl SyncItem {
    /// `DeviceCapabilityItemResult(**item)`: absent fields take their schema
    /// defaults (`status="ok"`, everything else `None`).
    #[must_use]
    pub fn from_value(item: &Value) -> Self {
        let field = |name: &str| item.get(name).cloned().unwrap_or(Value::Null);
        let status = item
            .get("status")
            .filter(|value| !value.is_null())
            .cloned()
            .unwrap_or_else(|| Value::String("ok".to_string()));
        Self {
            id: field("id"),
            name: field("name"),
            server_name: field("server_name"),
            status,
            stage: field("stage"),
            error_code: field("error_code"),
            retryable: field("retryable"),
            error: field("error"),
        }
    }

    #[must_use]
    pub fn to_value(&self) -> Value {
        let mut value = Map::new();
        value.insert("id".to_string(), self.id.clone());
        value.insert("name".to_string(), self.name.clone());
        value.insert("server_name".to_string(), self.server_name.clone());
        value.insert("status".to_string(), self.status.clone());
        value.insert("stage".to_string(), self.stage.clone());
        value.insert("error_code".to_string(), self.error_code.clone());
        value.insert("retryable".to_string(), self.retryable.clone());
        value.insert("error".to_string(), self.error.clone());
        Value::Object(value)
    }

    fn status_text(&self) -> &str {
        self.status.as_str().unwrap_or_default()
    }

    fn text(value: &Value) -> Option<String> {
        value
            .as_str()
            .map(str::to_string)
            .or_else(|| value.as_i64().map(|id| id.to_string()))
            .filter(|text| !text.is_empty())
    }
}

/// `DeviceCapabilitySyncResult` after `sync_device_payload` maps the ack.
#[derive(Debug, Clone)]
pub struct SyncResult {
    pub scope: Value,
    /// `plugin_sync`: the acknowledged versioned snapshot metadata.
    pub plugin_sync: Option<Value>,
    /// `desired_plugin_snapshot` (`exclude=True`): the payload whose versioned
    /// acknowledgement this result records.
    pub desired_plugin_snapshot: Option<Value>,
    pub device_id: String,
    pub success: bool,
    /// `acknowledged` (`exclude=True`): a false value stops the desired-state
    /// retry loop without considering the snapshot stable.
    pub acknowledged: bool,
    pub error: Option<String>,
    pub skills: Vec<SyncItem>,
    pub plugins: Vec<SyncItem>,
    pub mcps: Vec<SyncItem>,
    pub errors: Vec<Value>,
}

impl SyncResult {
    /// `DeviceCapabilitySyncResult(...)` from the RPC acknowledgement.
    ///
    /// `false` acks keep `acknowledged=True` so `sync_latest_device_capabilities`
    /// reloads the desired snapshot, exactly like the source.
    #[must_use]
    pub fn from_ack(device_id: &str, ack: &Value) -> Self {
        if !ack.is_object() {
            return Self {
                scope: Value::Null,
                plugin_sync: None,
                desired_plugin_snapshot: None,
                device_id: device_id.to_string(),
                success: false,
                acknowledged: false,
                error: Some("Capability sync RPC returned invalid data".to_string()),
                skills: Vec::new(),
                plugins: Vec::new(),
                mcps: Vec::new(),
                errors: Vec::new(),
            };
        }
        let items = |field: &str| -> Vec<SyncItem> {
            ack.get(field)
                .and_then(Value::as_array)
                .map(|items| items.iter().map(SyncItem::from_value).collect())
                .unwrap_or_default()
        };
        let errors = ack
            .get("errors")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut result = Self {
            scope: ack.get("scope").cloned().unwrap_or(Value::Null),
            plugin_sync: ack.get("plugin_sync").cloned(),
            desired_plugin_snapshot: None,
            device_id: device_id.to_string(),
            success: ack.get("success") != Some(&Value::Bool(false)),
            acknowledged: true,
            error: None,
            skills: items("skills"),
            plugins: items("plugins"),
            mcps: items("mcps"),
            errors,
        };
        if ack.get("success") == Some(&Value::Bool(false)) {
            // Source's rejection branch leaves the result schema's scope
            // default intact; only successful acknowledgements copy it.
            result.scope = Value::Null;
            result.error = Some(
                ack.get("error")
                    .and_then(Value::as_str)
                    .filter(|error| !error.is_empty())
                    .map(str::to_string)
                    .or_else(|| raw_item_failure_message(ack))
                    .unwrap_or_else(|| "device rejected sync".to_string()),
            );
        }
        result
    }

    /// A dispatch failure (`sync_device_payload`'s error branches) or the
    /// exhausted retry loop. The loop's result keeps the last acknowledgement's
    /// scope, items and versioned snapshot, exactly like the source.
    #[must_use]
    pub fn failure(device_id: &str, last: Option<Self>, error: &str) -> Self {
        match last {
            Some(mut last) => {
                last.success = false;
                last.acknowledged = true;
                last.error = Some(error.to_string());
                last
            }
            None => Self {
                scope: Value::Null,
                plugin_sync: None,
                desired_plugin_snapshot: None,
                device_id: device_id.to_string(),
                success: false,
                acknowledged: false,
                error: Some(error.to_string()),
                skills: Vec::new(),
                plugins: Vec::new(),
                mcps: Vec::new(),
                errors: Vec::new(),
            },
        }
    }

    /// `DeviceCapabilitySyncResult` serialization (the `results[0]` body).
    #[must_use]
    pub fn to_value(&self) -> Value {
        let mut value = Map::new();
        value.insert("scope".to_string(), self.scope.clone());
        if let Some(plugin_sync) = &self.plugin_sync {
            value.insert("plugin_sync".to_string(), plugin_sync.clone());
        }
        value.insert(
            "device_id".to_string(),
            Value::String(self.device_id.clone()),
        );
        value.insert("success".to_string(), Value::Bool(self.success));
        value.insert(
            "error".to_string(),
            self.error.clone().map_or(Value::Null, Value::String),
        );
        value.insert(
            "skills".to_string(),
            Value::Array(self.skills.iter().map(SyncItem::to_value).collect()),
        );
        value.insert(
            "plugins".to_string(),
            Value::Array(self.plugins.iter().map(SyncItem::to_value).collect()),
        );
        value.insert(
            "mcps".to_string(),
            Value::Array(self.mcps.iter().map(SyncItem::to_value).collect()),
        );
        value.insert("errors".to_string(), Value::Array(self.errors.clone()));
        Value::Object(value)
    }

    /// `DeviceCapabilitySyncResponse` for the single-device round trip.
    #[must_use]
    pub fn response(&self, mode: &str) -> Value {
        let mut errors = self.errors.clone();
        if let Some(error) = &self.error {
            let mut entry = Map::new();
            entry.insert(
                "device_id".to_string(),
                Value::String(self.device_id.clone()),
            );
            entry.insert("error".to_string(), Value::String(error.clone()));
            errors.push(Value::Object(entry));
        }
        let synced = i64::from(self.success);
        let mut value = Map::new();
        value.insert("success".to_string(), Value::Bool(self.success));
        value.insert(
            "device_id".to_string(),
            Value::String(self.device_id.clone()),
        );
        value.insert("mode".to_string(), Value::String(mode.to_string()));
        value.insert(
            "skills".to_string(),
            Value::Array(self.skills.iter().map(SyncItem::to_value).collect()),
        );
        value.insert(
            "plugins".to_string(),
            Value::Array(self.plugins.iter().map(SyncItem::to_value).collect()),
        );
        value.insert(
            "mcps".to_string(),
            Value::Array(self.mcps.iter().map(SyncItem::to_value).collect()),
        );
        value.insert("errors".to_string(), Value::Array(errors));
        value.insert("synced".to_string(), Value::from(synced));
        value.insert("failed".to_string(), Value::from(1 - synced));
        value.insert("skipped".to_string(), Value::from(0));
        value.insert("results".to_string(), Value::Array(vec![self.to_value()]));
        Value::Object(value)
    }
}

/// `_raw_item_failure_message` over the raw ack.
fn raw_item_failure_message(ack: &Value) -> Option<String> {
    for field in ["plugins", "skills", "mcps"] {
        let Some(items) = ack.get(field).and_then(Value::as_array) else {
            continue;
        };
        for item in items {
            if !item.is_object() {
                continue;
            }
            if !matches!(
                item.get("status").and_then(Value::as_str),
                Some("failed" | "error")
            ) {
                continue;
            }
            let Some(error) = item
                .get("error")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|error| !error.is_empty())
            else {
                continue;
            };
            let name = item
                .get("name")
                .and_then(Value::as_str)
                .or_else(|| item.get("id").and_then(Value::as_str))
                .map(str::to_string)
                .or_else(|| {
                    item.get("id")
                        .and_then(Value::as_i64)
                        .map(|id| id.to_string())
                })
                .unwrap_or_else(|| field.trim_end_matches('s').to_string());
            let stage = item
                .get("stage")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|stage| !stage.is_empty())
                .map(|stage| format!(" during {stage}"))
                .unwrap_or_default();
            let kind = match field {
                "plugins" => "Plugin",
                "skills" => "Skill",
                _ => "Mcp",
            };
            return Some(format!("{kind} {name} failed{stage}: {error}"));
        }
    }
    None
}

/// `record_device_sync_result`: reconcile aliases, map the ack onto the
/// device's installation rows, and commit.
pub async fn record_device_sync_result<Q>(
    session: &mut Q,
    user_id: i64,
    result: &SyncResult,
    guard: Option<&dyn crate::device_identity::LeaseCheck>,
) -> MysqlResult<()>
where
    Q: PluginQuery,
{
    record_device_sync_result_for_installs(session, user_id, result, guard, None).await
}

pub(crate) async fn record_device_sync_result_for_installs<Q>(
    session: &mut Q,
    user_id: i64,
    result: &SyncResult,
    guard: Option<&dyn crate::device_identity::LeaseCheck>,
    installed_ids: Option<&[i64]>,
) -> MysqlResult<()>
where
    Q: PluginQuery,
{
    // `_record_device_sync_result`: a versioned snapshot serializes with the
    // account protocol state before the alias reconciliation reads rows. Its
    // `lock_plugin_sync_state` re-enters `acquire_plugin_write_lock`, and the
    // reconciliation then re-enters it again, so the versioned branch owns two
    // acquire checks. The legacy branch's only acquire is the reconciliation's,
    // which the caller already ran before this function's reads.
    if result.desired_plugin_snapshot.is_some() {
        super::plugin_sync_protocol::lock_plugin_sync_state(session, user_id).await?;
        if let Some(guard) = guard {
            guard.check().await?;
        }
    }
    // `reconcile_plugin_device_rows` owns the first flush boundaries: the
    // superseded alias DELETE batch and the selected canonical `device_id`
    // assignment (dirty even when the value is unchanged).
    crate::device_identity::reconcile_plugin_device_rows_for_installs_on::<
        _,
        PluginDeviceInstallationRow,
    >(session, user_id, guard, installed_ids)
    .await?;
    let canonical_id = plugin_device_id_on(session, user_id, &result.device_id).await?;
    if let Some(payload) = &result.desired_plugin_snapshot {
        return record_versioned_result(
            session,
            user_id,
            &canonical_id,
            result,
            payload,
            guard,
            installed_ids,
        )
        .await;
    }
    let mut installs: Vec<InstalledKindRow> = session
        .fetch_all(DESIRED_INSTALLS_QUERY, (user_id,))
        .await?;
    installs.retain(|row| installed_ids.is_none_or(|ids| ids.contains(&row.id)));
    let mut flush = PendingFlush::default();
    let plugin_results: Vec<(i64, SyncItem)> = result
        .plugins
        .iter()
        .filter_map(|item| item.id.as_i64().map(|id| (id, item.clone())))
        .collect();
    // Source `_record_removed_installs` receives `set(plugin_results)`: a
    // reported plugin item acknowledges its install attempt even when a newer
    // uninstall already removed it from the desired set.
    let retained_ids: Vec<i64> = installs
        .iter()
        .map(|installed| installed.id)
        .chain(plugin_results.iter().map(|(id, _)| *id))
        .collect();
    record_removed_installs(
        session,
        user_id,
        &canonical_id,
        result,
        &retained_ids,
        &mut flush,
        installed_ids,
    )
    .await?;
    for installed in &installs {
        let item = plugin_results
            .iter()
            .find(|(id, _)| *id == installed.id)
            .map(|(_, item)| item.clone());
        record_desired_install(
            session,
            user_id,
            &canonical_id,
            installed,
            result,
            item,
            &mut flush,
        )
        .await?;
    }
    // Source `before_flush`: one ownership check covers the session's single
    // dirty flush, before any of the collected DELETE/UPDATE/INSERT statements
    // reaches the database. `before_commit` checks again from the caller's
    // `commit_revision`.
    flush.flush_with_guard(session, guard).await
}

/// `record_versioned_result`: materialize only the acknowledged generation of
/// a versioned snapshot.
///
/// Source: `app/services/device/plugin_sync_recording.py`. A generation below
/// the device's watermark, an item the device never acknowledged, or a desired
/// plugin that changed after dispatch never rewrites rows. Removed plugins
/// follow the acknowledgement's `remove` outcome, and the per-device watermark
/// advances to the snapshot's generation.
async fn record_versioned_result<Q>(
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
    let sync_state = super::plugin_sync_protocol::lock_plugin_sync_state(session, user_id).await?;
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
        if generation
            < super::plugin_sync_protocol::plugin_snapshot_watermark(
                &sync_state.json,
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
    }
    let mut document = sync_state.json.clone();
    super::plugin_sync_protocol::advance_plugin_snapshot_watermark(
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
fn build_failure(error: super::desired_capabilities::BuildError) -> brz_mysql::MysqlError {
    match error {
        super::desired_capabilities::BuildError::Mysql(error) => error,
        other => {
            tracing::error!(%other, "versioned snapshot desired-state reload failed");
            super::write_coordination::coordination_error("plugin_sync_desired_state_failed")
        }
    }
}

/// `_record_removed_installs`.
async fn record_removed_installs<Q>(
    session: &mut Q,
    user_id: i64,
    device_id: &str,
    result: &SyncResult,
    retained_ids: &[i64],
    flush: &mut PendingFlush,
    installed_ids: Option<&[i64]>,
) -> MysqlResult<()>
where
    Q: PluginQuery,
{
    let rows: Vec<PluginDeviceInstallationRow> = session
        .fetch_all(DEVICE_ROWS_FOR_DEVICE_QUERY, (user_id, device_id))
        .await?;
    let now = Local::now().naive_local();
    for row in rows {
        if !installed_ids.is_none_or(|ids| ids.contains(&row.installed_kind_id)) {
            continue;
        }
        if retained_ids.contains(&row.installed_kind_id) {
            continue;
        }
        if result.success {
            // `db.delete(row)`: the DELETE waits for the session's dirty flush.
            flush.push_delete(row.id);
            continue;
        }
        let error = result
            .error
            .as_deref()
            .unwrap_or("Device rejected plugin removal");
        flush.push_update(row.id, removed_failed_assignments(&row, error, now));
    }
    Ok(())
}

/// The columns SQLAlchemy's dirty tracking flushes for a failed removed row.
///
/// Assigning the same `state`/`error_code`/`error_message` to an
/// already-failed row emits nothing for them; `attempt_count`, `last_sync_at`
/// and `updated_at` always change.
fn removed_failed_assignments(
    row: &PluginDeviceInstallationRow,
    error: &str,
    now: NaiveDateTime,
) -> Vec<String> {
    let mut assigns = Vec::new();
    if row.state != "failed" {
        assigns.push("state='failed'".to_string());
    }
    if row.error_code != "PLUGIN_SYNC_FAILED" {
        assigns.push("error_code='PLUGIN_SYNC_FAILED'".to_string());
    }
    if row.error_message != error {
        assigns.push(format!("error_message='{}'", escape_sql(error)));
    }
    assigns.push(format!("attempt_count={}", row.attempt_count + 1));
    assigns.push(format!("last_sync_at='{}'", format_datetime(now)));
    assigns.push(format!("updated_at='{}'", format_datetime(now)));
    assigns
}

/// `_record_desired_install`'s dirty `error_message` assignment.
///
/// SQLAlchemy flushes the column only when the assigned text differs from the
/// loaded one, so the same (possibly empty) text stays out of the UPDATE.
fn desired_install_error_message_assignment(loaded: &str, assigned: &str) -> Option<String> {
    (loaded != assigned).then(|| format!("error_message='{}'", escape_sql(assigned)))
}

/// One deferred write collected by the result recording.
enum PendingWrite {
    /// `db.delete(row)`.
    Delete(i64),
    /// One dirty row's UPDATE assignments.
    Update { id: i64, assigns: Vec<String> },
    /// `db.add(PluginDeviceInstallation(...))`.
    Insert(DesiredInsert),
}

/// One pending `db.add` row.
struct DesiredInsert {
    installed_kind_id: i64,
    user_id: i64,
    device_id: String,
    release_id: i64,
    state: String,
    error_code: String,
    error_message: String,
    attempt_count: i64,
    now: chrono::NaiveDateTime,
}

/// The result recording's single deferred flush.
///
/// The source's session uses `autoflush=False`; the DELETE / UPDATE / INSERT
/// statements only reach the database when the commit flush runs. `assigned`
/// tracks that the session carries pending work (an equal-value assignment is
/// still dirty), which is exactly when the source's `before_flush` ownership
/// check runs.
#[derive(Default)]
struct PendingFlush {
    assigned: bool,
    writes: Vec<PendingWrite>,
    /// The account protocol state document assignment (`state.json = ...`).
    state: Option<StateAssignment>,
}

/// One dirty `PluginSyncState.json` assignment.
struct StateAssignment {
    id: Option<i64>,
    user_id: i64,
    document: String,
    changed: bool,
}

impl PendingFlush {
    /// Guard first (when the session is dirty), then emit the collected
    /// statements in SQLAlchemy's single-mapper unit-of-work order: the state
    /// document first, then dirty UPDATEs by primary key, then INSERTs in
    /// insertion order, then DELETEs by primary key (`save_obj` emits updates
    /// before inserts; `_sort_states` orders existing states by mapper primary
    /// key and new states by insertion order). A failed guard emits none of
    /// them.
    async fn flush_with_guard<Q>(
        &mut self,
        session: &mut Q,
        guard: Option<&dyn crate::device_identity::LeaseCheck>,
    ) -> MysqlResult<()>
    where
        Q: PluginQuery,
    {
        if self.assigned
            && let Some(guard) = guard
        {
            guard.check().await?;
        }
        if let Some(state) = self.state.take() {
            super::plugin_sync_protocol::write_sync_state_document(
                session,
                state.id,
                state.user_id,
                &state.document,
                state.changed,
            )
            .await?;
        }
        self.writes.sort_by_key(|write| match write {
            PendingWrite::Update { id, .. } => (0_u8, *id),
            // Stable sort: new rows keep SQLAlchemy's insertion order.
            PendingWrite::Insert(_) => (1, 0),
            PendingWrite::Delete(id) => (2, *id),
        });
        for write in &self.writes {
            match write {
                PendingWrite::Delete(id) => {
                    session
                        .execute(
                            "DELETE FROM plugin_device_installations WHERE \
                             plugin_device_installations.id = ?",
                            (*id,),
                        )
                        .await?;
                }
                PendingWrite::Update { id, assigns } => {
                    let statement = format!(
                        "UPDATE plugin_device_installations SET {} WHERE \
                         plugin_device_installations.id = {}",
                        assigns.join(", "),
                        id
                    );
                    session.execute(statement, ()).await?;
                }
                PendingWrite::Insert(insert) => {
                    session
                        .execute(
                            INSERT_INSTALLATION_QUERY,
                            (
                                insert.installed_kind_id,
                                insert.user_id,
                                insert.device_id.as_str(),
                                insert.release_id,
                                0_i64,
                                insert.state.as_str(),
                                insert.error_code.as_str(),
                                insert.error_message.as_str(),
                                insert.attempt_count,
                                insert.now,
                                insert.now,
                            ),
                        )
                        .await?;
                }
            }
        }
        Ok(())
    }

    fn push_update(&mut self, id: i64, assigns: Vec<String>) {
        self.assigned = true;
        if let Some(PendingWrite::Update {
            assigns: existing, ..
        }) = self
            .writes
            .iter_mut()
            .find(|write| matches!(write, PendingWrite::Update { id: row, .. } if *row == id))
        {
            *existing = assigns;
        } else {
            self.writes.push(PendingWrite::Update { id, assigns });
        }
    }

    fn push_delete(&mut self, id: i64) {
        self.assigned = true;
        self.writes.push(PendingWrite::Delete(id));
    }

    fn push_insert(&mut self, insert: DesiredInsert) {
        self.assigned = true;
        self.writes.push(PendingWrite::Insert(insert));
    }

    /// Assign the protocol state document. SQLAlchemy dirties the row on the
    /// assignment itself, so `before_flush` runs even when the document is
    /// equal and no UPDATE is emitted.
    fn assign_state(&mut self, id: Option<i64>, user_id: i64, document: &Value, changed: bool) {
        self.assigned = true;
        self.state = Some(StateAssignment {
            id,
            user_id,
            document: crate::json_compat::python_json_value(document),
            changed,
        });
    }
}

/// `_record_desired_install`.
#[allow(clippy::too_many_arguments)]
async fn record_desired_install<Q>(
    session: &mut Q,
    user_id: i64,
    device_id: &str,
    installed: &InstalledKindRow,
    result: &SyncResult,
    item: Option<SyncItem>,
    flush: &mut PendingFlush,
) -> MysqlResult<()>
where
    Q: PluginQuery,
{
    let Some(release_id) = integer_release_id(&installed.json.0.to_value()) else {
        return Ok(());
    };
    let row: Option<PluginDeviceInstallationRow> = session
        .fetch_optional(DEVICE_ROW_QUERY, (installed.id, device_id))
        .await?;
    if let Some(row) = &row
        && auto_update_blocked(row, release_id)
    {
        return Ok(());
    }
    let (state, error_message) = device_install_state(result, item.as_ref());
    if item.is_none()
        && result.success
        && row
            .as_ref()
            .is_some_and(|row| row.state == "installed" && row.actual_release_id == release_id)
    {
        return Ok(());
    }
    let Some(row) = row else {
        // `PluginDeviceInstallation(...)` plus `db.add`; the INSERT waits for
        // the session's dirty flush and keeps the model defaults.
        let now = Local::now().naive_local();
        flush.push_insert(DesiredInsert {
            installed_kind_id: installed.id,
            user_id,
            device_id: device_id.to_string(),
            release_id,
            state: state.to_string(),
            error_code: if state == "failed" {
                item.as_ref()
                    .and_then(|item| item.error_code.as_str())
                    .filter(|code| !code.is_empty())
                    .unwrap_or("PLUGIN_SYNC_FAILED")
                    .to_string()
            } else {
                String::new()
            },
            error_message: error_message.unwrap_or_default(),
            attempt_count: if state == "failed" { 1 } else { 0 },
            now,
        });
        return Ok(());
    };
    let desired_changed = row.desired_release_id != release_id;
    let mut attempt_count = row.attempt_count;
    if state == "installed" {
        attempt_count = 0;
    } else if state == "failed" {
        attempt_count = if desired_changed {
            1
        } else {
            row.attempt_count + 1
        };
    } else if desired_changed {
        attempt_count = 0;
    }
    let mut actual_release_id = row.actual_release_id;
    if state == "installed" {
        actual_release_id = release_id;
    }
    let error_code = if state == "failed" {
        item.as_ref()
            .and_then(|item| item.error_code.as_str())
            .filter(|code| !code.is_empty())
            .unwrap_or("PLUGIN_SYNC_FAILED")
            .to_string()
    } else {
        String::new()
    };
    let error_message = error_message.unwrap_or_default();
    let now = Local::now().naive_local();
    let mut assigns = Vec::new();
    if row.desired_release_id != release_id {
        assigns.push(format!("desired_release_id={release_id}"));
    }
    if row.actual_release_id != actual_release_id {
        assigns.push(format!("actual_release_id={actual_release_id}"));
    }
    if row.state != state {
        assigns.push(format!("state='{}'", escape_sql(state)));
    }
    if row.error_code != error_code {
        assigns.push(format!("error_code='{}'", escape_sql(&error_code)));
    }
    if let Some(assign) =
        desired_install_error_message_assignment(&row.error_message, &error_message)
    {
        assigns.push(assign);
    }
    if row.attempt_count != attempt_count {
        assigns.push(format!("attempt_count={attempt_count}"));
    }
    assigns.push(format!("last_sync_at='{}'", format_datetime(now)));
    assigns.push(format!("updated_at='{}'", format_datetime(now)));
    flush.push_update(row.id, assigns);
    Ok(())
}

/// `_device_install_state`.
fn device_install_state(
    result: &SyncResult,
    item: Option<&SyncItem>,
) -> (&'static str, Option<String>) {
    if let Some(item) = item {
        if matches!(item.status_text(), "failed" | "error") {
            return (
                "failed",
                Some(
                    SyncItem::text(&item.error)
                        .unwrap_or_else(|| "Device rejected plugin install".to_string()),
                ),
            );
        }
        if item.status_text() == "synced" {
            return ("installed", None);
        }
    }
    if !result.success {
        return (
            "failed",
            item.and_then(|item| SyncItem::text(&item.error))
                .or_else(|| result.error.clone()),
        );
    }
    if item.is_none() {
        // Overall ack succeeded but this plugin was not reported yet.
        return ("pending", None);
    }
    ("installed", None)
}

/// Source `_auto_update_blocked`.
fn auto_update_blocked(row: &PluginDeviceInstallationRow, desired_release_id: i64) -> bool {
    row.state == "failed"
        && row.attempt_count >= AUTO_UPDATE_FAILURE_LIMIT
        && row.actual_release_id != 0
        && row.actual_release_id != desired_release_id
        && row.desired_release_id == desired_release_id
}

/// `spec.releaseId` when it is an integer.
fn integer_release_id(json: &Value) -> Option<i64> {
    json.get("spec")
        .and_then(|spec| spec.get("releaseId"))
        .and_then(Value::as_i64)
}

/// The MySQL `DATETIME` literal shape (`YYYY-MM-DD HH:MM:SS.ffffff`).
fn format_datetime(value: NaiveDateTime) -> String {
    value.format("%Y-%m-%d %H:%M:%S%.6f").to_string()
}

/// Escape the literal text this module renders into UPDATE statements.
fn escape_sql(value: &str) -> String {
    value.replace('\\', "\\\\").replace('\'', "\\'")
}

#[cfg(test)]
#[path = "record_sync_result_tests.rs"]
mod tests;
