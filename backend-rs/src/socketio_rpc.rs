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
use std::sync::atomic::{AtomicU64, Ordering};
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
const MAX_FRAME_BYTES: usize = 1024 * 1024;
/// In-flight callbacks retained per process.
const MAX_WAITERS: usize = 1024;
/// Connection and authentication budget.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// Bounded reconnect budget after one subscription is lost.
const MAX_RECONNECT_ATTEMPTS: u32 = 5;
const RECONNECT_BASE_DELAY: Duration = Duration::from_secs(1);
const MAX_RECONNECT_DELAY: Duration = Duration::from_secs(30);

type CallbackKey = (String, String, u64);
type Waiters = Mutex<HashMap<CallbackKey, oneshot::Sender<Value>>>;

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
    next_id: AtomicU64,
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
        let (shutdown, receiver) = watch::channel(false);
        let endpoint = Endpoint {
            host: config.host.clone(),
            port: config.port,
            db: config.db,
            password: config.password.clone(),
        };
        let worker_waiters = Arc::clone(&waiters);
        tokio::spawn(run(worker_waiters, endpoint, receiver));
        Arc::new(Self {
            waiters,
            next_id: AtomicU64::new(0),
            _shutdown: shutdown,
        })
    }

    /// Register one callback waiter before its `emit` is published.
    pub fn begin(&self, sid: &str, namespace: &str) -> Result<SocketIoCall, RpcError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed).wrapping_add(1);
        let id = if id == 0 {
            self.next_id.fetch_add(1, Ordering::Relaxed).wrapping_add(1)
        } else {
            id
        };
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

async fn run(waiters: Arc<Waiters>, endpoint: Endpoint, mut shutdown: watch::Receiver<bool>) {
    let mut attempts = 0_u32;
    loop {
        let outcome = tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    return;
                }
                continue;
            }
            outcome = subscribe_and_read(&endpoint, &waiters) => outcome,
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

async fn subscribe_and_read(endpoint: &Endpoint, waiters: &Waiters) -> anyhow::Result<()> {
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
                    dispatch(value, waiters);
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

/// Route one inbound adapter frame. Only `callback` messages addressed to this
/// process are consumed; subscription confirmations and peer traffic are
/// ignored.
fn dispatch(value: brz_redis::types::Value, waiters: &Waiters) {
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
    if message.get("method").and_then(Value::as_str) != Some("callback") {
        return;
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
        );
        assert_eq!(waiters.lock().unwrap().len(), 1);
    }

    #[test]
    fn dropping_a_call_removes_its_waiter() {
        let rpc = SocketIoRpc {
            waiters: Arc::new(Mutex::new(HashMap::new())),
            next_id: AtomicU64::new(0),
            _shutdown: watch::channel(false).0,
        };
        let call = rpc.begin("sid", "/local-executor").unwrap();
        assert_eq!(call.id(), 1);
        assert_eq!(rpc.waiters.lock().unwrap().len(), 1);
        drop(call);
        assert!(rpc.waiters.lock().unwrap().is_empty());
    }

    #[test]
    fn callback_ids_start_at_one() {
        let rpc = SocketIoRpc {
            waiters: Arc::new(Mutex::new(HashMap::new())),
            next_id: AtomicU64::new(0),
            _shutdown: watch::channel(false).0,
        };
        assert_eq!(rpc.begin("a", "/n").unwrap().id(), 1);
        assert_eq!(rpc.begin("b", "/n").unwrap().id(), 2);
    }
}
