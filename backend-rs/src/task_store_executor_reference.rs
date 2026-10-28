// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `SqlAlchemySubtaskStore.create_assistant_subtask`'s executor-reference
//! resolution (`app/stores/tasks/sqlalchemy_subtask_store.py:98-190`) and the
//! paired subtask insert it precedes.
//!
//! The source locks the task row with `with_for_update().first()`
//! (`_take_task_executor_reference`), consumes the `lastExecutorName` /
//! `lastExecutorNamespace` / `lastExecutorDeletedAt` labels from the task JSON,
//! and only when the consumed name is empty falls back to the newest assistant
//! executor of the task. The resolved fields replace the assistant subtask's
//! initial empty executor values, and everything runs in the caller's session,
//! so the row lock has to stay in the same transaction as the paired insert.
//!
//! The transaction runs on the application's concrete `MysqlService`:
//! `Mysql::with_transaction`'s future is not `Send` through the generic store
//! handle, and the `TaskStore` trait object requires a `Send` method future.
//! The owning store supplies the resolved table names and (for a sharded
//! deployment) the ids it allocated before the insert.
use brz_mysql::{MysqlResult, MysqlRow, MysqlTransaction};
use serde_json::{Map, Value};

use crate::internal_callback::completion::task_column;
use crate::json_compat::python_json_value;
use crate::request_sql::{RequestSql, RouteKey};
use crate::task_store_create::{CreateSubtasksRequest, NewSubtaskRow, subtask_insert_arguments};
use crate::task_store_statements::{
    StatementArg, insert_subtask_statement, task_projection, update_task_json_statement,
};

/// `_consume_task_executor_reference`'s result (`ExecutorReference`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AssistantExecutor {
    pub namespace: String,
    pub name: String,
    /// `ExecutorReference.deleted_at` after the source's `== "true"` mapping.
    pub deleted_at: i64,
}

/// The result of reading `lastExecutor*` labels off a task JSON.
pub struct ConsumedExecutorReference {
    pub executor: AssistantExecutor,
    /// The rewritten task JSON when a name was consumed (the source assigns
    /// `task.json`, which the session flushes as one `UPDATE`); `None` when the
    /// labels produced no reference and the row is left untouched.
    pub stripped_json: Option<Value>,
}

/// `_take_task_executor_reference`'s locking read of the task row.
///
/// Recorded: `SELECT tasks_0438.id AS tasks_0438_id, ... \nFROM tasks_0438
/// \nWHERE tasks_0438.id = 904623193040349 \n LIMIT 1 FOR UPDATE`.
pub fn task_for_update_first_statement(table: &str) -> String {
    format!(
        "SELECT {projection} \nFROM {table} \nWHERE {table}.id = ? \n LIMIT 1 FOR UPDATE",
        projection = task_projection(table)
    )
}

/// The fallback read `create_assistant_subtask` issues when the task carried no
/// executor reference: the newest assistant executor of the task.
///
/// Recorded: `SELECT subtasks_0438.executor_namespace AS
/// subtasks_0438_executor_namespace, subtasks_0438.executor_name AS
/// subtasks_0438_executor_name, subtasks_0438.executor_deleted_at AS
/// subtasks_0438_executor_deleted_at \nFROM subtasks_0438 \nWHERE
/// subtasks_0438.task_id = 904623193040349 AND subtasks_0438.`role` =
/// 'ASSISTANT' AND subtasks_0438.executor_name != '' AND
/// subtasks_0438.executor_name IS NOT NULL ORDER BY subtasks_0438.id DESC
/// \n LIMIT 1`.
pub fn latest_assistant_executor_statement(table: &str) -> String {
    format!(
        "SELECT {table}.executor_namespace AS {table}_executor_namespace, \
         {table}.executor_name AS {table}_executor_name, \
         {table}.executor_deleted_at AS {table}_executor_deleted_at \n\
         FROM {table} \n\
         WHERE {table}.task_id = ? AND {table}.`role` = 'ASSISTANT' \
         AND {table}.executor_name != '' AND {table}.executor_name IS NOT NULL \
         ORDER BY {table}.id DESC \n LIMIT 1"
    )
}

/// `_consume_task_executor_reference` without the flush: pop the three handoff
/// labels, and report the rewritten JSON only when a name was consumed (the
/// source assigns `task.json` in exactly that case).
pub fn consume_executor_reference(task_json: &Value) -> ConsumedExecutorReference {
    let empty = || ConsumedExecutorReference {
        executor: AssistantExecutor::default(),
        stripped_json: None,
    };
    let Some(json_data) = task_json.as_object() else {
        return empty();
    };
    let Some(raw_metadata) = json_data.get("metadata").and_then(Value::as_object) else {
        return empty();
    };
    let Some(raw_labels) = raw_metadata.get("labels").and_then(Value::as_object) else {
        return empty();
    };
    let mut labels = raw_labels.clone();
    let name = pop_label_string(&mut labels, "lastExecutorName");
    let namespace = pop_label_string(&mut labels, "lastExecutorNamespace");
    let deleted_at = match labels.remove("lastExecutorDeletedAt") {
        Some(Value::String(flag)) if flag == "true" => 1,
        _ => 0,
    };
    if name.is_empty() {
        return empty();
    }
    let mut metadata = raw_metadata.clone();
    metadata.insert("labels".to_owned(), Value::Object(labels));
    let mut json_data = json_data.clone();
    json_data.insert("metadata".to_owned(), Value::Object(metadata));
    ConsumedExecutorReference {
        executor: AssistantExecutor {
            namespace,
            name,
            deleted_at,
        },
        stripped_json: Some(Value::Object(json_data)),
    }
}

/// `labels.pop(key, "") or ""` for a JSON object: only a string label can be
/// carried into a `String` column, and a missing/null label reads as empty.
fn pop_label_string(labels: &mut Map<String, Value>, key: &str) -> String {
    match labels.remove(key) {
        Some(Value::String(value)) => value,
        _ => String::new(),
    }
}

/// The `after_flush_postexec` task-run-metric hook's read of the inserted
/// assistant subtask (`app/services/task_run_metric_hooks.py:136-140`): the
/// hook reads `subtask.created_at`, which loads the ORM's expired timestamp
/// group before the enclosing savepoint is released.
///
/// Recorded: `SELECT subtasks_0438.created_at, subtasks_0438.updated_at
/// \nFROM subtasks_0438 \nWHERE subtasks_0438.id = 904623193040252`.
pub fn inserted_subtask_timestamps_statement(table: &str) -> String {
    format!("SELECT {table}.created_at, {table}.updated_at \nFROM {table} \nWHERE {table}.id = ?")
}

/// The paired insert result and the executor fields the assistant row carries.
pub struct SubtaskPairInsert {
    pub user_subtask_id: i64,
    pub assistant_subtask_id: i64,
    pub executor: AssistantExecutor,
    /// The inserted assistant subtask's `created_at` (the metric hook's
    /// captured value); `None` only when the row vanished inside the
    /// transaction, which the hook treats as "skip the event".
    pub assistant_created_at: Option<chrono::NaiveDateTime>,
}

/// `create_assistant_subtask` + `create_user_and_assistant_subtasks`: resolve
/// the executor reference (locking task read, label consumption, fallback
/// assistant read) and insert the paired rows inside `SAVEPOINT {savepoint}`,
/// all in one transaction.
pub async fn create_subtask_pair_with_executor_reference(
    sql: &mut dyn RequestSql,
    tasks_table: &str,
    subtasks_table: &str,
    savepoint: &str,
    with_id: bool,
    request: &CreateSubtasksRequest<'_>,
) -> MysqlResult<SubtaskPairInsert> {
    let task_id = request.user_subtask.task_id;
    let route = RouteKey::Task(task_id as u64);
    let executor = resolve_executor_reference_on(sql, tasks_table, subtasks_table, task_id).await?;
    let assistant_subtask = assistant_row_with_executor(&request.assistant_subtask, &executor);
    sql.execute_statement(route, &format!("SAVEPOINT {savepoint}"), Vec::new())
        .await?;
    let user_subtask_id =
        insert_subtask_row_on(sql, subtasks_table, with_id, &request.user_subtask).await?;
    let assistant_subtask_id =
        insert_subtask_row_on(sql, subtasks_table, with_id, &assistant_subtask).await?;
    // `after_flush_postexec` reads the new assistant subtask's `created_at`;
    // the ORM loads the expired timestamp pair on this same connection before
    // the savepoint is released.
    let timestamps = sql
        .fetch_optional_row(
            route,
            &inserted_subtask_timestamps_statement(subtasks_table),
            vec![StatementArg::Int(assistant_subtask_id)],
        )
        .await?;
    let assistant_created_at = timestamps.as_ref().and_then(|row| {
        row.get_at::<Option<chrono::NaiveDateTime>>(0)
            .ok()
            .flatten()
    });
    sql.execute_statement(route, &format!("RELEASE SAVEPOINT {savepoint}"), Vec::new())
        .await?;
    Ok(SubtaskPairInsert {
        user_subtask_id,
        assistant_subtask_id,
        executor,
        assistant_created_at,
    })
}

/// [`resolve_executor_reference`] on the caller's request transaction.
pub async fn resolve_executor_reference_on(
    sql: &mut dyn RequestSql,
    tasks_table: &str,
    subtasks_table: &str,
    task_id: i64,
) -> MysqlResult<AssistantExecutor> {
    let route = RouteKey::Task(task_id as u64);
    let task = sql
        .fetch_optional_row(
            route,
            &task_for_update_first_statement(tasks_table),
            vec![StatementArg::Int(task_id)],
        )
        .await?;
    let Some(task) = task else {
        return Ok(AssistantExecutor::default());
    };
    let task_json = task_column::<brz_mysql::Json<Value>>(&task, "json").map(|json| json.0);
    let consumed = match task_json {
        Some(json) => consume_executor_reference(&json),
        None => ConsumedExecutorReference {
            executor: AssistantExecutor::default(),
            stripped_json: None,
        },
    };
    if let Some(stripped) = consumed.stripped_json {
        let updated_at = chrono::Local::now()
            .naive_local()
            .format("%Y-%m-%d %H:%M:%S%.6f")
            .to_string();
        sql.execute_statement(
            route,
            &update_task_json_statement(tasks_table),
            vec![
                StatementArg::Str(python_json_value(&stripped)),
                StatementArg::Str(updated_at),
                StatementArg::Int(task_id),
            ],
        )
        .await?;
    }
    if !consumed.executor.name.is_empty() {
        return Ok(consumed.executor);
    }
    let Some(previous) = sql
        .fetch_optional_row(
            route,
            &latest_assistant_executor_statement(subtasks_table),
            vec![StatementArg::Int(task_id)],
        )
        .await?
    else {
        return Ok(AssistantExecutor::default());
    };
    Ok(AssistantExecutor {
        namespace: previous.get_at::<Option<String>>(0)?.unwrap_or_default(),
        name: previous.get_at::<Option<String>>(1)?.unwrap_or_default(),
        deleted_at: i64::from(previous.get_at::<Option<bool>>(2)?.unwrap_or(false)),
    })
}

/// The savepoint/insert half of [`create_subtask_pair_with_executor_reference`],
/// given an executor already resolved by the caller. The Source emits the
/// task's rename UPDATE between the executor reads and this block.
pub async fn create_subtask_pair_with_resolved_executor(
    sql: &mut dyn RequestSql,
    subtasks_table: &str,
    savepoint: &str,
    with_id: bool,
    request: &CreateSubtasksRequest<'_>,
    executor: &AssistantExecutor,
) -> MysqlResult<SubtaskPairInsert> {
    let assistant_subtask = assistant_row_with_executor(&request.assistant_subtask, executor);
    let route = RouteKey::Task(request.user_subtask.task_id as u64);
    sql.execute_statement(route, &format!("SAVEPOINT {savepoint}"), Vec::new())
        .await?;
    let user_subtask_id =
        insert_subtask_row_on(sql, subtasks_table, with_id, &request.user_subtask).await?;
    let assistant_subtask_id =
        insert_subtask_row_on(sql, subtasks_table, with_id, &assistant_subtask).await?;
    let timestamps = sql
        .fetch_optional_row(
            route,
            &inserted_subtask_timestamps_statement(subtasks_table),
            vec![StatementArg::Int(assistant_subtask_id)],
        )
        .await?;
    let assistant_created_at = timestamps.as_ref().and_then(|row| {
        row.get_at::<Option<chrono::NaiveDateTime>>(0)
            .ok()
            .flatten()
    });
    sql.execute_statement(route, &format!("RELEASE SAVEPOINT {savepoint}"), Vec::new())
        .await?;
    Ok(SubtaskPairInsert {
        user_subtask_id,
        assistant_subtask_id,
        executor: (*executor).clone(),
        assistant_created_at,
    })
}

/// One `subtasks` row insert on the caller's request transaction.
pub(crate) async fn insert_subtask_row_on(
    sql: &mut dyn RequestSql,
    table: &str,
    with_id: bool,
    row: &NewSubtaskRow<'_>,
) -> MysqlResult<i64> {
    let execution = sql
        .execute_statement(
            RouteKey::Task(row.task_id as u64),
            &insert_subtask_statement(table, with_id),
            subtask_insert_arguments(row, with_id),
        )
        .await?;
    Ok(if with_id {
        row.id
    } else {
        execution.last_insert_id as i64
    })
}

/// `_take_task_executor_reference` then the fallback assistant read.
pub(crate) async fn resolve_executor_reference<T: MysqlTransaction>(
    transaction: &mut T,
    tasks_table: &str,
    subtasks_table: &str,
    task_id: i64,
) -> MysqlResult<AssistantExecutor> {
    let task: Option<MysqlRow> = transaction
        .fetch_optional(task_for_update_first_statement(tasks_table), (task_id,))
        .await?;
    let Some(task) = task else {
        return Ok(AssistantExecutor::default());
    };
    let task_json = task_column::<brz_mysql::Json<Value>>(&task, "json").map(|json| json.0);
    let consumed = match task_json {
        Some(json) => consume_executor_reference(&json),
        None => ConsumedExecutorReference {
            executor: AssistantExecutor::default(),
            stripped_json: None,
        },
    };
    if let Some(stripped) = consumed.stripped_json {
        // `task.json = json_data`: the session flushes the changed column with
        // the model's `onupdate` timestamp.
        let updated_at = chrono::Local::now()
            .naive_local()
            .format("%Y-%m-%d %H:%M:%S%.6f")
            .to_string();
        transaction
            .execute(
                update_task_json_statement(tasks_table),
                (python_json_value(&stripped), updated_at, task_id),
            )
            .await?;
    }
    if !consumed.executor.name.is_empty() {
        return Ok(consumed.executor);
    }
    let Some(previous) = transaction
        .fetch_optional::<_, _, MysqlRow>(
            latest_assistant_executor_statement(subtasks_table),
            (task_id,),
        )
        .await?
    else {
        return Ok(AssistantExecutor::default());
    };
    Ok(AssistantExecutor {
        namespace: previous.get_at::<Option<String>>(0)?.unwrap_or_default(),
        name: previous.get_at::<Option<String>>(1)?.unwrap_or_default(),
        deleted_at: i64::from(previous.get_at::<Option<bool>>(2)?.unwrap_or(false)),
    })
}

/// The assistant row with the resolved executor fields (`executor_*` stay empty
/// only when both the labels and the fallback read produced nothing).
pub(crate) fn assistant_row_with_executor<'a>(
    assistant: &NewSubtaskRow<'a>,
    executor: &'a AssistantExecutor,
) -> NewSubtaskRow<'a> {
    NewSubtaskRow {
        executor_namespace: &executor.namespace,
        executor_name: &executor.name,
        executor_deleted_at: executor.deleted_at,
        ..*assistant
    }
}

/// One `subtasks` row insert on the open transaction.
pub(crate) async fn insert_subtask_row<T: MysqlTransaction>(
    transaction: &mut T,
    table: &str,
    with_id: bool,
    row: &NewSubtaskRow<'_>,
) -> MysqlResult<i64> {
    let execution = transaction
        .execute(
            insert_subtask_statement(table, with_id),
            subtask_insert_arguments(row, with_id),
        )
        .await?;
    Ok(if with_id {
        row.id
    } else {
        execution.last_insert_id as i64
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_locking_read_matches_the_recorded_statement() {
        let sql = task_for_update_first_statement("tasks_0438");
        assert!(sql.starts_with(
            "SELECT tasks_0438.id AS tasks_0438_id, tasks_0438.user_id AS tasks_0438_user_id, "
        ));
        assert!(
            sql.contains("tasks_0438.is_group_chat AS tasks_0438_is_group_chat \nFROM tasks_0438")
        );
        assert!(sql.ends_with("WHERE tasks_0438.id = ? \n LIMIT 1 FOR UPDATE"));
    }

    #[test]
    fn the_expired_timestamp_read_matches_the_recorded_statement() {
        assert_eq!(
            inserted_subtask_timestamps_statement("subtasks_0438"),
            "SELECT subtasks_0438.created_at, subtasks_0438.updated_at \n\
             FROM subtasks_0438 \nWHERE subtasks_0438.id = ?"
        );
    }

    #[test]
    fn the_fallback_read_matches_the_recorded_statement() {
        let sql = latest_assistant_executor_statement("subtasks_0438");
        assert!(sql.starts_with(
            "SELECT subtasks_0438.executor_namespace AS subtasks_0438_executor_namespace, "
        ));
        assert!(sql.contains(
            "subtasks_0438.`role` = 'ASSISTANT' AND subtasks_0438.executor_name != '' \
             AND subtasks_0438.executor_name IS NOT NULL ORDER BY subtasks_0438.id DESC"
        ));
        assert!(sql.ends_with("\n LIMIT 1"));
    }

    #[test]
    fn consuming_the_labels_strips_the_three_handoff_keys() {
        let task_json = json!({
            "kind": "Task",
            "metadata": {
                "name": "task-1",
                "labels": {
                    "lastExecutorName": "exec-1",
                    "lastExecutorNamespace": "wegent",
                    "lastExecutorDeletedAt": "true",
                    "keep": "me"
                }
            }
        });
        let consumed = consume_executor_reference(&task_json);
        assert_eq!(
            consumed.executor,
            AssistantExecutor {
                namespace: "wegent".to_owned(),
                name: "exec-1".to_owned(),
                deleted_at: 1,
            }
        );
        let stripped = consumed.stripped_json.expect("the row is rewritten");
        assert_eq!(
            stripped["metadata"]["labels"],
            json!({"keep": "me"}),
            "the three handoff labels are consumed"
        );
        assert_eq!(stripped["metadata"]["name"], "task-1");
        assert_eq!(stripped["kind"], "Task");
        assert_eq!(
            task_json["metadata"]["labels"]["lastExecutorName"], "exec-1",
            "the source copies before it pops"
        );
    }

    #[test]
    fn an_empty_name_leaves_the_row_untouched() {
        let task_json = json!({
            "metadata": {"labels": {"lastExecutorNamespace": "wegent"}}
        });
        let consumed = consume_executor_reference(&task_json);
        assert_eq!(consumed.executor, AssistantExecutor::default());
        assert!(consumed.stripped_json.is_none());
    }

    #[test]
    fn missing_metadata_and_labels_read_as_an_empty_reference() {
        for task_json in [
            json!(null),
            json!({}),
            json!({"metadata": null}),
            json!({"metadata": {"labels": null}}),
        ] {
            let consumed = consume_executor_reference(&task_json);
            assert_eq!(consumed.executor, AssistantExecutor::default());
            assert!(consumed.stripped_json.is_none());
        }
    }

    #[test]
    fn the_deleted_at_label_only_accepts_the_string_true() {
        let task_json = json!({
            "metadata": {"labels": {
                "lastExecutorName": "exec-1",
                "lastExecutorDeletedAt": true
            }}
        });
        assert_eq!(
            consume_executor_reference(&task_json).executor.deleted_at,
            0
        );
        let task_json = json!({
            "metadata": {"labels": {
                "lastExecutorName": "exec-1",
                "lastExecutorDeletedAt": "true"
            }}
        });
        assert_eq!(
            consume_executor_reference(&task_json).executor.deleted_at,
            1
        );
    }
}
