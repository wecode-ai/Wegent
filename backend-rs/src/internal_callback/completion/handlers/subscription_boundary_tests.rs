// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Focused tests for the task-completion transaction boundary.
//!
//! `on_task_completed` (`app/services/subscription/task_completion_handler.py:
//! 78-181`) opens one session and resolves the execution, applies
//! `update_execution_status` and writes the subscription statistics inside it;
//! the commit at the end of that status update closes the block. Recording
//! `20261027105553` (case `f742360f-b080-4725-b980-6af764719500`) shows the
//! boundary as query sequences 5..11 on one connection — the lookup, the status
//! read, the CAS write, the reload, the statistics read and its write, then
//! `COMMIT` — while the later notification block is autocommit.
#![cfg(test)]

use brz_mysql::Json;
use brz_mysql::{
    FromMysqlRow, Mysql, MysqlArgs, MysqlExecution, MysqlResult, MysqlRouteKey, MysqlRouting,
    MysqlService, MysqlTransaction, MysqlTransactionService,
};
use brz_redis::{EncodeRedisArg, EncodeRedisArgs, FromRedisBulk, Redis, RedisResult, RedisValues};
use chrono::NaiveDateTime;
use std::sync::{Arc, Mutex};

use super::handle_task_completed;
use crate::background_jobs::subscription::completion::{
    after_status, apply_status, terminal_result,
};
use crate::background_jobs::subscription::model::{self, Execution};
use crate::background_jobs::subscription::state;
use crate::background_jobs::subscription::state::write_statistics;
use crate::internal_callback::completion::{Completion, Tables, TaskCompletedEvent};

/// The completion issues no Redis command before a status change is applied.
struct NoRedis;

impl Redis for NoRedis {
    async fn get<K, R>(&self, _key: K) -> RedisResult<Option<R>>
    where
        K: EncodeRedisArg + Send,
        R: FromRedisBulk + Send,
    {
        unreachable!("the completion issues no Redis read")
    }

    async fn set<K, V>(&self, _key: K, _value: V) -> RedisResult<()>
    where
        K: EncodeRedisArg + Send,
        V: EncodeRedisArg + Send,
    {
        unreachable!("the completion issues no Redis write")
    }

    async fn mget<K, R>(&self, _keys: K) -> RedisResult<Vec<Option<R>>>
    where
        K: EncodeRedisArgs + Send,
        R: FromRedisBulk + Send,
    {
        unreachable!("the completion issues no Redis read")
    }

    async fn del_many<K>(&self, _keys: K) -> RedisResult<i64>
    where
        K: EncodeRedisArgs + Send,
    {
        unreachable!("the completion issues no Redis write")
    }

    async fn pfcount<K>(&self, _keys: K) -> RedisResult<i64>
    where
        K: EncodeRedisArgs + Send,
    {
        unreachable!("the completion issues no Redis read")
    }

    async fn hget<K, F, R>(&self, _key: K, _field: F) -> RedisResult<Option<R>>
    where
        K: EncodeRedisArg + Send,
        F: EncodeRedisArg + Send,
        R: FromRedisBulk + Send,
    {
        unreachable!("the completion issues no Redis read")
    }

    async fn hmget<K, F, R>(&self, _key: K, _fields: F) -> RedisResult<RedisValues<R>>
    where
        K: EncodeRedisArg + Send,
        F: EncodeRedisArgs + Send,
        R: FromRedisBulk + Send,
    {
        unreachable!("the completion issues no Redis read")
    }
}

fn tables() -> Tables {
    Tables {
        tasks: "tasks_0030",
        subtasks: "subtasks_0030",
    }
}

fn normalize(sql: &str) -> String {
    sql.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn running_execution() -> Execution {
    let clock = NaiveDateTime::default();
    Execution {
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

fn completed_event(execution: &Execution) -> TaskCompletedEvent<'static> {
    TaskCompletedEvent {
        task_id: execution.task_id,
        user_id: execution.user_id,
        status: "COMPLETED",
        subtask_id: 0,
        result: None,
        error: None,
    }
}

/// Records the statements one transaction carries and its commit.
#[derive(Default)]
struct RecordingTransaction {
    statements: Vec<String>,
    commits: usize,
}

impl RecordingTransaction {
    fn record<S: AsRef<str>>(&mut self, sql: S) {
        self.statements.push(normalize(sql.as_ref()));
    }
}

impl MysqlTransaction for RecordingTransaction {
    async fn execute<S, A>(&mut self, sql: S, _: A) -> MysqlResult<MysqlExecution>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
    {
        self.record(sql);
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
        self.record(sql);
        Ok(None)
    }

    async fn fetch_one<S, A, T>(&mut self, _: S, _: A) -> MysqlResult<T>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        panic!("the completion reads no single-row query")
    }

    fn fetch<'a, S, A, T>(
        &'a mut self,
        _: S,
        _: A,
    ) -> impl futures_util::Stream<Item = MysqlResult<T>>
    where
        S: AsRef<str> + Send + 'a,
        A: MysqlArgs + Send + 'a,
        T: FromMysqlRow + Send + 'a,
    {
        futures_util::stream::once(async { panic!("the completion does not stream") })
    }

    async fn fetch_all<S, A, T>(&mut self, _: S, _: A) -> MysqlResult<Vec<T>>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        Ok(Vec::new())
    }
}

/// A `Mysql` handle that runs each transaction against a
/// [`RecordingTransaction`] and counts the boundaries it opened. Statements
/// issued outside a transaction fail the test.
#[derive(Default)]
struct BoundaryLog {
    transactions: Arc<Mutex<Vec<RecordingTransaction>>>,
}

impl BoundaryLog {
    fn statements(&self) -> Vec<String> {
        self.transactions
            .lock()
            .unwrap()
            .iter()
            .flat_map(|transaction| transaction.statements.clone())
            .collect()
    }
}

impl Mysql for BoundaryLog {
    type Transaction = RecordingTransaction;

    fn with_route<R: MysqlRouting + 'static>(&self, _: R) -> MysqlService {
        panic!("the task-completion handler routes its own handle")
    }

    fn route<K: MysqlRouteKey>(&self, _: K) -> Self {
        Self {
            transactions: Arc::clone(&self.transactions),
        }
    }

    async fn fetch_optional<S, A, T>(&self, sql: S, _: A) -> MysqlResult<Option<T>>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        panic!(
            "statement outside the handler's transaction: {}",
            normalize(sql.as_ref())
        )
    }

    async fn fetch_all<S, A, T>(&self, _: S, _: A) -> MysqlResult<Vec<T>>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        Ok(Vec::new())
    }

    async fn execute<S, A>(&self, sql: S, _: A) -> MysqlResult<MysqlExecution>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
    {
        panic!(
            "statement outside the handler's transaction: {}",
            normalize(sql.as_ref())
        )
    }

    async fn fetch_one<S, A, T>(&self, _: S, _: A) -> MysqlResult<T>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        panic!("the completion reads no single-row query")
    }

    fn fetch<'a, S, A, T>(&'a self, _: S, _: A) -> impl futures_util::Stream<Item = MysqlResult<T>>
    where
        S: AsRef<str> + Send + 'a,
        A: MysqlArgs + Send + 'a,
        T: FromMysqlRow + Send + 'a,
    {
        futures_util::stream::once(async { panic!("the completion does not stream") })
    }

    async fn with_transaction<T, F>(&self, body: F) -> MysqlResult<T>
    where
        T: Send,
        F: for<'a> AsyncFnOnce(&'a mut Self::Transaction) -> MysqlResult<T> + Send,
    {
        let mut transaction = RecordingTransaction::default();
        let output = body(&mut transaction).await?;
        transaction.commits += 1;
        self.transactions.lock().unwrap().push(transaction);
        Ok(output)
    }
}

fn context<'a>(
    mysql: &'a BoundaryLog,
    redis: &'a NoRedis,
    manager: &'a crate::executor_manager::ExecutorManager,
) -> Completion<'a, BoundaryLog, NoRedis> {
    Completion {
        app: None,
        mysql,
        redis,
        tables: tables(),
        executor_manager: manager,
    }
}

/// The execution lookup and the completion share one boundary: the handler
/// opens exactly one transaction, the lookup statements run inside it, and it
/// commits once. No statement reaches the pooled handle.
#[tokio::test]
async fn the_execution_lookup_runs_inside_the_handler_transaction() {
    let mysql = BoundaryLog::default();
    let redis = NoRedis;
    let manager = crate::executor_manager::ExecutorManager::new("http://127.0.0.1:1")
        .expect("executor-manager client");
    let ctx = context(&mysql, &redis, &manager);
    let event = completed_event(&running_execution());

    handle_task_completed(&ctx, &event).await;

    let transactions = mysql.transactions.lock().unwrap();
    assert_eq!(
        transactions.len(),
        1,
        "one boundary, not one per statement: {:?}",
        mysql.statements()
    );
    assert_eq!(transactions[0].commits, 1, "the boundary commits once");
    let statements = &transactions[0].statements;
    assert!(
        statements[0].contains("background_executions WHERE background_executions.task_id = ?")
            && statements[0].contains("status IN ('PENDING', 'RUNNING')"),
        "{statements:?}"
    );
    assert!(
        statements[1].starts_with("SELECT")
            && statements[1].contains("FROM background_executions")
            && statements[1].contains("ORDER BY background_executions.id DESC"),
        "the status-free fallback read stays inside the boundary: {statements:?}"
    );
    assert!(
        statements
            .iter()
            .any(|statement| statement.contains("FROM `tasks_0030`")),
        "the auto-delete cleanup read shares the boundary: {statements:?}"
    );
}

/// `on_task_completed` returns for an execution that already reached a terminal
/// state before `update_execution_status` runs
/// (`app/services/subscription/task_completion_handler.py:91-98`), and
/// `update_execution_status` repeats the guard on the row it reads
/// (`execution.py:836-841`). Both are satisfied here, so a terminal execution
/// prepares no statement at all and leaves the caller's transaction untouched.
#[tokio::test]
async fn a_terminal_execution_issues_no_statement() {
    for terminal in ["COMPLETED", "COMPLETED_SILENT", "FAILED", "CANCELLED"] {
        let mut transaction = RecordingTransaction::default();
        let mut execution = running_execution();
        execution.status = terminal.to_string();
        let event = completed_event(&execution);
        let result = terminal_result(&event);

        let applied = apply_status(&mut transaction, &event, &execution, &result)
            .await
            .expect("a terminal execution is not an error");

        assert!(applied.is_none(), "{terminal} must not be re-applied");
        assert!(
            transaction.statements.is_empty(),
            "{terminal} prepared statements: {:?}",
            transaction.statements
        );
        assert_eq!(transaction.commits, 0, "{terminal} committed the boundary");
    }
}

/// `apply_status` writes through the caller's transaction: the CAS read is the
/// boundary's first statement and nothing is committed here.
#[tokio::test]
async fn the_status_cas_runs_on_the_callers_transaction() {
    let mut transaction = RecordingTransaction::default();
    let execution = running_execution();
    let event = completed_event(&execution);
    let result = terminal_result(&event);

    let applied = apply_status(&mut transaction, &event, &execution, &result)
        .await
        .expect("the CAS read is answered by the fake");

    assert!(applied.is_none(), "the fake returns no row");
    assert_eq!(
        transaction.statements.len(),
        1,
        "{:?}",
        transaction.statements
    );
    assert_eq!(
        transaction.statements[0],
        normalize(&model::execution_status_read())
    );
    assert_eq!(transaction.commits, 0, "the caller owns the commit");
}

/// A caller that only needs the status change still gets one boundary of its
/// own, opened by [`state::transition`] around the same CAS statements.
#[tokio::test]
async fn the_pooled_transition_opens_one_boundary() {
    let mysql = BoundaryLog::default();

    let changed =
        state::transition::<_, NoRedis>(&mysql, None, 2_539_501, "COMPLETED", Some("done"), None)
            .await
            .expect("the CAS read is answered by the fake");

    assert!(!changed, "the fake returns no row");
    let transactions = mysql.transactions.lock().unwrap();
    assert_eq!(transactions.len(), 1);
    assert_eq!(transactions[0].commits, 1);
    assert_eq!(
        transactions[0].statements,
        vec![normalize(&model::execution_status_read())]
    );
}

/// The statistics write belongs to the status transaction, not to the block that
/// runs after it: `_update_subscription_statistics` mutates the ORM entity and
/// lets the session flush it, which is why the recorded write is query sequence
/// 10 and the commit is 11. Driving the write with a transaction handle proves
/// it lands inside the caller's boundary and that the boundary is still open.
#[tokio::test]
async fn the_statistics_write_runs_on_the_callers_transaction() {
    let mut transaction = RecordingTransaction::default();
    let mut subscription = crate::background_jobs::subscription::model::Subscription {
        id: 264_564,
        user_id: 3650,
        name: "sub-household-hotsearch".to_string(),
        json: Json(serde_json::json!({
            "apiVersion": "agent.wegent.io/v1",
            "kind": "Subscription",
            "spec": {},
            "status": {"state": "Available", "executionCount": 2254},
            "_internal": {"execution_count": 2254}
        })),
        is_active: 1,
    };
    let now = crate::background_jobs::subscription::state::now_micros();

    write_statistics(
        &mut transaction,
        &mut subscription,
        "COMPLETED",
        "done",
        "",
        now,
    )
    .await
    .expect("the fake accepts the write");

    assert_eq!(
        transaction.commits, 0,
        "the caller's boundary is still open after the statistics write"
    );
    assert_eq!(
        transaction.statements.len(),
        1,
        "{:?}",
        transaction.statements
    );
    assert_eq!(
        transaction.statements[0],
        "UPDATE kinds SET json=?, updated_at=now() WHERE kinds.id = ?"
    );
    assert_eq!(
        subscription.json.0["status"]["lastExecutionStatus"], "COMPLETED",
        "the source statistics ride the CRD's status object"
    );
    assert_eq!(subscription.json.0["status"]["executionCount"], 2255);
    assert_eq!(subscription.json.0["_internal"]["execution_count"], 2255);
    assert_eq!(
        subscription.json.0["_internal"]["last_execution_message"],
        "done"
    );
}

/// A `Mysql` handle that records the statements a post-commit block issues and
/// answers every read with no row, so the block's first reads are observable.
#[derive(Default)]
struct RecordingMysql {
    statements: Mutex<Vec<String>>,
}

impl Mysql for RecordingMysql {
    type Transaction = MysqlTransactionService;

    fn with_route<R: MysqlRouting + 'static>(&self, _: R) -> MysqlService {
        panic!("the post-commit block routes no query in this test")
    }

    fn route<K: MysqlRouteKey>(&self, _: K) -> Self {
        Self::default()
    }

    async fn fetch_optional<S, A, T>(&self, sql: S, _: A) -> MysqlResult<Option<T>>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        self.statements
            .lock()
            .unwrap()
            .push(normalize(sql.as_ref()));
        Ok(None)
    }

    async fn fetch_all<S, A, T>(&self, _: S, _: A) -> MysqlResult<Vec<T>>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        Ok(Vec::new())
    }

    async fn execute<S, A>(&self, _: S, _: A) -> MysqlResult<MysqlExecution>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
    {
        panic!("the post-commit block writes only through its own helpers")
    }

    async fn fetch_one<S, A, T>(&self, _: S, _: A) -> MysqlResult<T>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        panic!("the post-commit block reads no single-row query")
    }

    fn fetch<'a, S, A, T>(&'a self, _: S, _: A) -> impl futures_util::Stream<Item = MysqlResult<T>>
    where
        S: AsRef<str> + Send + 'a,
        A: MysqlArgs + Send + 'a,
        T: FromMysqlRow + Send + 'a,
    {
        futures_util::stream::once(async { panic!("the post-commit block does not stream") })
    }

    async fn with_transaction<T, F>(&self, _: F) -> MysqlResult<T>
    where
        T: Send,
        F: for<'a> AsyncFnOnce(&'a mut Self::Transaction) -> MysqlResult<T> + Send,
    {
        panic!("the post-commit block commits nothing")
    }
}

impl RecordingMysql {
    fn statements(&self) -> Vec<String> {
        self.statements.lock().unwrap().clone()
    }
}

/// The status update commits before it emits, and the commit expires the ORM
/// instance (`app/services/subscription/execution.py:918,937`): the first
/// statement of the post-commit block is therefore the execution's own reload,
/// before the emitter reads the subscription.
#[tokio::test]
async fn the_post_commit_block_reloads_the_execution_first() {
    let mysql = RecordingMysql::default();
    let redis = NoRedis;
    let manager = crate::executor_manager::ExecutorManager::new("http://127.0.0.1:1")
        .expect("executor-manager client");
    let ctx = Completion {
        app: None,
        mysql: &mysql,
        redis: &redis,
        tables: tables(),
        executor_manager: &manager,
    };
    let execution = running_execution();
    let event = completed_event(&execution);
    let result = terminal_result(&event);

    let outcome = after_status(&ctx, &event, &execution, &result)
        .await
        .expect("the reload read is answered by the fake");

    assert!(outcome.is_none(), "an absent row ends the block");
    assert_eq!(
        mysql.statements(),
        vec![normalize(&model::execution_by_id())],
        "only the reload runs before the block stops"
    );
}
