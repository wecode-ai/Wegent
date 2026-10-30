// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Cancellation lifecycle tests for the synchronous chat-shell consumer.
//!
//! `_wait_for_sse_cancellation` is an independent task in the Source, so these
//! tests exercise the two races the chunk-loop-only poll could not express: a
//! cancel observed while the response headers are still outstanding, and a
//! cancel observed while one terminal-persistence step is awaited.

// Extracted test-only module: mark the file itself so source review does not
// infer production ownership for the local test servers spawned below.
#![cfg(test)]

use std::future::pending;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
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

const CREATED: &str = r#"{"type":"response.created","shell_type":"chat"}"#;
const DELTA: &str = r#"{"type":"response.output_text.delta","delta":"hello","offset":0}"#;
const COMPLETED: &str = r#"{"type":"response.completed","response":{}}"#;

fn tables() -> Tables {
    Tables {
        tasks: "tasks_0424",
        subtasks: "subtasks_0424",
    }
}

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

fn executor_manager() -> ExecutorManager {
    ExecutorManager::new("http://127.0.0.1:1").expect("client")
}

/// Holds the first `fetch_optional` forever and signals that it was reached, so
/// a test can stop the terminal persistence mid-step without a timer.
#[derive(Default)]
struct Gate {
    first_call: AtomicBool,
    reached: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
}

impl Gate {
    fn new() -> (Arc<Self>, tokio::sync::oneshot::Receiver<()>) {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let gate = Arc::new(Self {
            first_call: AtomicBool::new(true),
            reached: Mutex::new(Some(sender)),
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
        pending::<()>().await;
    }
}

/// Records every statement the completion path issues. Reads return no row, so
/// the terminal update stops after its first read (the production code's own
/// missing-row branch).
#[derive(Clone, Default)]
struct RecordingMysql {
    statements: Arc<Mutex<Vec<String>>>,
    gate: Option<Arc<Gate>>,
    /// Fires once when the terminal completion path issues its first read.
    terminal_signal: Option<Arc<Mutex<Option<tokio::sync::oneshot::Sender<()>>>>>,
}

impl RecordingMysql {
    fn gated(gate: Arc<Gate>) -> Self {
        Self {
            statements: Arc::default(),
            gate: Some(gate),
            terminal_signal: None,
        }
    }

    /// Signal once when the completion path reaches its first read.
    fn signaling() -> (Self, tokio::sync::oneshot::Receiver<()>) {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        (
            Self {
                statements: Arc::default(),
                gate: None,
                terminal_signal: Some(Arc::new(Mutex::new(Some(sender)))),
            },
            receiver,
        )
    }

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
        if let Some(signal) = &self.terminal_signal
            && let Some(sender) = signal.lock().unwrap().take()
        {
            let _ = sender.send(());
        }
        if let Some(gate) = &self.gate {
            gate.hold().await;
        }
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

/// One-shot gate for the cancellation GET: `started` fires once the read is
/// admitted, and the read does not return until `release` fires.
#[derive(Default)]
struct CancelGate {
    started: Option<tokio::sync::oneshot::Sender<()>>,
    release: Option<tokio::sync::oneshot::Receiver<()>>,
}

/// Records every Redis command the consumer issues and serves the
/// cross-worker cancel flag once a test arms it.
#[derive(Clone, Default)]
struct RecordingRedis {
    calls: Arc<Mutex<Vec<String>>>,
    cancelled: Arc<AtomicBool>,
    cancel_gate: Arc<Mutex<Option<CancelGate>>>,
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

    fn mark_cancelled(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    /// Hold the next cancellation GET: `started` resolves when it is admitted,
    /// and the read returns only after `release` fires. A completion records
    /// `GET-END`, so a test can prove the read finished before a later `DEL`.
    fn arm_cancel_gate(
        &self,
    ) -> (
        tokio::sync::oneshot::Receiver<()>,
        tokio::sync::oneshot::Sender<()>,
    ) {
        let (started, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release) = tokio::sync::oneshot::channel();
        *self.cancel_gate.lock().unwrap() = Some(CancelGate {
            started: Some(started),
            release: Some(release),
        });
        (started_rx, release_tx)
    }
}

impl brz_redis::Redis for RecordingRedis {
    async fn get<K, R>(&self, key: K) -> RedisResult<Option<R>>
    where
        K: EncodeRedisArg + Send,
        R: FromRedisBulk + Send,
    {
        let name = Self::key(&key);
        self.record(format!("GET {name}"));
        if name == format!("chat:cancel:{SUBTASK_ID}") {
            // Drop the `MutexGuard` before any await so the `Redis::get`
            // future stays `Send`.
            let gate = { self.cancel_gate.lock().unwrap().take() };
            if let Some(mut gate) = gate {
                if let Some(started) = gate.started.take() {
                    let _ = started.send(());
                }
                if let Some(release) = gate.release.take() {
                    let _ = release.await;
                }
                self.record(format!("GET-END {name}"));
            }
            if self.cancelled.load(Ordering::SeqCst) {
                return R::from_redis_bulk(bytes::Bytes::from_static(b"true")).map(Some);
            }
        }
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

/// One local chat-shell server that never writes response headers: the client
/// stays in its header wait until it drops the request future.
async fn spawn_header_stalled_server() -> (String, tokio::sync::oneshot::Receiver<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (started, started_receiver) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let Ok((mut stream, _)) = listener.accept().await else {
            return;
        };
        if !read_http_request(&mut stream).await {
            return;
        }
        let _ = started.send(());
        // Hold the connection without a response; the consumer's cancellation
        // must end the dispatch while this wait is outstanding.
        let mut byte = [0_u8; 1];
        let _ = stream.read(&mut byte).await;
    });
    (format!("http://{addr}"), started_receiver)
}

/// One local chat-shell server that answers with `200 text/event-stream` and
/// the supplied frames, then holds the connection open.
async fn spawn_stream_server(frames: Vec<&'static str>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let Ok((mut stream, _)) = listener.accept().await else {
            return;
        };
        if !read_http_request(&mut stream).await {
            return;
        }
        let _ = stream
            .write_all(
                b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n",
            )
            .await;
        for frame in frames {
            let _ = stream
                .write_all(format!("data: {frame}\n\n").as_bytes())
                .await;
        }
        let _ = stream.flush().await;
        let mut byte = [0_u8; 1];
        let _ = stream.read(&mut byte).await;
    });
    format!("http://{addr}")
}

/// Answers with `200 text/event-stream`, writes `first`, then waits before
/// each remaining frame. The total lifetime can exceed the per-read timeout
/// while every individual inter-chunk gap stays below it.
async fn spawn_gapped_stream_server(
    first: &'static str,
    frames: Vec<(&'static str, Duration)>,
) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let Ok((mut stream, _)) = listener.accept().await else {
            return;
        };
        if !read_http_request(&mut stream).await {
            return;
        }
        let _ = stream
            .write_all(
                b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n",
            )
            .await;
        let _ = stream
            .write_all(format!("data: {first}\n\n").as_bytes())
            .await;
        let _ = stream.flush().await;
        for (frame, gap) in frames {
            tokio::time::sleep(gap).await;
            let _ = stream
                .write_all(format!("data: {frame}\n\n").as_bytes())
                .await;
            let _ = stream.flush().await;
        }
        let mut byte = [0_u8; 1];
        let _ = stream.read(&mut byte).await;
    });
    format!("http://{addr}")
}

/// As [`spawn_stream_server`], but signals after the frames were flushed and
/// keeps the connection open, so a test can act while the terminal drain is
/// still reading the delayed EOF.
async fn spawn_stream_server_holding(
    frames: Vec<&'static str>,
) -> (String, tokio::sync::oneshot::Receiver<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (flushed, flushed_receiver) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let Ok((mut stream, _)) = listener.accept().await else {
            return;
        };
        if !read_http_request(&mut stream).await {
            return;
        }
        let _ = stream
            .write_all(
                b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n",
            )
            .await;
        for frame in frames {
            let _ = stream
                .write_all(format!("data: {frame}\n\n").as_bytes())
                .await;
        }
        let _ = stream.flush().await;
        let _ = flushed.send(());
        let mut byte = [0_u8; 1];
        let _ = stream.read(&mut byte).await;
    });
    (format!("http://{addr}"), flushed_receiver)
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

/// An already-set cross-worker flag is resolved by the poll loop's immediate
/// GET, before the stream's first interval wait; the stream open is still
/// started and then dropped like the Source's `_cancel_sse_stream_open`.
#[tokio::test]
async fn an_already_set_cancel_resolves_on_the_initial_get() {
    let (url, _request_received) = spawn_header_stalled_server().await;
    let redis = RecordingRedis::default();
    redis.mark_cancelled();
    let mysql = RecordingMysql::default();
    let executor = executor_manager();
    let request = execution_request();
    let ctx = ConsumerContext {
        mysql: &mysql,
        redis: Some(&redis),
        tables: tables(),
        executor_manager: &executor,
        app: None,
    };

    let collected = tokio::time::timeout(
        Duration::from_secs(5),
        collect(&ctx, &url, &request, "req-test", Some(2)),
    )
    .await
    .expect("an already-set flag does not wait for an interval")
    .expect("a cancelled dispatch is not a failure");

    assert_eq!(collected.content, "");
    assert_eq!(
        redis.count("GET chat:cancel:"),
        1,
        "the immediate GET resolves the flag without a later poll: {:?}",
        redis.calls()
    );
    assert_eq!(
        redis.count("DEL chat:cancel:"),
        2,
        "register and unregister still delete the key: {:?}",
        redis.calls()
    );
}

/// A stream that outlives the per-read timeout must keep running while
/// chunks arrive. The regression this guards is a total request deadline that
/// cuts an otherwise healthy long-running Chat turn at the timeout boundary.
#[tokio::test]
async fn stream_outliving_the_read_timeout_continues_while_chunks_arrive() {
    let gap = Duration::from_millis(1_200);
    let read_timeout = Duration::from_secs(2);
    let url = spawn_gapped_stream_server(CREATED, vec![(DELTA, gap), (COMPLETED, gap)]).await;
    let redis = RecordingRedis::default();
    let mysql = RecordingMysql::default();
    let executor = executor_manager();
    let ctx = ConsumerContext {
        mysql: &mysql,
        redis: Some(&redis),
        tables: tables(),
        executor_manager: &executor,
        app: None,
    };
    let request = execution_request();

    let collected = tokio::time::timeout(
        Duration::from_secs(6),
        collect_with_read_timeout(&ctx, &url, &request, "req-test", Some(2), read_timeout),
    )
    .await
    .expect("the stream completes after outliving the read timeout")
    .expect("chunks arriving inside the read timeout keep the stream alive");

    assert_eq!(collected.content, "hello");
}

/// A cross-worker cancel is acted on while `.send()` still awaits the HTTP
/// response headers; the previous implementation could only poll between
/// chunks, so it stayed suspended for the whole header wait.
#[tokio::test]
async fn cancel_is_observed_while_the_header_wait_is_outstanding() {
    let (url, request_received) = spawn_header_stalled_server().await;
    let redis = RecordingRedis::default();
    let mysql = RecordingMysql::default();
    let executor = executor_manager();
    let request = execution_request();
    let ctx = ConsumerContext {
        mysql: &mysql,
        redis: Some(&redis),
        tables: tables(),
        executor_manager: &executor,
        app: None,
    };

    let dispatch = collect(&ctx, &url, &request, "req-test", Some(2));
    tokio::pin!(dispatch);
    // The headers never arrive; wait until the request is in flight, then arm
    // the cross-worker flag.
    tokio::select! {
        received = request_received => received.expect("the request reaches the server"),
        result = &mut dispatch => panic!("the dispatch ended before the header wait: {result:?}"),
    }
    redis.mark_cancelled();

    let collected = tokio::time::timeout(Duration::from_secs(5), &mut dispatch)
        .await
        .expect("cancellation ends the dispatch while the headers are outstanding")
        .expect("a cancelled dispatch is not a failure");

    assert_eq!(collected.content, "");
    assert!(
        redis.count("GET chat:cancel:") >= 2,
        "the initial GET plus the poll that observes the armed flag: {:?}",
        redis.calls()
    );
    assert_eq!(
        redis.count("DEL chat:cancel:"),
        2,
        "register and unregister still delete the key: {:?}",
        redis.calls()
    );
}

/// A cross-worker cancel is acted on while the terminal event's persistence is
/// awaiting a read that never returns. Only dropping the consume future - the
/// Source's `stream_task.cancel()` - can end the dispatch here.
#[tokio::test]
async fn cancel_is_observed_during_a_slow_persistence_step() {
    let url = spawn_stream_server(vec![CREATED, DELTA, COMPLETED]).await;
    let (gate, persistence_started) = Gate::new();
    let redis = RecordingRedis::default();
    let mysql = RecordingMysql::gated(gate);
    let executor = executor_manager();
    let ctx = ConsumerContext {
        mysql: &mysql,
        redis: Some(&redis),
        tables: tables(),
        executor_manager: &executor,
        app: None,
    };

    let request = execution_request();
    let dispatch = collect(&ctx, &url, &request, "req-test", Some(2));
    tokio::pin!(dispatch);
    tokio::select! {
        signal = persistence_started => signal.expect("the terminal persistence read is reached"),
        result = &mut dispatch => panic!("the dispatch finished before cancellation: {result:?}"),
    }

    // The terminal completion is now blocked on its by-id read; only the
    // independent cancel poll can end the dispatch from here.
    redis.mark_cancelled();
    let collected = tokio::time::timeout(Duration::from_secs(5), &mut dispatch)
        .await
        .expect("cancellation interrupts the persistence step")
        .expect("a cancelled dispatch is not a failure");

    assert_eq!(
        collected.content, "hello",
        "the content accumulated before the terminal event is kept"
    );
    assert!(
        mysql
            .statements()
            .iter()
            .any(|statement| statement.contains("subtasks_0424")),
        "the terminal persistence read was reached: {:?}",
        mysql.statements()
    );
    assert!(
        redis.count("GET chat:cancel:") >= 2,
        "the initial GET plus a later poll during the blocked persistence: {:?}",
        redis.calls()
    );
    assert_eq!(
        redis.count("DEL chat:cancel:"),
        2,
        "register and unregister still delete the key: {:?}",
        redis.calls()
    );
}

/// Terminal received, EOF delayed: `_drain_terminal_stream` keeps the
/// independent cancel poll running. A flag armed after the terminal must not
/// change the delivered completed state, and the poll must still issue its
/// GETs through the drain.
#[tokio::test]
async fn terminal_received_with_delayed_eof_keeps_polling_during_the_drain() {
    let (url, frames_flushed) = spawn_stream_server_holding(vec![CREATED, DELTA, COMPLETED]).await;
    let redis = RecordingRedis::default();
    let mysql = RecordingMysql::default();
    let executor = executor_manager();
    let ctx = ConsumerContext {
        mysql: &mysql,
        redis: Some(&redis),
        tables: tables(),
        executor_manager: &executor,
        app: None,
    };

    let request = execution_request();
    let dispatch = collect(&ctx, &url, &request, "req-test", Some(2));
    tokio::pin!(dispatch);
    tokio::select! {
        flushed = frames_flushed => flushed.expect("the terminal frames were flushed"),
        result = &mut dispatch => panic!("the dispatch ended before the terminal: {result:?}"),
    }

    // The terminal already won; arm the cross-worker flag while the drain is
    // still reading the held-open tail.
    redis.mark_cancelled();
    let collected = tokio::time::timeout(Duration::from_secs(5), &mut dispatch)
        .await
        .expect("the bounded drain completes")
        .expect("the delivered completed state is unchanged");

    assert_eq!(
        collected.content, "hello",
        "the completed result survives the in-drain cancellation"
    );
    assert!(
        redis.count("GET chat:cancel:") >= 2,
        "the same poll keeps issuing GETs through the drain: {:?}",
        redis.calls()
    );
    let subtask_reads = mysql
        .statements()
        .iter()
        .filter(|statement| statement.contains("subtasks_0424"))
        .count();
    assert_eq!(
        subtask_reads,
        2,
        "only the terminal completion runs; an in-drain cancel has no effect: {:?}",
        mysql.statements()
    );
}

/// `finally` must stop scheduling cancellation reads and then await the one
/// already-admitted GET: `stop` never abandons an in-flight read, and no new
/// poll is scheduled afterwards.
#[tokio::test]
async fn stop_joins_an_admitted_cancel_get() {
    use std::future::poll_fn;
    use std::task::Poll;

    let redis = RecordingRedis::default();
    let (mut started, release) = redis.arm_cancel_gate();
    let (stop, stop_rx) = tokio::sync::oneshot::channel();
    let key = format!("chat:cancel:{SUBTASK_ID}");
    let mut poll = Box::pin(poll_cancellation(&redis, &key, stop_rx));

    tokio::select! {
        biased;
        _ = &mut started => {}
        _ = &mut poll => panic!("poller finished before the GET was admitted"),
    }
    // Termination wins while the admitted GET is still in flight.
    stop.send(()).unwrap();
    let pending = poll_fn(|cx| Poll::Ready(poll.as_mut().poll(cx).is_pending())).await;
    assert!(pending, "stop must not abandon the admitted GET");
    assert_eq!(redis.count("GET chat:cancel:"), 1);

    release.send(()).unwrap();
    poll.await;
    assert_eq!(
        redis.count("GET chat:cancel:"),
        1,
        "no new poll may be scheduled after stop: {:?}",
        redis.calls()
    );
    let calls = redis.calls();
    let get_end = calls
        .iter()
        .position(|call| call.starts_with("GET-END chat:cancel:"))
        .expect("the admitted GET completed before the join returned");
    assert_eq!(
        get_end + 1,
        calls.len(),
        "GET completion is the last call: {calls:?}"
    );
}

/// Stopping between polls finishes immediately and never issues another GET.
#[tokio::test]
async fn stop_during_the_interval_wait_schedules_no_further_get() {
    use std::future::poll_fn;
    use std::task::Poll;

    let redis = RecordingRedis::default();
    let (stop, stop_rx) = tokio::sync::oneshot::channel();
    let key = format!("chat:cancel:{SUBTASK_ID}");
    let mut poll = Box::pin(poll_cancellation(&redis, &key, stop_rx));

    let pending = poll_fn(|cx| Poll::Ready(poll.as_mut().poll(cx).is_pending())).await;
    assert!(
        pending,
        "the first GET resolves and the loop waits between polls"
    );
    assert_eq!(redis.count("GET chat:cancel:"), 1);

    stop.send(()).unwrap();
    poll.await;
    assert_eq!(
        redis.count("GET chat:cancel:"),
        1,
        "stop during the interval wait schedules no further GET: {:?}",
        redis.calls()
    );
    assert_eq!(
        redis.count("GET-END chat:cancel:"),
        0,
        "no GET was outstanding"
    );
}

/// End to end: with a cancellation GET admitted and held, the terminal path
/// finishes and `collect` cannot run `unregister_stream`'s `DEL` until that GET
/// completes; the DEL then follows the GET.
#[tokio::test]
async fn unregister_del_waits_for_an_admitted_cancel_get() {
    let url = spawn_stream_server(vec![CREATED, COMPLETED]).await;
    let redis = RecordingRedis::default();
    let (mut started, release) = redis.arm_cancel_gate();
    let (mysql, mut terminal) = RecordingMysql::signaling();
    let executor = executor_manager();
    let request = execution_request();
    let ctx = ConsumerContext {
        mysql: &mysql,
        redis: Some(&redis),
        tables: tables(),
        executor_manager: &executor,
        app: None,
    };

    let mut collect_fut = Box::pin(collect(&ctx, &url, &request, "req-test", Some(2)));
    tokio::select! {
        biased;
        _ = &mut started => {}
        _ = collect_fut.as_mut() => panic!("collect finished before the cancel GET was admitted"),
    }
    tokio::select! {
        biased;
        _ = &mut terminal => {}
        _ = collect_fut.as_mut() => panic!("collect finished before the terminal path ran"),
    }

    // The admitted GET is still outstanding, so the unregister DEL is blocked;
    // only `register_stream`'s clear has run.
    assert_eq!(
        redis.count("DEL chat:cancel:"),
        1,
        "unregister DEL must wait for the in-flight GET: {:?}",
        redis.calls()
    );

    release.send(()).unwrap();
    let collected = collect_fut.await.expect("collect succeeds");
    assert_eq!(collected.content, "");

    let calls = redis.calls();
    let unregister = calls
        .iter()
        .rposition(|call| call.starts_with("DEL chat:cancel:"))
        .expect("unregister DEL ran");
    let get_end = calls
        .iter()
        .position(|call| call.starts_with("GET-END chat:cancel:"))
        .expect("the admitted GET completed");
    assert!(
        get_end < unregister,
        "unregister DEL must follow the admitted GET: {calls:?}"
    );
}
