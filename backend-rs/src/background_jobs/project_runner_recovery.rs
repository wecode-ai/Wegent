//! Explicit recovery of rejected assignments, without moving live work.

use super::super::robot::model::{COLUMNS, Execution};
use crate::plugins_marketplace::query::PluginQuery;
use anyhow::Result;

pub(crate) fn original_session(execution: &Execution) -> bool {
    !execution.runtime_device_id.is_empty()
        && execution.intent()["runtime_request"]["newSession"] == false
}

pub(crate) async fn session_matches_on(
    query: &mut impl PluginQuery,
    execution: &Execution,
    device_id: i64,
) -> Result<bool> {
    if !original_session(execution) {
        return Ok(true);
    }
    let source = crate::device_identity::resolve_owned_device_alias_on(
        query,
        execution.executor_owner_user_id,
        &execution.runtime_device_id,
    )
    .await?;
    Ok(source.is_some_and(|device| device.id == device_id))
}

pub(crate) async fn available_on(
    query: &mut impl PluginQuery,
    issue: &str,
    exclude: i64,
) -> Result<bool> {
    let rows: Vec<Execution> = query.fetch_all(
        format!("SELECT {COLUMNS} FROM loop_item_executions WHERE loop_item_id=? AND id<>? AND status IN ('queued','pending_approval','claimed','running','cancel_requested')"),
        (issue, exclude),
    ).await?;
    Ok(rows.iter().all(Execution::assignment_pending))
}

pub(crate) async fn permits_on(
    query: &mut impl PluginQuery,
    execution: &Execution,
    bound: &str,
) -> Result<bool> {
    let context = execution.context();
    // Manual group dispatches also have internal run IDs.
    let manual_group = context["dispatch_kind"] == "collaboration_group"
        && context["assignment_key"].as_str().is_some_and(|key| {
            !key.is_empty()
                && execution.automation_run_id == format!("collaboration-group:{key}")
                && context["run_id"] == format!("collaboration-group:{key}")
        });
    if execution.automatic() && !manual_group
        || execution.selection()["runner_routing"]["recovery_from_environment_id"] != bound
    {
        return Ok(false);
    }
    available_on(query, &execution.loop_item_id, execution.id).await
}
