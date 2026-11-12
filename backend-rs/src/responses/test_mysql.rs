// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use brz_mysql::{
    FromMysqlRow, Mysql, MysqlArgs, MysqlExecution, MysqlResult, MysqlRouteKey, MysqlRouting,
    MysqlRow, MysqlService, MysqlTransaction,
};
use serde_json::json;

pub(super) const TASK_ID: i64 = 424_242;
pub(super) const SUBTASK_ID: i64 = 424_243;

/// Holds the first `fetch_optional` until released and signals that it was
/// reached, so a test can stop persistence mid-step without a timer.
#[derive(Default)]
pub(super) struct Gate {
    first_call: AtomicBool,
    reached: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    release: tokio::sync::Notify,
}

impl Gate {
    pub(super) fn new() -> (Arc<Self>, tokio::sync::oneshot::Receiver<()>) {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let gate = Arc::new(Self {
            first_call: AtomicBool::new(true),
            reached: Mutex::new(Some(sender)),
            release: tokio::sync::Notify::new(),
        });
        (gate, receiver)
    }

    async fn hold(&self) {
        if !self.first_call.swap(false, Ordering::SeqCst) {
            return;
        }
        if let Some(sender) = self.reached.lock().unwrap().take() {
            let _ = sender.send(());
        }
        self.release.notified().await;
    }

    pub(super) fn release(&self) {
        self.release.notify_one();
    }
}

/// Records the statements and transaction outcome. Each fixture row is consumed
/// once to keep the stream and cancellation tests independent of MySQL I/O.
#[derive(Clone, Default)]
pub(super) struct RecordingMysql {
    statements: Arc<Mutex<Vec<String>>>,
    gate: Option<Arc<Gate>>,
    rows: Arc<Mutex<Vec<TerminalRows>>>,
    fail_parent_update: bool,
    /// Fires once when the terminal completion path issues its first read.
    terminal_signal: Option<Arc<Mutex<Option<tokio::sync::oneshot::Sender<()>>>>>,
}

impl RecordingMysql {
    pub(super) async fn with_terminal_rows(self, terminal_status: &'static str) -> Self {
        let rows = TerminalRows::load(terminal_status).await;
        self.rows.lock().unwrap().push(rows);
        self
    }

    pub(super) fn gated(gate: Arc<Gate>) -> Self {
        Self {
            gate: Some(gate),
            ..Self::default()
        }
    }

    pub(super) fn signaling() -> (Self, tokio::sync::oneshot::Receiver<()>) {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        (
            Self {
                terminal_signal: Some(Arc::new(Mutex::new(Some(sender)))),
                ..Self::default()
            },
            receiver,
        )
    }

    pub(super) fn failing_parent_update() -> Self {
        Self {
            fail_parent_update: true,
            ..Self::default()
        }
    }

    fn record(&self, sql: &str) {
        self.statements
            .lock()
            .unwrap()
            .push(sql.split_whitespace().collect::<Vec<_>>().join(" "));
    }

    pub(super) fn statements(&self) -> Vec<String> {
        self.statements.lock().unwrap().clone()
    }
}

impl Mysql for RecordingMysql {
    type Transaction = RecordingTransaction;

    fn with_route<R: MysqlRouting + 'static>(&self, _: R) -> MysqlService {
        panic!("the consumer must reuse the configured handle")
    }

    fn route<K: MysqlRouteKey>(&self, _: K) -> Self {
        self.clone()
    }

    async fn fetch_optional<S, A, T>(&self, sql: S, _: A) -> MysqlResult<Option<T>>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        self.record(sql.as_ref());
        Ok(None)
    }

    async fn fetch_all<S, A, T>(&self, sql: S, _: A) -> MysqlResult<Vec<T>>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        self.record(sql.as_ref());
        Ok(Vec::new())
    }

    async fn execute<S, A>(&self, sql: S, _: A) -> MysqlResult<MysqlExecution>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
    {
        self.record(sql.as_ref());
        Ok(MysqlExecution {
            rows_affected: 1,
            last_insert_id: 0,
        })
    }

    async fn fetch_one<S, A, T>(&self, _: S, _: A) -> MysqlResult<T>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        Err(brz_mysql::MysqlError::RowNotFound)
    }

    fn fetch<'a, S, A, T>(
        &'a self,
        _: S,
        _: A,
    ) -> impl futures_util::Stream<Item = MysqlResult<T>> + Send + 'a
    where
        S: AsRef<str> + Send + 'a,
        A: MysqlArgs + Send + 'a,
        T: FromMysqlRow + Send + 'a,
    {
        futures_util::stream::empty()
    }

    async fn with_transaction<T, F>(&self, operation: F) -> MysqlResult<T>
    where
        T: Send,
        F: for<'a> AsyncFnOnce(&'a mut Self::Transaction) -> MysqlResult<T> + Send,
    {
        let mut transaction = RecordingTransaction {
            mysql: self.clone(),
            rows: self.rows.lock().unwrap().pop(),
        };
        let result = operation(&mut transaction).await;
        self.record(if result.is_ok() { "COMMIT" } else { "ROLLBACK" });
        result
    }
}

struct TerminalRows {
    task: Option<MysqlRow>,
    subtask: Option<MysqlRow>,
    assistant: Option<MysqlRow>,
}

impl TerminalRows {
    async fn load(terminal_status: &'static str) -> Self {
        use crate::sql_test_support::mysql_rows::{MysqlRows, Value};
        let fixture = MysqlRows::start(move |sql| {
            if sql.ends_with("fixture_task") {
                return vec![
                    ("id", Value::I64(TASK_ID)),
                    ("user_id", Value::I64(6501)),
                    ("kind", Value::Text("Task".into())),
                    ("name", Value::Text("test-task".into())),
                    ("namespace", Value::Text("default".into())),
                    (
                        "json",
                        Value::Text(json!({"status": {"status": "RUNNING"}}).to_string()),
                    ),
                ];
            }
            let status = if sql.ends_with("fixture_assistant") {
                terminal_status
            } else {
                "RUNNING"
            };
            vec![
                ("id", Value::I64(SUBTASK_ID)),
                ("user_id", Value::I64(6501)),
                ("task_id", Value::I64(TASK_ID)),
                ("team_id", Value::I64(0)),
                ("title", Value::Text(String::new())),
                ("bot_ids", Value::Text("[]".into())),
                ("role", Value::Text("ASSISTANT".into())),
                ("executor_namespace", Value::Text(String::new())),
                ("executor_name", Value::Text(String::new())),
                ("executor_deleted_at", Value::Null),
                ("prompt", Value::Text(String::new())),
                ("message_id", Value::I64(2)),
                ("parent_id", Value::I64(1)),
                ("status", Value::Text(status.into())),
                ("progress", Value::I64(100)),
                ("result", Value::Text(json!({"value": "hello"}).to_string())),
                ("error_message", Value::Null),
                ("created_at", Value::DateTime),
                ("updated_at", Value::DateTime),
                ("completed_at", Value::Null),
            ]
        })
        .await;
        let task = fixture
            .mysql
            .fetch_one("SELECT fixture_task", ())
            .await
            .unwrap();
        let subtask = fixture
            .mysql
            .fetch_one("SELECT fixture_subtask", ())
            .await
            .unwrap();
        let assistant = fixture
            .mysql
            .fetch_one("SELECT fixture_assistant", ())
            .await
            .unwrap();
        Self {
            task: Some(task),
            subtask: Some(subtask),
            assistant: Some(assistant),
        }
    }
}

pub(super) struct RecordingTransaction {
    mysql: RecordingMysql,
    rows: Option<TerminalRows>,
}

impl MysqlTransaction for RecordingTransaction {
    async fn execute<S, A>(&mut self, sql: S, _: A) -> MysqlResult<MysqlExecution>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
    {
        self.mysql.record(sql.as_ref());
        if self.mysql.fail_parent_update && sql.as_ref().starts_with("UPDATE tasks_") {
            return Err(brz_mysql::MysqlError::QueryTimedOut);
        }
        Ok(MysqlExecution {
            rows_affected: 1,
            last_insert_id: 0,
        })
    }

    async fn fetch_optional<S, A, T>(&mut self, sql: S, _: A) -> MysqlResult<Option<T>>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        self.mysql.record(sql.as_ref());
        let sql = sql.as_ref();
        if sql.contains("subtasks_") && sql.ends_with("FOR UPDATE") {
            if let Some(signal) = &self.mysql.terminal_signal
                && let Some(sender) = signal.lock().unwrap().take()
            {
                let _ = sender.send(());
            }
            if let Some(gate) = &self.mysql.gate {
                gate.hold().await;
            }
            return self
                .rows
                .as_mut()
                .and_then(|rows| rows.subtask.take())
                .map(T::from_mysql_row)
                .transpose();
        }
        if sql.contains("tasks_") && sql.ends_with("FOR UPDATE") {
            return self
                .rows
                .as_mut()
                .and_then(|rows| rows.task.take())
                .map(T::from_mysql_row)
                .transpose();
        }
        Ok(None)
    }

    async fn fetch_one<S, A, T>(&mut self, _: S, _: A) -> MysqlResult<T>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        Err(brz_mysql::MysqlError::RowNotFound)
    }

    async fn fetch_all<S, A, T>(&mut self, sql: S, _: A) -> MysqlResult<Vec<T>>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        self.mysql.record(sql.as_ref());
        if sql.as_ref().contains("FROM subtasks_") {
            return self
                .rows
                .as_mut()
                .and_then(|rows| rows.assistant.take())
                .map(T::from_mysql_row)
                .into_iter()
                .collect();
        }
        Ok(Vec::new())
    }

    fn fetch<'a, S, A, T>(
        &'a mut self,
        _: S,
        _: A,
    ) -> impl futures_util::Stream<Item = MysqlResult<T>> + Send + 'a
    where
        S: AsRef<str> + Send + 'a,
        A: MysqlArgs + Send + 'a,
        T: FromMysqlRow + Send + 'a,
    {
        futures_util::stream::empty()
    }
}
