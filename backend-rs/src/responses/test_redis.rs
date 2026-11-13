// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Shared Redis command recording for Responses consumer lifecycle tests.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crate::responses::test_mysql::SUBTASK_ID;
use brz_redis::{
    EncodeRedisArg, EncodeRedisArgs, FromRedisBulk, FromRedisValue, RedisResult, SetOptions,
};

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
pub(super) struct RecordingRedis {
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

    pub(super) fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }

    pub(super) fn count(&self, prefix: &str) -> usize {
        self.calls()
            .iter()
            .filter(|call| call.starts_with(prefix))
            .count()
    }

    pub(super) fn cancel_get_after(&self, marker: &str) -> bool {
        let calls = self.calls();
        let Some(index) = calls.iter().position(|call| call == marker) else {
            return false;
        };
        calls[index + 1..]
            .iter()
            .any(|call| call.starts_with("GET chat:cancel:"))
    }

    pub(super) fn mark_cancelled(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    /// Hold the next cancellation GET: `started` resolves when it is admitted,
    /// and the read returns only after `release` fires. A completion records
    /// `GET-END`, so a test can prove the read finished before a later `DEL`.
    pub(super) fn arm_cancel_gate(
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
    async fn eval<S, K, A, R>(&self, script: S, keys: K, arguments: A) -> RedisResult<R>
    where
        S: EncodeRedisArg + Send,
        K: EncodeRedisArgs + Send,
        A: EncodeRedisArgs + Send,
        R: FromRedisValue + Send,
    {
        assert_eq!(
            script.as_encoded_bytes(),
            Some(crate::responses::stream_state::REGISTER_SCRIPT.as_bytes())
        );
        assert_eq!(keys.num_args(), 2);
        assert_eq!(arguments.num_args(), 0);
        let mut command = brz_redis::cmd("EVAL");
        keys.encode_args(&mut command)?;
        let names: Vec<String> = (1..command.arg_count())
            .map(|index| String::from_utf8_lossy(command.arg_at(index).unwrap()).into_owned())
            .collect();
        assert_eq!(
            names,
            [
                format!("chat:cancel:{SUBTASK_ID}"),
                format!("chat:cancel-intent:{SUBTASK_ID}")
            ]
        );
        self.record(format!("EVAL {}", names.join(" ")));
        R::from_redis_value(&brz_redis::Value::Int(0))
    }

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

    async fn del_many<K>(&self, keys: K) -> RedisResult<i64>
    where
        K: EncodeRedisArgs + Send,
    {
        let mut command = brz_redis::cmd("DEL");
        keys.encode_args(&mut command)?;
        let names: Vec<String> = (1..command.arg_count())
            .map(|index| String::from_utf8_lossy(command.arg_at(index).unwrap()).into_owned())
            .collect();
        if names
            .first()
            .is_some_and(|key| key.starts_with("chat:cancel:"))
        {
            assert_eq!(
                names,
                [
                    format!("chat:cancel:{SUBTASK_ID}"),
                    format!("chat:cancel-intent:{SUBTASK_ID}")
                ]
            );
        }
        self.record(format!("DEL-MANY {}", names.join(" ")));
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

    async fn lrange<K, R>(&self, key: K, start: i64, stop: i64) -> RedisResult<Vec<R>>
    where
        K: EncodeRedisArg + Send,
        R: FromRedisValue + Send,
    {
        self.record(format!("LRANGE {} {start} {stop}", Self::key(&key)));
        Ok(Vec::new())
    }

    async fn publish<C, M>(&self, channel: C, message: M) -> RedisResult<i64>
    where
        C: EncodeRedisArg + Send,
        M: EncodeRedisArg + Send,
    {
        let payload = message
            .as_encoded_bytes()
            .map(|bytes| String::from_utf8_lossy(bytes).into_owned())
            .unwrap_or_default();
        self.record(format!("PUBLISH {} {payload}", Self::key(&channel)));
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
