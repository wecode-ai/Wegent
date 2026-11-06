//! Real Redis protocol tests, explicitly invoked by the Backend Rust CI job.
use super::*;
use brz_redis::{Redis, RedisService};

async fn connection() -> RedisService {
    RedisService::single(
        std::env::var("GIT_INBOX_TEST_REDIS_ENDPOINT").expect("isolated Redis endpoint required"),
    )
    .await
    .expect("Redis connection")
}

fn subscription(user: i64, id: &str) -> Value {
    json!({"id":id,"user_id":user,"device_id":"computer","generation":"old","source":{"provider":"github","instance":"https://github.com","accountId":"7","repositoryId":"42","repositoryPath":"org/repo"},"secret":"encrypted-secret","active":true,"confirmed_sequence":0,"latest_sequence":0,"gap_before":0,"pending_count":0,"last_received_at":null,"connection_key":"source"})
}

async fn append(redis: &RedisService, id: &str, delivery: &str) -> Value {
    run(redis,id,None,"append",json!({"secret":"encrypted-secret","deliveryId":delivery,"delivery":json!({"id":delivery,"payload":{"largeId":u64::MAX}}).to_string(),"receivedAt":"2026-11-04T00:00:00Z"})).await.unwrap()
}

async fn atomic_dedup_ack_takeover_and_expiry_use_real_redis() {
    let redis = connection().await;
    let id = crypto::random_id().unwrap();
    let user = 1_000_000_000 + i64::from(u32::from_str_radix(&id[..7], 16).unwrap());
    let created = run(&redis, &id, Some(user), "create", subscription(user, &id))
        .await
        .unwrap();
    let another = crypto::random_id().unwrap();
    let repeated = run(
        &redis,
        &another,
        Some(user),
        "create",
        subscription(user, &another),
    )
    .await
    .unwrap();
    assert_eq!(created["row"]["id"], repeated["row"]["id"]);
    let (first, duplicate) = tokio::join!(append(&redis, &id, "one"), append(&redis, &id, "one"));
    assert_eq!(first["row"]["latest_sequence"], 1);
    assert_eq!(duplicate["row"]["pending_count"], 1);
    assert!(
        run(&redis, &id, Some(user + 1), "get", json!({}))
            .await
            .is_err()
    );
    let old = json!({"deviceId":"computer","generation":"old","after":0});
    let page = run(&redis, &id, Some(user), "events", old.clone())
        .await
        .unwrap();
    assert_eq!(page["items"][0]["sequence"], 1);
    let payload: Value = serde_json::from_str(page["items"][0]["data"].as_str().unwrap()).unwrap();
    assert_eq!(payload["payload"]["largeId"], json!(u64::MAX));
    assert!(
        run(
            &redis,
            &id,
            Some(user),
            "ack",
            json!({"deviceId":"computer","generation":"old","sequence":2})
        )
        .await
        .is_err()
    );
    run(
        &redis,
        &id,
        Some(user),
        "ack",
        json!({"deviceId":"computer","generation":"old","sequence":1}),
    )
    .await
    .unwrap();
    assert_eq!(append(&redis, &id, "one").await["row"]["pending_count"], 0);
    append(&redis, &id, "two").await;
    let changed=run(&redis,&id,Some(user),"update",json!({"deviceId":"cloud","generation":"old","nextGeneration":"new","connection_key":"cloud-source"})).await.unwrap();
    assert_eq!(changed["row"]["confirmed_sequence"], 1);
    for operation in ["events", "remove", "configuration"] {
        assert!(
            run(&redis, &id, Some(user), operation, old.clone())
                .await
                .is_err()
        );
    }
    append(&redis, &id, "three").await;
    let key = format!("{PREFIX}subscription:{id}");
    let ttl: i64 = redis
        .eval(
            "return redis.call('TTL',KEYS[1])",
            [format!("{key}:queue")],
            Vec::<String>::new(),
        )
        .await
        .unwrap();
    assert!(ttl > 2_591_900 && ttl <= 2_592_000);
    let _: i64 = redis
        .eval(
            "return redis.call('ZADD',KEYS[1],0,'2')",
            [format!("{key}:expiry")],
            Vec::<String>::new(),
        )
        .await
        .unwrap();
    assert!(
        run(
            &redis,
            &id,
            Some(user),
            "ack",
            json!({"deviceId":"cloud","generation":"new","sequence":999})
        )
        .await
        .is_err()
    );
    let expired = run(&redis, &id, Some(user), "get", json!({}))
        .await
        .unwrap();
    assert_eq!(expired["row"]["gap_before"], 2);
    assert_eq!(expired["row"]["pending_count"], 1);
    assert_eq!(
        run(&redis, &id, Some(user), "get", json!({}))
            .await
            .unwrap()["row"]["gap_before"],
        2
    );
    append(&redis, &id, "three").await;
    let _: i64 = redis
        .eval(
            "return redis.call('DEL',KEYS[1])",
            [format!("{key}:queue")],
            Vec::<String>::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        run(&redis, &id, Some(user), "get", json!({}))
            .await
            .unwrap()["row"]["gap_before"],
        3
    );
    run(
        &redis,
        &id,
        Some(user),
        "remove",
        json!({"deviceId":"cloud","generation":"new"}),
    )
    .await
    .unwrap();
    assert!(
        run(
            &redis,
            &id,
            None,
            "append",
            json!({"secret":"encrypted-secret"})
        )
        .await
        .is_err()
    );
    let listed = run(&redis, "", Some(user), "list", json!({}))
        .await
        .unwrap();
    assert!(
        !listed["ids"]
            .as_array()
            .is_some_and(|ids| ids.contains(&json!(id)))
    );
}

async fn capacity_rejection_and_pagination_never_silently_trim_pending_events() {
    let redis = connection().await;
    let id = crypto::random_id().unwrap();
    let user = 2_000_000_000 + i64::from(u32::from_str_radix(&id[..7], 16).unwrap());
    run(&redis, &id, Some(user), "create", subscription(user, &id))
        .await
        .unwrap();
    for number in 0..101 {
        append(&redis, &id, &number.to_string()).await;
    }
    let binding = json!({"deviceId":"computer","generation":"old","after":0});
    let first = run(&redis, &id, Some(user), "events", binding.clone())
        .await
        .unwrap();
    assert_eq!(first["items"].as_array().unwrap().len(), 100);
    let second = run(
        &redis,
        &id,
        Some(user),
        "events",
        json!({"deviceId":"computer","generation":"old","after":100}),
    )
    .await;
    let second = second.unwrap();
    assert_eq!(second["items"].as_array().unwrap().len(), 1);
    assert_eq!(second["items"][0]["sequence"], 101);
    let key = format!("{PREFIX}subscription:{id}");
    let _:i64=redis.eval("for i=102,10000 do redis.call('ZADD',KEYS[1],i,tostring(i)) end return redis.call('ZCARD',KEYS[1])",[format!("{key}:queue")],Vec::<String>::new()).await.unwrap();
    assert!(run(&redis,&id,None,"append",json!({"secret":"encrypted-secret","deliveryId":"overflow","delivery":"{}","receivedAt":"now"})).await.is_err());
    let retained = run(&redis, &id, Some(user), "get", json!({}))
        .await
        .unwrap();
    assert_eq!(retained["row"]["pending_count"], 10000);
    assert_eq!(retained["row"]["latest_sequence"], 101);
    run(&redis, &id, Some(user), "remove", binding)
        .await
        .unwrap();
}

// One runtime keeps the Redis transport's process-wide resolver alive for both scenarios.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires isolated Redis; executed by test-backend-rs CI"]
async fn redis_inbox_contract() {
    atomic_dedup_ack_takeover_and_expiry_use_real_redis().await;
    capacity_rejection_and_pagination_never_silently_trim_pending_events().await;
}
