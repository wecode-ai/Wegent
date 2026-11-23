// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The desired-install pending flush used by the device capability sync.

use super::*;

/// One deferred write collected during `ensure_pending_for_device`'s iteration
/// and emitted at the source's `db.commit()` flush.
#[derive(Default)]
pub(super) struct PendingFlush {
    /// `autoflush=False`: the guard runs once for the session's flush, which
    /// happens whenever a row was assigned (even to an equal value) or a row
    /// was added, regardless of whether any SQL is emitted.
    pub(super) assigned: bool,
    /// `db.add(...)` INSERTs in iteration order; SQLAlchemy's unit of work
    /// processes one mapper's INSERTs before its UPDATEs.
    pub(super) inserts: Vec<DesiredInsert>,
    /// Dirty-column UPDATEs keyed by the identity-map row index.
    pub(super) updates: Vec<(usize, Vec<String>)>,
}

/// One `db.add(PluginDeviceInstallation(...))` pending INSERT.
pub(super) struct DesiredInsert {
    pub(super) installed_kind_id: i64,
    pub(super) user_id: i64,
    pub(super) device_id: String,
    pub(super) release_id: i64,
    pub(super) now: chrono::NaiveDateTime,
}

/// `(last_sync_at, updated_at)` for a newly materialized pending row.
///
/// Source `_ensure_desired_install_pending` adds
/// `PluginDeviceInstallation(..., state="pending")` without setting a sync
/// timestamp, so SQLAlchemy applies the column defaults
/// (`app/models/plugin_marketplace.py`): `last_sync_at` uses `EPOCH_TIME`
/// ("epoch means never synced") while `updated_at` uses `datetime.now`.
pub(super) fn pending_row_times(
    now: chrono::NaiveDateTime,
) -> (chrono::NaiveDateTime, chrono::NaiveDateTime) {
    (EPOCH, now)
}

impl PendingFlush {
    /// Emit the collected INSERTs (iteration order) and UPDATEs (identity-map
    /// order, primary key ascending), then the caller's COMMIT. The UPDATE
    /// collection is sorted by identity-map position first: the iteration may
    /// visit rows in any order, but the source's flush follows the identity
    /// map populated by the leading read.
    /// Run the source's flush boundary: guard first (when the session is
    /// dirty), then emit the recorded INSERT/UPDATE statements.
    pub(super) async fn flush_with_guard<Q>(
        &mut self,
        session: &mut Q,
        identity_map: &[PluginDeviceInstallationRow],
        guard: Option<&dyn wegent_plugin_store::LeaseCheck>,
    ) -> MysqlResult<()>
    where
        Q: MysqlQuery,
    {
        if let Some(guard) = guard
            && self.assigned
        {
            guard.check().await?;
        }
        self.emit(session, identity_map).await
    }

    pub(super) async fn emit<Q>(
        &mut self,
        session: &mut Q,
        identity_map: &[PluginDeviceInstallationRow],
    ) -> MysqlResult<()>
    where
        Q: MysqlQuery,
    {
        self.updates.sort_by_key(|(index, _)| *index);
        for insert in &self.inserts {
            let (last_sync_at, updated_at) = pending_row_times(insert.now);
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
                        last_sync_at,
                        updated_at,
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
pub(super) fn flush_timestamp() -> String {
    Local::now()
        .naive_local()
        .format("%Y-%m-%d %H:%M:%S%.6f")
        .to_string()
}
