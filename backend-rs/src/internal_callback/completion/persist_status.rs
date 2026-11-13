// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The task-status update `_update_task_status_sync` performs after a
//! completion callback (`app/services/chat/storage/db.py`). Split from
//! [`persist`](super) so the file stays within the source-size bound.
use brz_mysql::{Json, MysqlError, MysqlResult, MysqlRow, MysqlTransaction};
use serde_json::{Value, json};

use super::sql;
use super::{
    CollaborationStatus, Delivery, collaboration_status, complete_task_model, delivery,
    local_datetime, local_isoformat, render_task_crd, subtask_column, task_column,
};
use crate::internal_callback::py_json::python_dumps;

pub(crate) async fn update_task_status_on<T: MysqlTransaction>(
    tables: sql::Tables,
    mysql: &mut T,
    task_id: i64,
    changed_subtask_id: i64,
) -> MysqlResult<Option<bool>> {
    let Some(task) = lock_task(mysql, tables.tasks, task_id).await? else {
        return Ok(None);
    };
    Ok(update_locked_task_status(
        tables,
        mysql,
        task,
        task_id,
        changed_subtask_id,
        None,
        false,
        None,
    )
    .await?
    .map(|task| task.auto_advance))
}

pub(super) async fn lock_task<T: MysqlTransaction>(
    mysql: &mut T,
    task_table: &str,
    task_id: i64,
) -> MysqlResult<Option<MysqlRow>> {
    let sql = format!(
        "{} FOR UPDATE",
        sql::active_task_projection_statement(task_table)
    );
    mysql.fetch_optional(sql, (task_id,)).await
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn update_locked_task_status<T: MysqlTransaction>(
    tables: sql::Tables,
    mysql: &mut T,
    task: MysqlRow,
    task_id: i64,
    changed_subtask_id: i64,
    pending_delivery: Option<(Delivery, Option<&Value>)>,
    terminal: bool,
    required_status: Option<&str>,
) -> MysqlResult<Option<CollaborationStatus>> {
    let task_table = tables.tasks;
    let owner_user_id = task_column::<i64>(&task, "user_id").ok_or(MysqlError::RowNotFound)?;
    let task_json: Option<Value> = task_column::<Json<Value>>(&task, "json").map(|json| json.0);

    let _owner: Vec<MysqlRow> = mysql
        .fetch_all(
            sql::owner_matches_task_id_statement(task_table),
            (task_id, owner_user_id),
        )
        .await?;
    let subtasks = crate::task_store_listing::order_assistant_subtasks(
        mysql
            .fetch_all(sql::assistant_subtasks(tables), (task_id,))
            .await?,
    )?;
    let Some(last) = subtasks.last() else {
        return Ok(None);
    };
    let last_status = subtask_column::<String>(last, "status").unwrap_or_default();
    if required_status.is_some_and(|required| {
        last_status != required || subtask_column::<i64>(last, "id") != Some(changed_subtask_id)
    }) {
        return Ok(None);
    }
    // `list_assistant_by_task` labels its columns too, so the last subtask's
    // result — the payload `_apply_status_update` writes into the task CRD's
    // `status.result` — is decoded positionally.
    let mut last_result: Option<Value> =
        subtask_column::<Json<Value>>(last, "result").map(|json| json.0);

    let found = subtasks
        .iter()
        .any(|row| subtask_column::<i64>(row, "id") == Some(changed_subtask_id));
    let changed: Option<MysqlRow> = if !found && last_result.is_none() {
        mysql
            .fetch_optional(sql::subtask_by_id(tables), (changed_subtask_id,))
            .await?
    } else {
        None
    };
    if let Some(row) = changed {
        last_result = subtask_column::<Json<Value>>(&row, "result").map(|json| json.0);
    }

    let Some(Value::Object(mut payload)) = task_json else {
        return Err(MysqlError::InvalidQuery {
            reason: "Task JSON must be an object".into(),
        });
    };
    let Some(Value::Object(status_object)) = payload.get("status").cloned() else {
        return Err(MysqlError::InvalidQuery {
            reason: "Task status must be an object".into(),
        });
    };
    let decision =
        collaboration_status(mysql, task_table, task_id, &payload, last, &last_status).await?;
    let new_status = &decision.status;
    let progress = decision.progress;

    if new_status == "RUNNING"
        && matches!(
            status_object.get("status").and_then(Value::as_str),
            Some("CANCELLING" | "CANCELLED")
        )
    {
        return Ok(None);
    }
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
    let mut document = Value::Object(render_task_crd(payload));
    if terminal {
        wegent_task_store::settle_pipeline_handoff(&mut document, changed_subtask_id);
    }
    if let Some((pending, payload)) = pending_delivery {
        let marker = if decision.auto_advance {
            "advance"
        } else {
            "notify"
        };
        delivery::labels(&mut document)[pending.label(changed_subtask_id)] = match payload {
            Some(payload) => json!({"kind": marker, "event": payload}).to_string().into(),
            None => json!(marker),
        };
    }
    let json_text = python_dumps(&document);
    let row_updated_at = local_datetime();
    let sql = sql::update_task_json_statement(task_table);
    let written = mysql
        .execute(sql, (json_text, row_updated_at, task_id))
        .await?;
    Ok((required_status.is_none() || written.rows_affected != 0).then_some(decision))
}
