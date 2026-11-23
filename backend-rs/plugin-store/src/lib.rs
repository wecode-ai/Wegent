// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Identity-based reconciliation of plugin installation rows.

#![forbid(unsafe_code)]

use brz_mysql::{FromMysqlRow, Mysql, MysqlResult, MysqlTransaction};
use chrono::NaiveDateTime;
use std::collections::{HashMap, hash_map::Entry};
use wegent_backend_persistence::mysql_query::MysqlQuery;
use wegent_device_identity::plugin_device_id_on;

/// Row abstraction for `coalesce_plugin_device_rows`, letting the marketplace
/// and installed-plugin APIs share the source coalescing contract while each
/// keeps its own recorded column projection.
pub trait DeviceRow {
    fn user_id(&self) -> i64;
    fn device_id(&self) -> &str;
    fn installed_kind_id(&self) -> i64;
    fn last_sync_at(&self) -> NaiveDateTime;
    fn updated_at(&self) -> NaiveDateTime;
}

/// Source `app/services/device/runtime_route.py::_state_order`.
///
/// `datetime.min` is the source's fallback for null timestamps; the DB
/// columns are `NOT NULL`, so `NaiveDateTime` is always present.
fn state_order<R: DeviceRow>(row: &R, canonical_id: &str) -> (NaiveDateTime, NaiveDateTime, bool) {
    (
        row.last_sync_at(),
        row.updated_at(),
        row.device_id() == canonical_id,
    )
}

/// Source `app/services/plugin_device_identity.py::coalesce_plugin_device_rows`.
///
/// Returns `(installed_kind_id, canonical_id) -> selected_row` as an
/// insertion-ordered vector, mirroring the source's Python dict (which
/// preserves insertion order). The identity cache mirrors the source: one
/// `plugin_device_id` call per unique `(user_id, device_id)` pair.
pub async fn coalesce_plugin_device_rows<M, R>(
    mysql: &M,
    rows: Vec<R>,
) -> MysqlResult<Vec<((i64, String), R)>>
where
    M: Mysql,
    R: DeviceRow + Clone,
{
    let mut query = mysql;
    coalesce_plugin_device_rows_on(&mut query, rows).await
}

/// `coalesce_plugin_device_rows` on a borrowed session handle.
pub async fn coalesce_plugin_device_rows_on<Q, R>(
    query: &mut Q,
    rows: Vec<R>,
) -> MysqlResult<Vec<((i64, String), R)>>
where
    Q: MysqlQuery,
    R: DeviceRow + Clone,
{
    let mut identities: HashMap<(i64, String), String> = HashMap::new();
    for row in &rows {
        let key = (row.user_id(), row.device_id().to_string());
        if let Entry::Vacant(entry) = identities.entry(key) {
            let canonical = plugin_device_id_on(query, row.user_id(), row.device_id()).await?;
            entry.insert(canonical);
        }
    }
    Ok(coalesce_plugin_device_rows_resolved(
        rows,
        |user_id, device_id| identities[&(user_id, device_id.to_string())].clone(),
    ))
}

/// Select the newest canonical-device row without performing any I/O.
pub fn coalesce_plugin_device_rows_resolved<R, F>(
    rows: Vec<R>,
    mut resolve: F,
) -> Vec<((i64, String), R)>
where
    R: DeviceRow,
    F: FnMut(i64, &str) -> String,
{
    let mut selected: Vec<((i64, String), R)> = Vec::new();
    let mut seen: HashMap<(i64, String), usize> = HashMap::new();
    for row in rows {
        let canonical_id = resolve(row.user_id(), row.device_id());
        let key = (row.installed_kind_id(), canonical_id.clone());
        if let Some(&index) = seen.get(&key) {
            if state_order(&row, &canonical_id) > state_order(&selected[index].1, &canonical_id) {
                selected[index].1 = row;
            }
        } else {
            seen.insert(key.clone(), selected.len());
            selected.push((key, row));
        }
    }
    selected
}

/// Full `plugin_device_installations` row used by `reconcile_plugin_device_rows`
/// (`app/models/plugin_marketplace.py::PluginDeviceInstallation`). The aliases
/// mirror SQLAlchemy's mapped-column projection.
#[derive(Debug, Clone, FromMysqlRow)]
pub struct PluginDeviceInstallationRow {
    #[mysql(rename = "plugin_device_installations_id")]
    pub id: i64,
    #[mysql(rename = "plugin_device_installations_installed_kind_id")]
    pub installed_kind_id: i64,
    #[mysql(rename = "plugin_device_installations_user_id")]
    pub user_id: i64,
    #[mysql(rename = "plugin_device_installations_device_id")]
    pub device_id: String,
    #[mysql(rename = "plugin_device_installations_desired_release_id")]
    pub desired_release_id: i64,
    #[mysql(rename = "plugin_device_installations_actual_release_id")]
    pub actual_release_id: i64,
    #[mysql(rename = "plugin_device_installations_state")]
    pub state: String,
    #[mysql(rename = "plugin_device_installations_error_code")]
    pub error_code: String,
    #[mysql(rename = "plugin_device_installations_error_message")]
    pub error_message: String,
    #[mysql(rename = "plugin_device_installations_attempt_count")]
    pub attempt_count: i64,
    #[mysql(rename = "plugin_device_installations_last_sync_at")]
    pub last_sync_at: NaiveDateTime,
    #[mysql(rename = "plugin_device_installations_updated_at")]
    pub updated_at: NaiveDateTime,
}

impl DeviceRow for PluginDeviceInstallationRow {
    fn user_id(&self) -> i64 {
        self.user_id
    }

    fn device_id(&self) -> &str {
        &self.device_id
    }

    fn installed_kind_id(&self) -> i64 {
        self.installed_kind_id
    }

    fn last_sync_at(&self) -> NaiveDateTime {
        self.last_sync_at
    }

    fn updated_at(&self) -> NaiveDateTime {
        self.updated_at
    }
}

/// `reconcile_plugin_device_rows` needs the primary key to delete superseded
/// alias rows and to update the retained rows' canonical `device_id`.
pub trait ReconcileRow: DeviceRow {
    fn id(&self) -> i64;
}

impl ReconcileRow for PluginDeviceInstallationRow {
    fn id(&self) -> i64 {
        self.id
    }
}

/// `db.query(PluginDeviceInstallation).filter(user_id=...).all()`: every
/// mapped column with its SQLAlchemy alias. The source does not lock these
/// rows; `reconcile_plugin_device_rows` serializes writers with the account
/// lease instead.
const RECONCILE_SELECT_QUERY: &str = "SELECT plugin_device_installations.id AS plugin_device_installations_id, \
     plugin_device_installations.installed_kind_id AS plugin_device_installations_installed_kind_id, \
     plugin_device_installations.user_id AS plugin_device_installations_user_id, \
     plugin_device_installations.device_id AS plugin_device_installations_device_id, \
     plugin_device_installations.desired_release_id AS plugin_device_installations_desired_release_id, \
     plugin_device_installations.actual_release_id AS plugin_device_installations_actual_release_id, \
     plugin_device_installations.state AS plugin_device_installations_state, \
     plugin_device_installations.error_code AS plugin_device_installations_error_code, \
     plugin_device_installations.error_message AS plugin_device_installations_error_message, \
     plugin_device_installations.attempt_count AS plugin_device_installations_attempt_count, \
     plugin_device_installations.last_sync_at AS plugin_device_installations_last_sync_at, \
     plugin_device_installations.updated_at AS plugin_device_installations_updated_at \
     FROM plugin_device_installations \
     WHERE plugin_device_installations.user_id = ?";

/// `db.delete(row)`: SQLAlchemy deletes by primary key.
const DELETE_ROW_QUERY: &str =
    "DELETE FROM plugin_device_installations WHERE plugin_device_installations.id = ?";

/// `row.device_id = canonical_id`: the flush of the rewritten canonical alias.
const UPDATE_DEVICE_ID_QUERY: &str =
    "UPDATE plugin_device_installations SET device_id=? WHERE plugin_device_installations.id = ?";

/// Source `app/services/plugin_device_identity.py::reconcile_plugin_device_rows`.
///
/// Converges legacy alias rows within the caller's write transaction. It reads
/// the user's rows, coalesces them to one row per
/// `(installed_kind_id, canonical device)`, deletes the superseded alias rows,
/// then rewrites each retained row's `device_id` to its canonical id. Identity
/// reads go through the pooled handle (`mysql`) because
/// `coalesce_plugin_device_rows` resolves `plugin_device_id` per unique
/// `(user_id, device_id)` pair, exactly like the source.
///
/// Returns the retained rows in primary-key load order. The source session's
/// identity map keeps exactly these rows in that order, and a later
/// `db.commit()` flush (e.g. `ensure_pending_for_device`'s pending UPDATEs)
/// emits its UPDATE statements in this order, not in the caller's iteration
/// order.
pub async fn reconcile_plugin_device_rows<T, M, R>(
    mut transaction: &mut T,
    mysql: &M,
    user_id: i64,
) -> MysqlResult<Vec<R>>
where
    T: MysqlTransaction,
    M: Mysql,
    R: ReconcileRow + Clone + FromMysqlRow + Send,
{
    let rows: Vec<R> = transaction
        .fetch_all(RECONCILE_SELECT_QUERY, (user_id,))
        .await?;
    let selected = coalesce_plugin_device_rows(mysql, rows.clone()).await?;
    converge_plugin_device_rows(&mut transaction, rows, &selected, None).await
}

/// `reconcile_plugin_device_rows` on one borrowed session handle.
///
/// The source resolves and rewrites the rows inside one request session;
/// callers that already own that session's transaction pass it here
/// so the identity reads stay on the pinned connection.
pub trait LeaseCheck: Sync {
    fn check<'a>(
        &'a self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = MysqlResult<()>> + Send + 'a>>;
}

pub async fn reconcile_plugin_device_rows_for_installs_on<Q, R>(
    query: &mut Q,
    user_id: i64,
    guard: Option<&dyn LeaseCheck>,
    installed_ids: Option<&[i64]>,
) -> MysqlResult<Vec<R>>
where
    Q: MysqlQuery,
    R: ReconcileRow + Clone + FromMysqlRow + Send,
{
    let mut rows: Vec<R> = query.fetch_all(RECONCILE_SELECT_QUERY, (user_id,)).await?;
    rows.retain(|row| installed_ids.is_none_or(|ids| ids.contains(&row.installed_kind_id())));
    let selected = coalesce_plugin_device_rows_on(query, rows.clone()).await?;
    converge_plugin_device_rows(query, rows, &selected, guard).await
}

/// Delete the superseded alias rows and rewrite each retained row's
/// `device_id`, then return the retained rows in primary-key load order.
async fn converge_plugin_device_rows<Q, R>(
    query: &mut Q,
    rows: Vec<R>,
    selected: &[((i64, String), R)],
    guard: Option<&dyn LeaseCheck>,
) -> MysqlResult<Vec<R>>
where
    Q: MysqlQuery,
    R: ReconcileRow + Clone + Send,
{
    let retained: std::collections::HashSet<i64> =
        selected.iter().map(|(_, row)| row.id()).collect();
    // First flush boundary: the alias DELETE batch.
    if let Some(guard) = guard
        && rows.iter().any(|row| !retained.contains(&row.id()))
    {
        guard.check().await?;
    }
    for row in &rows {
        if !retained.contains(&row.id()) {
            query.execute(DELETE_ROW_QUERY, (row.id(),)).await?;
        }
    }
    // Second flush boundary: the canonical `device_id` assignment, which marks
    // every selected row dirty even when the value does not change.
    if let Some(guard) = guard
        && !selected.is_empty()
    {
        guard.check().await?;
    }
    for ((_, canonical_id), row) in selected {
        if row.device_id() != canonical_id {
            query
                .execute(UPDATE_DEVICE_ID_QUERY, (canonical_id.as_str(), row.id()))
                .await?;
        }
    }
    // Identity-map order after the deletes and rewrites: the retained rows in
    // primary-key load order.
    Ok(rows
        .into_iter()
        .filter(|row| retained.contains(&row.id()))
        .collect())
}

#[cfg(test)]
mod tests;
