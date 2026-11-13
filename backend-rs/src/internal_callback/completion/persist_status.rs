// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The task-status update `_update_task_status_sync` performs after a
//! completion callback (`app/services/chat/storage/db.py`). Split from
//! [`persist`](super) so the file stays within the source-size bound.
use brz_mysql::{Json, MysqlError, MysqlResult, MysqlRow, MysqlTransaction};
use serde_json::{Map, Value, json};

use super::sql;
use super::{
    collaboration_status, complete_task_model, local_datetime, local_isoformat, render_task_crd,
    subtask_column, task_column,
};
use crate::internal_callback::py_json::python_dumps;

pub(super) async fn lock_active_task<T: MysqlTransaction>(
    tables: sql::Tables,
    mysql: &mut T,
    task_id: i64,
) -> MysqlResult<Option<MysqlRow>> {
    mysql
        .fetch_optional(
            format!(
                "{} FOR UPDATE",
                sql::active_task_projection_statement(tables.tasks)
            ),
            (task_id,),
        )
        .await
}

pub(crate) async fn update_task_status_on<T: MysqlTransaction>(
    tables: sql::Tables,
    mysql: &mut T,
    task_id: i64,
    changed_subtask_id: i64,
) -> MysqlResult<Option<bool>> {
    let Some(task) = lock_active_task(tables, mysql, task_id).await? else {
        return Ok(None);
    };
    write_derived_task_status(tables, mysql, task_id, &task, changed_subtask_id, None).await
}

/// Recompute the parent while holding its writer lock. Only the current turn
/// can change the task status or advance a pipeline.
pub(super) async fn write_derived_task_status<T: MysqlTransaction>(
    tables: sql::Tables,
    mysql: &mut T,
    task_id: i64,
    task: &MysqlRow,
    changed_subtask_id: i64,
    terminal_result: Option<&Value>,
) -> MysqlResult<Option<bool>> {
    let Some(Json(Value::Object(mut payload))) = task_column::<Json<Value>>(task, "json") else {
        return Err(MysqlError::ColumnNotFound("task json".into()));
    };
    let Some(Value::Object(mut updated)) = payload.get("status").cloned() else {
        return Err(MysqlError::ColumnNotFound("task json status".into()));
    };
    let task_status = updated.get("status").and_then(Value::as_str);
    if matches!(task_status, Some("CANCELLED" | "DELETE")) {
        return Ok(None);
    }
    let cancelling = task_status == Some("CANCELLING");

    let owner_user_id = task_column::<i64>(task, "user_id").unwrap_or(0);
    let _: Vec<MysqlRow> = mysql
        .fetch_all(
            sql::owner_matches_task_id_statement(tables.tasks),
            (task_id, owner_user_id),
        )
        .await?;
    let subtasks = mysql
        .fetch_all(sql::assistant_subtasks(tables), (task_id,))
        .await
        .and_then(crate::task_store_listing::order_assistant_subtasks)?;
    let Some(last) = subtasks.last() else {
        return Ok(None);
    };
    if subtask_column::<i64>(last, "id") != Some(changed_subtask_id) {
        return Ok(None);
    }
    let last_status = subtask_column::<String>(last, "status")
        .ok_or_else(|| MysqlError::ColumnNotFound("subtask status".into()))?;
    if cancelling && !matches!(last_status.as_str(), "COMPLETED" | "FAILED" | "CANCELLED") {
        return Ok(None);
    }
    let last_result = subtask_column::<Json<Value>>(last, "result").map(|json| json.0);
    let decision = collaboration_status(
        tables,
        mysql,
        task_id,
        &payload,
        last,
        &last_status,
        cancelling,
    )
    .await?;
    let new_status = decision.status;
    let progress = decision.progress;

    let now = local_isoformat();
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

    if last_status == "COMPLETED"
        && let Some(path) = terminal_result
            .and_then(|result| result.get("standalone_chat_workspace_path"))
            .filter(|path| !path.is_null())
        && let Value::Object(spec) = payload
            .entry("spec")
            .or_insert_with(|| Value::Object(Map::new()))
    {
        spec.insert("standaloneChatWorkspacePath".into(), path.clone());
    }
    complete_task_model(&mut payload);
    let json_text = python_dumps(&Value::Object(render_task_crd(payload)));
    let row_updated_at = local_datetime();
    mysql
        .execute(
            sql::update_task_json_statement(tables.tasks),
            (json_text, row_updated_at, task_id),
        )
        .await?;
    Ok(Some(decision.auto_advance))
}
