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

use brz_mysql::MysqlResult;
use chrono::{Local, NaiveDateTime};
use serde_json::Value;

use crate::device_identity::plugin_device_id_on;
use crate::plugins_marketplace::db::InstalledKindRow;
use wegent_backend_persistence::mysql_query::MysqlQuery;
use wegent_plugin_store::PluginDeviceInstallationRow;

use super::report::{DESIRED_INSTALLS_QUERY, DEVICE_ROW_QUERY, INSERT_INSTALLATION_QUERY};

mod local_completion;
mod versioned;

pub(super) use local_completion::record_local_completion;
use versioned::{record_versioned_result, stable_plugin};

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

#[path = "record_sync_result_types.rs"]
mod record_sync_result_types;
pub use record_sync_result_types::{SyncItem, SyncResult};

/// `_raw_item_failure_message` over the raw ack.
pub(crate) fn raw_item_failure_message(ack: &Value) -> Option<String> {
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
#[cfg(test)]
async fn record_device_sync_result<Q>(
    session: &mut Q,
    user_id: i64,
    result: &SyncResult,
    guard: Option<&dyn wegent_plugin_store::LeaseCheck>,
) -> MysqlResult<()>
where
    Q: MysqlQuery,
{
    record_device_sync_result_for_installs(session, user_id, result, guard, None).await
}

pub async fn record_device_sync_result_for_installs<Q>(
    session: &mut Q,
    user_id: i64,
    result: &SyncResult,
    guard: Option<&dyn wegent_plugin_store::LeaseCheck>,
    installed_ids: Option<&[i64]>,
) -> MysqlResult<()>
where
    Q: MysqlQuery,
{
    // Check ownership before alias mutations. The versioned branch reads its
    // protocol state once, after resolving the canonical device identity.
    if result
        .desired_plugin_snapshot
        .as_ref()
        .is_some_and(|payload| payload.get("plugin_sync").is_some())
        && let Some(guard) = guard
    {
        guard.check().await?;
    }
    // `reconcile_plugin_device_rows` owns the first flush boundaries: the
    // superseded alias DELETE batch and the selected canonical `device_id`
    // assignment (dirty even when the value is unchanged).
    wegent_plugin_store::reconcile_plugin_device_rows_for_installs_on::<
        _,
        PluginDeviceInstallationRow,
    >(session, user_id, guard, installed_ids)
    .await?;
    let canonical_id = plugin_device_id_on(session, user_id, &result.device_id).await?;
    if let Some(payload) = &result.desired_plugin_snapshot
        && payload.get("plugin_sync").is_some()
    {
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
    // Source `current_legacy_plugin_ids` fences a legacy acknowledgement: only
    // installs whose desired payload is byte-identical to the one dispatched
    // may be rewritten. The fence re-loads that payload by the dispatched
    // installed ids, so this read is a required member of the result session
    // (`_load_installed_plugins(only_ids=...)`).
    let confirmed = match &result.desired_plugin_snapshot {
        Some(snapshot) => {
            Some(current_legacy_plugin_ids(session, user_id, &canonical_id, snapshot).await?)
        }
        None => None,
    };
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
        // Source: `if confirmed is not None and installed.id not in confirmed:
        // continue` — an install whose payload drifted since dispatch is not
        // rewritten by this acknowledgement.
        if confirmed
            .as_ref()
            .is_some_and(|confirmed| !confirmed.contains(&installed.id))
        {
            continue;
        }
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
    // reaches the database. The caller fences the installation revisions before commit.
    flush.flush_with_guard(session, guard).await
}

/// `current_legacy_plugin_ids`: fence a legacy acknowledgement with the exact
/// payload dispatched before the RPC.
///
/// Only installs whose current desired payload equals the dispatched one are
/// confirmed; an install that changed while the device was acknowledging is
/// left to the next sync. The read is `_load_installed_plugins(only_ids=...)`
/// over the dispatched installed ids, in the order the payload lists them.
async fn current_legacy_plugin_ids<Q: MysqlQuery>(
    session: &mut Q,
    user_id: i64,
    device_id: &str,
    snapshot: &Value,
) -> MysqlResult<std::collections::HashSet<i64>> {
    let mut expected: Vec<(i64, &Value)> = Vec::new();
    for item in snapshot
        .get("plugins")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
    {
        if let Some(id) = item.get("installed_plugin_id").and_then(Value::as_i64) {
            expected.push((id, item));
        }
    }
    let only_ids: Vec<i64> = {
        let mut ids: Vec<i64> = expected.iter().map(|(id, _)| *id).collect();
        ids.sort_unstable();
        ids
    };
    let current = super::desired_capabilities::load_installed_plugins_for_ids(
        session, user_id, device_id, &only_ids,
    )
    .await
    .map_err(build_failure)?;
    Ok(current
        .iter()
        .filter_map(|item| {
            let id = item.get("installed_plugin_id").and_then(Value::as_i64)?;
            let dispatched = expected
                .iter()
                .find(|(expected_id, _)| *expected_id == id)
                .map(|(_, item)| *item)?;
            (stable_plugin(item) == stable_plugin(dispatched)).then_some(id)
        })
        .collect())
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
    Q: MysqlQuery,
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
    actual_release_id: i64,
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
        guard: Option<&dyn wegent_plugin_store::LeaseCheck>,
    ) -> MysqlResult<()>
    where
        Q: MysqlQuery,
    {
        if self.assigned
            && let Some(guard) = guard
        {
            guard.check().await?;
        }
        if self.state.is_some() {
            // Wait for device rows before taking the shared account-state
            // write lock. The CAS still precedes every deferred device write.
            self.lock_device_rows(session).await?;
        }
        if let Some(state) = self.state.take() {
            // Even an unchanged watermark must fence device writes against
            // a newer dispatch committed after the ACK read its state.
            let requires_cas = state.changed || !self.writes.is_empty();
            super::plugin_sync_protocol::write_sync_state_document(
                session,
                state.id,
                state.user_id,
                &state.document,
                requires_cas,
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
                                insert.actual_release_id,
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

    async fn lock_device_rows<Q: MysqlQuery>(&self, session: &mut Q) -> MysqlResult<()> {
        let mut ids = self
            .writes
            .iter()
            .filter_map(|write| match write {
                PendingWrite::Update { id, .. } | PendingWrite::Delete(id) => Some(*id),
                PendingWrite::Insert(_) => None,
            })
            .collect::<Vec<_>>();
        ids.sort_unstable();
        ids.dedup();
        for id in ids {
            let _: Option<i64> = session
                .fetch_optional(
                    "SELECT id FROM plugin_device_installations WHERE id=? FOR UPDATE",
                    (id,),
                )
                .await?;
        }
        let mut inserts = self
            .writes
            .iter()
            .filter_map(|write| match write {
                PendingWrite::Insert(insert) => Some((
                    insert.user_id,
                    insert.installed_kind_id,
                    insert.device_id.as_str(),
                )),
                _ => None,
            })
            .collect::<Vec<_>>();
        inserts.sort_unstable();
        inserts.dedup();
        for identity in inserts {
            let _: Option<i64> = session.fetch_optional(
                "SELECT id FROM plugin_device_installations WHERE user_id=? AND installed_kind_id=? AND device_id=? FOR UPDATE", identity,
            ).await?;
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
    Q: MysqlQuery,
{
    let Some(release_id) = integer_release_id(&installed.json.0.to_value()) else {
        return Ok(());
    };
    record_installation_result(
        session, user_id, device_id, installed, release_id, result, item, flush, false,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn record_installation_result<Q: MysqlQuery>(
    session: &mut Q,
    user_id: i64,
    device_id: &str,
    installed: &InstalledKindRow,
    release_id: i64,
    result: &SyncResult,
    item: Option<SyncItem>,
    flush: &mut PendingFlush,
    confirmed_local: bool,
) -> MysqlResult<()> {
    let installed_id = installed.id;
    let source_preserved = item
        .as_ref()
        .is_some_and(|item| item.status_text() == "source_preserved");
    if source_preserved
        && (!item
            .as_ref()
            .is_some_and(|item| super::personal_source::valid_source(&item.source))
            || !super::personal_source::owned_install(
                session,
                user_id,
                &installed.json.0.to_value(),
            )
            .await?)
    {
        return Err(super::write_coordination::coordination_error(
            "INVALID_LOCAL_COMPLETION",
        ));
    }
    let row: Option<PluginDeviceInstallationRow> = session
        .fetch_optional(DEVICE_ROW_QUERY, (installed_id, device_id))
        .await?;
    if let Some(row) = &row
        && !confirmed_local
        && !source_preserved
        && auto_update_blocked(row, release_id)
    {
        return Ok(());
    }
    let (state, error_message) = device_install_state(result, item.as_ref());
    if item.is_none()
        && result.success
        && let Some(row) = &row
    {
        if row.state == "installed" && row.actual_release_id == release_id {
            return Ok(());
        }
        if row.state == "source"
            && row.desired_release_id == release_id
            && row.actual_release_id == 0
            && super::personal_source::owned_install(session, user_id, &installed.json.0.to_value())
                .await?
        {
            return Ok(());
        }
    }
    let Some(row) = row else {
        // `PluginDeviceInstallation(...)` plus `db.add`; the INSERT waits for
        // the session's dirty flush and keeps the model defaults.
        let now = Local::now().naive_local();
        flush.push_insert(DesiredInsert {
            installed_kind_id: installed_id,
            user_id,
            device_id: device_id.to_string(),
            release_id,
            actual_release_id: if confirmed_local && state == "installed" {
                release_id
            } else {
                0
            },
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
    if matches!(state, "installed" | "source") {
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
    } else if state == "source" {
        actual_release_id = 0;
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
        if item.status_text() == "source_preserved" {
            return ("source", None);
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
