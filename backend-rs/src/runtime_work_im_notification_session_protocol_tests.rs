// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Real Redis read/write routing with an independent, stale reader snapshot.
//! Reuses the CI job's two Redis servers without changing replication settings.

use super::*;
use anyhow::{Result, ensure};
use serde_json::json;

#[tokio::test]
#[ignore = "requires the two loopback Redis servers in Backend Rust CI"]
async fn runtime_notification_recipient_decisions_ignore_stale_readers() -> Result<()> {
    let writer = std::env::var("WEGENT_TEST_REDIS_ADDRESS")?;
    let reader = std::env::var("WEGENT_TEST_REDIS_REPLICA_ADDRESS")?;
    for endpoint in [&writer, &reader] {
        ensure!(endpoint.parse::<std::net::SocketAddr>()?.ip().is_loopback());
    }
    ensure!(writer != reader);
    let primary = RedisService::single(writer.clone()).await?;
    let stale = RedisService::single(reader.clone()).await?;
    let routed = RedisService::noshard(writer, [reader]).await?;
    let user = chrono::Utc::now().timestamp_micros();
    let session = format!("notification-{}", crate::device_identity_lock::lock_token());
    let keys = [
        global_notification_key(user),
        user_sessions_key(user),
        presence_key(user),
        private_session_key(&session),
    ];
    let result = verify_decisions(&primary, &stale, &routed, user, &session).await;
    let primary_cleanup = primary.del_many(keys.clone()).await;
    let reader_cleanup = stale.del_many(keys).await;
    result?;
    primary_cleanup?;
    reader_cleanup?;
    Ok(())
}

async fn verify_decisions(
    primary: &RedisService,
    stale: &RedisService,
    routed: &RedisService,
    user: i64,
    session: &str,
) -> Result<()> {
    let address = json!({"deviceId":"fixture-device","localTaskId":"fixture-task"});
    let cache = RedisNotificationSessionCache {
        redis: Some(routed),
    };
    seed_recipient(primary, stale, user, session, &address).await?;
    assert!(
        routed
            .zrevrange::<_, String>(user_sessions_key(user), 0, -1)
            .await?
            .is_empty()
    );
    let recipients = resolve(&cache, user, &address).await?;
    assert_eq!(
        recipients.len(),
        1,
        "A stale index must not suppress delivery"
    );
    assert_eq!(recipients[0].session_key, session);
    verify_presence(primary, stale, routed, user, session, &address).await
}

async fn seed_recipient(
    primary: &RedisService,
    stale: &RedisService,
    user: i64,
    session: &str,
    address: &Value,
) -> Result<()> {
    primary
        .set(
            global_notification_key(user),
            json!({"enabled":true}).to_string(),
        )
        .await?;
    stale
        .set(
            global_notification_key(user),
            json!({"enabled":false}).to_string(),
        )
        .await?;
    primary
        .set(
            private_session_key(session),
            json!({
                "session_key":session,"user_id":user,"channel_type":"dingtalk","channel_id":42,
                "conversation_id":"private","sender_id":"staff","active_runtime_task":address
            })
            .to_string(),
        )
        .await?;
    add_member(primary, &user_sessions_key(user), session).await?;
    Ok(())
}

async fn verify_presence(
    primary: &RedisService,
    stale: &RedisService,
    routed: &RedisService,
    user: i64,
    session: &str,
    address: &Value,
) -> Result<()> {
    let cache = RedisNotificationSessionCache {
        redis: Some(routed),
    };
    primary.del_many([user_sessions_key(user)]).await?;
    primary
        .set(
            global_notification_key(user),
            json!({"enabled":true,"session_key":session}).to_string(),
        )
        .await?;
    add_member(primary, &presence_key(user), "fixture\0active").await?;
    assert!(
        resolve(&cache, user, address).await?.is_empty(),
        "Current foreground presence suppresses default delivery"
    );

    primary.del_many([presence_key(user)]).await?;
    add_member(stale, &presence_key(user), "fixture\0active").await?;
    assert_eq!(
        routed
            .zrevrange::<_, String>(presence_key(user), 0, -1)
            .await?
            .len(),
        1
    );
    let recipients = resolve(&cache, user, address).await?;
    assert_eq!(
        recipients.len(),
        1,
        "Stale foreground presence must not suppress an away user's delivery"
    );
    assert_eq!(recipients[0].session_key, session);
    Ok(())
}

async fn add_member(redis: &RedisService, key: &str, member: &str) -> Result<()> {
    let mut command = brz_redis::cmd("ZADD");
    command.arg(key).arg(unix_seconds() + 3600.0).arg(member);
    let _: i64 = redis.command(command).await?;
    Ok(())
}
