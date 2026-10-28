// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Focused tests for the background dispatch supervisor and its real
//! chat-shell consumer (`sse_sync::collect`).
#![cfg(test)]

use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use brz_mysql::{
    FromMysqlRow, Mysql, MysqlArgs, MysqlExecution, MysqlResult, MysqlRouteKey, MysqlRouting,
    MysqlService, MysqlTransaction,
};
use brz_redis::{EncodeRedisArg, EncodeRedisArgs, FromRedisBulk, RedisResult, SetOptions};
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use super::*;
use crate::executor_manager::ExecutorManager;
use crate::internal_callback::completion::Tables;
use crate::responses::create::dispatch::ExecutionRequest;

const TASK_ID: i64 = 424_242;
const SUBTASK_ID: i64 = 424_243;

fn tables() -> Tables {
    Tables {
        tasks: "tasks_0424",
        subtasks: "subtasks_0424",
    }
}

/// Records every statement the completion path issues. Reads return no row,
/// so the terminal update stops after its first read (the production code's
/// own missing-row branch).
///
/// This is why the lifecycle test asserts the routed by-id SELECT instead of a
/// literal UPDATE: `brz_mysql::MysqlRow` has no public constructor and the
/// existing fake server only returns parse errors, so the recorder cannot
/// produce the row that would reach `execute`.
#[derive(Clone, Default)]
struct RecordingMysql {
    statements: Arc<Mutex<Vec<String>>>,
}

impl RecordingMysql {
    fn record(&self, sql: &str) {
        self.statements
            .lock()
            .unwrap()
            .push(sql.split_whitespace().collect::<Vec<_>>().join(" "));
    }

    fn statements(&self) -> Vec<String> {
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
            statements: Arc::clone(&self.statements),
        };
        operation(&mut transaction).await
    }
}

/// The consumer transaction: records its reads and executes every write.
struct RecordingTransaction {
    statements: Arc<Mutex<Vec<String>>>,
}

impl RecordingTransaction {
    fn record(&self, sql: &str) {
        self.statements
            .lock()
            .unwrap()
            .push(sql.split_whitespace().collect::<Vec<_>>().join(" "));
    }
}

impl MysqlTransaction for RecordingTransaction {
    async fn execute<S, A>(&mut self, sql: S, _: A) -> MysqlResult<MysqlExecution>
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

    async fn fetch_optional<S, A, T>(&mut self, sql: S, _: A) -> MysqlResult<Option<T>>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        self.record(sql.as_ref());
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
        self.record(sql.as_ref());
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

/// Records every Redis command the consumer issues, in call order.
#[derive(Clone, Default)]
struct RecordingRedis {
    calls: Arc<Mutex<Vec<String>>>,
}

impl RecordingRedis {
    fn key<K: EncodeRedisArg>(key: &K) -> String {
        key.as_encoded_bytes()
            .map(|bytes| String::from_utf8_lossy(bytes).into_owned())
            .unwrap_or_default()
    }

    fn record(&self, call: String) {
        self.calls.lock().unwrap().push(call);
    }

    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }

    fn count(&self, prefix: &str) -> usize {
        self.calls()
            .iter()
            .filter(|call| call.starts_with(prefix))
            .count()
    }
}

impl brz_redis::Redis for RecordingRedis {
    async fn get<K, R>(&self, key: K) -> RedisResult<Option<R>>
    where
        K: EncodeRedisArg + Send,
        R: FromRedisBulk + Send,
    {
        self.record(format!("GET {}", Self::key(&key)));
        Ok(None)
    }

    async fn set<K, V>(&self, key: K, _: V) -> RedisResult<()>
    where
        K: EncodeRedisArg + Send,
        V: EncodeRedisArg + Send,
    {
        self.record(format!("SET {}", Self::key(&key)));
        Ok(())
    }

    async fn set_with<K, V>(&self, key: K, _: V, _: SetOptions) -> RedisResult<bool>
    where
        K: EncodeRedisArg + Send,
        V: EncodeRedisArg + Send,
    {
        self.record(format!("SET {}", Self::key(&key)));
        Ok(true)
    }

    async fn append<K, V>(&self, key: K, _: V) -> RedisResult<i64>
    where
        K: EncodeRedisArg + Send,
        V: EncodeRedisArg + Send,
    {
        self.record(format!("APPEND {}", Self::key(&key)));
        Ok(0)
    }

    async fn expire<K>(&self, key: K, _: u64) -> RedisResult<bool>
    where
        K: EncodeRedisArg + Send,
    {
        self.record(format!("EXPIRE {}", Self::key(&key)));
        Ok(true)
    }

    async fn del<K>(&self, key: K) -> RedisResult<i64>
    where
        K: EncodeRedisArg + Send,
    {
        self.record(format!("DEL {}", Self::key(&key)));
        Ok(1)
    }

    async fn del_many<K>(&self, _: K) -> RedisResult<i64>
    where
        K: EncodeRedisArgs + Send,
    {
        self.record("DEL keys".to_string());
        Ok(1)
    }

    async fn mget<K, R>(&self, _: K) -> RedisResult<Vec<Option<R>>>
    where
        K: EncodeRedisArgs + Send,
        R: FromRedisBulk + Send,
    {
        self.record("MGET".to_string());
        Ok(Vec::new())
    }

    async fn lset<K, V>(&self, key: K, _: i64, _: V) -> RedisResult<()>
    where
        K: EncodeRedisArg + Send,
        V: EncodeRedisArg + Send,
    {
        self.record(format!("LSET {}", Self::key(&key)));
        Ok(())
    }

    async fn publish<C, M>(&self, channel: C, _: M) -> RedisResult<i64>
    where
        C: EncodeRedisArg + Send,
        M: EncodeRedisArg + Send,
    {
        self.record(format!("PUBLISH {}", Self::key(&channel)));
        Ok(1)
    }

    async fn rpush<K, V>(&self, key: K, _: V) -> RedisResult<i64>
    where
        K: EncodeRedisArg + Send,
        V: EncodeRedisArgs + Send,
    {
        self.record(format!("RPUSH {}", Self::key(&key)));
        Ok(1)
    }

    async fn pfcount<K>(&self, _: K) -> RedisResult<i64>
    where
        K: EncodeRedisArgs + Send,
    {
        Ok(0)
    }

    async fn hget<K, F, R>(&self, _: K, _: F) -> RedisResult<Option<R>>
    where
        K: EncodeRedisArg + Send,
        F: EncodeRedisArg + Send,
        R: FromRedisBulk + Send,
    {
        Ok(None)
    }

    async fn hmget<K, F, R>(&self, _: K, _: F) -> RedisResult<brz_redis::RedisValues<R>>
    where
        K: EncodeRedisArg + Send,
        F: EncodeRedisArgs + Send,
        R: FromRedisBulk + Send,
    {
        Err(brz_redis::RedisError::new(
            brz_redis::ErrorKind::ClientError,
            "stub does not serve HMGET",
        ))
    }
}

/// Captures warning/error messages so a failed consumer is provably observable.
#[derive(Clone, Default)]
struct LogCapture {
    messages: Arc<Mutex<Vec<String>>>,
}

impl LogCapture {
    fn messages(&self) -> Vec<String> {
        self.messages.lock().unwrap().clone()
    }
}

struct CaptureVisit<'a>(&'a mut String);

impl tracing::field::Visit for CaptureVisit<'_> {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            self.0.push_str(&format!("{value:?}"));
        }
    }

    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
        if field.name() == "message" {
            self.0.push_str(value);
        }
    }

    fn record_i64(&mut self, field: &tracing::field::Field, value: i64) {
        if matches!(field.name(), "task_id" | "subtask_id") {
            self.0.push_str(&format!(" {}={value}", field.name()));
        }
    }
}

impl tracing::Subscriber for LogCapture {
    fn enabled(&self, _: &tracing::Metadata<'_>) -> bool {
        true
    }

    fn new_span(&self, _: &tracing::span::Attributes<'_>) -> tracing::span::Id {
        tracing::span::Id::from_u64(1)
    }

    fn record(&self, _: &tracing::span::Id, _: &tracing::span::Record<'_>) {}

    fn record_follows_from(&self, _: &tracing::span::Id, _: &tracing::span::Id) {}

    fn event(&self, event: &tracing::Event<'_>) {
        if *event.metadata().level() <= tracing::Level::WARN {
            let mut message = String::new();
            event.record(&mut CaptureVisit(&mut message));
            self.messages.lock().unwrap().push(message);
        }
    }

    fn enter(&self, _: &tracing::span::Id) {}

    fn exit(&self, _: &tracing::span::Id) {}
}

/// One local chat-shell HTTP server. It answers `200 text/event-stream` with
/// the supplied frames; `gated` frames are only written after `release`.
struct TestServer {
    url: String,
    started: tokio::sync::oneshot::Receiver<()>,
    release: Option<tokio::sync::oneshot::Sender<()>>,
}

async fn spawn_server(
    status: u16,
    before_gate: Vec<&'static str>,
    after_gate: Vec<&'static str>,
) -> TestServer {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (started_sender, started) = tokio::sync::oneshot::channel();
    let (release, release_receiver) = if after_gate.is_empty() {
        (None, None)
    } else {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        (Some(sender), Some(receiver))
    };
    tokio::spawn(async move {
        let Ok((mut stream, _)) = listener.accept().await else {
            return;
        };
        if !read_http_request(&mut stream).await {
            return;
        }
        if status != 200 {
            let _ = stream
                .write_all(
                    format!(
                        "HTTP/1.1 {status} Test\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
                    )
                    .as_bytes(),
                )
                .await;
            let _ = started_sender.send(());
            return;
        }
        let _ = stream
            .write_all(
                b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n",
            )
            .await;
        for frame in before_gate {
            let _ = stream
                .write_all(format!("data: {frame}\n\n").as_bytes())
                .await;
        }
        let _ = stream.flush().await;
        let _ = started_sender.send(());
        if let Some(receiver) = release_receiver {
            let _ = receiver.await;
        }
        for frame in after_gate {
            let _ = stream
                .write_all(format!("data: {frame}\n\n").as_bytes())
                .await;
        }
        let _ = stream.flush().await;
    });
    TestServer {
        url: format!("http://{addr}"),
        started,
        release,
    }
}

async fn read_http_request(stream: &mut TcpStream) -> bool {
    let mut buffer = Vec::new();
    loop {
        let mut chunk = [0_u8; 1024];
        match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => return false,
            Ok(read) => buffer.extend_from_slice(&chunk[..read]),
        }
        let Some(headers_end) = buffer.windows(4).position(|window| window == b"\r\n\r\n") else {
            continue;
        };
        let headers = String::from_utf8_lossy(&buffer[..headers_end]).to_ascii_lowercase();
        let length = headers
            .lines()
            .find_map(|line| line.strip_prefix("content-length:"))
            .and_then(|value| value.trim().parse::<usize>().ok())
            .unwrap_or(0);
        let body_end = headers_end + 4 + length;
        while buffer.len() < body_end {
            let mut chunk = [0_u8; 1024];
            match stream.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(read) => buffer.extend_from_slice(&chunk[..read]),
            }
        }
        return true;
    }
}

const CREATED: &str = r#"{"type":"response.created","shell_type":"chat"}"#;
const DELTA: &str = r#"{"type":"response.output_text.delta","delta":"hello","offset":0}"#;
const COMPLETED: &str = r#"{"type":"response.completed","response":{}}"#;

fn execution_request() -> ExecutionRequest {
    ExecutionRequest {
        task_id: TASK_ID,
        subtask_id: SUBTASK_ID,
        message_id: Some(2),
        prompt: json!("hello"),
        model_config: json!({"model_id": "test-model"}),
        ..ExecutionRequest::default()
    }
}

fn consumer(
    mysql: RecordingMysql,
    redis: RecordingRedis,
) -> ConsumerState<RecordingMysql, RecordingRedis> {
    ConsumerState {
        mysql,
        redis: Some(redis),
        tables: tables(),
        executor_manager: ExecutorManager::new("http://127.0.0.1:1").expect("client"),
        app: Weak::new(),
    }
}

fn chat_job(
    target_url: &str,
    mysql: RecordingMysql,
    redis: RecordingRedis,
) -> ChatShellJob<RecordingMysql, RecordingRedis> {
    ChatShellJob {
        task_id: TASK_ID,
        subtask_id: SUBTASK_ID,
        consumer: consumer(mysql, redis),
        target_url: target_url.to_string(),
        request: execution_request(),
        request_id: "req-test".to_string(),
    }
}

async fn wait_for_cancel_dels(redis: &RecordingRedis, expected: usize) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if redis.count("DEL chat:cancel:") >= expected {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the expected chat:cancel DELs arrive within the bound");
}

/// The real worker path runs the real SSE consumer: the cancel key is cleared
/// before the stream (the early DEL), polled during it, content is persisted,
/// and the key is deleted in the finally (the late DEL).
///
/// Persistence limitation: this asserts the routed by-id SELECT that starts the
/// completion persistence, not a literal UPDATE. `brz_mysql::MysqlRow` has no
/// public constructor and the existing fake server only returns parse errors,
/// so the recorder's missing-row branch stops before `execute`; the
/// APPEND/SET/DEL evidence plus this read prove the consumer ran and reached
/// persistence.
#[tokio::test]
async fn background_job_runs_the_real_consumer_lifecycle() {
    let server = spawn_server(200, vec![CREATED, DELTA, COMPLETED], vec![]).await;
    let redis = RecordingRedis::default();
    let mysql = RecordingMysql::default();
    let dispatch = ResponsesDispatch::<RecordingMysql, RecordingRedis>::spawn();
    assert!(dispatch.submit(DispatchJob::ChatShell(Box::new(chat_job(
        &server.url,
        mysql.clone(),
        redis.clone()
    )))));

    wait_for_cancel_dels(&redis, 2).await;

    let cancel_key = format!("chat:cancel:{SUBTASK_ID}");
    assert_eq!(
        redis
            .calls()
            .iter()
            .filter(|call| **call == format!("DEL {cancel_key}"))
            .count(),
        2,
        "register and unregister each delete the same key: {:?}",
        redis.calls()
    );
    assert!(
        redis.count(&format!("GET {cancel_key}")) >= 1,
        "the consumer polls the cancel key while the stream runs: {:?}",
        redis.calls()
    );
    assert!(
        redis
            .calls()
            .iter()
            .any(|call| call.starts_with("APPEND chat:streaming:block_content:")),
        "stream content is persisted: {:?}",
        redis.calls()
    );
    assert!(
        mysql
            .statements()
            .iter()
            .any(|statement| statement.contains("subtasks_0424")),
        "the terminal event reaches the completion persistence read: {:?}",
        mysql.statements()
    );
}

/// Admission returns before the consumer finishes: the supervisor must not
/// block the request path on a live stream.
#[tokio::test]
async fn acceptance_returns_before_the_consumer_finishes() {
    let server = spawn_server(200, vec![CREATED, DELTA], vec![COMPLETED]).await;
    let redis = RecordingRedis::default();
    let dispatch = ResponsesDispatch::<RecordingMysql, RecordingRedis>::spawn();
    assert!(dispatch.submit(DispatchJob::ChatShell(Box::new(chat_job(
        &server.url,
        RecordingMysql::default(),
        redis.clone()
    )))));

    // The server saw the request and the consumer is blocked on the gate.
    let _ = server.started.await;
    assert_eq!(
        redis.count("DEL chat:cancel:"),
        1,
        "only the registration DEL is issued while the stream is still open: {:?}",
        redis.calls()
    );

    server.release.expect("gated server").send(()).unwrap();
    wait_for_cancel_dels(&redis, 2).await;
}

/// A chat-shell 500 is surfaced (and logged with the job identity), never
/// reported as completion.
#[tokio::test]
async fn chat_shell_500_is_observable() {
    let server = spawn_server(500, vec![], vec![]).await;
    let job = chat_job(
        &server.url,
        RecordingMysql::default(),
        RecordingRedis::default(),
    );
    let capture = LogCapture::default();
    let guard = tracing::subscriber::set_default(capture.clone());
    let result = run_chat_shell(job).await;
    drop(guard);

    let error = result.expect_err("a 500 is not a completion");
    assert!(error.contains("HTTP status code: 500"), "{error}");
    let messages = capture.messages();
    assert!(
        messages
            .iter()
            .any(|message| message.contains("chat-shell background consumer failed")),
        "{messages:?}"
    );
    assert!(
        messages
            .iter()
            .any(|message| message.contains(&TASK_ID.to_string())),
        "the failure log carries the task identity: {messages:?}"
    );
}

/// A stream that ends without a terminal frame is surfaced (and logged), never
/// reported as completion.
#[tokio::test]
async fn mid_stream_error_is_observable() {
    let server = spawn_server(200, vec![CREATED, DELTA], vec![]).await;
    let job = chat_job(
        &server.url,
        RecordingMysql::default(),
        RecordingRedis::default(),
    );
    let capture = LogCapture::default();
    let guard = tracing::subscriber::set_default(capture.clone());
    let result = run_chat_shell(job).await;
    drop(guard);

    let error = result.expect_err("a stream without a terminal frame is not a completion");
    assert!(error.contains("without terminal event"), "{error}");
    let messages = capture.messages();
    assert!(
        messages
            .iter()
            .any(|message| message.contains("chat-shell background consumer failed")),
        "{messages:?}"
    );
}
