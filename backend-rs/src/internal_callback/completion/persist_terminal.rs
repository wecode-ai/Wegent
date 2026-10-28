// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The terminal subtask `update_fields` flush (`app/services/chat/storage/db.py`
//! `_update_subtask_sync`) and the `result` assignment it applies.
//!
//! `if result is not None` (`db.py:136`) decides whether the `result` column is
//! part of the UPDATE: a FAILED completion without a payload collects `None`
//! and leaves the stored value untouched. `updated_at` and `completed_at` are
//! independent wall-clock reads, `completed_at` first (`db.py:181-184`).
use brz_mysql::{Json, Mysql, MysqlRow, MysqlTransaction};
use brz_redis::Redis;
use serde_json::Value;

use super::{Completion, local_datetime, sql, subtask_column};
use crate::internal_callback::py_json::python_dumps;

/// `_update_subtask_sync`'s `result` assignment (`db.py:136-177`).
///
/// Only a caller-provided object result is merged with the row's `silent_exit`
/// flags and sanitized; `None` means "do not update the column" and leaves the
/// stored value untouched, which is the shape a FAILED completion without a
/// payload records. A non-object result is treated as absent, matching the
/// collected payloads this flow passes.
fn stored_result(result: Option<&Value>, existing: Option<&Value>) -> Option<Value> {
    let value = result.filter(|value| value.is_object())?;
    let mut stored = value.clone();
    if let (Value::Object(stored_object), Some(Value::Object(existing))) = (&mut stored, existing)
        && existing
            .get("silent_exit")
            .is_some_and(|value| !value.is_null())
    {
        stored_object.insert("silent_exit".into(), existing["silent_exit"].clone());
        if let Some(reason) = existing.get("silent_exit_reason") {
            stored_object.insert("silent_exit_reason".into(), reason.clone());
        }
    }
    Some(sanitize_result_for_storage(&stored))
}

/// `sanitize_result_for_storage`: drop tool input/output from stored thinking
/// steps, leaving every other field untouched.
fn sanitize_result_for_storage(result: &Value) -> Value {
    let Some(object) = result.as_object() else {
        return result.clone();
    };
    let Some(Value::Array(steps)) = object.get("thinking") else {
        return result.clone();
    };
    let mut copy = object.clone();
    copy.insert(
        "thinking".into(),
        Value::Array(
            steps
                .iter()
                .map(|step| match step {
                    Value::Object(step) => {
                        let mut step = step.clone();
                        step.shift_remove("input");
                        step.shift_remove("output");
                        Value::Object(step)
                    }
                    other => other.clone(),
                })
                .collect(),
        ),
    );
    Value::Object(copy)
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn update_subtask_status_on<M: Mysql, R: Redis, T: MysqlTransaction>(
    ctx: &Completion<'_, M, R>,
    mysql: &mut T,
    subtask_id: i64,
    status: &str,
    result: Option<&Value>,
    error: Option<&str>,
    executor_name: Option<&str>,
    executor_namespace: Option<&str>,
) -> Option<(i64, MysqlRow, Option<String>)> {
    let row: MysqlRow = mysql
        .fetch_optional(sql::subtask_by_id(ctx.tables), (subtask_id,))
        .await
        .ok()
        .flatten()?;
    // `SubtaskStore.get_by_id` (`sqlalchemy_subtask_store.py:321-330`)
    // eager-loads `Subtask.contexts` with `subqueryload`, so the source issues
    // this read even though the update never consumes it.
    let _contexts: Vec<MysqlRow> = mysql
        .fetch_all(sql::contexts_by_subtask(), (subtask_id,))
        .await
        .unwrap_or_default();
    let owner_task_id = subtask_column::<i64>(&row, "task_id").unwrap_or(0);
    let existing_executor_name = subtask_column::<String>(&row, "executor_name");
    // The ORM projection labels every column `{table}_{column}`, so the stored
    // result is read by its position in that projection.
    let existing_result: Option<Value> =
        subtask_column::<Json<Value>>(&row, "result").map(|json| json.0);

    let stored_result = stored_result(result, existing_result.as_ref());
    let stored_json = stored_result.as_ref().map(python_dumps).unwrap_or_default();
    // `_before_flush` reads the committed error message and result for the
    // task-run metrics. A write without a `result` column leaves the stored
    // result in place, so the hook observes the existing row value.
    let metrics_message = crate::task_run_metrics::failure_message(
        error,
        stored_result.as_ref().or(existing_result.as_ref()),
    );

    // `fields["completed_at"] = datetime.now()` is assigned before the ORM's
    // `updated_at` `onupdate` stamp (`db.py:181-184`), so the two wall-clock
    // reads are independent and completed_at precedes updated_at, as the
    // recorded statements show.
    let completed_at = local_datetime();
    let updated_at = local_datetime();
    let with_result = stored_result.is_some();
    let with_executor = executor_name.is_some_and(|name| !name.is_empty())
        && existing_executor_name.is_none_or(|name| name.is_empty());
    let with_error = error.is_some();
    let namespace = executor_namespace.unwrap_or_default();
    let name = executor_name.unwrap_or_default();
    let error = error.unwrap_or_default();
    let sql = sql::update_subtask_terminal(ctx.tables, with_result, with_error, with_executor);

    // Read and write on the same writer transaction; metrics publish after commit.
    let outcome = match (with_executor, with_error, with_result) {
        (true, true, true) => {
            mysql
                .execute(
                    sql,
                    (
                        namespace,
                        name,
                        status,
                        stored_json,
                        error,
                        updated_at,
                        completed_at,
                        subtask_id,
                    ),
                )
                .await
        }
        (true, true, false) => {
            mysql
                .execute(
                    sql,
                    (
                        namespace,
                        name,
                        status,
                        error,
                        updated_at,
                        completed_at,
                        subtask_id,
                    ),
                )
                .await
        }
        (true, false, true) => {
            mysql
                .execute(
                    sql,
                    (
                        namespace,
                        name,
                        status,
                        stored_json,
                        updated_at,
                        completed_at,
                        subtask_id,
                    ),
                )
                .await
        }
        (true, false, false) => {
            mysql
                .execute(
                    sql,
                    (
                        namespace,
                        name,
                        status,
                        updated_at,
                        completed_at,
                        subtask_id,
                    ),
                )
                .await
        }
        (false, true, true) => {
            mysql
                .execute(
                    sql,
                    (
                        status,
                        stored_json,
                        error,
                        updated_at,
                        completed_at,
                        subtask_id,
                    ),
                )
                .await
        }
        (false, true, false) => {
            mysql
                .execute(sql, (status, error, updated_at, completed_at, subtask_id))
                .await
        }
        (false, false, true) => {
            mysql
                .execute(
                    sql,
                    (status, stored_json, updated_at, completed_at, subtask_id),
                )
                .await
        }
        (false, false, false) => {
            mysql
                .execute(sql, (status, updated_at, completed_at, subtask_id))
                .await
        }
    };
    if let Err(failure) = outcome {
        tracing::warn!(%failure, "callback subtask update failed");
        return None;
    }
    Some((owner_task_id, row, metrics_message))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn an_absent_result_leaves_the_stored_value_untouched() {
        // `if result is not None` (`db.py:136`): a FAILED completion without a
        // payload writes no `result` column.
        assert_eq!(
            stored_result(None, Some(&json!({"value": "existing"}))),
            None
        );
        assert_eq!(stored_result(None, None), None);
    }

    #[test]
    fn a_present_result_still_merges_and_sanitizes() {
        let existing = json!({"silent_exit": true, "silent_exit_reason": "max_steps"});
        let result = stored_result(Some(&json!({"value": "ok"})), Some(&existing)).expect("result");
        assert_eq!(result["value"], json!("ok"));
        assert_eq!(result["silent_exit"], json!(true));
        assert_eq!(result["silent_exit_reason"], json!("max_steps"));
    }
}
