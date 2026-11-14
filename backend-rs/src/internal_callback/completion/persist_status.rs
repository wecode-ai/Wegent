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
    CollaborationStatus, Delivery, collaboration_status, complete_task_model, delivery,
    local_datetime, local_isoformat, render_task_crd, subtask_column, task_column,
};
use crate::internal_callback::py_json::python_dumps;
use wegent_task_store::task_store_subscription_reads::{
    assistant_membership_statement, latest_assistant_statement,
};

pub(super) async fn read_assistants<T: MysqlTransaction>(
    mysql: &mut T,
    tables: sql::Tables,
    task_id: i64,
    is_subscription: bool,
) -> MysqlResult<Vec<MysqlRow>> {
    let statement = if is_subscription {
        latest_assistant_statement(tables.subtasks)
    } else {
        sql::assistant_subtasks(tables)
    };
    mysql
        .fetch_all(statement, (task_id,))
        .await
        .and_then(crate::task_store_listing::order_assistant_subtasks)
}

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
    terminal_result: Option<&Value>,
) -> MysqlResult<Option<CollaborationStatus>> {
    let task_table = tables.tasks;
    let owner_user_id = task_column::<i64>(&task, "user_id").ok_or(MysqlError::RowNotFound)?;
    let task_json: Option<Value> = task_column::<Json<Value>>(&task, "json").map(|json| json.0);
    let is_subscription = task_column::<i64>(&task, "is_active") == Some(2);

    let _owner: Vec<MysqlRow> = mysql
        .fetch_all(
            sql::owner_matches_task_id_statement(task_table),
            (task_id, owner_user_id),
        )
        .await?;
    let subtasks = crate::task_store_listing::order_assistant_subtasks(
        read_assistants(mysql, tables, task_id, is_subscription).await?,
    )?;
    let Some(last) = subtasks.last() else {
        return Ok(None);
    };
    let last_status = subtask_column::<String>(last, "status").unwrap_or_default();
    let mut is_latest = subtask_column::<i64>(last, "id") == Some(changed_subtask_id);
    if is_subscription && !is_latest {
        is_latest = mysql
            .fetch_optional::<_, _, (i64,)>(
                assistant_membership_statement(tables.subtasks),
                (changed_subtask_id, task_id),
            )
            .await?
            .is_some();
    }
    if !is_latest && !terminal {
        return Ok(None);
    }
    if required_status.is_some_and(|required| {
        last_status != required || subtask_column::<i64>(last, "id") != Some(changed_subtask_id)
    }) {
        return Ok(None);
    }
    let last_result = subtask_column::<Json<Value>>(last, "result").map(|json| json.0);

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
    let previous_status = status_object.get("status").and_then(Value::as_str);
    let preserve_parent = !is_latest || matches!(previous_status, Some("CANCELLED" | "DELETE"));
    let decision = if preserve_parent {
        CollaborationStatus {
            status: previous_status.unwrap_or(&last_status).to_owned(),
            progress: status_object.get("progress").and_then(Value::as_i64),
            auto_advance: false,
        }
    } else {
        collaboration_status(
            mysql,
            task_table,
            task_id,
            &payload,
            last,
            &last_status,
            previous_status == Some("CANCELLING"),
        )
        .await?
    };
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
    if !preserve_parent {
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
    }
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
