// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The task-status update `_update_task_status_sync` performs after a
//! completion callback (`app/services/chat/storage/db.py`). Split from
//! [`persist`](super) so the file stays within the source-size bound.
use brz_mysql::{Json, Mysql, MysqlResult, MysqlRow, MysqlTransaction};
use brz_redis::Redis;
use serde_json::{Value, json};

use super::sql;
use super::{
    Completion, collaboration_status, complete_task_model, local_datetime, local_isoformat,
    render_task_crd, subtask_column, task_column,
};
use crate::internal_callback::py_json::python_dumps;

/// `_update_task_status_sync`'s `try/except` around the status reads
/// (`app/services/chat/storage/db.py:207,285-287`): a store failure logs the
/// failing read and the caller returns before performing any write. The failure
/// never propagates into the callback response path.
pub(crate) fn read_status<T>(
    result: MysqlResult<T>,
    task_id: i64,
    read: &'static str,
) -> Option<T> {
    match result {
        Ok(value) => Some(value),
        Err(error) => {
            tracing::error!(%error, task_id, read, "callback task status read failed");
            None
        }
    }
}

pub(crate) async fn update_task_status_on<M: Mysql, R: Redis, T: MysqlTransaction>(
    ctx: &Completion<'_, M, R>,
    mysql: &mut T,
    task_id: i64,
    changed_subtask_id: i64,
) -> bool {
    // `task_store.get_task_by_states(...).first()`: the active two-state task
    // read through the ORM's labeled projection, with no row lock.
    let task: Option<MysqlRow> = read_status(
        mysql
            .fetch_optional(
                sql::active_task_projection_statement(ctx.tables.tasks),
                (task_id,),
            )
            .await,
        task_id,
        "task",
    )
    .flatten();
    let Some(task) = task else {
        return false;
    };
    let owner_user_id = task_column::<i64>(&task, "user_id").unwrap_or(0);
    let task_json: Option<Value> = task_column::<Json<Value>>(&task, "json").map(|json| json.0);

    // `list_assistant_by_task`'s owner guard, then the ordered listing.
    // `_update_task_status_sync` wraps the whole block in `try/except`: a
    // failed read logs and aborts before any later write.
    let Some(_owner) = read_status::<Vec<MysqlRow>>(
        mysql
            .fetch_all(
                sql::owner_matches_task_id_statement(ctx.tables.tasks),
                (task_id, owner_user_id),
            )
            .await,
        task_id,
        "owner_guard",
    ) else {
        return false;
    };
    let Some(subtasks) = read_status(
        mysql
            .fetch_all(sql::assistant_subtasks(ctx.tables), (task_id,))
            .await,
        task_id,
        "assistant_subtasks",
    ) else {
        return false;
    };
    let Some(last) = subtasks.last() else {
        return false;
    };
    let last_status = subtask_column::<String>(last, "status").unwrap_or_default();
    // `list_assistant_by_task` labels its columns too, so the last subtask's
    // result — the payload `_apply_status_update` writes into the task CRD's
    // `status.result` — is decoded positionally.
    let mut last_result: Option<Value> =
        subtask_column::<Json<Value>>(last, "result").map(|json| json.0);

    let found = subtasks
        .iter()
        .any(|row| subtask_column::<i64>(row, "id") == Some(changed_subtask_id));
    let changed: Option<MysqlRow> = if !found && last_result.is_none() {
        // `read_status` returns `None` on a store failure; abort before writing
        // rather than treating the failure as "no row".
        let Some(row) = read_status(
            mysql
                .fetch_optional(sql::subtask_by_id(ctx.tables), (changed_subtask_id,))
                .await,
            task_id,
            "changed_subtask",
        ) else {
            return false;
        };
        row
    } else {
        None
    };
    if let Some(row) = changed {
        last_result = subtask_column::<Json<Value>>(&row, "result").map(|json| json.0);
    }

    let Some(Value::Object(mut payload)) = task_json else {
        return false;
    };
    let Some(Value::Object(status_object)) = payload.get("status").cloned() else {
        return false;
    };
    let Some(decision) =
        collaboration_status(ctx, mysql, task_id, &payload, last, &last_status).await
    else {
        return false;
    };
    let new_status = decision.status;
    let progress = decision.progress;

    let now = local_isoformat();
    let mut updated = status_object;
    updated.insert("status".into(), Value::String(new_status.clone()));
    if let Some(result) = last_result {
        updated.insert("result".into(), result);
    }
    if let Some(progress) = progress {
        updated.insert("progress".into(), json!(progress));
    }
    if matches!(
        new_status.as_str(),
        "COMPLETED" | "CANCELLED" | "PENDING_CONFIRMATION"
    ) {
        updated.insert("completedAt".into(), Value::String(now.clone()));
    }
    if last_status == "FAILED" {
        updated.insert(
            "errorMessage".into(),
            subtask_column::<String>(last, "error_message").map_or(Value::Null, Value::String),
        );
    }
    updated.insert("updatedAt".into(), Value::String(now.clone()));
    payload.insert("status".into(), Value::Object(updated));

    complete_task_model(&mut payload);
    let json_text = python_dumps(&Value::Object(render_task_crd(payload)));
    let row_updated_at = local_datetime();
    let sql = sql::update_task_json_statement(ctx.tables.tasks);
    // A single statement runs on the pooled connection's autocommit; no
    // explicit transaction or COMMIT is needed. A failed write aborts the
    // source's `try/except` before it can hand back an advance intent.
    if let Err(failure) = mysql
        .execute(sql, (json_text, row_updated_at, task_id))
        .await
    {
        tracing::warn!(%failure, "callback task update failed");
        return false;
    }
    decision.auto_advance
}
