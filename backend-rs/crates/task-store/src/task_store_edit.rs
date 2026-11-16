// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The message-edit write path of `SubtaskStore`
//! (`app/services/subtask.py:edit_user_message` and the store methods it
//! reaches).
//!
//! The source runs one SQLAlchemy session: `task_store.get_by_id_for_update`
//! locks the task row, `subtask_store.get_latest_assistant_executor_from`
//! captures the newest assistant executor inside the deletion range,
//! `subtask_store.delete_from_message_id` loads and deletes the range (with
//! the `subtask_contexts` cleanup), `_persist_task_executor_reference` rewrites
//! the task labels when an executor was captured, and `db.commit()` ends the
//! transaction. The statements and the transaction body live here so the
//! single-table and sharded stores render the same SQL.
//!
//! The transaction runs on the application's concrete `MysqlService` rather
//! than the generic store handle. The sharded store resolves its physical
//! table names before locking, so the transaction only needs the shared pool;
//! `Mysql::with_transaction`'s future is not `Send` through a generic `M`, and
//! the `TaskStore` trait object requires a `Send` method future.
use brz_mysql::{FromMysqlCol, MysqlError, MysqlResult, MysqlRow, MysqlService, MysqlTransaction};
use serde_json::{Map, Value};

use crate::json_compat::python_json_value;
use crate::task_store::task_update_timestamp;
use crate::task_store_statements::{
    distinct_subtask_owners_statement, owner_matches_task_id_statement, subtask_projection,
    task_projection,
};

/// Marker carried on the sentinel error that ends the edit transaction when
/// `task_store.get_by_id_for_update` finds no task row. The source raises
/// `HTTPException(404, "Task not found")`, so the session ends without a
/// commit and the transaction rolls back.
const TASK_NOT_FOUND: &str = "subtask edit: task not found";

/// `task_store.get_by_id_for_update` found no task row.
pub fn message_edit_task_not_found() -> MysqlError {
    MysqlError::InvalidQuery {
        reason: TASK_NOT_FOUND.to_owned(),
    }
}

/// Whether `error` is the message-edit task-not-found sentinel.
pub fn is_message_edit_task_not_found(error: &MysqlError) -> bool {
    matches!(error, MysqlError::InvalidQuery { reason } if reason == TASK_NOT_FOUND)
}

/// The outcome of the message-edit write transaction.
pub enum MessageEditCommit {
    /// The task row disappeared between the subtask read and the lock.
    TaskNotFound,
    /// The rows `delete_from_message_id` loaded and deleted, in query order.
    Deleted(Vec<MysqlRow>),
}

/// The physical tables and owner-filter form the owning store resolved for
/// the message-edit transaction.
pub struct MessageEditTables {
    /// `task_model_for_task_id` / `_model_for_task_id_lookup`'s selection.
    pub tasks: String,
    /// `subtask_model_for_task_id`'s selection.
    pub subtasks: String,
    /// The store's `_filter_owner_user_id` form.
    pub ownership: MessageEditOwnership,
}

/// How a store applies `_filter_owner_user_id` to the deletion range.
pub enum MessageEditOwnership {
    /// The base store adds the owner subquery to each statement
    /// (`Subtask.task_id.in_(select(TaskResource.id).where(user_id == ...))`).
    StatementFilter,
    /// The sharded store verifies ownership with `_owner_matches_task_id`
    /// before reading the range, so its statements carry no owner filter.
    OwnershipProbe,
}

/// `subtask_service.edit_user_message`'s write transaction: the source's one
/// session runs `task_store.get_by_id_for_update`,
/// `subtask_store.get_latest_assistant_executor_from`,
/// `subtask_store.delete_from_message_id`, and
/// `_persist_task_executor_reference` on one connection, then `db.commit()`.
/// Returning `Err` (including the task-not-found sentinel) rolls back.
pub async fn commit_message_edit(
    mysql: &MysqlService,
    tables: &MessageEditTables,
    task_id: i64,
    from_message_id: i64,
    owner_user_id: i64,
) -> MysqlResult<MessageEditCommit> {
    let outcome = mysql
        .with_transaction(async |transaction| {
            // `task_store.get_by_id_for_update`: the row lock stays on this
            // connection until the commit at the end of the closure.
            let Some(task) = transaction
                .fetch_optional(task_for_update_statement(&tables.tasks), (task_id,))
                .await?
            else {
                return Err(message_edit_task_not_found());
            };
            let executor = match tables.ownership {
                MessageEditOwnership::OwnershipProbe => {
                    // `get_latest_assistant_executor_from` checks the owner
                    // before reading the executor columns.
                    if !owner_matches_task_id(
                        transaction,
                        &tables.tasks,
                        &tables.subtasks,
                        task_id,
                        owner_user_id,
                    )
                    .await?
                    {
                        None
                    } else {
                        transaction
                            .fetch_optional(
                                latest_assistant_executor_from_statement(&tables.subtasks, false),
                                (task_id, from_message_id),
                            )
                            .await?
                    }
                }
                MessageEditOwnership::StatementFilter => {
                    transaction
                        .fetch_optional(
                            latest_assistant_executor_from_statement(&tables.subtasks, true),
                            (task_id, from_message_id, owner_user_id),
                        )
                        .await?
                }
            };
            let rows: Vec<MysqlRow> = match tables.ownership {
                MessageEditOwnership::OwnershipProbe => {
                    if !owner_matches_task_id(
                        transaction,
                        &tables.tasks,
                        &tables.subtasks,
                        task_id,
                        owner_user_id,
                    )
                    .await?
                    {
                        Vec::new()
                    } else {
                        transaction
                            .fetch_all(
                                subtasks_from_message_statement(&tables.subtasks, false),
                                (task_id, from_message_id),
                            )
                            .await?
                    }
                }
                MessageEditOwnership::StatementFilter => {
                    transaction
                        .fetch_all(
                            subtasks_from_message_statement(&tables.subtasks, true),
                            (task_id, from_message_id, owner_user_id),
                        )
                        .await?
                }
            };
            let ids = subtask_ids(&rows)?;
            delete_subtask_rows(transaction, &tables.subtasks, &ids).await?;
            if let Some(executor) = executor {
                persist_task_executor_reference(
                    transaction,
                    &tables.tasks,
                    task_id,
                    &task,
                    &executor,
                )
                .await?;
            }
            Ok(rows)
        })
        .await;
    match outcome {
        Ok(rows) => Ok(MessageEditCommit::Deleted(rows)),
        Err(error) if is_message_edit_task_not_found(&error) => Ok(MessageEditCommit::TaskNotFound),
        Err(error) => Err(error),
    }
}

/// `ShardedSubtaskStore._owner_matches_task_id`: the task row of that owner,
/// or the single owner of the task's subtasks.
async fn owner_matches_task_id<T: MysqlTransaction>(
    transaction: &mut T,
    task_table: &str,
    subtask_table: &str,
    task_id: i64,
    owner_user_id: i64,
) -> MysqlResult<bool> {
    let row: Option<MysqlRow> = transaction
        .fetch_optional(
            owner_matches_task_id_statement(task_table),
            (task_id, owner_user_id),
        )
        .await?;
    if row.is_some() {
        return Ok(true);
    }
    let owners: Vec<MysqlRow> = transaction
        .fetch_all(distinct_subtask_owners_statement(subtask_table), (task_id,))
        .await?;
    if owners.len() != 1 {
        return Ok(false);
    }
    Ok(owners[0].get_required::<i64>("user_id")? == owner_user_id)
}

/// `subtask_store.has_running_assistant`
/// (`db.query(Subtask.id).filter(task_id, role == ASSISTANT,
/// status.in_([PENDING, RUNNING])).first()`), read from `table`.
pub fn running_assistant_statement(table: &str) -> String {
    format!(
        "SELECT {table}.id AS {table}_id \nFROM {table} \n\
         WHERE {table}.task_id = ? AND {table}.`role` = 'ASSISTANT' \
         AND {table}.status IN ('PENDING', 'RUNNING') \n LIMIT 1"
    )
}

/// `task_store.get_by_id_for_update`
/// (`db.query(model).filter(model.id == id).with_for_update().one_or_none()`):
/// the full task projection under a row lock. `one_or_none` adds no `LIMIT`.
///
/// The ORM's labeled projection is part of the statement text here: Replay
/// correlates a locking read with the recorded `COM_QUERY` only by exact
/// materialized tokens, because its semantic predicate matcher excludes
/// `FOR UPDATE` queries.
pub fn task_for_update_statement(table: &str) -> String {
    format!(
        "SELECT {projection} \nFROM {table} \nWHERE {table}.id = ? FOR UPDATE",
        projection = task_projection(table)
    )
}

/// `subtask_store.get_latest_assistant_executor_from`: the newest assistant
/// executor inside the deletion range, read from `table`. `owner_filter` adds
/// the base store's `_filter_owner_user_id` predicate
/// (`task_id IN (SELECT tasks.id FROM tasks WHERE tasks.user_id = ?)`); the
/// sharded store checks ownership with a separate probe instead.
pub fn latest_assistant_executor_from_statement(table: &str, owner_filter: bool) -> String {
    let mut sql = format!(
        "SELECT executor_namespace, executor_name, executor_deleted_at \nFROM {table} \n\
         WHERE {table}.task_id = ? AND {table}.`role` = 'ASSISTANT' \
         AND {table}.message_id >= ? AND {table}.executor_name != '' \
         AND {table}.executor_name IS NOT NULL"
    );
    if owner_filter {
        sql.push_str(&format!(
            " AND {table}.task_id IN (SELECT tasks.id FROM tasks WHERE tasks.user_id = ?)"
        ));
    }
    sql.push_str(&format!(" ORDER BY {table}.id DESC \n LIMIT 1"));
    sql
}

/// `subtask_store.delete_from_message_id`'s row load
/// (`db.query(model).filter(task_id, message_id >= from).all()`): the full
/// subtask projection of the deletion range, read from `table`.
pub fn subtasks_from_message_statement(table: &str, owner_filter: bool) -> String {
    let mut sql = format!(
        "SELECT {projection} \nFROM {table} \n\
         WHERE {table}.task_id = ? AND {table}.message_id >= ?",
        projection = subtask_projection(table)
    );
    if owner_filter {
        sql.push_str(&format!(
            " AND {table}.task_id IN (SELECT tasks.id FROM tasks WHERE tasks.user_id = ?)"
        ));
    }
    sql
}

/// `_cleanup_contexts`'s attachment reassignment: attachment contexts survive
/// the message deletion and lose their owner instead.
pub fn attachment_context_cleanup_statement(count: usize) -> String {
    let placeholders = vec!["?"; count].join(", ");
    format!(
        "UPDATE subtask_contexts SET subtask_id=0, updated_at=now() \
         WHERE subtask_contexts.subtask_id IN ({placeholders}) \
         AND subtask_contexts.context_type = 'attachment'"
    )
}

/// `_cleanup_contexts`'s `synchronize_session='fetch'` id read that SQLAlchemy
/// issues before the bulk delete.
pub fn non_attachment_context_ids_statement(count: usize) -> String {
    let placeholders = vec!["?"; count].join(", ");
    format!(
        "SELECT subtask_contexts.id \nFROM subtask_contexts \n\
         WHERE subtask_contexts.subtask_id IN ({placeholders}) \
         AND subtask_contexts.context_type != 'attachment'"
    )
}

/// `_cleanup_contexts`'s bulk delete of the non-attachment contexts.
pub fn non_attachment_context_delete_statement(count: usize) -> String {
    let placeholders = vec!["?"; count].join(", ");
    format!(
        "DELETE FROM subtask_contexts \
         WHERE subtask_contexts.subtask_id IN ({placeholders}) \
         AND subtask_contexts.context_type != 'attachment'"
    )
}

/// `db.delete(subtask)` for one loaded row.
pub fn subtask_delete_statement(table: &str) -> String {
    format!("DELETE FROM {table} WHERE {table}.id = ?")
}

/// The id of every row [`subtasks_from_message_statement`] projected,
/// decoded positionally because the projection aliases each column with the
/// deployment's resolved table name.
pub fn subtask_ids(rows: &[MysqlRow]) -> MysqlResult<Vec<i64>> {
    let index = crate::task_store_statements::subtask_column_index("id")
        .expect("the subtask projection selects id");
    rows.iter().map(|row| row.get_at(index)).collect()
}

/// Decode one column of the locked task row positionally: [`task_projection`]
/// aliases every column with the deployment's physical table name, which the
/// caller cannot know.
fn task_column<T: FromMysqlCol>(row: &MysqlRow, column: &str) -> MysqlResult<T> {
    let index = crate::task_store_statements::task_column_index(column).ok_or_else(|| {
        MysqlError::InvalidQuery {
            reason: format!("unknown task projection column: {column}"),
        }
    })?;
    row.get_at(index)
}

/// `subtask_store._delete_subtasks`: `_cleanup_contexts` then one
/// `db.delete()` per loaded subtask. `table` is the table the rows were read
/// from; `transaction` keeps the deletes on the flow's connection.
pub async fn delete_subtask_rows<T: MysqlTransaction>(
    transaction: &mut T,
    table: &str,
    subtask_ids: &[i64],
) -> MysqlResult<()> {
    if subtask_ids.is_empty() {
        return Ok(());
    }
    let count = subtask_ids.len();
    transaction
        .execute(
            attachment_context_cleanup_statement(count),
            subtask_ids.to_vec(),
        )
        .await?;
    let _ids: Vec<MysqlRow> = transaction
        .fetch_all(
            non_attachment_context_ids_statement(count),
            subtask_ids.to_vec(),
        )
        .await?;
    transaction
        .execute(
            non_attachment_context_delete_statement(count),
            subtask_ids.to_vec(),
        )
        .await?;
    for subtask_id in subtask_ids {
        transaction
            .execute(subtask_delete_statement(table), (*subtask_id,))
            .await?;
    }
    Ok(())
}

/// `subtask_service._persist_task_executor_reference`: keep the newest
/// assistant executor on the task labels for the resend's sandbox reuse, then
/// `task_store.update_json` rewrites the task row.
pub async fn persist_task_executor_reference<T: MysqlTransaction>(
    transaction: &mut T,
    table: &str,
    task_id: i64,
    task: &MysqlRow,
    executor: &MysqlRow,
) -> MysqlResult<()> {
    let name: Option<String> = executor.get("executor_name")?;
    let Some(name) = name.filter(|value| !value.is_empty()) else {
        // `if not executor_name: raise ValueError(...)`.
        return Err(MysqlError::InvalidQuery {
            reason: "Cannot persist an empty executor name".to_owned(),
        });
    };
    let namespace: Option<String> = executor.get("executor_namespace")?;
    let deleted_at: Option<i8> = executor.get("executor_deleted_at")?;
    let current: Option<brz_mysql::Json<Value>> = task_column(task, "json")?;
    let payload = executor_labels(
        current.as_ref().map(|json| &json.0),
        namespace.as_deref().unwrap_or(""),
        &name,
        deleted_at.unwrap_or(0) != 0,
    )?;
    transaction
        .execute(
            crate::task_store_statements::update_task_json_statement(table),
            (
                python_json_value(&payload),
                task_update_timestamp(),
                task_id,
            ),
        )
        .await
        .map(|_| ())
}

/// `_persist_task_executor_reference`'s payload: `dict(task.json or {})` with
/// `metadata.labels.lastExecutor*` assigned.
fn executor_labels(
    task_json: Option<&Value>,
    namespace: &str,
    name: &str,
    deleted_at: bool,
) -> MysqlResult<Value> {
    let mut root = match task_json {
        None => Map::new(),
        Some(Value::Object(object)) => object.clone(),
        Some(other) if !python_truthy(other) => Map::new(),
        Some(_) => {
            return Err(MysqlError::InvalidQuery {
                reason: "task json is not an object".to_owned(),
            });
        }
    };
    let mut metadata = match root.remove("metadata") {
        Some(Value::Object(object)) => object,
        _ => Map::new(),
    };
    let mut labels = match metadata.remove("labels") {
        Some(Value::Object(object)) => object,
        _ => Map::new(),
    };
    labels.insert(
        "lastExecutorName".to_owned(),
        Value::String(name.to_owned()),
    );
    labels.insert(
        "lastExecutorNamespace".to_owned(),
        Value::String(namespace.to_owned()),
    );
    labels.insert(
        "lastExecutorDeletedAt".to_owned(),
        Value::String(if deleted_at { "true" } else { "false" }.to_owned()),
    );
    metadata.insert("labels".to_owned(), Value::Object(labels));
    root.insert("metadata".to_owned(), Value::Object(metadata));
    Ok(Value::Object(root))
}

/// Python truthiness for the JSON values `task.json or {}` and
/// `bool(...)` inspect.
pub fn python_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|number| number != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(items) => !items.is_empty(),
        Value::Object(object) => !object.is_empty(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn running_assistant_statement_matches_the_source_query() {
        assert_eq!(
            running_assistant_statement("subtasks_0345"),
            "SELECT subtasks_0345.id AS subtasks_0345_id \nFROM subtasks_0345 \n\
             WHERE subtasks_0345.task_id = ? AND subtasks_0345.`role` = 'ASSISTANT' \
             AND subtasks_0345.status IN ('PENDING', 'RUNNING') \n LIMIT 1"
        );
    }

    #[test]
    fn task_for_update_statement_keeps_the_row_lock() {
        let sql = task_for_update_statement("tasks_0345");
        assert!(sql.ends_with("WHERE tasks_0345.id = ? FOR UPDATE"));
        assert!(!sql.contains("LIMIT"));
        // The recorded locking read is matched by exact materialized tokens, so
        // the ORM's labeled projection is part of the statement.
        assert!(sql.starts_with(
            "SELECT tasks_0345.id AS tasks_0345_id, tasks_0345.user_id AS tasks_0345_user_id, "
        ));
        assert!(
            sql.contains("tasks_0345.is_group_chat AS tasks_0345_is_group_chat \nFROM tasks_0345")
        );
    }

    #[test]
    fn executor_statement_adds_the_owner_subquery_only_for_the_base_store() {
        let sharded = latest_assistant_executor_from_statement("subtasks_0345", false);
        assert!(!sharded.contains("IN (SELECT tasks.id"));
        assert!(sharded.ends_with("ORDER BY subtasks_0345.id DESC \n LIMIT 1"));
        let base = latest_assistant_executor_from_statement("subtasks", true);
        assert!(base.contains(
            "AND subtasks.task_id IN (SELECT tasks.id FROM tasks WHERE tasks.user_id = ?)"
        ));
    }

    #[test]
    fn deletion_range_projection_uses_the_mapper_order() {
        let sql = subtasks_from_message_statement("subtasks_0345", false);
        assert!(sql.starts_with(
            "SELECT subtasks_0345.id AS subtasks_0345_id, subtasks_0345.user_id AS subtasks_0345_user_id, "
        ));
        assert!(sql.contains("subtasks_0345.`role` AS subtasks_0345_role"));
        assert!(sql.ends_with("WHERE subtasks_0345.task_id = ? AND subtasks_0345.message_id >= ?"));
    }

    #[test]
    fn context_cleanup_statements_bind_one_placeholder_per_id() {
        assert!(attachment_context_cleanup_statement(2).contains("IN (?, ?)"));
        assert!(non_attachment_context_ids_statement(2).contains("IN (?, ?)"));
        assert!(non_attachment_context_delete_statement(2).contains("IN (?, ?)"));
        assert_eq!(
            subtask_delete_statement("subtasks_0345"),
            "DELETE FROM subtasks_0345 WHERE subtasks_0345.id = ?"
        );
    }

    #[test]
    fn executor_labels_replace_non_object_metadata_and_keep_other_keys() {
        let payload = executor_labels(
            Some(&serde_json::json!({
                "spec": {"title": "t"},
                "metadata": "stale"
            })),
            "ns",
            "exec",
            true,
        )
        .unwrap();
        assert_eq!(payload["spec"]["title"], "t");
        assert_eq!(payload["metadata"]["labels"]["lastExecutorName"], "exec");
        assert_eq!(payload["metadata"]["labels"]["lastExecutorNamespace"], "ns");
        assert_eq!(
            payload["metadata"]["labels"]["lastExecutorDeletedAt"],
            "true"
        );
    }

    #[test]
    fn absent_task_json_starts_an_empty_document() {
        let payload = executor_labels(None, "", "exec", false).unwrap();
        assert_eq!(
            payload["metadata"]["labels"]["lastExecutorDeletedAt"],
            "false"
        );
    }

    #[test]
    fn python_truthiness_matches_the_source() {
        assert!(!python_truthy(&Value::Null));
        assert!(!python_truthy(&serde_json::json!(0)));
        assert!(!python_truthy(&serde_json::json!("")));
        assert!(!python_truthy(&serde_json::json!([])));
        assert!(!python_truthy(&serde_json::json!({})));
        assert!(python_truthy(&serde_json::json!("false")));
    }

    #[test]
    fn task_not_found_sentinel_is_recognised() {
        assert!(is_message_edit_task_not_found(
            &message_edit_task_not_found()
        ));
    }
}
