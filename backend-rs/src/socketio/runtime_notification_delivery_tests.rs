//! Protocol integration tests with real Redis and a provider test double.

use super::*;
use brz_redis::{
    Cmd, EncodeRedisArg, EncodeRedisArgs, FromRedisBulk, FromRedisValue, RedisResult, RedisService,
    RedisValues,
};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

struct FaultRedis<'a> {
    redis: &'a RedisService,
    fail_reply: AtomicBool,
}

impl Redis for FaultRedis<'_> {
    async fn command<T: FromRedisValue + Send>(&self, command: Cmd) -> RedisResult<T> {
        if command.arg_at(0) == Some(b"SET")
            && command
                .arg_at(1)
                .is_some_and(|key| key.starts_with(b"channel:runtime_task_reply_target:"))
            && self.fail_reply.swap(false, Ordering::SeqCst)
        {
            return Err(brz_redis::RedisError::new(
                brz_redis::ErrorKind::ClientError,
                "Injected reply write failure",
            ));
        }
        self.redis.command(command).await
    }
    async fn eval<S, K, A, R>(&self, script: S, keys: K, arguments: A) -> RedisResult<R>
    where
        S: EncodeRedisArg + Send,
        K: EncodeRedisArgs + Send,
        A: EncodeRedisArgs + Send,
        R: FromRedisValue + Send,
    {
        self.redis.eval(script, keys, arguments).await
    }
    async fn get<K: EncodeRedisArg + Send, T: FromRedisBulk + Send>(
        &self,
        key: K,
    ) -> RedisResult<Option<T>> {
        self.redis.get(key).await
    }
    async fn set<K: EncodeRedisArg + Send, V: EncodeRedisArg + Send>(
        &self,
        key: K,
        value: V,
    ) -> RedisResult<()> {
        self.redis.set(key, value).await
    }
    async fn mget<K: EncodeRedisArgs + Send, T: FromRedisBulk + Send>(
        &self,
        keys: K,
    ) -> RedisResult<Vec<Option<T>>> {
        self.redis.mget(keys).await
    }
    async fn del_many<K: EncodeRedisArgs + Send>(&self, keys: K) -> RedisResult<i64> {
        self.redis.del_many(keys).await
    }
    async fn pfcount<K: EncodeRedisArgs + Send>(&self, keys: K) -> RedisResult<i64> {
        self.redis.pfcount(keys).await
    }
    async fn hget<K: EncodeRedisArg + Send, F: EncodeRedisArg + Send, T: FromRedisBulk + Send>(
        &self,
        key: K,
        field: F,
    ) -> RedisResult<Option<T>> {
        self.redis.hget(key, field).await
    }
    async fn hmget<K: EncodeRedisArg + Send, F: EncodeRedisArgs + Send, T: FromRedisBulk + Send>(
        &self,
        key: K,
        fields: F,
    ) -> RedisResult<RedisValues<T>> {
        self.redis.hmget(key, fields).await
    }
}

#[tokio::test]
#[ignore = "requires loopback MySQL and Redis; runs in Backend Rust CI"]
async fn runtime_notification_replay_preserves_delivery_and_reply_target() -> Result<()> {
    use super::super::super::runtime_notification_outbox as outbox;

    let endpoint = std::env::var("RUNTIME_NOTIFICATION_TEST_REDIS_ADDRESS")?;
    assert!(endpoint.parse::<std::net::SocketAddr>()?.ip().is_loopback());
    let redis = RedisService::single(endpoint).await?;
    let session: PrivateSession = serde_json::from_value(json!({
        "session_key":format!("fixture-{}",crate::device_identity_lock::lock_token()),
        "user_id":7,"channel_id":42,"channel_type":"dingtalk",
        "conversation_id":"private","sender_id":"staff-7"
    }))?;
    let address = json!({"deviceId":"computer","localTaskId":"task-1"});
    let receipt = receipt_key(
        7,
        "computer\0task-1",
        &session.session_key,
        "turn:1:completed",
    );
    let next = receipt_key(
        7,
        "computer\0task-1",
        &session.session_key,
        "turn:2:completed",
    );
    let reply = format!(
        "channel:runtime_task_reply_target:{}:provider-message",
        session.session_key
    );
    let calls = AtomicUsize::new(0);
    let fault = FaultRedis {
        redis: &redis,
        fail_reply: AtomicBool::new(true),
    };
    let send = |_| async {
        calls.fetch_add(1, Ordering::SeqCst);
        Ok(
            json!({"processQueryKey":"provider-message","text":"private notification body","chat":{"id":"private-chat"}}),
        )
    };
    let delivery = || outbox::Delivery {
        session: serde_json::from_value(serde_json::to_value(&session).unwrap()).unwrap(),
        address: address.clone(),
        message: "Done".to_owned(),
    };
    let outcome = outbox::test_database(async |mysql| {
        outbox::enqueue(mysql, vec![(receipt.clone(), delivery())]).await?;
        let first = outbox::claim(mysql).await?.unwrap();
        let rejection = deliver_session(mysql, &fault, &first, |_| async {
            Ok(json!({"code":"Forbidden","message":"provider rejected delivery"}))
        })
        .await
        .unwrap_err();
        assert!(rejection.to_string().contains("Forbidden"));
        let saved: Option<brz_mysql::Json<Value>> = mysql
            .fetch_one(
                "SELECT provider_result FROM runtime_notification_deliveries WHERE id=?",
                (receipt.as_str(),),
            )
            .await?;
        assert!(
            saved.is_none(),
            "An HTTP-level success with a provider error is not a receipt"
        );
        let error = deliver_session(mysql, &fault, &first, send)
            .await
            .unwrap_err();
        assert!(
            error.to_string().contains("Injected reply write failure"),
            "{error:#}"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        outbox::settle(mysql, &first, false).await?;

        // Drop the receipt cache to model eviction or a Redis restart.
        redis.del_many([receipt.as_str(), reply.as_str()]).await?;
        mysql
            .execute(
                "UPDATE runtime_notification_deliveries SET next_attempt_at=UTC_TIMESTAMP(6)",
                (),
            )
            .await?;
        let reopened = outbox::claim(mysql).await?.unwrap();
        assert_eq!(
            reopened.provider_result,
            Some(json!({"messageId":"provider-message"}))
        );
        assert!(!deliver_session(mysql, &fault, &reopened, send).await?);
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "A replay must not send a second notification"
        );
        let saved: Option<String> = redis.get(&reply).await?;
        assert_eq!(serde_json::from_str::<Value>(&saved.unwrap())?, address);
        let saved: String = redis.get(receipt.as_str()).await?.unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&saved)?,
            json!({"messageId":"provider-message"})
        );
        let mut ttl = brz_redis::cmd("TTL");
        ttl.arg(receipt.as_str());
        let ttl: i64 = redis.command(ttl).await?;
        assert!(ttl > 0 && ttl <= 7 * 24 * 60 * 60);
        outbox::settle(mysql, &reopened, true).await?;

        // Replaying the same turn after success remains a no-op.
        outbox::enqueue(mysql, vec![(receipt.clone(), delivery())]).await?;
        assert!(outbox::claim(mysql).await?.is_none());

        // Identical text in another turn is a separate notification.
        outbox::enqueue(mysql, vec![(next.clone(), delivery())]).await?;
        let another = outbox::claim(mysql).await?.unwrap();
        assert!(deliver_session(mysql, &fault, &another, send).await?);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        outbox::settle(mysql, &another, true).await?;

        // Upgrade must also respect receipts written before the MySQL outbox.
        let legacy = format!("{receipt}-legacy");
        redis.set(legacy.as_str(), "sent").await?;
        outbox::enqueue(mysql, vec![(legacy.clone(), delivery())]).await?;
        let migrated = outbox::claim(mysql).await?.unwrap();
        assert!(!deliver_session(mysql, &fault, &migrated, send).await?);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        outbox::settle(mysql, &migrated, true).await?;
        redis.del_many([legacy.as_str()]).await?;
        Ok(())
    })
    .await;
    redis
        .del_many([
            receipt.clone(),
            next.clone(),
            format!("{receipt}:lock"),
            format!("{next}:lock"),
            reply,
        ])
        .await?;
    outcome
}
