// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Recording fixtures for execution frame contract tests.

use serde_json::Value;

/// A `Redis` stub that records block-content appends and answers the block
/// key reads: the first text-block read misses (create) and later reads
/// return a recorded Source id.
#[derive(Clone, Default)]
pub struct RecordingRedis {
    pub state: std::sync::Arc<std::sync::Mutex<RecordingState>>,
}

#[derive(Default)]
pub struct RecordingState {
    pub text_reads: usize,
    pub appends: Vec<String>,
    /// Every served command rendered as `<COMMAND> <key>`, in call order.
    pub calls: Vec<String>,
    /// The recorded `chat:task_streaming:{task}` object served by `GET`.
    pub task_streaming: Option<String>,
    pub task_streaming_reads: usize,
    /// Every `SET key value` payload, in call order.
    pub sets: Vec<(String, Vec<u8>)>,
    pub evals: Vec<Vec<String>>,
    pub lists: std::collections::HashMap<String, Vec<String>>,
    pub published: Vec<Value>,
    /// Every raw command rendered as space-joined arguments (`PUBLISH ...`).
    pub commands: Vec<String>,
}

impl RecordingRedis {
    fn key_name<K: brz_redis::EncodeRedisArg>(key: &K) -> String {
        key.as_encoded_bytes()
            .map(|bytes| String::from_utf8_lossy(bytes).into_owned())
            .unwrap_or_default()
    }
}

impl brz_redis::Redis for RecordingRedis {
    async fn hset<K, F, V>(&self, _key: K, _field: F, _value: V) -> brz_redis::RedisResult<i64>
    where
        K: brz_redis::EncodeRedisArg + Send,
        F: brz_redis::EncodeRedisArg + Send,
        V: brz_redis::EncodeRedisArg + Send,
    {
        Ok(1)
    }

    async fn eval<S, K, A, R>(&self, script: S, keys: K, arguments: A) -> brz_redis::RedisResult<R>
    where
        S: brz_redis::EncodeRedisArg + Send,
        K: brz_redis::EncodeRedisArgs + Send,
        A: brz_redis::EncodeRedisArgs + Send,
        R: brz_redis::FromRedisValue + Send,
    {
        let mut command = brz_redis::cmd("EVAL");
        command.arg_encoded(script)?;
        command.arg_encoded(keys.num_args())?;
        keys.encode_args(&mut command)?;
        arguments.encode_args(&mut command)?;
        let captured: Vec<String> = (1..command.arg_count())
            .filter_map(|index| command.arg_at(index))
            .map(|bytes| String::from_utf8_lossy(bytes).into_owned())
            .collect();
        let mut state = self.state.lock().expect("state");
        state.evals.push(captured.clone());
        if captured[2].starts_with("chat:streaming:blocks:") {
            let found = state.lists.get(&captured[2]).and_then(|blocks| {
                blocks.iter().enumerate().rev().find(|(_, raw)| {
                    serde_json::from_str::<Value>(raw).unwrap()["id"] == captured[4]
                })
            });
            let values = found
                .map(|(index, raw)| {
                    vec![
                        brz_redis::Value::BulkString(index.to_string().into_bytes().into()),
                        brz_redis::Value::BulkString(raw.as_bytes().to_vec().into()),
                    ]
                })
                .unwrap_or_default();
            return R::from_redis_value(&brz_redis::Value::Array(values));
        }
        if captured[2].starts_with("chat:task_streaming:") {
            let key = &captured[2];
            state.calls.push(format!("EVAL {key}"));
            let current = state
                .sets
                .iter()
                .rev()
                .find(|(stored_key, _)| stored_key == key)
                .map(|(_, value)| String::from_utf8(value.clone()).expect("marker JSON"))
                .or_else(|| state.task_streaming.clone())
                .unwrap_or_default();
            if current != captured[3] {
                return R::from_redis_value(&brz_redis::Value::Int(0));
            }
            state
                .sets
                .push((key.clone(), captured[4].as_bytes().to_vec()));
        }
        R::from_redis_value(&brz_redis::Value::Int(1))
    }

    async fn command<R>(&self, command: brz_redis::Cmd) -> brz_redis::RedisResult<R>
    where
        R: brz_redis::FromRedisValue + Send,
    {
        let rendered = (0..command.arg_count())
            .filter_map(|index| command.arg_at(index))
            .map(|bytes| String::from_utf8_lossy(bytes).into_owned())
            .collect::<Vec<_>>()
            .join(" ");
        self.state.lock().expect("state").commands.push(rendered);
        R::from_redis_value(&brz_redis::Value::Int(0))
    }

    async fn get<K, R>(&self, key: K) -> brz_redis::RedisResult<Option<R>>
    where
        K: brz_redis::EncodeRedisArg + Send,
        R: brz_redis::FromRedisBulk + Send,
    {
        let name = Self::key_name(&key);
        self.state
            .lock()
            .expect("state")
            .calls
            .push(format!("GET {name}"));
        if name.starts_with("chat:streaming:text_block:") {
            let mut state = self.state.lock().expect("state");
            state.text_reads += 1;
            if state.text_reads > 1 {
                return R::from_redis_bulk(brz_redis::RedisBytes::from(
                    b"text-1792479722634".to_vec(),
                ))
                .map(Some);
            }
        }
        if name.starts_with("chat:task_streaming:") {
            let mut state = self.state.lock().expect("state");
            state.task_streaming_reads += 1;
            // Read-after-write: Replay serves the value this target already
            // wrote for the key before any canned recorded object.
            if let Some((_, value)) = state.sets.iter().rev().find(|(key, _)| *key == name) {
                return R::from_redis_bulk(brz_redis::RedisBytes::from(value.clone())).map(Some);
            }
            if let Some(value) = state.task_streaming.clone() {
                return R::from_redis_bulk(brz_redis::RedisBytes::from(value.into_bytes()))
                    .map(Some);
            }
        }
        Ok(None)
    }

    async fn set<K, V>(&self, key: K, _value: V) -> brz_redis::RedisResult<()>
    where
        K: brz_redis::EncodeRedisArg + Send,
        V: brz_redis::EncodeRedisArg + Send,
    {
        let name = Self::key_name(&key);
        self.state
            .lock()
            .expect("state")
            .calls
            .push(format!("SET {name}"));
        Ok(())
    }

    async fn set_with<K, V>(
        &self,
        key: K,
        value: V,
        _options: brz_redis::SetOptions,
    ) -> brz_redis::RedisResult<bool>
    where
        K: brz_redis::EncodeRedisArg + Send,
        V: brz_redis::EncodeRedisArg + Send,
    {
        let name = Self::key_name(&key);
        let payload = value
            .as_encoded_bytes()
            .map(<[u8]>::to_vec)
            .unwrap_or_default();
        let mut state = self.state.lock().expect("state");
        state.calls.push(format!("SET {name}"));
        state.sets.push((name, payload));
        Ok(true)
    }

    async fn append<K, V>(&self, key: K, _value: V) -> brz_redis::RedisResult<i64>
    where
        K: brz_redis::EncodeRedisArg + Send,
        V: brz_redis::EncodeRedisArg + Send,
    {
        let name = Self::key_name(&key);
        let mut state = self.state.lock().expect("state");
        state.calls.push(format!("APPEND {name}"));
        if name.starts_with("chat:streaming:block_content:") {
            state.appends.push(name);
        }
        Ok(0)
    }

    async fn expire<K>(&self, key: K, _seconds: u64) -> brz_redis::RedisResult<bool>
    where
        K: brz_redis::EncodeRedisArg + Send,
    {
        let name = Self::key_name(&key);
        self.state
            .lock()
            .expect("state")
            .calls
            .push(format!("EXPIRE {name}"));
        Ok(true)
    }

    async fn rpush<K, V>(&self, key: K, values: V) -> brz_redis::RedisResult<i64>
    where
        K: brz_redis::EncodeRedisArg + Send,
        V: brz_redis::EncodeRedisArgs + Send,
    {
        let name = Self::key_name(&key);
        let mut command = brz_redis::cmd("RPUSH");
        values.encode_args(&mut command)?;
        let values = (1..command.arg_count())
            .filter_map(|index| command.arg_at(index))
            .map(|bytes| String::from_utf8_lossy(bytes).into_owned());
        let mut state = self.state.lock().expect("state");
        state.calls.push(format!("RPUSH {name}"));
        let list = state.lists.entry(name).or_default();
        list.extend(values);
        Ok(list.len() as i64)
    }

    async fn lrange<K, R>(&self, key: K, start: i64, stop: i64) -> brz_redis::RedisResult<Vec<R>>
    where
        K: brz_redis::EncodeRedisArg + Send,
        R: brz_redis::FromRedisValue + Send,
    {
        assert_eq!((start, stop), (0, -1));
        let state = self.state.lock().expect("state");
        state
            .lists
            .get(&Self::key_name(&key))
            .into_iter()
            .flatten()
            .map(|value| {
                R::from_redis_value(&brz_redis::Value::BulkString(
                    value.as_bytes().to_vec().into(),
                ))
            })
            .collect()
    }

    async fn lset<K, V>(&self, key: K, index: i64, value: V) -> brz_redis::RedisResult<()>
    where
        K: brz_redis::EncodeRedisArg + Send,
        V: brz_redis::EncodeRedisArg + Send,
    {
        let mut state = self.state.lock().expect("state");
        let list = state.lists.get_mut(&Self::key_name(&key)).expect("list");
        list[index as usize] = Self::key_name(&value);
        Ok(())
    }

    async fn publish<C, M>(&self, channel: C, message: M) -> brz_redis::RedisResult<i64>
    where
        C: brz_redis::EncodeRedisArg + Send,
        M: brz_redis::EncodeRedisArg + Send,
    {
        assert_eq!(Self::key_name(&channel), "socketio");
        self.state
            .lock()
            .expect("state")
            .published
            .push(serde_json::from_str(&Self::key_name(&message)).expect("publish JSON"));
        Ok(1)
    }

    async fn mget<K, R>(&self, _keys: K) -> brz_redis::RedisResult<Vec<Option<R>>>
    where
        K: brz_redis::EncodeRedisArgs + Send,
        R: brz_redis::FromRedisBulk + Send,
    {
        Ok(Vec::new())
    }

    async fn del_many<K>(&self, _keys: K) -> brz_redis::RedisResult<i64>
    where
        K: brz_redis::EncodeRedisArgs + Send,
    {
        Ok(0)
    }

    async fn pfcount<K>(&self, _keys: K) -> brz_redis::RedisResult<i64>
    where
        K: brz_redis::EncodeRedisArgs + Send,
    {
        Ok(0)
    }

    async fn hget<K, F, R>(&self, _key: K, _field: F) -> brz_redis::RedisResult<Option<R>>
    where
        K: brz_redis::EncodeRedisArg + Send,
        F: brz_redis::EncodeRedisArg + Send,
        R: brz_redis::FromRedisBulk + Send,
    {
        Ok(None)
    }

    async fn hmget<K, F, R>(
        &self,
        _key: K,
        _fields: F,
    ) -> brz_redis::RedisResult<brz_redis::RedisValues<R>>
    where
        K: brz_redis::EncodeRedisArg + Send,
        F: brz_redis::EncodeRedisArgs + Send,
        R: brz_redis::FromRedisBulk + Send,
    {
        Err(brz_redis::RedisError::new(
            brz_redis::ErrorKind::ClientError,
            "stub does not serve HMGET",
        ))
    }
}

#[cfg(test)]
#[derive(Default)]
pub(crate) struct NoopEmit;

#[cfg(test)]
impl crate::LocalEmit for NoopEmit {
    async fn deliver(
        &self,
        _namespace: &str,
        _event: &str,
        _room: &str,
        _skip_sid: Option<&str>,
        _payload: &Value,
    ) {
    }
}
