//! Real transactions and presence checks for automatic registration retention.
use super::*;
use brz_mysql::MysqlService;
use brz_redis::RedisService;
use std::time::{SystemTime, UNIX_EPOCH};

async fn verify(mysql: &MysqlService, redis: &RedisService, user: i64) {
    mysql
        .execute("CREATE TABLE users(id BIGINT PRIMARY KEY)", ())
        .await
        .unwrap();
    mysql
        .execute("INSERT INTO users VALUES (?)", (user,))
        .await
        .unwrap();
    mysql.execute("CREATE TABLE kinds(id BIGINT PRIMARY KEY,user_id BIGINT,kind TEXT,name TEXT,namespace TEXT,json JSON,is_active BOOL,created_at DATETIME,updated_at DATETIME)",()).await.unwrap();
    mysql.execute("CREATE TABLE subtasks(id BIGINT PRIMARY KEY,user_id BIGINT,executor_name TEXT,status TEXT)",()).await.unwrap();
    mysql.execute("CREATE TABLE loop_item_executions(id BIGINT PRIMARY KEY,executor_owner_user_id BIGINT,runtime_device_id TEXT,runtime_instance_id TEXT,status TEXT)",()).await.unwrap();
    let now = Utc::now();
    for id in 1..=9_i64 {
        let name = format!("retention-{user}-{id}");
        let status = match id {
            3 => json!({"lastSeenAt": now.to_rfc3339()}),
            4 => json!({}),
            _ => json!({"lastSeenAt": (now-TimeDelta::days(8)).to_rfc3339()}),
        };
        let document = json!({"spec":{"deviceType":if id == 9 {"cloud"} else {"app"},"runtimeInstanceId":"fixture","cloudConfig":{"sandboxId":"managed-fixture"}},"status":status});
        mysql
            .execute(
                "INSERT INTO kinds VALUES (?,?,'Device',?,'default',?,true,NOW(),NOW())",
                (id, user, name, Json(document)),
            )
            .await
            .unwrap();
    }
    let online = online_key(user, "app-record-2");
    let malformed = online_key(user, "app-record-7");
    let legacy = online_key(user, &format!("retention-{user}-8"));
    redis
        .set(&online, "{\"socket_id\":\"fixture\"}")
        .await
        .unwrap();
    redis.set(&malformed, "not-json").await.unwrap();
    redis
        .set(
            &legacy,
            "{\"socket_id\":\"fixture\",\"runtime_instance_id\":\"fixture\"}",
        )
        .await
        .unwrap();
    mysql
        .execute(
            "INSERT INTO subtasks VALUES (1,?,'device-app-record-5','RUNNING')",
            (user,),
        )
        .await
        .unwrap();
    mysql
        .execute(
            "INSERT INTO loop_item_executions VALUES (1,?,'app-record-6','fixture','queued')",
            (user,),
        )
        .await
        .unwrap();
    let tables = vec!["subtasks".to_owned()];
    for id in 1..=9_i64 {
        let removed = mysql
            .with_transaction(async |tx| prune_record(tx, redis, user, id, &tables, now).await)
            .await
            .unwrap();
        assert_eq!(
            removed,
            id == 1,
            "Only the expired idle registration may be removed: {id}"
        );
    }
    let active: Vec<(i64,)> = mysql
        .fetch_all("SELECT id FROM kinds WHERE is_active=true ORDER BY id", ())
        .await
        .unwrap();
    assert_eq!(active, (2..=9).map(|id| (id,)).collect::<Vec<_>>());
    let unknown: (Json<Value>,) = mysql
        .fetch_one("SELECT json FROM kinds WHERE id=4", ())
        .await
        .unwrap();
    assert!(
        unknown.0.0["status"]["offlineSince"]
            .as_str()
            .and_then(crate::device_presence::parse_observed_time)
            .is_some(),
        "Unknown presence must start a retention clock: {}",
        unknown.0.0
    );
    // Rechecking an unknown registration starts its retention clock, never deletes it immediately.
    assert!(
        !mysql
            .with_transaction(async |tx| prune_record(tx, redis, user, 4, &tables, now).await)
            .await
            .unwrap()
    );
    for key in [&online, &malformed, &legacy] {
        redis.del(key).await.unwrap();
    }
    assert!(
        mysql
            .fetch_optional::<_, _, (i64,)>("SELECT id FROM subtasks WHERE id=1", ())
            .await
            .unwrap()
            .is_some()
    );
    assert!(
        mysql
            .fetch_optional::<_, _, (i64,)>("SELECT id FROM loop_item_executions WHERE id=1", ())
            .await
            .unwrap()
            .is_some()
    );
}

#[tokio::test]
#[ignore = "requires disposable loopback MySQL and Redis; invoked by Backend Rust CI"]
async fn retention_preserves_online_busy_unknown_and_recent_registrations() {
    let address: std::net::SocketAddr = std::env::var("WEGENT_TEST_MYSQL_ADDRESS")
        .unwrap()
        .parse()
        .unwrap();
    let redis_address: std::net::SocketAddr = std::env::var("WEGENT_TEST_REDIS_ADDRESS")
        .unwrap()
        .parse()
        .unwrap();
    assert!(address.ip().is_loopback() && redis_address.ip().is_loopback());
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let user = (nonce % 1_000_000_000) as i64 + 1_000_000_000;
    let database = format!("retention_{nonce}");
    let url = |name| format!("mysql://root@{address}/{name}?ssl-mode=disabled");
    let admin = MysqlService::connect(&url("mysql")).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {database}"), ())
        .await
        .unwrap();
    let mysql = MysqlService::connect(&url(&database)).await.unwrap();
    let redis = RedisService::single(redis_address.to_string())
        .await
        .unwrap();
    let test_mysql = mysql.clone();
    let result = tokio::spawn(async move { verify(&test_mysql, &redis, user).await }).await;
    mysql.close().await;
    admin
        .execute(format!("DROP DATABASE {database}"), ())
        .await
        .unwrap();
    result.unwrap();
}
