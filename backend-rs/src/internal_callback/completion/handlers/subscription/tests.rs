// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

use brz_redis::{EncodeRedisArg, EncodeRedisArgs, FromRedisBulk, RedisResult, RedisValues};

/// The cleanup path issues no Redis command; the completion context still
/// requires a Redis handle.
#[derive(Default)]
struct NoRedis {
    commands: std::sync::Mutex<Vec<Vec<String>>>,
    streaming_status: Option<String>,
}

impl Redis for NoRedis {
    async fn eval<S, K, A, R>(&self, script: S, keys: K, arguments: A) -> RedisResult<R>
    where
        S: EncodeRedisArg + Send,
        K: EncodeRedisArgs + Send,
        A: EncodeRedisArgs + Send,
        R: brz_redis::FromRedisValue + Send,
    {
        let mut command = brz_redis::cmd("EVAL");
        command.arg_encoded(script)?.arg_encoded(keys.num_args())?;
        keys.encode_args(&mut command)?;
        arguments.encode_args(&mut command)?;
        self.command(command).await
    }

    async fn command<R: brz_redis::FromRedisValue + Send>(
        &self,
        command: brz_redis::Cmd,
    ) -> RedisResult<R> {
        self.commands.lock().unwrap().push(
            (0..command.arg_count())
                .map(|index| String::from_utf8_lossy(command.arg_at(index).unwrap()).into_owned())
                .collect(),
        );
        R::from_redis_value(&brz_redis::Value::Int(1))
    }
    async fn get<K, R>(&self, key: K) -> RedisResult<Option<R>>
    where
        K: EncodeRedisArg + Send,
        R: FromRedisBulk + Send,
    {
        let key = String::from_utf8(key.as_encoded_bytes().unwrap().to_vec()).unwrap();
        assert!(key.starts_with("chat:task_streaming:"));
        self.commands
            .lock()
            .unwrap()
            .push(vec!["GET".to_owned(), key]);
        self.streaming_status
            .as_ref()
            .map(|value| R::from_redis_bulk(brz_redis::RedisBytes::from(value.as_bytes().to_vec())))
            .transpose()
    }

    async fn set<K, V>(&self, _key: K, _value: V) -> RedisResult<()>
    where
        K: EncodeRedisArg + Send,
        V: EncodeRedisArg + Send,
    {
        unreachable!("runtime cleanup issues no Redis write")
    }

    async fn mget<K, R>(&self, _keys: K) -> RedisResult<Vec<Option<R>>>
    where
        K: EncodeRedisArgs + Send,
        R: FromRedisBulk + Send,
    {
        unreachable!("runtime cleanup issues no Redis read")
    }

    async fn del_many<K>(&self, _keys: K) -> RedisResult<i64>
    where
        K: EncodeRedisArgs + Send,
    {
        unreachable!("runtime cleanup issues no Redis write")
    }

    async fn pfcount<K>(&self, _keys: K) -> RedisResult<i64>
    where
        K: EncodeRedisArgs + Send,
    {
        unreachable!("runtime cleanup issues no Redis read")
    }

    async fn hget<K, F, R>(&self, _key: K, _field: F) -> RedisResult<Option<R>>
    where
        K: EncodeRedisArg + Send,
        F: EncodeRedisArg + Send,
        R: FromRedisBulk + Send,
    {
        unreachable!("runtime cleanup issues no Redis read")
    }

    async fn hmget<K, F, R>(&self, _key: K, _fields: F) -> RedisResult<RedisValues<R>>
    where
        K: EncodeRedisArg + Send,
        F: EncodeRedisArgs + Send,
        R: FromRedisBulk + Send,
    {
        unreachable!("runtime cleanup issues no Redis read")
    }
}

fn tables() -> Tables {
    Tables {
        tasks: "tasks_0030",
        subtasks: "subtasks_0030",
    }
}

fn manager() -> crate::executor_manager::ExecutorManager {
    crate::executor_manager::ExecutorManager::new("http://127.0.0.1:1")
        .expect("executor-manager client")
}

fn running_execution() -> execution::Execution {
    execution::Execution {
        id: 11,
        user_id: 7,
        subscription_id: 22,
        task_id: 42,
        inbox_message_id: 73,
        status: "RUNNING".to_owned(),
        version: 4,
        prompt: "fixture".to_owned(),
        trigger_reason: "Scheduled".to_owned(),
        result_summary: String::new(),
        error_message: String::new(),
        created_at: None,
    }
}

#[tokio::test]
async fn terminal_results_write_status_summary_error_and_inbox() {
    use serde_json::json;
    for (status, silent, expected, inbox, notify) in [
        ("COMPLETED", false, "COMPLETED", "processed", true),
        ("COMPLETED", true, "COMPLETED_SILENT", "processed", false),
        ("FAILED", false, "FAILED", "failed", true),
        ("CANCELLED", false, "CANCELLED", "unread", false),
    ] {
        let capture = TransactionCapture::default();
        let mut transaction = capture.transaction();
        let result = json!({"value": "partial output", "silent_exit": silent});
        let event = TaskCompletedEvent {
            task_id: 42,
            subtask_id: 33,
            user_id: 7,
            status,
            result: Some(&result),
            error: Some("provider failed"),
        };
        let completed = execution::complete(&mut transaction, running_execution(), &event)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(completed.execution.status, expected);
        assert_eq!(completed.execution.result_summary, "partial output");
        assert_eq!(completed.execution.error_message, "provider failed");
        assert_eq!(completed.payload["status"], expected);
        assert_eq!(completed.payload["is_silent"], silent);
        assert!(completed.payload["updated_at"].as_str().unwrap().len() <= 26);
        assert_eq!(completed.notify, notify);
        let values = capture.values.lock().unwrap();
        assert!(values.iter().any(
            |(sql, value)| sql.starts_with("UPDATE background_executions") && value == expected
        ));
        assert!(
            values
                .iter()
                .any(|(sql, value)| sql.starts_with("UPDATE queue_messages") && value == inbox)
        );
        let writes = capture.statements();
        assert!(writes[0].sql.contains("completed_at=?"));
        assert!(writes[0].sql.contains("version=version+1"));
        assert!(writes[0].sql.contains("AND status=? AND version=?"));
        if status == "CANCELLED" {
            assert!(
                writes
                    .iter()
                    .any(|query| query.sql.contains("process_subscription_id=0"))
            );
        }
    }
}

#[tokio::test]
async fn duplicate_terminal_callbacks_do_not_write_or_notify() {
    let event = TaskCompletedEvent {
        task_id: 42,
        subtask_id: 33,
        user_id: 7,
        status: "COMPLETED",
        result: None,
        error: None,
    };
    for status in ["COMPLETED", "COMPLETED_SILENT", "FAILED", "CANCELLED"] {
        let capture = TransactionCapture::default();
        let mut execution = running_execution();
        execution.status = status.to_owned();
        assert!(
            execution::complete(&mut capture.transaction(), execution, &event)
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(capture.update_attempts(), 0);
        assert!(capture.statements().is_empty());
    }
}

#[tokio::test]
async fn optimistic_conflicts_do_not_apply_counters_inbox_or_notifications() {
    let capture = TransactionCapture {
        zero_updates: true,
        ..Default::default()
    };
    let event = TaskCompletedEvent {
        task_id: 42,
        subtask_id: 33,
        user_id: 7,
        status: "COMPLETED",
        result: None,
        error: None,
    };
    assert!(
        execution::complete(&mut capture.transaction(), running_execution(), &event)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(capture.update_attempts(), 1);
    assert_eq!(capture.statements().len(), 1);
}

#[tokio::test]
async fn database_write_failure_stops_completion_side_effects() {
    let capture = TransactionCapture::failing_at(1);
    let event = TaskCompletedEvent {
        task_id: 42,
        subtask_id: 33,
        user_id: 7,
        status: "FAILED",
        result: None,
        error: Some("failure"),
    };
    assert!(
        execution::complete(&mut capture.transaction(), running_execution(), &event)
            .await
            .is_err()
    );
    assert_eq!(capture.update_attempts(), 1);
    assert!(capture.statements().is_empty());
}

#[test]
fn counters_preserve_subscription_fields_and_silent_semantics() {
    use serde_json::json;
    let original = json!({"spec": {"displayName": "Fixture"}, "status": {"executionCount": 2, "successCount": 1}, "_internal": {"execution_count": 2, "custom": "fixture"}});
    let mut subscription = original.clone();
    assert!(execution::update_statistics(
        &mut subscription,
        "COMPLETED",
        "2026-01-01T00:00:00",
        Some("done"),
        None
    ));
    assert_eq!(subscription["status"]["executionCount"], 3);
    assert_eq!(subscription["status"]["successCount"], 2);
    assert_eq!(subscription["_internal"]["execution_count"], 3);
    assert_eq!(subscription["_internal"]["custom"], "fixture");
    assert_eq!(subscription["spec"], original["spec"]);
    let completed = subscription.clone();
    assert!(!execution::update_statistics(
        &mut subscription,
        "COMPLETED_SILENT",
        "now",
        None,
        None
    ));
    assert_eq!(subscription, completed);
    subscription["spec"]["codeWikiRef"] = json!({"id": 91});
    assert!(execution::update_statistics(
        &mut subscription,
        "COMPLETED_SILENT",
        "now",
        None,
        None
    ));
    assert_eq!(subscription["status"]["executionCount"], 4);
    assert_eq!(subscription["status"]["successCount"], 2);
    assert!(execution::update_statistics(
        &mut subscription,
        "FAILED",
        "now",
        None,
        Some("failure")
    ));
    assert_eq!(subscription["status"]["failureCount"], 1);
    assert_eq!(
        subscription["_internal"]["last_execution_message"],
        "failure"
    );
}

#[tokio::test]
async fn code_wiki_completions_update_statistics_without_generic_notification() {
    use serde_json::json;
    let capture = TransactionCapture::default();
    let subscription = json!({"spec": {"displayName": "Wiki", "codeWikiRef": {"id": 91}}});
    let row = crate::sql_test_support::mysql_row::row(vec![
        ("json", json!(subscription.to_string())),
        ("name", json!("wiki-schedule")),
    ])
    .await;
    capture.rows.lock().unwrap().push_back(row);
    let event = TaskCompletedEvent {
        task_id: 42,
        subtask_id: 33,
        user_id: 7,
        status: "COMPLETED",
        result: None,
        error: None,
    };
    let completed = execution::complete(&mut capture.transaction(), running_execution(), &event)
        .await
        .unwrap()
        .unwrap();
    assert!(!completed.notify);
    assert_eq!(completed.subscription.unwrap()["status"]["successCount"], 1);
    assert!(
        capture
            .statements()
            .iter()
            .any(|query| query.sql.starts_with("UPDATE kinds"))
    );
}

async fn execution_row() -> MysqlRow {
    execution_row_with(11, "RUNNING").await
}

async fn execution_row_with(id: i64, status: &str) -> MysqlRow {
    use serde_json::json;
    crate::sql_test_support::mysql_row::row(vec![
        ("background_executions_id", json!(id)),
        ("background_executions_user_id", json!(7)),
        ("background_executions_subscription_id", json!(22)),
        ("background_executions_task_id", json!(42)),
        ("background_executions_inbox_message_id", json!(0)),
        ("background_executions_status", json!(status)),
        ("background_executions_version", json!(0)),
        ("background_executions_prompt", json!("fixture")),
        ("background_executions_trigger_reason", json!("Scheduled")),
        ("background_executions_result_summary", json!("")),
        ("background_executions_error_message", json!("")),
        ("background_executions_created_at", json!(null)),
    ])
    .await
}

async fn current_round_rows(execution_id: i64, subtask_id: i64) -> [MysqlRow; 2] {
    use serde_json::json;
    let payload =
        json!({"metadata": {"labels": {"backgroundExecutionId": execution_id.to_string()}}});
    let task = crate::sql_test_support::mysql_row::row(vec![
        ("id", json!(42)),
        ("user_id", json!(7)),
        ("kind", json!("Task")),
        ("name", json!("task")),
        ("namespace", json!("default")),
        ("json", json!(payload.to_string())),
    ])
    .await;
    let latest = crate::sql_test_support::mysql_row::row(vec![("id", json!(subtask_id))]).await;
    [task, latest]
}

#[tokio::test]
async fn completed_subscription_callback_writes_execution_terminal_state() {
    let capture = TransactionCapture::default();
    let row = execution_row().await;
    let rows = current_round_rows(11, 33).await;
    capture.rows.lock().unwrap().extend(rows);
    capture.rows.lock().unwrap().push_back(row);
    let redis = NoRedis::default();
    let manager = manager();
    let celery = crate::CeleryBroker::new(None);
    let ctx = Completion {
        mysql: &capture,
        redis: &redis,
        tables: tables(),
        executor_manager: &manager,
        celery: &celery,
    };
    handle_task_completed(
        &ctx,
        &TaskCompletedEvent {
            task_id: 42,
            subtask_id: 33,
            user_id: 7,
            status: "COMPLETED",
            result: None,
            error: None,
        },
    )
    .await;
    let writes = capture.statements();
    assert!(
        writes
            .iter()
            .any(|query| query.sql.starts_with("UPDATE background_executions")),
        "a completed subscription must leave RUNNING: {writes:?}"
    );
    let commands = redis.commands.lock().unwrap();
    assert_eq!(commands.len(), 2);
    assert_eq!(commands[0][0], "PUBLISH");
    let status_event: serde_json::Value = serde_json::from_str(&commands[0][2]).unwrap();
    assert_eq!(status_event["event"], "background:execution_update");
    assert_eq!(status_event["data"][0]["status"], "COMPLETED");
    assert_eq!(commands[1][0], "LPUSH");
    let message: serde_json::Value = serde_json::from_str(&commands[1][2]).unwrap();
    assert_eq!(
        message["headers"]["task"],
        "app.tasks.subscription_completion_tasks.notify_execution"
    );
    assert_eq!(message["headers"]["ignore_result"], true);
    use base64::Engine as _;
    let body = base64::engine::general_purpose::STANDARD
        .decode(message["body"].as_str().unwrap())
        .unwrap();
    let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(body[1], serde_json::json!({"execution_id": 11}));
}

mod broker_tests;
mod round_tests;

#[tokio::test]
async fn subscription_completion_cleans_runtime_and_marks_subtasks_after_commit() {
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let manager =
        ExecutorManager::new(format!("http://{}", listener.local_addr().unwrap())).unwrap();
    let server = tokio::spawn(async move {
        let mut requests = Vec::new();
        for status in ["404 Not Found", "200 OK"] {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            loop {
                let mut chunk = [0; 4096];
                let count = stream.read(&mut chunk).await.unwrap();
                assert!(
                    count > 0,
                    "request must finish before the connection closes"
                );
                bytes.extend_from_slice(&chunk[..count]);
                if let Some(end) = bytes.windows(4).position(|value| value == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..end]);
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    if bytes.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            requests.push(String::from_utf8(bytes).unwrap());
            let body = r#"{"status":"success"}"#;
            stream.write_all(format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        }
        requests
    });
    let capture = TransactionCapture::default();
    let execution = execution_row().await;
    let subscription = crate::sql_test_support::mysql_row::row(vec![
        (
            "json",
            json!(json!({"spec": {"displayName": "Fixture"}}).to_string()),
        ),
        ("name", json!("schedule")),
    ])
    .await;
    let task = crate::sql_test_support::mysql_row::row(vec![
        ("id", json!(42)),
        ("user_id", json!(7)),
        ("kind", json!("Task")),
        ("name", json!("task")),
        ("namespace", json!("default")),
        ("json", json!("{}")),
    ])
    .await;
    let owner = crate::sql_test_support::mysql_row::row(vec![("id", json!(42))]).await;
    let subtask = crate::sql_test_support::mysql_row::row(vec![
        ("id", json!(33)),
        ("user_id", json!(7)),
        ("task_id", json!(42)),
        ("team_id", json!(1)),
        ("title", json!("fixture")),
        ("bot_ids", json!("")),
        ("role", json!("ASSISTANT")),
        ("executor_namespace", json!("default")),
        ("executor_name", json!("fixture-executor")),
    ])
    .await;
    let initial_round = current_round_rows(11, 33).await;
    let cleanup_round = current_round_rows(11, 33).await;
    capture.rows.lock().unwrap().extend(
        initial_round
            .into_iter()
            .chain([execution, subscription])
            .chain(cleanup_round)
            .chain([task, owner]),
    );
    capture.all_rows.lock().unwrap().push_back(vec![subtask]);
    let redis = NoRedis::default();
    let celery = crate::CeleryBroker::new(None);
    let ctx = Completion {
        mysql: &capture,
        redis: &redis,
        tables: tables(),
        executor_manager: &manager,
        celery: &celery,
    };
    let result = json!({"value": "done"});
    let event = TaskCompletedEvent {
        task_id: 42,
        subtask_id: 33,
        user_id: 7,
        status: "COMPLETED",
        result: Some(&result),
        error: None,
    };
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        handle_task_completed(&ctx, &event),
    )
    .await
    .unwrap();
    let requests = server.await.unwrap();
    assert!(requests[0].starts_with("GET /executor-manager/sandboxes/42 "));
    assert!(requests[1].starts_with("POST /executor-manager/executor/delete "));
    assert!(requests[1].contains("fixture-executor"));
    assert_eq!(
        capture.transaction_count(),
        2,
        "status commits before runtime cleanup"
    );
    let statements = capture.statements();
    assert!(
        statements
            .iter()
            .any(|query| query.sql.starts_with("UPDATE kinds"))
    );
    assert!(statements.iter().any(|query| {
        query
            .sql
            .starts_with("UPDATE subtasks_0030 SET executor_deleted_at")
    }));
    let commands = redis.commands.lock().unwrap();
    assert_eq!(commands.iter().filter(|args| args[0] == "LPUSH").count(), 1);
}

/// `on_task_completed`'s one `get_db_session()` block: the execution
/// lookup and the auto-delete probe run inside the same transaction, and
/// the probe keeps the source's two-state `is_active_query()` read.
#[tokio::test]
async fn the_task_completion_reads_run_inside_one_transaction() {
    let capture = TransactionCapture::default();
    let rows = current_round_rows(11, 33).await;
    capture.rows.lock().unwrap().extend(rows);
    let redis = NoRedis::default();
    let manager = manager();
    let celery = crate::CeleryBroker::new(None);
    let ctx = Completion {
        mysql: &capture,
        redis: &redis,
        tables: tables(),
        executor_manager: &manager,
        celery: &celery,
    };
    let event = TaskCompletedEvent {
        task_id: 42,
        subtask_id: 33,
        user_id: 7,
        status: "COMPLETED",
        result: None,
        error: None,
    };
    handle_task_completed(&ctx, &event).await;
    assert_eq!(capture.transaction_count(), 1);
    let statements = capture.statements();
    assert_eq!(statements.len(), 4, "{statements:?}");
    assert!(
        statements[0].sql.ends_with("FOR UPDATE")
            && statements[2]
                .sql
                .contains("background_executions WHERE id=? FOR UPDATE"),
        "{statements:?}"
    );
    assert!(
        statements[3]
            .sql
            .contains("WHERE id = ? AND kind = 'Task' AND is_active IN (1, 2)"),
        "{statements:?}"
    );
}

/// A capture-only `Mysql` handle: the pool issues no statement directly,
/// and `with_transaction` runs the closure against a transaction capture.
#[derive(Clone, Default)]
struct TransactionCapture {
    transactions: std::sync::Arc<std::sync::Mutex<usize>>,
    statements: std::sync::Arc<std::sync::Mutex<Vec<crate::sql_test_support::Query>>>,
    attempts: std::sync::Arc<std::sync::Mutex<usize>>,
    fail_at: Option<usize>,
    rows: std::sync::Arc<std::sync::Mutex<std::collections::VecDeque<MysqlRow>>>,
    values: std::sync::Arc<std::sync::Mutex<Vec<(String, String)>>>,
    all_rows: std::sync::Arc<std::sync::Mutex<std::collections::VecDeque<Vec<MysqlRow>>>>,
    zero_updates: bool,
    executions: std::sync::Arc<std::sync::Mutex<Option<std::collections::BTreeMap<i64, MysqlRow>>>>,
}

impl TransactionCapture {
    /// Fail the Nth update so the batch's abort behavior is observable.
    fn failing_at(attempt: usize) -> Self {
        Self {
            fail_at: Some(attempt),
            ..Self::default()
        }
    }

    fn transaction(&self) -> CapturedTransaction {
        CapturedTransaction {
            statements: std::sync::Arc::clone(&self.statements),
            attempts: std::sync::Arc::clone(&self.attempts),
            fail_at: self.fail_at,
            rows: std::sync::Arc::clone(&self.rows),
            values: std::sync::Arc::clone(&self.values),
            all_rows: std::sync::Arc::clone(&self.all_rows),
            zero_updates: self.zero_updates,
            executions: std::sync::Arc::clone(&self.executions),
        }
    }

    fn transaction_count(&self) -> usize {
        *self.transactions.lock().unwrap()
    }

    fn update_attempts(&self) -> usize {
        *self.attempts.lock().unwrap()
    }

    fn statements(&self) -> Vec<crate::sql_test_support::Query> {
        self.statements.lock().unwrap().clone()
    }
}

struct CapturedTransaction {
    statements: std::sync::Arc<std::sync::Mutex<Vec<crate::sql_test_support::Query>>>,
    attempts: std::sync::Arc<std::sync::Mutex<usize>>,
    fail_at: Option<usize>,
    rows: std::sync::Arc<std::sync::Mutex<std::collections::VecDeque<MysqlRow>>>,
    values: std::sync::Arc<std::sync::Mutex<Vec<(String, String)>>>,
    all_rows: std::sync::Arc<std::sync::Mutex<std::collections::VecDeque<Vec<MysqlRow>>>>,
    zero_updates: bool,
    executions: std::sync::Arc<std::sync::Mutex<Option<std::collections::BTreeMap<i64, MysqlRow>>>>,
}

impl CapturedTransaction {
    fn record<S: AsRef<str>, A: brz_mysql::MysqlArgs>(&self, sql: S, arguments: A) {
        self.statements
            .lock()
            .unwrap()
            .push(crate::sql_test_support::Query {
                sql: sql.as_ref().to_string(),
                args: arguments.len(),
                first_integer: arguments
                    .first_route_value()
                    .and_then(|value| value.as_i64().ok()),
            });
    }
}

impl MysqlTransaction for CapturedTransaction {
    async fn execute<S, A>(
        &mut self,
        sql: S,
        arguments: A,
    ) -> brz_mysql::MysqlResult<brz_mysql::MysqlExecution>
    where
        S: AsRef<str> + Send,
        A: brz_mysql::MysqlArgs + Send,
    {
        let mut attempts = self.attempts.lock().unwrap();
        *attempts += 1;
        if self.fail_at == Some(*attempts) {
            return Err(brz_mysql::MysqlError::RowNotFound);
        }
        drop(attempts);
        if let Some(value) = arguments
            .first_route_value()
            .and_then(|value| value.as_str().ok())
        {
            self.values
                .lock()
                .unwrap()
                .push((sql.as_ref().to_owned(), value.to_owned()));
        }
        self.record(sql, arguments);
        Ok(brz_mysql::MysqlExecution {
            rows_affected: if self.zero_updates { 0 } else { 1 },
            last_insert_id: 0,
        })
    }

    async fn fetch_optional<S, A, T>(
        &mut self,
        sql: S,
        arguments: A,
    ) -> brz_mysql::MysqlResult<Option<T>>
    where
        S: AsRef<str> + Send,
        A: brz_mysql::MysqlArgs + Send,
        T: brz_mysql::FromMysqlRow + Send,
    {
        let execution_id = arguments
            .first_route_value()
            .and_then(|value| value.as_i64().ok());
        let is_execution = sql
            .as_ref()
            .contains("FROM background_executions WHERE id=?");
        self.record(sql, arguments);
        if is_execution && let Some(executions) = self.executions.lock().unwrap().as_mut() {
            return executions
                .remove(&execution_id.expect("execution lookup must use its exact ID"))
                .map(T::from_mysql_row)
                .transpose();
        }
        self.rows
            .lock()
            .unwrap()
            .pop_front()
            .map(T::from_mysql_row)
            .transpose()
    }

    async fn fetch_one<S, A, T>(&mut self, _: S, _: A) -> brz_mysql::MysqlResult<T>
    where
        S: AsRef<str> + Send,
        A: brz_mysql::MysqlArgs + Send,
        T: brz_mysql::FromMysqlRow + Send,
    {
        panic!("transaction capture does not serve single-row reads")
    }

    fn fetch<'transaction, S, A, T>(
        &'transaction mut self,
        _: S,
        _: A,
    ) -> impl futures_util::Stream<Item = brz_mysql::MysqlResult<T>> + Send + 'transaction
    where
        S: AsRef<str> + Send + 'transaction,
        A: brz_mysql::MysqlArgs + Send + 'transaction,
        T: brz_mysql::FromMysqlRow + Send + 'transaction,
    {
        futures_util::stream::once(async { panic!("transaction capture does not stream") })
    }

    async fn fetch_all<S, A, T>(&mut self, sql: S, arguments: A) -> brz_mysql::MysqlResult<Vec<T>>
    where
        S: AsRef<str> + Send,
        A: brz_mysql::MysqlArgs + Send,
        T: brz_mysql::FromMysqlRow + Send,
    {
        self.record(sql, arguments);
        self.all_rows
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_default()
            .into_iter()
            .map(T::from_mysql_row)
            .collect()
    }
}

impl brz_mysql::Mysql for TransactionCapture {
    type Transaction = CapturedTransaction;

    fn with_route<R: brz_mysql::MysqlRouting + 'static>(&self, _: R) -> brz_mysql::MysqlService {
        panic!("the handler opens exactly one transaction")
    }

    fn route<K: brz_mysql::MysqlRouteKey>(&self, _: K) -> Self {
        self.clone()
    }

    async fn execute<S, A>(&self, _: S, _: A) -> brz_mysql::MysqlResult<brz_mysql::MysqlExecution>
    where
        S: AsRef<str> + Send,
        A: brz_mysql::MysqlArgs + Send,
    {
        panic!("the executor updates must run inside the transaction")
    }

    async fn fetch_optional<S, A, T>(&self, _: S, _: A) -> brz_mysql::MysqlResult<Option<T>>
    where
        S: AsRef<str> + Send,
        A: brz_mysql::MysqlArgs + Send,
        T: brz_mysql::FromMysqlRow + Send,
    {
        panic!("the handler reads inside the transaction")
    }

    async fn fetch_one<S, A, T>(&self, _: S, _: A) -> brz_mysql::MysqlResult<T>
    where
        S: AsRef<str> + Send,
        A: brz_mysql::MysqlArgs + Send,
        T: brz_mysql::FromMysqlRow + Send,
    {
        panic!("the handler reads inside the transaction")
    }

    fn fetch<'service, S, A, T>(
        &'service self,
        _: S,
        _: A,
    ) -> impl futures_util::Stream<Item = brz_mysql::MysqlResult<T>> + Send + 'service
    where
        S: AsRef<str> + Send + 'service,
        A: brz_mysql::MysqlArgs + Send + 'service,
        T: brz_mysql::FromMysqlRow + Send + 'service,
    {
        futures_util::stream::once(async { panic!("the handler reads inside the transaction") })
    }

    async fn fetch_all<S, A, T>(&self, _: S, _: A) -> brz_mysql::MysqlResult<Vec<T>>
    where
        S: AsRef<str> + Send,
        A: brz_mysql::MysqlArgs + Send,
        T: brz_mysql::FromMysqlRow + Send,
    {
        panic!("the handler reads inside the transaction")
    }

    async fn with_transaction<T, F>(&self, operation: F) -> brz_mysql::MysqlResult<T>
    where
        T: Send,
        F: for<'transaction> AsyncFnOnce(
                &'transaction mut Self::Transaction,
            ) -> brz_mysql::MysqlResult<T>
            + Send,
    {
        *self.transactions.lock().unwrap() += 1;
        let mut transaction = self.transaction();
        operation(&mut transaction).await
    }
}

/// `_db_session`'s flush: every selected subtask update joins the caller's
/// transaction, and the helper never sends the old ad-hoc `COMMIT`.
#[tokio::test]
async fn the_executor_deleted_updates_join_the_session_transaction() {
    let capture = TransactionCapture::default();
    let sql = sql::update_subtask_executor_deleted(tables());
    let updates = vec![
        ("2026-10-21 15:45:26.537475".to_string(), 801406538589674),
        ("2026-10-21 15:45:26.537475".to_string(), 801406538589675),
    ];

    let mut transaction = capture.transaction();
    apply_executor_deleted_updates(&mut transaction, &sql, &updates)
        .await
        .expect("batch applies");

    assert_eq!(capture.update_attempts(), 2);
    let statements = capture.statements();
    assert_eq!(statements.len(), 2, "{statements:?}");
    for statement in &statements {
        assert_eq!(statement.sql, sql, "{statement:?}");
        assert_eq!(statement.args, 3, "{statement:?}");
    }
    assert!(
        statements.iter().all(|statement| statement.sql != "COMMIT"),
        "{statements:?}"
    );
}

/// A failed update aborts the batch: the source `db_session` rolls the
/// whole flush back, so no later subtask is updated.
#[tokio::test]
async fn a_failed_executor_deleted_update_aborts_the_batch() {
    let capture = TransactionCapture::failing_at(2);
    let sql = sql::update_subtask_executor_deleted(tables());
    let updates = vec![
        ("2026-10-21 15:45:26.537475".to_string(), 801406538589674),
        ("2026-10-21 15:45:26.537475".to_string(), 801406538589675),
    ];

    let mut transaction = capture.transaction();
    let outcome = apply_executor_deleted_updates(&mut transaction, &sql, &updates).await;

    assert!(outcome.is_err(), "{outcome:?}");
    assert_eq!(capture.update_attempts(), 2);
    assert_eq!(capture.statements().len(), 1);
}
