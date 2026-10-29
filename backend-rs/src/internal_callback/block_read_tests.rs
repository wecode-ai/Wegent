// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Block hydration regression tests using the real session loader.
use super::session;
use brz_redis::{
    EncodeRedisArg, EncodeRedisArgs, FromRedisBulk, FromRedisValue, RedisValues, Value,
};

/// `LRANGE` is an arbitrary command here, so the default `command` path
/// rejects it like a failed dependency read.
struct FailingListRedis;

/// `LRANGE` succeeds but the stored list is empty.
struct EmptyListRedis;

/// `LRANGE` returns one block that references a content key, and `MGET`
/// fails while hydrating it.
struct FailingHydrationRedis;

/// Serve either a missing Redis key or an explicitly stored content string.
struct HydratedContentRedis(Option<&'static str>);

fn block_entry() -> String {
    r#"{"id":"b1","type":"text","content":"","status":"done","timestamp":1,"_content_key":"chat:streaming:block_content:5:b1"}"#.to_string()
}

macro_rules! required_redis_items {
    () => {
        async fn get<K, R>(&self, _key: K) -> brz_redis::RedisResult<Option<R>>
        where
            K: EncodeRedisArg + Send,
            R: FromRedisBulk + Send,
        {
            Ok(None)
        }

        async fn set<K, V>(&self, _key: K, _value: V) -> brz_redis::RedisResult<()>
        where
            K: EncodeRedisArg + Send,
            V: EncodeRedisArg + Send,
        {
            Ok(())
        }

        async fn del_many<K>(&self, _keys: K) -> brz_redis::RedisResult<i64>
        where
            K: EncodeRedisArgs + Send,
        {
            Ok(0)
        }

        async fn pfcount<K>(&self, _keys: K) -> brz_redis::RedisResult<i64>
        where
            K: EncodeRedisArgs + Send,
        {
            Ok(0)
        }

        async fn hget<K, F, R>(&self, _key: K, _field: F) -> brz_redis::RedisResult<Option<R>>
        where
            K: EncodeRedisArg + Send,
            F: EncodeRedisArg + Send,
            R: FromRedisBulk + Send,
        {
            Ok(None)
        }

        async fn hmget<K, F, R>(
            &self,
            _key: K,
            _fields: F,
        ) -> brz_redis::RedisResult<RedisValues<R>>
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
    };
}

impl brz_redis::Redis for FailingListRedis {
    required_redis_items!();

    async fn mget<K, R>(&self, _keys: K) -> brz_redis::RedisResult<Vec<Option<R>>>
    where
        K: EncodeRedisArgs + Send,
        R: FromRedisBulk + Send,
    {
        Ok(Vec::new())
    }
}

impl brz_redis::Redis for EmptyListRedis {
    required_redis_items!();

    async fn mget<K, R>(&self, _keys: K) -> brz_redis::RedisResult<Vec<Option<R>>>
    where
        K: EncodeRedisArgs + Send,
        R: FromRedisBulk + Send,
    {
        Ok(Vec::new())
    }

    async fn lrange<K, R>(&self, _key: K, _start: i64, _stop: i64) -> brz_redis::RedisResult<Vec<R>>
    where
        K: EncodeRedisArg + Send,
        R: FromRedisValue + Send,
    {
        Ok(Vec::new())
    }
}

impl brz_redis::Redis for FailingHydrationRedis {
    required_redis_items!();

    async fn lrange<K, R>(&self, _key: K, _start: i64, _stop: i64) -> brz_redis::RedisResult<Vec<R>>
    where
        K: EncodeRedisArg + Send,
        R: FromRedisValue + Send,
    {
        R::from_redis_value(&Value::BulkString(block_entry().into_bytes().into()))
            .map(|block| vec![block])
    }

    async fn mget<K, R>(&self, _keys: K) -> brz_redis::RedisResult<Vec<Option<R>>>
    where
        K: EncodeRedisArgs + Send,
        R: FromRedisBulk + Send,
    {
        Err(brz_redis::RedisError::new(
            brz_redis::ErrorKind::ClientError,
            "stub read failure",
        ))
    }
}

impl brz_redis::Redis for HydratedContentRedis {
    required_redis_items!();

    async fn lrange<K, R>(&self, _key: K, _start: i64, _stop: i64) -> brz_redis::RedisResult<Vec<R>>
    where
        K: EncodeRedisArg + Send,
        R: FromRedisValue + Send,
    {
        let mut block: serde_json::Value = serde_json::from_str(&block_entry()).expect("block");
        block["text"] = serde_json::json!("stale metadata alias");
        let bytes = serde_json::to_vec(&block).expect("block JSON");
        R::from_redis_value(&Value::BulkString(bytes.into())).map(|block| vec![block])
    }

    /// Match Redis MGET's missing bulk reply without conflating it with empty bytes.
    async fn mget<K, R>(&self, _keys: K) -> brz_redis::RedisResult<Vec<Option<R>>>
    where
        K: EncodeRedisArgs + Send,
        R: FromRedisBulk + Send,
    {
        let content = self
            .0
            .map(|text| R::from_redis_bulk(brz_redis::RedisBytes::from(text.as_bytes().to_vec())))
            .transpose()?;
        Ok(vec![content])
    }
}

#[tokio::test]
async fn a_missing_content_key_is_not_an_explicit_empty_snapshot() {
    let redis = HydratedContentRedis(None);
    let blocks = session::get_blocks(&redis, 5).await;
    assert_eq!(blocks.len(), 1);
    assert!(!blocks[0].contains_key("content"));
    assert!(!blocks[0].contains_key("text"));
    assert!(!blocks[0].contains_key(session::BLOCK_CONTENT_KEY_FIELD));
    let finalized = session::finalize_and_get_blocks(&redis, 5, None, Some("COMPLETED")).await;
    assert!(!finalized[0].contains_key("content"));
}

#[tokio::test]
async fn an_explicitly_stored_empty_content_key_remains_empty() {
    let redis = HydratedContentRedis(Some(""));
    let blocks = session::get_blocks(&redis, 5).await;
    assert_eq!(blocks.len(), 1);
    assert_eq!(blocks[0].get("content"), Some(&serde_json::json!("")));
    let finalized = session::finalize_and_get_blocks(&redis, 5, None, Some("COMPLETED")).await;
    assert_eq!(finalized[0].get("content"), Some(&serde_json::json!("")));
}

#[tokio::test]
async fn a_failed_block_read_yields_no_blocks() {
    let redis = FailingListRedis;
    assert!(session::get_blocks(&redis, 5).await.is_empty());
    assert!(
        session::finalize_and_get_blocks(&redis, 5, None, Some("COMPLETED"))
            .await
            .is_empty()
    );
}

#[tokio::test]
async fn an_empty_block_list_yields_no_blocks() {
    let redis = EmptyListRedis;
    assert!(session::get_blocks(&redis, 5).await.is_empty());
    assert!(
        session::finalize_and_get_blocks(&redis, 5, None, Some("COMPLETED"))
            .await
            .is_empty()
    );
}

#[tokio::test]
async fn a_failed_content_hydration_yields_no_blocks() {
    let redis = FailingHydrationRedis;
    assert!(session::get_blocks(&redis, 5).await.is_empty());
    assert!(
        session::finalize_and_get_blocks(&redis, 5, None, Some("COMPLETED"))
            .await
            .is_empty()
    );
}
