// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Disconnect projection for a device's in-flight work.
//!
//! Source: `app/api/ws/device_namespace.py::_handle_device_disconnect` and the
//! `emit_chat_error` loop in `on_disconnect`. The handler fails every RUNNING
//! subtask whose executor name is `device-<route>`, fails each parent task,
//! and then emits one `chat:error` per failed subtask into its task room.
//!
//! The source runs the subtask writes and the parent-task updates on one
//! request session and commits once; the emissions happen after the database
//! connection is released. Errors are logged, never propagated.

use std::sync::Arc;

use brz_mysql::{MysqlResult, MysqlRow, MysqlTransaction as _};
use chrono::Local;
use serde::Serialize;

use crate::socketio::device_lifecycle::publish_room_event;
use crate::socketio::runtime::{CHAT_NAMESPACE, SocketRuntime};
use crate::state::AppState;
use crate::task_mutation_api::{TaskUpdateBody, update_task};

/// `executor_name` of one device's work (`f"device-{device_id}"`).
const DEVICE_EXECUTOR_PREFIX: &str = "device-";
/// `subtask_store.update_fields` error text.
const DISCONNECT_ERROR: &str = "Device disconnected unexpectedly";
/// `emit_chat_error` error text.
const CHAT_ERROR: &str = "Device disconnected";

/// One failed subtask's emission identity.
#[derive(Debug, Clone)]
pub struct FailedSubtask {
    pub task_id: i64,
    pub subtask_id: i64,
    pub message_id: Option<i64>,
}

impl FailedSubtask {
    fn from_row(table: &str, row: &MysqlRow) -> MysqlResult<Self> {
        Ok(Self {
            task_id: row.get_required(&format!("{table}_task_id"))?,
            subtask_id: row.get_required(&format!("{table}_id"))?,
            message_id: row.get(&format!("{table}_message_id"))?,
        })
    }
}

/// `_handle_device_disconnect`: fail the device's RUNNING subtasks and their
/// parent tasks.
pub async fn fail_running_subtasks(
    state: &AppState,
    user_id: i64,
    route_id: &str,
) -> Vec<FailedSubtask> {
    let executor_name = format!("{DEVICE_EXECUTOR_PREFIX}{route_id}");
    // The source's sharded session fans a filter without a task id out across
    // every `subtasks` shard, so the deployment's table list decides the reads.
    let mut found: Vec<(String, MysqlRow)> = Vec::new();
    for table in state.task_store.subtask_tables() {
        let statement =
            crate::task_store_statements::running_subtasks_by_executor_statement(&table);
        match state
            .mysql
            .fetch_all(&statement, (executor_name.as_str(),))
            .await
        {
            Ok(rows) => found.extend(rows.into_iter().map(|row| (table.clone(), row))),
            Err(error) => {
                tracing::error!(%error, user_id, route_id, "device disconnect subtask read failed");
                return Vec::new();
            }
        }
    }
    if found.is_empty() {
        return Vec::new();
    }
    let mut task_ids = Vec::new();
    let now = Local::now().naive_local();
    let written = state
        .mysql
        .with_transaction(async |transaction| -> MysqlResult<Vec<FailedSubtask>> {
            let mut failed = Vec::with_capacity(found.len());
            for (table, row) in &found {
                let subtask = FailedSubtask::from_row(table, row)?;
                transaction
                    .execute(
                        crate::task_store_statements::fail_disconnected_subtask_statement(table)
                            .as_str(),
                        ("FAILED", DISCONNECT_ERROR, now, now, subtask.subtask_id),
                    )
                    .await?;
                failed.push(subtask);
            }
            Ok(failed)
        })
        .await;
    let failed = match written {
        Ok(failed) => failed,
        Err(error) => {
            tracing::error!(%error, user_id, route_id, "device disconnect subtask update failed");
            return Vec::new();
        }
    };
    for subtask in &failed {
        if !task_ids.contains(&subtask.task_id) {
            task_ids.push(subtask.task_id);
        }
    }
    for task_id in task_ids {
        let mut body = TaskUpdateBody::default();
        body.status.set("FAILED".to_owned());
        if let Err(error) = update_task(state, user_id, task_id, None, &body).await {
            tracing::error!(
                ?error,
                user_id,
                task_id,
                "device disconnect task status update failed"
            );
        }
    }
    failed
}

/// The `emit_chat_error` payload for one failed subtask.
#[derive(Serialize)]
struct ChatError<'a> {
    subtask_id: i64,
    error: &'a str,
    task_id: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    message_id: Option<i64>,
}

/// `extended_emitter.emit_chat_error`: local delivery plus the adapter publish
/// for the task room.
pub async fn emit_chat_errors(
    state: &AppState,
    runtime: &Arc<SocketRuntime>,
    failed: &[FailedSubtask],
) {
    for subtask in failed {
        let payload = serde_json::to_value(ChatError {
            subtask_id: subtask.subtask_id,
            error: CHAT_ERROR,
            task_id: subtask.task_id,
            message_id: subtask.message_id,
        })
        .expect("a chat error serializes");
        if let Err(error) = runtime
            .emitters()
            .chat_error(subtask.task_id, &payload)
            .await
        {
            tracing::warn!(%error, task_id = subtask.task_id, "chat:error local delivery failed");
        }
        let room = format!("task:{}", subtask.task_id);
        publish_room_event(state, "chat:error", &payload, CHAT_NAMESPACE, &room).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sql_test_support::mysql_rows::{MysqlRows, Value};

    #[tokio::test]
    async fn failed_subtasks_decode_physical_table_labels() {
        for (table, id, task_id, message_id) in [
            (
                "subtasks",
                "subtasks_id",
                "subtasks_task_id",
                "subtasks_message_id",
            ),
            (
                "subtasks_0001",
                "subtasks_0001_id",
                "subtasks_0001_task_id",
                "subtasks_0001_message_id",
            ),
        ] {
            for expected_message_id in [Some(9), None] {
                let fixture = MysqlRows::start(move |_| {
                    vec![
                        (id, Value::I64(4)),
                        (task_id, Value::I64(7)),
                        (
                            message_id,
                            expected_message_id.map(Value::I64).unwrap_or(Value::Null),
                        ),
                    ]
                })
                .await;
                let statement =
                    crate::task_store_statements::running_subtasks_by_executor_statement(table);
                let row: MysqlRow = fixture
                    .mysql
                    .fetch_one(statement, ("device-runner",))
                    .await
                    .unwrap();

                let failed = FailedSubtask::from_row(table, &row).unwrap();

                assert_eq!(failed.subtask_id, 4);
                assert_eq!(failed.task_id, 7);
                assert_eq!(failed.message_id, expected_message_id);
            }
        }
    }

    #[tokio::test]
    async fn disconnect_updates_labeled_subtasks_and_their_shared_parent() {
        let fixture = MysqlRows::start_results(|sql| {
            if sql.starts_with("UPDATE ") {
                return (vec![], vec![]);
            }
            if sql.contains("FROM subtasks ") {
                let rows = vec![
                    vec![
                        ("subtasks_id", Value::I64(4)),
                        ("subtasks_task_id", Value::I64(7)),
                        ("subtasks_message_id", Value::I64(9)),
                    ],
                    vec![
                        ("subtasks_id", Value::I64(5)),
                        ("subtasks_task_id", Value::I64(7)),
                        ("subtasks_message_id", Value::Null),
                    ],
                ];
                return (rows[0].clone(), rows);
            }
            if sql.contains("FROM tasks ") || sql.contains("FROM `tasks` ") {
                let row = vec![
                    ("id", Value::I64(7)),
                    ("user_id", Value::I64(1)),
                    (
                        "json",
                        Value::Text(r#"{"status":{"status":"RUNNING"}}"#.into()),
                    ),
                    ("project_id", Value::Null),
                    ("client_origin", Value::Null),
                    ("created_at", Value::DateTime),
                    ("updated_at", Value::DateTime),
                ];
                return (row.clone(), vec![row]);
            }
            (vec![("id", Value::I64(0))], vec![])
        })
        .await;
        let state = crate::app_test_support::app(fixture.mysql.clone());

        let failed = fail_running_subtasks(&state, 1, "runner").await;

        assert_eq!(failed.len(), 2);
        assert_eq!(failed[0].subtask_id, 4);
        assert_eq!(failed[0].task_id, 7);
        assert_eq!(failed[0].message_id, Some(9));
        assert_eq!(failed[1].subtask_id, 5);
        assert_eq!(failed[1].task_id, 7);
        assert_eq!(failed[1].message_id, None);
        let queries = fixture.queries();
        assert_eq!(
            queries
                .iter()
                .filter(|sql| sql.starts_with("UPDATE subtasks "))
                .count(),
            2
        );
        assert_eq!(queries.iter().filter(|sql| sql.starts_with("UPDATE tasks ") || sql.starts_with("UPDATE `tasks` ")).count(), 1);
    }

    #[test]
    fn chat_error_skips_an_absent_message_id() {
        let payload = serde_json::to_value(ChatError {
            subtask_id: 4,
            error: CHAT_ERROR,
            task_id: 7,
            message_id: None,
        })
        .unwrap();
        assert_eq!(
            payload,
            serde_json::json!({"subtask_id": 4, "error": "Device disconnected", "task_id": 7})
        );
        let with_message = serde_json::to_value(ChatError {
            subtask_id: 4,
            error: CHAT_ERROR,
            task_id: 7,
            message_id: Some(9),
        })
        .unwrap();
        assert_eq!(
            with_message,
            serde_json::json!({"subtask_id": 4, "error": "Device disconnected", "task_id": 7, "message_id": 9})
        );
    }

    #[test]
    fn one_read_statement_is_rendered_per_physical_table() {
        let statements = crate::task_store_traits::single_subtask_table(
            crate::task_store_tables::TableTemplates {
                tasks: "tasks",
                subtasks: "subtasks",
            },
        )
        .iter()
        .map(|table| crate::task_store_statements::running_subtasks_by_executor_statement(table))
        .collect::<Vec<_>>();
        assert_eq!(statements.len(), 1);
        assert!(statements[0].contains("FROM subtasks "));

        let sharded = ["subtasks_0000".to_string(), "subtasks_0001".to_string()]
            .iter()
            .map(|table| {
                crate::task_store_statements::running_subtasks_by_executor_statement(table)
            })
            .collect::<Vec<_>>();
        assert_eq!(sharded.len(), 2);
        assert!(sharded[0].contains("FROM subtasks_0000 "));
        assert!(sharded[1].contains("FROM subtasks_0001 "));
    }

    #[test]
    fn the_executor_name_is_route_scoped() {
        assert_eq!(
            format!("{DEVICE_EXECUTOR_PREFIX}app-record-7"),
            "device-app-record-7"
        );
    }
}
