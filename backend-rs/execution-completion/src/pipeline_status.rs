// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Derive parent Task status from a completed pipeline stage and its active Team.
use super::{sql, subtask_column};
use brz_mysql::{Json, MysqlResult, MysqlRow, MysqlTransaction};
use serde_json::{Map, Value, json};
use wegent_task_store::task_store_pipeline::{
    PipelineStage, completed_bot_identity, load_member_bot, managed_strategy, pipeline_stage,
};

/// The collaboration strategy's two decisions for one completion:
/// `get_task_status_on_subtask_complete` renders the status, and
/// `get_auto_advance_info` decides whether `_update_task_status_sync` schedules
/// the next pipeline turn (`app/services/adapters/collaboration_strategy.py`).
pub struct CollaborationStatus {
    pub status: String,
    pub progress: Option<i64>,
    pub auto_advance: bool,
}

/// `CollaborationStrategyFactory.get_strategy_for_task` plus
/// `get_task_status_on_subtask_complete` and `get_auto_advance_info`.
pub(super) async fn collaboration_status<T: MysqlTransaction>(
    mysql: &mut T,
    task_table: &str,
    task_id: i64,
    payload: &Map<String, Value>,
    subtask: &MysqlRow,
    subtask_status: &str,
    cancelling: bool,
) -> MysqlResult<CollaborationStatus> {
    // A real terminal event settles cancellation without scheduling another stage.
    if cancelling {
        return Ok(default_collaboration_status(subtask_status));
    }
    // `get_regular_active_task`: the exact task read the factory issues. Its
    // outcome decides whether the factory reads the task's Team at all.
    let regular_task_found = mysql
        .fetch_optional::<_, _, MysqlRow>(
            sql::regular_active_task_statement(task_table),
            (task_id,),
        )
        .await?
        .is_some();

    if !regular_task_found || subtask_status != "COMPLETED" || !payload.contains_key("spec") {
        return Ok(default_collaboration_status(subtask_status));
    }
    let team = strategy_team(mysql, regular_task_found, payload).await?;
    let snapshot = managed_strategy(&mut &mut *mysql, Some(payload), task_id).await?;
    let spec = snapshot.as_ref().or_else(|| team.as_ref()?.get("spec"));
    if let Some(spec) = spec.filter(|spec| spec["collaborationModel"] == "pipeline") {
        let bot_id = subtask_column::<Json<Value>>(subtask, "bot_ids")
            .and_then(|ids| ids.0.as_array()?.first()?.as_i64());
        let bot = match bot_id {
            Some(id) => completed_bot_identity(mysql, id).await?,
            None => None,
        };
        let stage = pipeline_stage(payload.get("spec"), spec, bot.as_ref(), snapshot.is_some());
        let owner = payload
            .get("spec")
            .and_then(|spec| spec.pointer("/teamRef/user_id"))
            .and_then(Value::as_i64);
        let next_available = match (&stage, team.is_some(), owner) {
            (PipelineStage::Advance(next), true, Some(owner)) => {
                load_member_bot(mysql, owner, &spec["members"][*next])
                    .await?
                    .is_some()
            }
            _ => team.is_some(),
        };
        return Ok(pipeline_status(stage, next_available));
    }
    Ok(default_collaboration_status(subtask_status))
}

fn pipeline_status(stage: PipelineStage, next_available: bool) -> CollaborationStatus {
    let (status, progress, auto_advance) = match stage {
        PipelineStage::Complete => ("COMPLETED", 100, false),
        PipelineStage::Advance(_) if next_available => ("PENDING", 0, true),
        PipelineStage::Confirm if next_available => ("PENDING_CONFIRMATION", 100, false),
        _ => ("FAILED", 100, false),
    };
    CollaborationStatus {
        status: status.to_owned(),
        progress: Some(progress),
        auto_advance,
    }
}

fn default_collaboration_status(subtask_status: &str) -> CollaborationStatus {
    CollaborationStatus {
        status: subtask_status.to_owned(),
        progress: matches!(subtask_status, "COMPLETED" | "CANCELLED").then_some(100),
        auto_advance: false,
    }
}

/// `CollaborationStrategyFactory.get_strategy_for_task`'s team read
/// (`app/services/adapters/collaboration_strategy.py:405-440`).
///
/// The factory answers `DefaultCollaborationStrategy` as soon as
/// `get_regular_active_task` finds no row, before `_get_team_from_task_ref` can
/// read `kinds`; a task outside the regular active state (a subscription task,
/// whose `is_active` is not the single active state) therefore issues no Team
/// read at all. The ref's `user_id` is what `_get_team_from_task_ref` keys the
/// read on, so a ref without one resolves no team either.
async fn strategy_team<T: MysqlTransaction>(
    mysql: &mut T,
    regular_task_found: bool,
    payload: &Map<String, Value>,
) -> MysqlResult<Option<Value>> {
    let team_ref = payload
        .get("spec")
        .filter(|_| regular_task_found)
        .and_then(|spec| spec.get("teamRef"))
        .and_then(Value::as_object);
    let Some(team_ref) = team_ref else {
        return Ok(None);
    };
    let name = team_ref
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let namespace = team_ref
        .get("namespace")
        .and_then(Value::as_str)
        .unwrap_or("default");
    let Some(owner) = team_ref.get("user_id").and_then(Value::as_i64) else {
        return Ok(None);
    };
    let team: Option<MysqlRow> = mysql
        .fetch_optional(sql::team_by_owner(), (owner, namespace, name))
        .await?;
    Ok(team
        .and_then(|row| row.get::<Json<Value>>("kinds_json").ok().flatten())
        .map(|json| json.0))
}

pub async fn settle_unavailable_on(
    tx: &mut impl MysqlTransaction,
    tasks: &str,
    subtasks: &str,
    task_id: i64,
    parent: i64,
    fenced_child: Option<i64>,
) -> brz_mysql::MysqlResult<Option<CollaborationStatus>> {
    let row: Option<MysqlRow> = tx
        .fetch_optional(
            wegent_task_store::task_store::task_for_update_first_statement(tasks),
            (task_id,),
        )
        .await?;
    let Some(Json(mut task)) = row
        .as_ref()
        .filter(|row| sql::is_active_task(row))
        .and_then(|row| crate::task_column::<Json<Value>>(row, "json"))
    else {
        return Ok(None);
    };
    let child = wegent_task_store::task_store_pipeline::pending_pipeline_child(&task, parent);
    // Another handoff may have been committed while acquiring the worker lease.
    let mut still_running = child.is_some() && child != fenced_child;
    if !still_running && sql::dispatchable_task_status(&task).is_some() {
        let latest = sql::latest_assistant_id(tx, subtasks, task_id).await?;
        let reason = wegent_task_store::task_store_pipeline::PIPELINE_UNAVAILABLE;
        let owns_unstarted_turn = if latest == Some(parent) {
            task["metadata"]["labels"][crate::delivery::Delivery::Callback.label(parent)]
                .is_string()
        } else if let Some(child) = child.filter(|id| Some(*id) == latest) {
            let updated = tx
                .execute(
                    format!(
                        "UPDATE {subtasks} SET status='FAILED', error_message=?, \
                    updated_at=NOW(6), completed_at=NOW(6) \
                    WHERE id=? AND task_id=? AND status='PENDING'"
                    ),
                    (reason, child, task_id),
                )
                .await?;
            if updated.rows_affected == 0 {
                still_running = tx.fetch_optional::<_, _, i64>(
                    format!("SELECT id FROM {subtasks} WHERE id=? AND task_id=? AND status='RUNNING'"),
                    (child, task_id),
                ).await?.is_some();
            }
            updated.rows_affected == 1
        } else {
            false
        };
        if owns_unstarted_turn {
            let now = chrono::Local::now().naive_local();
            task["status"]["status"] = json!("FAILED");
            task["status"]["progress"] = json!(100);
            task["status"]["errorMessage"] = json!(reason);
            let timestamp = json!(now.format("%Y-%m-%dT%H:%M:%S%.6f").to_string());
            task["status"]["completedAt"] = timestamp.clone();
            task["status"]["updatedAt"] = timestamp;
            wegent_task_store::clear_pending_pipeline_handoff(&mut task);
            tx.execute(
                sql::update_task_json_statement(tasks),
                (
                    wegent_python_compat::py_json::python_dumps(&task),
                    now.format("%Y-%m-%d %H:%M:%S%.6f").to_string(),
                    task_id,
                ),
            )
            .await?;
        }
    }
    Ok(task["status"]["status"]
        .as_str()
        .map(|status| CollaborationStatus {
            status: status.to_owned(),
            progress: task["status"]["progress"].as_i64(),
            auto_advance: still_running,
        }))
}

#[cfg(test)]
#[path = "collaboration_team_tests.rs"]
mod collaboration_team_tests;
