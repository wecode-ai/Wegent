// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Subtask cancel-flow operations for the single-table [`DefaultTaskStore`].
//!
//! `POST /api/v1/responses/{response_id}/cancel` resolves the running
//! assistant subtask, reads its partial streamed content, and writes the
//! terminal subtask state. These operations belong to the source
//! `SubtaskStore`; they live here as free functions so the task/subtask read
//! trait file stays within the repository's file-size bound, and the trait
//! methods on `DefaultTaskStore` delegate to them.
use brz_mysql::{Mysql, MysqlResult, MysqlRow};

use crate::task_store::{
    DefaultTaskStore, SUBTASKS_TABLE, latest_assistant_for_user_by_statuses_statement,
    latest_subtask_ref_statement, running_assistant_for_user_statement,
    subtask_by_id_refresh_statement, subtask_ref_statement, update_subtask_cancelled_statement,
    update_subtask_completed_statement,
};

/// `subtask_store.get_by_id`: one subtask's full row.
pub(super) async fn get_subtask_ref<M: Mysql>(
    store: &DefaultTaskStore<M>,
    subtask_id: i64,
) -> MysqlResult<Option<MysqlRow>> {
    store
        .mysql
        .fetch_optional(subtask_ref_statement(SUBTASKS_TABLE), (subtask_id,))
        .await
}

/// `subtask_store.list_by_user` (limit 1): the newest subtask of one user.
pub(super) async fn latest_subtask_ref_for_user<M: Mysql>(
    store: &DefaultTaskStore<M>,
    user_id: i32,
) -> MysqlResult<Option<MysqlRow>> {
    store
        .mysql
        .fetch_optional(latest_subtask_ref_statement(SUBTASKS_TABLE), (user_id,))
        .await
}

/// `SubtaskStore.get_latest_assistant_for_user_by_statuses`.
pub(super) async fn latest_assistant_for_user_by_statuses<M: Mysql>(
    store: &DefaultTaskStore<M>,
    task_id: i64,
    user_id: i32,
    statuses: &[&str],
) -> MysqlResult<Option<MysqlRow>> {
    if statuses.is_empty() {
        return Ok(None);
    }
    store
        .mysql
        .fetch_optional(
            latest_assistant_for_user_by_statuses_statement(SUBTASKS_TABLE, statuses),
            (task_id, user_id),
        )
        .await
}

/// `subtask_store.update_fields` for the cancel flow: mark one subtask
/// COMPLETED with its partial result.
pub(super) async fn update_subtask_completed<M: Mysql>(
    store: &DefaultTaskStore<M>,
    subtask_id: i64,
    result_json: &str,
    updated_at: &str,
    completed_at: &str,
) -> MysqlResult<u64> {
    store
        .mysql
        .execute(
            update_subtask_completed_statement(SUBTASKS_TABLE),
            (
                "COMPLETED",
                100,
                result_json,
                updated_at,
                completed_at,
                subtask_id,
            ),
        )
        .await
        .map(|outcome| outcome.rows_affected)
}

/// `subtask_store.get_running_assistant_for_user`: the caller's running
/// assistant subtask of one task.
pub(super) async fn running_assistant_for_user<M: Mysql>(
    store: &DefaultTaskStore<M>,
    task_id: i64,
    user_id: i64,
) -> MysqlResult<Option<MysqlRow>> {
    store
        .mysql
        .fetch_optional(
            running_assistant_for_user_statement(SUBTASKS_TABLE),
            (task_id, user_id),
        )
        .await
}

/// `subtask_store.update_fields` for the cancel flow: mark one subtask
/// CANCELLED with progress 100.
pub(super) async fn update_subtask_cancelled<M: Mysql>(
    store: &DefaultTaskStore<M>,
    subtask_id: i64,
    updated_at: &str,
    completed_at: &str,
    reset_error_message: bool,
) -> MysqlResult<u64> {
    let statement = update_subtask_cancelled_statement(SUBTASKS_TABLE, reset_error_message);
    let outcome = if reset_error_message {
        store
            .mysql
            .execute(
                statement,
                ("CANCELLED", 100, "", updated_at, completed_at, subtask_id),
            )
            .await?
    } else {
        store
            .mysql
            .execute(
                statement,
                ("CANCELLED", 100, updated_at, completed_at, subtask_id),
            )
            .await?
    };
    Ok(outcome.rows_affected)
}

/// `db.refresh(subtask)`: re-read one subtask row by primary key.
pub(super) async fn refresh_subtask<M: Mysql>(
    store: &DefaultTaskStore<M>,
    subtask_id: i64,
) -> MysqlResult<Option<MysqlRow>> {
    store
        .mysql
        .fetch_optional(
            subtask_by_id_refresh_statement(SUBTASKS_TABLE),
            (subtask_id,),
        )
        .await
}

/// `task_owner_matches`: whether the owner owns the task, or is the only user
/// its subtasks belong to.
pub(super) async fn task_owner_matches<M: Mysql>(
    store: &DefaultTaskStore<M>,
    task_id: i64,
    owner_user_id: i64,
) -> MysqlResult<bool> {
    use crate::task_store::TASKS_TABLE;
    use crate::task_store_statements::{
        distinct_subtask_owners_statement, owner_matches_task_id_statement,
    };
    let row: Option<MysqlRow> = store
        .mysql
        .fetch_optional(
            owner_matches_task_id_statement(TASKS_TABLE),
            (task_id, owner_user_id),
        )
        .await?;
    if row.is_some() {
        return Ok(true);
    }
    let owners: Vec<MysqlRow> = store
        .mysql
        .fetch_all(
            distinct_subtask_owners_statement(SUBTASKS_TABLE),
            (task_id,),
        )
        .await?;
    if owners.len() != 1 {
        return Ok(false);
    }
    Ok(owners[0].get_required::<i64>("user_id")? == owner_user_id)
}

/// `_queue_bulk_status_metrics` plus `mark_task_subtasks_deleted`: the
/// failed-assistant read, the `synchronize_session='fetch'` id read, then the
/// bulk update. The FAILED ASSISTANT rows and the queue-time clock feed the
/// after-commit task-run metric publish.
pub(super) async fn mark_subtasks_deleted<M: Mysql>(
    store: &DefaultTaskStore<M>,
    task_id: i64,
    owner_user_id: i64,
    updated_at: &str,
) -> MysqlResult<crate::task_store::DeletedSubtasks> {
    use crate::task_store::DeletedSubtasks;
    use crate::task_store_statements::{
        failed_assistant_subtasks_statement, mark_subtasks_deleted_statement,
        subtask_ids_for_update_statement,
    };
    // `queue_bulk_subtask_status_metrics` reads its one `state_changed_at`
    // clock before iterating the queued rows.
    let queued_at = chrono::Local::now().naive_local();
    let failed_assistant: Vec<MysqlRow> = store
        .mysql
        .fetch_all(
            failed_assistant_subtasks_statement(SUBTASKS_TABLE, true),
            (task_id, owner_user_id),
        )
        .await?;
    let _ids: Vec<MysqlRow> = store
        .mysql
        .fetch_all(
            subtask_ids_for_update_statement(SUBTASKS_TABLE, true),
            (task_id, owner_user_id),
        )
        .await?;
    let sql = mark_subtasks_deleted_statement(SUBTASKS_TABLE, true);
    let rows_affected = store
        .mysql
        .execute(sql, (true, "DELETE", updated_at, task_id, owner_user_id))
        .await
        .map(|outcome| outcome.rows_affected)?;
    Ok(DeletedSubtasks {
        rows_affected,
        failed_assistant,
        queued_at,
    })
}
