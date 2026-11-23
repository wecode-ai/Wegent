// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Focused tests for the completion's statement shapes.
//!
//! `SubscriptionTaskCompletionHandler.on_task_completed`
//! (`app/services/subscription/task_completion_handler.py:78-181`) resolves the
//! execution once through `_find_execution_by_task_id`, maps the terminal status
//! before any database work, and hands the resolved row to the status update.
//! Recording `20261027105553` (case `f742360f-b080-4725-b980-6af764719500`)
//! carries exactly one task-id execution read and no second lookup.
#![cfg(test)]

use chrono::NaiveDateTime;
use serde_json::json;

use super::completion::terminal_result;
use super::model;
use crate::internal_callback::completion::TaskCompletedEvent;

fn normalize(sql: &str) -> String {
    sql.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn execution() -> model::Execution {
    let clock = NaiveDateTime::default();
    model::Execution {
        id: 2_539_501,
        user_id: 3650,
        subscription_id: 264_564,
        task_id: 501_652_180_355_339,
        inbox_message_id: 0,
        trigger_reason: String::new(),
        prompt: String::new(),
        status: "RUNNING".to_string(),
        result_summary: String::new(),
        error_message: String::new(),
        version: 0,
        started_at: clock,
        completed_at: clock,
        created_at: clock,
        updated_at: clock,
    }
}

/// `_map_status` keeps `COMPLETED_SILENT` only for a silent completion; the
/// silent branch is what skips the follower dispatch afterwards.
#[test]
fn the_terminal_status_mapping_matches_the_source() {
    let user_id = execution().user_id;
    let task_id = execution().task_id;
    let silent = json!({"value": "done", "silent_exit": true});
    let silent_event = TaskCompletedEvent {
        task_id,
        user_id,
        status: "COMPLETED",
        subtask_id: 0,
        result: Some(&silent),
        error: None,
    };
    let result = terminal_result(&silent_event);
    assert_eq!(result.status, "COMPLETED_SILENT");
    assert!(result.silent);
    assert_eq!(result.summary.as_deref(), Some("done"));

    let directives = json!({"value": "Build finished\n\n【静默】【@列表：900101】"});
    let directive_result = terminal_result(&TaskCompletedEvent {
        result: Some(&directives),
        ..silent_event
    });
    assert_eq!(directive_result.summary.as_deref(), Some("Build finished"));
    assert_eq!(
        directive_result.notification_summary.as_deref(),
        Some("Build finished\n\n【静默】【@列表：900101】")
    );

    let event = TaskCompletedEvent {
        task_id,
        user_id,
        status: "COMPLETED",
        subtask_id: 0,
        result: None,
        error: None,
    };
    assert_eq!(terminal_result(&event).status, "COMPLETED");
    let failed = TaskCompletedEvent {
        status: "FAILED",
        ..event
    };
    assert_eq!(terminal_result(&failed).status, "FAILED");
    let cancelled = TaskCompletedEvent {
        status: "CANCELLED",
        ..event
    };
    assert_eq!(terminal_result(&cancelled).status, "CANCELLED");
}

/// The execution lookup keeps the recorded task-id reads and the recorded
/// reload; the fused `ORDER BY status IN (...)` statement had no counterpart and
/// made Replay reject the terminal callback.
#[test]
fn the_execution_lookup_keeps_the_recorded_task_reads() {
    let running = normalize(&model::execution_running_by_task());
    assert_eq!(
        running,
        normalize(&format!(
            "SELECT {} FROM background_executions \
             WHERE background_executions.task_id = ? \
             AND background_executions.status IN ('PENDING', 'RUNNING') \
             ORDER BY background_executions.id DESC LIMIT 1",
            model::EXECUTION_COLUMNS
        ))
    );
    assert!(!running.contains("ORDER BY status IN"), "{running}");

    let latest = normalize(&model::execution_latest_by_task());
    assert!(
        latest.starts_with(&format!(
            "SELECT {} FROM background_executions",
            model::EXECUTION_COLUMNS
        )),
        "{latest}"
    );
    assert!(
        latest.ends_with(
            "WHERE background_executions.task_id = ? \
             ORDER BY background_executions.id DESC LIMIT 1"
        ) && !latest.contains("status IN"),
        "{latest}"
    );

    assert_eq!(
        normalize(&model::execution_by_id()),
        normalize(&format!(
            "SELECT {} FROM background_executions WHERE background_executions.id = ?",
            model::EXECUTION_COLUMNS
        ))
    );
    assert!(
        normalize(&model::execution_status_read())
            .ends_with("WHERE background_executions.id = ? LIMIT 1"),
        "the status read is the ORM's `.first()`, so it ends in LIMIT 1"
    );
}

use super::completion::{TerminalResult, after_status};
use crate::internal_callback::completion::subscription::boundary_tests::{
    NoRedis, execution_row, subscription_row,
};
use crate::internal_callback::completion::{Completion, Tables};
use crate::internal_callback::completion::{code_wiki, subscription};
use crate::sql_test_support::mysql_rows::{MysqlRows, Row, Value as SqlValue};
use brz_mysql::{MysqlService, MysqlServiceOptions};
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

async fn http_request(stream: &mut tokio::net::TcpStream) -> String {
    let mut bytes = Vec::new();
    loop {
        let mut chunk = [0; 2048];
        let length = stream.read(&mut chunk).await.unwrap();
        assert!(length > 0, "HTTP fixture closed before the body arrived");
        bytes.extend_from_slice(&chunk[..length]);
        if let Some(headers_end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
            let headers = String::from_utf8_lossy(&bytes[..headers_end]);
            let length = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().unwrap())
                })
                .unwrap_or(0);
            if bytes.len() >= headers_end + 4 + length {
                return String::from_utf8(bytes).unwrap();
            }
        }
    }
}

async fn http_reply(stream: &mut tokio::net::TcpStream, body: &str) {
    stream.write_all(format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    ).as_bytes()).await.unwrap();
}

fn inbox_execution(status: &str) -> Row {
    let mut row = execution_row(status);
    row.iter_mut()
        .find(|(name, _)| *name == "inbox_message_id")
        .unwrap()
        .1 = SqlValue::I64(88);
    row
}

#[tokio::test]
async fn redis_failure_does_not_drop_inbox_or_follower_delivery() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let api = format!("http://{}", listener.local_addr().unwrap());
    let delivery = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        assert!(
            http_request(&mut stream)
                .await
                .starts_with("POST /v1.0/oauth2/accessToken ")
        );
        http_reply(&mut stream, r#"{"accessToken":"fixture-token"}"#).await;
        let (mut stream, _) = listener.accept().await.unwrap();
        let request = http_request(&mut stream).await;
        assert!(request.starts_with("POST /v1.0/robot/oToMessages/batchSend "));
        assert!(request.contains("fixture-recipient") && request.contains("Data too long"));
        http_reply(&mut stream, "{}").await;
    });
    let server =
        MysqlRows::start_results(move |sql| {
            let row =
                if sql.contains("FROM background_executions") {
                    inbox_execution("FAILED")
                } else if sql.contains("FROM subscription_follows") {
                    vec![
                        ("follower_user_id", SqlValue::I64(3650)),
                        (
                            "config",
                            SqlValue::Text(
                                json!({
                                    "notification_level":"notify", "notification_channel_ids":[4]
                                })
                                .to_string(),
                            ),
                        ),
                    ]
                } else if sql.contains("FROM users") {
                    vec![(
                        "preferences",
                        SqlValue::Text(
                            json!({
                                "im_channels":{"4":{"sender_staff_id":"fixture-recipient"}}
                            })
                            .to_string(),
                        ),
                    )]
                } else if sql.contains("FROM kinds") && sql.contains("Messager") {
                    vec![("json", SqlValue::Bytes(serde_json::to_vec(&json!({
                "spec":{"channelType":"dingtalk","config":{
                    "client_id":"fixture-app", "client_secret":"***", "api_base_url":api
                }}
            })).unwrap()))]
                } else if sql.contains("FROM kinds") {
                    subscription_row()
                } else if sql.starts_with("UPDATE ") {
                    return (Vec::new(), Vec::new());
                } else {
                    return (vec![("id", SqlValue::I64(0))], Vec::new());
                };
            (row.clone(), vec![row])
        })
        .await;
    let app = crate::app_test_support::app(server.mysql.clone());
    let redis = NoRedis {
        fail_publication: true,
        ..Default::default()
    };
    let execution = execution();
    let event = TaskCompletedEvent {
        task_id: execution.task_id,
        user_id: execution.user_id,
        subtask_id: 0,
        status: "FAILED",
        result: None,
        error: Some("Data too long"),
    };
    let ctx = Completion {
        app: Some(&app),
        mysql: &server.mysql,
        redis: &redis,
        tables: Tables {
            tasks: "tasks_0030",
            subtasks: "subtasks_0030",
        },
        executor_manager: &app.executor_manager,
    };
    let result = TerminalResult {
        status: "FAILED",
        silent: false,
        summary: None,
        notification_summary: None,
    };
    assert_eq!(
        after_status(&ctx, &event, &execution, &result)
            .await
            .expect("optional publication cannot abort required delivery"),
        Some("FAILED".into())
    );
    tokio::time::timeout(Duration::from_secs(5), delivery)
        .await
        .expect("follower delivery still runs")
        .unwrap();
    assert_eq!(redis.failed_publications.load(Ordering::SeqCst), 1);
    assert!(
        server
            .queries()
            .iter()
            .any(|q| q.starts_with("UPDATE queue_messages SET status='failed'"))
    );
    assert!(
        server
            .queries()
            .iter()
            .any(|q| q.contains("FROM subscription_follows"))
    );
}

fn cleanup_task_row() -> Row {
    vec![
        ("id", SqlValue::I64(501_652_180_355_339)),
        ("user_id", SqlValue::I64(3650)),
        ("kind", SqlValue::Text("Task".into())),
        ("name", SqlValue::Text("fixture-task".into())),
        ("namespace", SqlValue::Text("default".into())),
        (
            "json",
            SqlValue::Bytes(
                serde_json::to_vec(&json!({
                    "metadata":{"labels":{"autoDeleteExecutor":"true"}},
                    "status":{"status":"COMPLETED"}
                }))
                .unwrap(),
            ),
        ),
        ("is_active", SqlValue::I8(1)),
        ("created_at", SqlValue::DateTime),
        ("updated_at", SqlValue::DateTime),
        ("project_id", SqlValue::Null),
        ("client_origin", SqlValue::Null),
        ("is_group_chat", SqlValue::I8(0)),
    ]
}

#[tokio::test]
async fn held_delete_releases_the_only_connection_for_delivery_and_later_handlers() {
    for subscription_execution in [true, false] {
        let committed = Arc::new(AtomicBool::new(false));
        let page_reads = Arc::new(AtomicUsize::new(0));
        let state = committed.clone();
        let pages = page_reads.clone();
        let server = MysqlRows::start_results(move |sql| {
            let row = if sql.contains("FROM background_executions") {
                let row = inbox_execution(if state.load(Ordering::SeqCst) {
                    "COMPLETED"
                } else {
                    "RUNNING"
                });
                return (
                    row.clone(),
                    if subscription_execution {
                        vec![row]
                    } else {
                        Vec::new()
                    },
                );
            } else if sql.starts_with("UPDATE background_executions") {
                state.store(true, Ordering::SeqCst);
                // Empty columns select MysqlRows' OK packet with affected_rows=1.
                // The lost-CAS fixture uses a nonempty schema with no rows instead.
                return (Vec::new(), Vec::new());
            } else if sql.contains("FROM kinds") {
                subscription_row()
            } else if sql.contains("FROM ")
                && sql.contains("tasks_0030")
                && !sql.contains("subtasks_0030")
            {
                cleanup_task_row()
            } else if sql.starts_with("SELECT id FROM subtasks_0030") {
                vec![("id", SqlValue::I64(42))]
            } else if sql.contains("FROM ")
                && sql.contains("subtasks_0030")
                && sql.contains("executor_deleted_at")
            {
                let row = vec![
                    ("id", SqlValue::I64(42)),
                    ("user_id", SqlValue::I64(3650)),
                    ("executor_name", SqlValue::Text("fixture-runtime".into())),
                    ("executor_namespace", SqlValue::Text("default".into())),
                ];
                // The SDK disables statement caching: each fetch calls this
                // for PREPARE and EXECUTE. Alternate complete callback pairs
                // so both the initial scan and a later flag scan can finish.
                let read = pages.fetch_add(1, Ordering::SeqCst);
                return (
                    row.clone(),
                    if (read / 2).is_multiple_of(2) {
                        vec![row]
                    } else {
                        Vec::new()
                    },
                );
            } else if sql.starts_with("UPDATE ") {
                return (Vec::new(), Vec::new());
            } else {
                return (vec![("id", SqlValue::I64(0))], Vec::new());
            };
            (row.clone(), vec![row])
        })
        .await;
        let server = Arc::new(server);
        let mysql = MysqlService::connect_lazy_with_options(
            &server.url,
            MysqlServiceOptions::default().with_max_connections(1),
        )
        .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let manager = crate::executor_manager::ExecutorManager::new(format!(
            "http://{}",
            listener.local_addr().unwrap()
        ))
        .unwrap()
        // The SDK's 400 ms read default would end the DELETE before the
        // progress check; keep the real request alive until explicitly released.
        .with_http_client(
            brz_http::Client::builder()
                .read_timeout(Duration::from_secs(10))
                .build()
                .unwrap(),
        );
        let (delete_started, held) = tokio::sync::oneshot::channel();
        let (release, wait_release) = tokio::sync::oneshot::channel();
        let sql_at_delete = Arc::clone(&server);
        let http = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            assert!(http_request(&mut stream).await.starts_with("GET "));
            http_reply(&mut stream, "{}").await;
            let (mut stream, _) = listener.accept().await.unwrap();
            assert!(http_request(&mut stream).await.starts_with("DELETE "));
            delete_started.send(sql_at_delete.requests()).unwrap();
            let _ = wait_release.await;
            http_reply(&mut stream, r#"{"success":true}"#).await;
        });
        let lease = crate::sql_test_support::redis_lease::RedisLease::start().await;
        let mut app = crate::app_test_support::app(mysql.clone());
        Arc::get_mut(&mut app).unwrap().redis = Some(
            brz_redis::RedisService::single(&lease.address)
                .await
                .unwrap(),
        );
        let redis = NoRedis::default();
        let execution = execution();
        let event = TaskCompletedEvent {
            task_id: execution.task_id,
            user_id: execution.user_id,
            subtask_id: 42,
            status: "COMPLETED",
            result: None,
            error: None,
        };
        let ctx = Completion {
            app: Some(&app),
            mysql: &mysql,
            redis: &redis,
            tables: Tables {
                tasks: "tasks_0030",
                subtasks: "subtasks_0030",
            },
            executor_manager: &manager,
        };
        let (finished, delivered) = tokio::sync::oneshot::channel();
        tokio::join!(
            async {
                subscription::handle_task_completed(&ctx, &event).await;
                code_wiki::conclude_code_wiki_run(&ctx, &event).await;
                finished.send(()).unwrap();
            },
            async {
                let requests_at_delete = tokio::time::timeout(Duration::from_secs(5), held)
                    .await
                    .expect("cleanup reaches the real DELETE")
                    .unwrap();
                let progress = tokio::time::timeout(Duration::from_secs(2), delivered).await;
                let queries = server.queries();
                release.send(()).unwrap();
                assert!(
                    matches!(progress, Ok(Ok(()))),
                    "held DELETE must not occupy the only DB connection or delay later handlers: {queries:?}"
                );
                let prepared = requests_at_delete
                    .iter()
                    .rposition(|request| {
                        request.sql.contains("FROM subtasks_0030")
                            && request.sql.contains("executor_deleted_at=false")
                    })
                    .expect("cleanup prepared runtime references");
                assert!(
                    requests_at_delete[prepared + 1..]
                        .iter()
                        .any(|request| { request.sql.eq_ignore_ascii_case("COMMIT") }),
                    "preparation must commit before DELETE arrives: {requests_at_delete:?}"
                );
                if subscription_execution {
                    assert!(
                        queries
                            .iter()
                            .any(|q| q.starts_with("UPDATE queue_messages"))
                    );
                    assert!(
                        queries
                            .iter()
                            .any(|q| q.contains("FROM subscription_follows"))
                    );
                }
                assert!(
                    queries
                        .iter()
                        .any(|q| q.contains("wiki_generations.status = 'RUNNING'"))
                );
                assert!(
                    !queries
                        .iter()
                        .any(|q| q.starts_with("UPDATE subtasks_0030"))
                );
            }
        );
        http.await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let requests = server.requests();
                if let Some(updated) = requests
                    .iter()
                    .rposition(|request| request.sql.starts_with("UPDATE subtasks_0030"))
                    && requests[updated + 1..]
                        .iter()
                        .any(|request| request.sql.eq_ignore_ascii_case("COMMIT"))
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the owned cleanup commits flags after DELETE completes");
    }
}
