// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Process-owned Socket.IO Redis-adapter RPC client.
//!
//! The source backend runs a `socketio.AsyncServer` whose `AsyncRedisManager`
//! keeps one long-lived Redis subscription on the `socketio` channel. A
//! `sio.call(event, data, to=sid, namespace=namespace)` publish carries a
//! `callback` identity (`[sid, namespace, id]`) and the adapter delivers the
//! peer's acknowledgement as a `callback` message on that subscription.
//!
//! The migrated handlers that perform such a call run without a Python
//! Socket.IO server, so this module owns the equivalent subscription for the
//! Rust process: one startup task subscribes to `socketio`, routes `callback`
//! messages to in-flight calls, and reconnects with a bounded budget.
//!
//! `brz-redis` exposes RESP framing (`brz_redis::resp`) but no streaming
//! Pub/Sub consumer, so the subscription uses a dedicated Tokio TCP
//! connection with the shared Breeze RESP codec. It never shares a pooled
//! request/response session: unsolicited push frames must not be mistaken for
//! command replies.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use brz_redis::resp::encoder::encode_command_slices;
use brz_redis::resp::{ParseResult, parse_reply};
use bytes::{Bytes, BytesMut};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{oneshot, watch};
use tokio::time::timeout;

use crate::config::RedisConfig;

/// `AsyncRedisManager`'s channel (`socketio_emit::SOCKETIO_CHANNEL`).
const CHANNEL: &[u8] = b"socketio";
/// One inbound push frame is bounded before parsing.
const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
/// In-flight callbacks retained per process.
const MAX_WAITERS: usize = 1024;
/// Per-socket ack-id counters retained per process.
const MAX_SID_COUNTERS: usize = 4096;
/// Connection and authentication budget.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// Bounded reconnect budget after one subscription is lost.
const MAX_RECONNECT_ATTEMPTS: u32 = 5;
const RECONNECT_BASE_DELAY: Duration = Duration::from_secs(1);
const MAX_RECONNECT_DELAY: Duration = Duration::from_secs(30);

type CallbackKey = (String, String, u64);
type Waiters = Mutex<HashMap<CallbackKey, oneshot::Sender<Value>>>;
/// Receives adapter `emit` messages so the local Socket.IO sessions can deliver
/// them to their rooms.
pub type EmitSink = Arc<dyn Fn(Value) + Send + Sync>;

/// A failed Socket.IO RPC round trip.
#[derive(Debug)]
pub enum RpcError {
    /// The subscriber is not running or the waiter table is full.
    Unavailable(String),
    /// The peer did not answer within the source timeout.
    Timeout,
    /// The subscription closed while the call was pending.
    Closed,
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unavailable(reason) => write!(formatter, "{reason}"),
            Self::Timeout => write!(formatter, "timed out"),
            Self::Closed => write!(formatter, "connection closed"),
        }
    }
}

impl std::error::Error for RpcError {}

/// The process-lifetime Socket.IO subscription and its callback waiters.
pub struct SocketIoRpc {
    waiters: Arc<Waiters>,
    emit_sink: Arc<Mutex<Option<EmitSink>>>,
    /// `base_manager._generate_ack_id`: one `itertools.count(1)` per socket
    /// id, dropped when the socket goes away.
    next_ids: Mutex<HashMap<String, u64>>,
    /// Dropping the last sender stops the subscription worker.
    _shutdown: watch::Sender<bool>,
}

impl SocketIoRpc {
    /// Start the subscriber worker from the application's Redis configuration.
    ///
    /// Called once from application startup; the worker is initialization-owned
    /// and retries a bounded number of times before giving up.
    #[must_use]
    pub fn start(config: &RedisConfig) -> Arc<Self> {
        let waiters: Arc<Waiters> = Arc::new(Mutex::new(HashMap::new()));
        let emit_sink: Arc<Mutex<Option<EmitSink>>> = Arc::new(Mutex::new(None));
        let (shutdown, receiver) = watch::channel(false);
        let endpoint = Endpoint {
            host: config.host.clone(),
            port: config.port,
            db: config.db,
            password: config.password.clone(),
        };
        let worker_waiters = Arc::clone(&waiters);
        let worker_sink = Arc::clone(&emit_sink);
        tokio::spawn(run(worker_waiters, worker_sink, endpoint, receiver));
        Arc::new(Self {
            waiters,
            emit_sink,
            next_ids: Mutex::new(HashMap::new()),
            _shutdown: shutdown,
        })
    }

    /// Installs the adapter `emit` receiver for local session delivery.
    pub fn set_emit_sink(&self, sink: EmitSink) {
        if let Ok(mut slot) = self.emit_sink.lock() {
            *slot = Some(sink);
        }
    }

    /// Register one callback waiter before its `emit` is published.
    pub fn begin(&self, sid: &str, namespace: &str) -> Result<SocketIoCall, RpcError> {
        let id = self.next_callback_id(sid)?;
        let key = (sid.to_string(), namespace.to_string(), id);
        let (sender, receiver) = oneshot::channel();
        {
            let mut waiters = self
                .waiters
                .lock()
                .map_err(|_| RpcError::Unavailable("callback waiter table is poisoned".into()))?;
            if waiters.len() >= MAX_WAITERS {
                return Err(RpcError::Unavailable(
                    "too many pending Socket.IO callbacks".into(),
                ));
            }
            waiters.insert(key.clone(), sender);
        }
        Ok(SocketIoCall {
            key,
            id,
            receiver,
            waiters: Arc::clone(&self.waiters),
        })
    }

    /// Deliver an acknowledgement to a waiter owned by this process.
    ///
    /// `async_pubsub_manager.py::_return_callback` returns the callback
    /// locally when the emitting host is this host and only publishes
    /// `{"method": "callback", ...}` for another host. Resolving the local
    /// waiter directly keeps the adapter channel free of a frame the source
    /// never sends; the caller publishes only when this returns `false`.
    pub fn deliver_local(&self, sid: &str, namespace: &str, id: u64, args: &Value) -> bool {
        let Ok(mut waiters) = self.waiters.lock() else {
            return false;
        };
        let key = (sid.to_string(), namespace.to_string(), id);
        let Some(sender) = waiters.remove(&key) else {
            return false;
        };
        // A dropped receiver means the caller already timed out; the waiter is
        // still ours, so the frame must not be published for someone else.
        let _ = sender.send(args.clone());
        true
    }

    /// `_generate_ack_id`: the next ack id of one socket, counting from 1.
    ///
    /// The counter is per socket id, so a fresh socket always starts at 1 no
    /// matter how many calls the process has made elsewhere. Counters of
    /// sockets with no pending call are dropped before the table grows past
    /// [`MAX_SID_COUNTERS`], which is also where a disconnected socket's
    /// counter (deleted by the source on disconnect) is released.
    fn next_callback_id(&self, sid: &str) -> Result<u64, RpcError> {
        let mut counters = self
            .next_ids
            .lock()
            .map_err(|_| RpcError::Unavailable("callback id counter table is poisoned".into()))?;
        if !counters.contains_key(sid) && counters.len() >= MAX_SID_COUNTERS {
            let active = self
                .waiters
                .lock()
                .map_err(|_| RpcError::Unavailable("callback waiter table is poisoned".into()))?
                .keys()
                .map(|(waiter_sid, _, _)| waiter_sid.clone())
                .collect::<std::collections::HashSet<_>>();
            counters.retain(|candidate, _| active.contains(candidate));
            if counters.len() >= MAX_SID_COUNTERS {
                return Err(RpcError::Unavailable(
                    "too many Socket.IO callback id counters".into(),
                ));
            }
        }
        let next = counters.entry(sid.to_owned()).or_insert(1);
        let id = *next;
        *next = next.checked_add(1).unwrap_or(1);
        Ok(id)
    }
}

/// One in-flight Socket.IO call; dropping it removes the waiter.
pub struct SocketIoCall {
    key: CallbackKey,
    id: u64,
    receiver: oneshot::Receiver<Value>,
    waiters: Arc<Waiters>,
}

impl SocketIoCall {
    /// The callback id carried in the `emit` message.
    #[must_use]
    pub fn id(&self) -> u64 {
        self.id
    }

    /// Await the acknowledgement's positional arguments.
    pub async fn wait(mut self, deadline: Duration) -> Result<Value, RpcError> {
        match timeout(deadline, &mut self.receiver).await {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(_)) => Err(RpcError::Closed),
            Err(_) => Err(RpcError::Timeout),
        }
    }
}

impl Drop for SocketIoCall {
    fn drop(&mut self) {
        if let Ok(mut waiters) = self.waiters.lock() {
            waiters.remove(&self.key);
        }
    }
}

struct Endpoint {
    host: String,
    port: u16,
    db: i64,
    password: Option<String>,
}

async fn run(
    waiters: Arc<Waiters>,
    emit_sink: Arc<Mutex<Option<EmitSink>>>,
    endpoint: Endpoint,
    mut shutdown: watch::Receiver<bool>,
) {
    let mut attempts = 0_u32;
    loop {
        let outcome = tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    return;
                }
                continue;
            }
            outcome = subscribe_and_read(&endpoint, &waiters, &emit_sink) => outcome,
        };
        match outcome {
            Ok(()) => attempts = 0,
            Err(error) => {
                attempts = attempts.saturating_add(1);
                tracing::warn!(%error, attempts, "Socket.IO Redis subscription ended");
            }
        }
        fail_waiters(&waiters);
        if *shutdown.borrow() || attempts >= MAX_RECONNECT_ATTEMPTS {
            if attempts >= MAX_RECONNECT_ATTEMPTS {
                tracing::error!(
                    attempts,
                    "Socket.IO Redis subscription stopped after its reconnect budget"
                );
            }
            return;
        }
        let delay = RECONNECT_BASE_DELAY
            .saturating_mul(1_u32 << (attempts - 1).min(5))
            .min(MAX_RECONNECT_DELAY);
        tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    return;
                }
            }
            () = tokio::time::sleep(delay) => {}
        }
    }
}

/// Fail every pending call so request handlers do not wait for their full
/// timeout after the subscription is gone.
fn fail_waiters(waiters: &Waiters) {
    if let Ok(mut waiters) = waiters.lock() {
        waiters.clear();
    }
}

async fn subscribe_and_read(
    endpoint: &Endpoint,
    waiters: &Waiters,
    emit_sink: &Mutex<Option<EmitSink>>,
) -> anyhow::Result<()> {
    let mut stream = timeout(
        CONNECT_TIMEOUT,
        TcpStream::connect((endpoint.host.as_str(), endpoint.port)),
    )
    .await
    .map_err(|_| anyhow::anyhow!("Redis subscription connect timed out"))??;
    stream.set_nodelay(true).ok();

    if let Some(password) = endpoint.password.as_deref() {
        write_command(&mut stream, &[b"AUTH", password.as_bytes()]).await?;
        expect_ok(&mut stream).await?;
    }
    if endpoint.db != 0 {
        let database = endpoint.db.to_string();
        write_command(&mut stream, &[b"SELECT", database.as_bytes()]).await?;
        expect_ok(&mut stream).await?;
    }
    write_command(&mut stream, &[b"SUBSCRIBE", CHANNEL]).await?;

    let mut buffer = BytesMut::with_capacity(8 * 1024);
    let mut chunk = [0_u8; 8 * 1024];
    loop {
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            return Err(anyhow::anyhow!("Redis subscription connection closed"));
        }
        buffer.extend_from_slice(&chunk[..read]);
        loop {
            let pending = Bytes::copy_from_slice(&buffer);
            match parse_reply(&pending) {
                Ok(ParseResult::Complete { value, consumed }) => {
                    let _ = buffer.split_to(consumed);
                    dispatch(value, waiters, emit_sink);
                }
                Ok(ParseResult::Incomplete) => break,
                Err(error) => return Err(anyhow::Error::from(error)),
            }
        }
        if buffer.len() > MAX_FRAME_BYTES {
            return Err(anyhow::anyhow!(
                "Redis subscription frame exceeded {MAX_FRAME_BYTES} bytes"
            ));
        }
    }
}

async fn write_command(stream: &mut TcpStream, arguments: &[&[u8]]) -> anyhow::Result<()> {
    let mut frame = Vec::with_capacity(64);
    encode_command_slices(arguments.iter().copied(), arguments.len(), &mut frame);
    stream.write_all(&frame).await?;
    stream.flush().await?;
    Ok(())
}

async fn expect_ok(stream: &mut TcpStream) -> anyhow::Result<()> {
    let mut buffer = BytesMut::with_capacity(64);
    let mut chunk = [0_u8; 64];
    loop {
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            return Err(anyhow::anyhow!("Redis connection closed during setup"));
        }
        buffer.extend_from_slice(&chunk[..read]);
        let pending = Bytes::copy_from_slice(&buffer);
        if let ParseResult::Complete { value, .. } = parse_reply(&pending)? {
            return match value {
                brz_redis::types::Value::Okay => Ok(()),
                brz_redis::types::Value::SimpleString(_) => Ok(()),
                other => Err(anyhow::anyhow!("Redis setup command failed: {other:?}")),
            };
        }
    }
}

/// Route one inbound adapter frame. `callback` messages addressed to this
/// process resolve their waiter, `emit` messages reach the local Socket.IO
/// sessions, and subscription confirmations are ignored.
fn dispatch(
    value: brz_redis::types::Value,
    waiters: &Waiters,
    emit_sink: &Mutex<Option<EmitSink>>,
) {
    let brz_redis::types::Value::Array(items) = value else {
        return;
    };
    let [kind, channel, payload] = items.as_slice() else {
        return;
    };
    if !matches!(kind, brz_redis::types::Value::BulkString(bytes) if bytes.as_ref() == b"message") {
        return;
    }
    if !matches!(channel, brz_redis::types::Value::BulkString(bytes) if bytes.as_ref() == CHANNEL) {
        return;
    }
    let brz_redis::types::Value::BulkString(payload) = payload else {
        return;
    };
    let Ok(message) = serde_json::from_slice::<Value>(payload) else {
        return;
    };
    match message.get("method").and_then(Value::as_str) {
        Some("callback") => {}
        Some("emit") => {
            if let Ok(sink) = emit_sink.lock()
                && let Some(sink) = sink.as_ref()
            {
                sink(message);
            }
            return;
        }
        _ => return,
    }
    if message.get("host_id").and_then(Value::as_str) != Some(crate::socketio_emit::host_id()) {
        return;
    }
    let (Some(sid), Some(namespace), Some(id)) = (
        message.get("sid").and_then(Value::as_str),
        message.get("namespace").and_then(Value::as_str),
        message.get("id").and_then(Value::as_u64),
    ) else {
        return;
    };
    let Some(args) = message.get("args") else {
        return;
    };
    let key = (sid.to_string(), namespace.to_string(), id);
    let sender = waiters
        .lock()
        .ok()
        .and_then(|mut waiters| waiters.remove(&key));
    if let Some(sender) = sender {
        let _ = sender.send(args.clone());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use brz_redis::types::Value;

    fn push(json: &str) -> Value {
        Value::Array(vec![
            Value::BulkString(Bytes::from_static(b"message")),
            Value::BulkString(Bytes::from_static(b"socketio")),
            Value::BulkString(Bytes::from(json.to_owned())),
        ])
    }

    fn no_sink() -> Mutex<Option<EmitSink>> {
        Mutex::new(None)
    }

    #[test]
    fn adapter_emits_reach_the_registered_sink() {
        let waiters: Waiters = Mutex::new(HashMap::new());
        let seen: Arc<Mutex<Vec<serde_json::Value>>> = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&seen);
        let sink: Mutex<Option<EmitSink>> = Mutex::new(Some(Arc::new(move |message| {
            captured.lock().unwrap().push(message)
        })));
        dispatch(
            push(
                r#"{"method":"emit","event":"device:online","data":[{"device_id":"d"}],"namespace":"/chat","room":"user:1"}"#,
            ),
            &waiters,
            &sink,
        );
        assert_eq!(seen.lock().unwrap().len(), 1);
        assert_eq!(seen.lock().unwrap()[0]["event"], "device:online");
    }

    #[test]
    fn callback_frames_are_routed_to_the_matching_waiter() {
        let waiters: Waiters = Mutex::new(HashMap::new());
        let (sender, mut receiver) = oneshot::channel();
        waiters
            .lock()
            .unwrap()
            .insert(("sid".into(), "/local-executor".into(), 7), sender);
        dispatch(
            push(&format!(
                r#"{{"method":"callback","host_id":"{}","sid":"sid","namespace":"/local-executor","id":7,"args":[{{"success":false}}]}}"#,
                crate::socketio_emit::host_id()
            )),
            &waiters,
            &no_sink(),
        );
        assert_eq!(
            receiver.try_recv().unwrap(),
            serde_json::json!([{"success": false}])
        );
        assert!(waiters.lock().unwrap().is_empty());
    }

    #[test]
    fn foreign_callbacks_and_other_channels_are_ignored() {
        let waiters: Waiters = Mutex::new(HashMap::new());
        let (sender, mut receiver) = oneshot::channel();
        waiters
            .lock()
            .unwrap()
            .insert(("sid".into(), "/local-executor".into(), 1), sender);
        dispatch(
            push(
                r#"{"method":"callback","host_id":"00000000000000000000000000000000","sid":"sid","namespace":"/local-executor","id":1,"args":[]}"#,
            ),
            &waiters,
            &no_sink(),
        );
        assert!(receiver.try_recv().is_err());
        assert_eq!(waiters.lock().unwrap().len(), 1);
        dispatch(
            Value::Array(vec![
                Value::BulkString(Bytes::from_static(b"message")),
                Value::BulkString(Bytes::from_static(b"other")),
                Value::BulkString(Bytes::from_static(b"{}")),
            ]),
            &waiters,
            &no_sink(),
        );
        assert_eq!(waiters.lock().unwrap().len(), 1);
    }

    #[test]
    fn dropping_a_call_removes_its_waiter() {
        let rpc = SocketIoRpc {
            waiters: Arc::new(Mutex::new(HashMap::new())),
            emit_sink: Arc::new(Mutex::new(None)),
            next_ids: Mutex::new(HashMap::new()),
            _shutdown: watch::channel(false).0,
        };
        let call = rpc.begin("sid", "/local-executor").unwrap();
        assert_eq!(call.id(), 1);
        assert_eq!(rpc.waiters.lock().unwrap().len(), 1);
        drop(call);
        assert!(rpc.waiters.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_local_ack_resolves_the_waiter() {
        let rpc = SocketIoRpc {
            waiters: Arc::new(Mutex::new(HashMap::new())),
            emit_sink: Arc::new(Mutex::new(None)),
            next_ids: Mutex::new(HashMap::new()),
            _shutdown: watch::channel(false).0,
        };
        let call = rpc.begin("sid-1", "/local-executor").unwrap();
        let id = call.id();
        assert!(rpc.deliver_local("sid-1", "/local-executor", id, &serde_json::json!(["ok"])));
        assert_eq!(
            call.wait(Duration::from_secs(1)).await.unwrap(),
            serde_json::json!(["ok"])
        );
    }

    #[tokio::test]
    async fn an_unknown_callback_is_not_delivered_locally() {
        let rpc = SocketIoRpc {
            waiters: Arc::new(Mutex::new(HashMap::new())),
            emit_sink: Arc::new(Mutex::new(None)),
            next_ids: Mutex::new(HashMap::new()),
            _shutdown: watch::channel(false).0,
        };
        assert!(!rpc.deliver_local("sid-1", "/local-executor", 1, &serde_json::json!([])));
    }

    #[test]
    fn callback_ids_are_allocated_per_socket() {
        let rpc = SocketIoRpc {
            waiters: Arc::new(Mutex::new(HashMap::new())),
            emit_sink: Arc::new(Mutex::new(None)),
            next_ids: Mutex::new(HashMap::new()),
            _shutdown: watch::channel(false).0,
        };
        // Every fresh socket starts at 1, independent of the calls other
        // sockets already made in this process.
        assert_eq!(rpc.begin("a", "/n").unwrap().id(), 1);
        assert_eq!(rpc.begin("a", "/n").unwrap().id(), 2);
        assert_eq!(rpc.begin("b", "/n").unwrap().id(), 1);
        assert_eq!(rpc.begin("a", "/n").unwrap().id(), 3);
        assert_eq!(rpc.begin("b", "/n").unwrap().id(), 2);
    }
}
