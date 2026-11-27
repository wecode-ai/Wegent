//! Reuse ordinary receipt writes after a local plan's revision was checked.
use super::*;
use crate::plugins_installed::plugin_sync_protocol::{
    PluginSyncState, merge_local_receipt_watermark, plugin_snapshot_watermark,
};

#[allow(clippy::too_many_arguments)]
pub(in crate::plugins_installed) async fn record_local_completion<Q: MysqlQuery>(
    query: &mut Q,
    user_id: i64,
    installed: &InstalledKindRow,
    result: &SyncResult,
    generation: i64,
    state: &PluginSyncState,
    guard: &dyn wegent_plugin_store::LeaseCheck,
) -> MysqlResult<()> {
    // Source confirmation owns alias cleanup even when no other devices need
    // background preparation. The caller already fenced the current intent.
    wegent_plugin_store::reconcile_plugin_device_rows_for_installs_on::<
        _,
        PluginDeviceInstallationRow,
    >(query, user_id, Some(guard), Some(&[installed.id]))
    .await?;
    let mut flush = PendingFlush::default();
    if installed.is_active {
        record_installation_result(
            query,
            user_id,
            &result.device_id,
            installed,
            integer_release_id(&installed.json.0.to_value()).unwrap_or(0),
            result,
            result.plugins.first().cloned(),
            &mut flush,
            true,
        )
        .await?;
    } else {
        let row: Option<PluginDeviceInstallationRow> = query
            .fetch_optional(DEVICE_ROW_QUERY, (installed.id, result.device_id.as_str()))
            .await?;
        if let Some(row) = row {
            flush.push_delete(row.id);
        }
    }
    guard.check().await?;
    // Lock dependent rows before taking the shared account-state row lock.
    flush.lock_device_rows(query).await?;
    if !flush.writes.is_empty()
        || generation > plugin_snapshot_watermark(&state.json, &result.device_id, installed.id)
    {
        merge_local_receipt_watermark(
            query,
            user_id,
            state,
            &result.device_id,
            installed.id,
            generation,
        )
        .await?;
    }
    flush.flush_with_guard(query, None).await
}
