// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Focused tests for `_recover_executor_if_needed`'s read and its predicates.
use std::time::Duration;

use brz_mysql::{MysqlResult, MysqlRouteKey, MysqlRouteOutput, MysqlRouting};
use serde_json::{Value, json};

use super::{
    has_fork_workspace_archive, has_inherited_claude_session, payload_reports_missing,
    probes_executor_binding, read_subtask_with_contexts, recover_executor_if_needed,
    requires_claude_session, shell_supports_recovery,
};
use crate::chat_repository::contexts_by_subtask_ids_statement;
use crate::responses::create::dispatch::ExecutionRequest;
use crate::sql_test_support::mysql_pool_server;
use crate::sql_test_support::mysql_rows::{MysqlRows, Row, Value as SqlValue};
use crate::task_store::TableTemplates;
use crate::task_store_statements::{subtask_by_id_statement, subtask_column_index};

/// Deployment shard policy for the test: the recorded `{{subtasks}}` template
/// renders the physical table the recording shows.
struct RecordedShard;

impl MysqlRouting for RecordedShard {
    fn resolve<'a>(
        &'a self,
        template: &'a str,
        _key: &'a dyn MysqlRouteKey,
    ) -> MysqlResult<impl MysqlRouteOutput + 'a> {
        Ok(match template {
            "subtasks" => "subtasks_0711".to_string(),
            "tasks" => "tasks_0711".to_string(),
            other => other.to_string(),
        })
    }
}

fn templates() -> TableTemplates {
    TableTemplates {
        tasks: "{{tasks}}",
        subtasks: "{{subtasks}}",
    }
}

fn normalize(sql: &str) -> String {
    sql.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// `_recover_executor_if_needed` only re-reads the subtask for the coding
/// shells; every other shell returns before the read.
#[test]
fn only_coding_shells_enter_the_recovery_read() {
    for shell in ["ClaudeCode", "Agno", "CodeX", "Codex"] {
        assert!(shell_supports_recovery(shell), "{shell}");
    }
    for shell in ["Chat", "Dify", ""] {
        assert!(!shell_supports_recovery(shell), "{shell}");
    }
}

/// `_has_fork_workspace_archive` needs a non-blank `storageKey`.
#[test]
fn a_fork_workspace_archive_requires_a_non_blank_storage_key() {
    assert!(has_fork_workspace_archive(Some(
        &json!({"workspaceArchive": {"storageKey": "archive/one"}})
    )));
    assert!(!has_fork_workspace_archive(Some(
        &json!({"workspaceArchive": {"storageKey": "   "}})
    )));
    assert!(!has_fork_workspace_archive(Some(
        &json!({"workspaceArchive": {}})
    )));
    assert!(!has_fork_workspace_archive(Some(&json!({}))));
    assert!(!has_fork_workspace_archive(None));
}

/// `_mark_missing_executor_deleted` (`dispatcher.py:341-343`): a blank or
/// `device-*` binding is never soft-probed.
#[test]
fn the_executor_probe_skips_blank_and_device_bindings() {
    assert!(probes_executor_binding(
        "wegent-task-haoxuan3-7c2a3a222e00cad"
    ));
    assert!(probes_executor_binding("  wegent-task-one  "));
    assert!(!probes_executor_binding(""));
    assert!(!probes_executor_binding("   "));
    assert!(!probes_executor_binding("device-abc"));
    assert!(!probes_executor_binding(" device-abc "));
}

/// `remote_workspace_service.executor_alive`: only a terminal phase or the
/// "No pod found" error reports the executor as missing. The recorded create
/// case answered `200 status=success phase=Running`, which is alive.
#[test]
fn only_terminal_or_missing_pods_report_the_executor_as_gone() {
    assert!(!payload_reports_missing(
        &json!({"status": "success", "phase": "Running"})
    ));
    assert!(!payload_reports_missing(&json!({"status": "SUCCESS"})));
    assert!(!payload_reports_missing(
        &json!({"status": "success", "phase": "Succeeded"})
    ));
    assert!(!payload_reports_missing(&json!({"phase": "Pending"})));
    assert!(!payload_reports_missing(
        &json!({"error_msg": "temporarily unavailable"})
    ));
    assert!(!payload_reports_missing(&json!({})));
    assert!(payload_reports_missing(
        &json!({"status": "error", "phase": "Succeeded"})
    ));
    assert!(payload_reports_missing(
        &json!({"status": "error", "phase": "Failed"})
    ));
    assert!(payload_reports_missing(
        &json!({"status": "error", "error_msg": "No pod found for executor x/y"})
    ));
}

#[test]
fn claude_continuation_requires_a_safe_session_for_the_current_bot() {
    let mut request = ExecutionRequest {
        bot: json!([{"id": 9, "shell_type": "ClaudeCode"}]),
        inherited_sessions: vec![
            json!({"agent": "ClaudeCode", "sessionId": "session-1", "botId": 8}),
        ],
        ..ExecutionRequest::default()
    };
    assert!(requires_claude_session(&request));
    assert!(!has_inherited_claude_session(&request));
    request.inherited_sessions[0]["botId"] = json!("9");
    assert!(has_inherited_claude_session(&request));
    request.inherited_sessions[0]["sessionId"] = json!("../invalid");
    assert!(!has_inherited_claude_session(&request));
    request.new_session = true;
    assert!(!requires_claude_session(&request));
}

async fn recovery_fixture(task_json: Value) -> MysqlRows {
    MysqlRows::start_results(move |sql| {
        if sql.starts_with("UPDATE ") {
            return (vec![], vec![]);
        }
        if sql.contains("FROM subtask_contexts") {
            return (vec![("id", SqlValue::I64(0))], vec![]);
        }
        let row: Row = if sql.contains("executor_deleted_at") {
            let mut row = vec![("unused", SqlValue::Null); 23];
            for (column, value) in [
                ("task_id", SqlValue::I64(100)),
                ("executor_name", SqlValue::Text("old-executor".into())),
                ("executor_namespace", SqlValue::Text("old-namespace".into())),
                ("executor_deleted_at", SqlValue::I8(0)),
            ] {
                row[subtask_column_index(column).unwrap()] = (column, value);
            }
            row
        } else {
            assert!(sql.contains("FROM tasks"), "{sql}");
            vec![
                ("id", SqlValue::I64(100)),
                ("user_id", SqlValue::I32(7)),
                ("json", SqlValue::Text(task_json.to_string())),
            ]
        };
        (row.clone(), vec![row])
    })
    .await
}

#[tokio::test]
async fn missing_executor_prepares_a_replacement_before_building_the_dispatch_payload() {
    let (result, _, queries) = recover_missing_executor(false).await;
    result.unwrap();
    let writes: Vec<&str> = queries
        .iter()
        .filter(|sql| sql.starts_with("UPDATE ") && sql.contains("executor_deleted_at"))
        .map(String::as_str)
        .collect();
    assert_eq!(writes.len(), 2);
    assert!(writes[0].contains("executor_deleted_at = true"));
    assert!(writes[1].contains("executor_deleted_at = false"));
    assert!(
        queries
            .iter()
            .any(|sql| sql.contains("s.status IN ('PENDING', 'RUNNING')"))
    );
}

#[tokio::test]
async fn a_failed_prepare_keeps_the_deleted_binding_and_reports_the_manager_error() {
    let (result, request, queries) = recover_missing_executor(true).await;
    assert_eq!(result.unwrap_err().to_string(), "Pod preparation timed out");
    assert_eq!(request.executor_name.as_deref(), Some("old-executor"));
    assert!(
        queries
            .iter()
            .any(|sql| sql.contains("executor_deleted_at = true"))
    );
    assert!(
        !queries
            .iter()
            .any(|sql| sql.contains("executor_deleted_at = false"))
    );
}

async fn recover_missing_executor(
    prepare_fails: bool,
) -> (anyhow::Result<()>, ExecutionRequest, Vec<String>) {
    use std::sync::Arc;
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
    use tokio::net::TcpListener;

    let fixture = recovery_fixture(json!({})).await;
    let mut app = crate::app_test_support::app(fixture.mysql.clone());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    Arc::get_mut(&mut app).unwrap().executor_manager =
        crate::executor_manager::ExecutorManager::new(&url).unwrap();
    app.completion_app.set(Arc::downgrade(&app)).unwrap();
    let manager = tokio::spawn(async move {
        let mut paths = vec![
            "/executor-manager/executor/address",
            "/executor-manager/executors/prepare",
        ];
        if !prepare_fails {
            paths.push("/executor-manager/v1/responses");
        }
        for path in paths {
            let (connection, _) = listener.accept().await.unwrap();
            let mut connection = BufReader::new(connection);
            let mut request_line = String::new();
            connection.read_line(&mut request_line).await.unwrap();
            let mut length = 0;
            loop {
                let mut header = String::new();
                assert!(connection.read_line(&mut header).await.unwrap() > 0);
                if header == "\r\n" {
                    break;
                }
                if let Some(value) = header.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = value.trim().parse().unwrap();
                }
            }
            let (status, body) = if path.ends_with("/address") {
                assert!(request_line.starts_with(&format!("GET {path}?")));
                assert!(request_line.contains("executor_name=old-executor"));
                (
                    "200 OK",
                    json!({"status": "error", "error_msg": "No pod found for executor old-executor"}),
                )
            } else {
                assert!(request_line.starts_with(&format!("POST {path} ")));
                let mut body = vec![0; length];
                connection.read_exact(&mut body).await.unwrap();
                let body: Value = serde_json::from_slice(&body).unwrap();
                if path.ends_with("/responses") {
                    assert_eq!(body["metadata"]["executor_name"], "replacement");
                    assert_eq!(body["metadata"]["executor_namespace"], "replacement-ns");
                    ("200 OK", json!({"id": "resp_100", "status": "queued"}))
                } else {
                    assert_eq!(body["task_id"], 100);
                    assert_eq!(body["subtask_id"], 101);
                    assert!(body["executor_name"].is_null());
                    assert!(body["executor_namespace"].is_null());
                    assert_eq!(body["skip_git_clone"], false);
                    if prepare_fails {
                        (
                            "500 Internal Server Error",
                            json!({"detail": "Pod preparation timed out"}),
                        )
                    } else {
                        // The regular HTTP client's read timeout is 400 ms.
                        tokio::time::sleep(Duration::from_millis(450)).await;
                        (
                            "200 OK",
                            json!({"status": "success", "executor_name": "replacement", "executor_namespace": "replacement-ns"}),
                        )
                    }
                }
            };
            let body = body.to_string();
            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len(),
            );
            connection
                .get_mut()
                .write_all(response.as_bytes())
                .await
                .unwrap();
        }
    });
    let mut request = ExecutionRequest {
        task_id: 100,
        subtask_id: 101,
        user_id: 7,
        bot: json!([{"shell_type": "Codex"}]),
        executor_name: Some("old-executor".into()),
        executor_namespace: Some("old-namespace".into()),
        ..ExecutionRequest::default()
    };
    tokio::time::timeout(Duration::from_secs(10), async {
        let result = if prepare_fails {
            recover_executor_if_needed(&app, &mut request, None)
                .await
                .map(|_| ())
        } else {
            crate::responses::create::seam::enqueue_executor_dispatch(
                &app,
                &format!("{url}/executor-manager"),
                &request,
                None,
            );
            Ok(())
        };
        manager.await.unwrap();
        (result, request, fixture.queries())
    })
    .await
    .expect("recovery fixture did not finish")
}

/// The recovery read is `subtask_store.get_by_id`'s ORM projection: every
/// mapped column labeled `{table}_{column}`, `WHERE {table}.id = ? LIMIT 1`,
/// rendered against the subtask's shard. It is the same pair the RUNNING
/// transition issues later, which is why the recorded create flow has two
/// identical reads.
#[test]
fn the_recovery_read_matches_the_recorded_subtask_pair() {
    let read = normalize(&subtask_by_id_statement(templates().subtasks));
    assert!(
        read.contains(
            "{{subtasks}}.id AS {{subtasks}}_id, {{subtasks}}.user_id AS {{subtasks}}_user_id"
        ),
        "{read}"
    );
    assert!(read.contains("WHERE {{subtasks}}.id = ? LIMIT 1"), "{read}");

    let contexts = normalize(&contexts_by_subtask_ids_statement(1));
    assert!(
        contexts.contains("FROM subtask_contexts WHERE subtask_contexts.subtask_id IN (?)"),
        "{contexts}"
    );
    assert!(
        contexts.ends_with("ORDER BY subtask_contexts.id ASC"),
        "{contexts}"
    );
}

/// The first statement the recovery read prepares targets the routed shard
/// table, before the contexts load and before the RUNNING transition.
#[tokio::test]
async fn the_recovery_read_is_prepared_against_the_shard_first() {
    tokio::time::timeout(Duration::from_secs(5), async {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mysql = crate::connect_mysql(&format!(
            "mysql://test:test@{}/test?ssl-mode=disabled",
            listener.local_addr().unwrap()
        ))
        .unwrap()
        .with_route(RecordedShard);
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(mysql_pool_server::capture_queries_until(listener, stopped));

        // The fake server answers prepared statements with a SQL error, so the
        // read stops at the first statement.
        let _ = read_subtask_with_contexts(&mysql, templates(), 801_406_538_674_542).await;

        stop.send(()).unwrap();
        let queries = server.await.unwrap();
        mysql.close().await;

        let read = queries.first().expect("the recovery read is issued");
        assert!(
            read.contains("FROM `subtasks_0711`"),
            "the read targets the routed shard table: {read}"
        );
        assert!(
            read.contains("`subtasks_0711`.id AS `subtasks_0711_id`"),
            "the read keeps the ORM's labeled projection: {read}"
        );
        assert!(
            read.contains("WHERE `subtasks_0711`.id = ?") && read.trim_end().ends_with("LIMIT 1"),
            "the read keeps the by-id predicate and LIMIT 1: {read}"
        );
    })
    .await
    .expect("the recovery read should be prepared within the test timeout");
}
