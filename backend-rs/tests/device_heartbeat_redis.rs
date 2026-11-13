// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Device heartbeat regression through the production Socket.IO handlers and Redis.

#[allow(dead_code)]
#[path = "support/engineio_poll_client.rs"]
mod engineio_poll_client;
#[allow(dead_code)]
#[path = "support/responses_mysql.rs"]
mod fixture;

use std::{net::SocketAddr, sync::Arc, time::Duration};

use brz_redis::{Redis, RedisService, cmd};
use engineio_poll_client::PollClient;
use serde_json::{Value, json};
use tokio::{net::TcpListener, sync::oneshot, time::timeout};
use wegent_backend_rs::{build_app_state_with_clients, migrations, socketio};

const USER_ID: i32 = 7;
const NAMESPACE: &str = "/local-executor";
const SHORT_TTL_SECONDS: u64 = 30;

#[tokio::test]
#[ignore = "requires disposable MySQL and Redis; explicitly run by Backend Rust CI"]
async fn device_heartbeat_refreshes_presence_for_string_task_ids() {
    let address: SocketAddr = std::env::var("WEGENT_TEST_REDIS_ADDRESS")
        .expect("set the disposable Redis fixture address")
        .parse()
        .expect("numeric loopback address");
    assert!(
        address.ip().is_loopback(),
        "only a disposable Redis is allowed"
    );
    let redis = RedisService::single(address.to_string()).await.unwrap();
    let fixture = fixture::Fixture::new().await;
    migrations::upgrade(&fixture.mysql).await.unwrap();
    fixture
        .mysql
        .execute(
            "INSERT INTO users (id, user_name, password_hash, is_active, role, auth_source, preferences)
             VALUES (?, 'heartbeat-e2e', '', true, 'user', 'password', '{}')",
            (USER_ID,),
        )
        .await
        .unwrap();
    let state = build_app_state_with_clients(fixture.mysql.clone(), Some(redis.clone()))
        .await
        .unwrap();
    let token = jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &json!({"sub": "heartbeat-e2e", "exp": chrono::Utc::now().timestamp() + 60}),
        &jsonwebtoken::EncodingKey::from_secret(state.auth.jwt_key.as_bytes()),
    )
    .unwrap();
    let server = socketio::handlers::build(Arc::new(state)).await.unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap().to_string();
    let (stop, stopped) = oneshot::channel();
    let server = tokio::spawn(server.serve(listener, async {
        let _ = stopped.await;
    }));

    let device_id = format!(
        "heartbeat-e2e-{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_micros()
    );
    let key = format!("device:online:{USER_ID}:{device_id}");
    let outcome = tokio::spawn({
        let redis = redis.clone();
        let key = key.clone();
        async move {
            timeout(
                Duration::from_secs(20),
                assert_heartbeats(&address, &token, &redis, &device_id, &key),
            )
            .await
            .expect("device heartbeat scenario timed out");
        }
    })
    .await;
    let _ = stop.send(());
    let stopped = server.await;
    redis.del(key).await.unwrap();
    fixture.close().await;
    stopped.unwrap().unwrap();
    outcome.unwrap();
}

async fn assert_heartbeats(
    address: &str,
    token: &str,
    redis: &RedisService,
    device_id: &str,
    key: &str,
) {
    let client = PollClient::connect(address, NAMESPACE, &json!({"token": token}).to_string())
        .await
        .unwrap();
    assert_eq!(
        event_ack(
            &client,
            1,
            "device:register",
            json!({"device_id": device_id, "name": "Heartbeat E2E", "device_type": "local"}),
        )
        .await,
        json!({"success": true, "device_id": device_id, "device_route_id": device_id})
    );
    let registered = online(redis, key).await;
    assert_eq!(registered["socket_id"], client.socket_id());
    assert!(redis.expire(key, SHORT_TTL_SECONDS).await.unwrap());
    assert!((1..=30_000).contains(&pttl(redis, key).await));

    assert_eq!(
        event_ack(
            &client,
            2,
            "device:heartbeat",
            json!({"device_id": device_id, "running_task_ids": ["9007199254740993"]}),
        )
        .await,
        json!({"success": true})
    );
    let refreshed = online(redis, key).await;
    assert_eq!(refreshed["socket_id"], client.socket_id());
    assert_eq!(
        refreshed["running_task_ids"],
        json!([9_007_199_254_740_993_i64])
    );
    assert_ne!(refreshed["last_heartbeat"], registered["last_heartbeat"]);
    assert!((75_000..=90_000).contains(&pttl(redis, key).await));

    for (id, invalid) in [(3, "not-a-task-id"), (4, "9223372036854775808")] {
        assert!(redis.expire(key, SHORT_TTL_SECONDS).await.unwrap());
        assert_eq!(
            event_ack(
                &client,
                id,
                "device:heartbeat",
                json!({"device_id": device_id, "running_task_ids": ["123", invalid]}),
            )
            .await,
            json!({"error": "Invalid payload: running_task_ids must be integers"})
        );
        assert_eq!(online(redis, key).await, refreshed);
        assert!((1..=30_000).contains(&pttl(redis, key).await));
    }
}

async fn event_ack(client: &PollClient, id: u8, event: &str, payload: Value) -> Value {
    let args = json!([event, payload]);
    client
        .post(&format!("42{NAMESPACE},{id}{args}"))
        .await
        .unwrap();
    let prefix = format!("43{NAMESPACE},{id}[");
    loop {
        for packet in client.poll_packets().await.unwrap() {
            if packet.starts_with(&prefix) {
                let [ack]: [Value; 1] = serde_json::from_str(&packet[prefix.len() - 1..]).unwrap();
                return ack;
            }
        }
    }
}

async fn online(redis: &RedisService, key: &str) -> Value {
    let raw: String = redis.get(key).await.unwrap().expect("device is online");
    serde_json::from_str(&raw).unwrap()
}

async fn pttl(redis: &RedisService, key: &str) -> i64 {
    let mut command = cmd("PTTL");
    command.arg(key);
    redis.command(command).await.unwrap()
}

#[tokio::test]
#[ignore = "requires disposable MySQL and Redis; explicitly run by Backend Rust CI"]
async fn app_registration_respects_a_legacy_unique_device_name() {
    const OWNER_ID: i32 = 8;
    const USERNAME: &str = "app-registration-e2e";

    let address: SocketAddr = std::env::var("WEGENT_TEST_REDIS_ADDRESS")
        .expect("set the disposable Redis fixture address")
        .parse()
        .expect("numeric loopback address");
    assert!(
        address.ip().is_loopback(),
        "only a disposable Redis is allowed"
    );
    let redis = RedisService::single(address.to_string()).await.unwrap();

    let fixture = fixture::Fixture::new().await;
    migrations::upgrade(&fixture.mysql).await.unwrap();
    fixture.mysql.execute(
        "CREATE UNIQUE INDEX uniq_user_kind_name_namespace ON kinds (user_id, kind, name, namespace)",
        (),
    ).await.unwrap();
    fixture.mysql.execute(
        "INSERT INTO users (id, user_name, password_hash, is_active, role, auth_source, preferences)
         VALUES (?, ?, '', true, 'user', 'password', '{}')",
        (OWNER_ID, USERNAME),
    ).await.unwrap();
    let mut devices = Vec::new();
    for (name, legacy_type) in [("local-device", "remote"), ("legacy-local-device", "local")] {
        let registration = fixture.mysql.execute(
            "INSERT INTO kinds (user_id, kind, name, namespace, json, is_active, created_at, updated_at)
             VALUES (?, 'Device', ?, 'default', ?, false, now(), now())",
            (OWNER_ID, name, json!({
                "kind": "Device",
                "metadata": {"name": name, "namespace": "default"},
                "spec": {
                    "deviceType": legacy_type, "deviceId": name,
                    "runtimeInstanceId": "runtime-original", "appDeviceId": "electron-original",
                },
            }).to_string()),
        ).await.unwrap();
        let route = format!("app-record-{}", registration.last_insert_id);
        let key = format!("device:online:{OWNER_ID}:{route}");
        devices.push(LegacyDevice {
            name,
            legacy_type,
            route,
            key,
        });
    }

    let state = build_app_state_with_clients(fixture.mysql.clone(), Some(redis.clone()))
        .await
        .unwrap();
    assert!(
        state.unique_app_device_names,
        "enable legacy unique names for this test"
    );
    let token = jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &json!({"sub": USERNAME, "exp": chrono::Utc::now().timestamp() + 60}),
        &jsonwebtoken::EncodingKey::from_secret(state.auth.jwt_key.as_bytes()),
    )
    .unwrap();
    let server = socketio::handlers::build(Arc::new(state)).await.unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap().to_string();
    let (stop, stopped) = oneshot::channel();
    let server = tokio::spawn(server.serve(listener, async {
        let _ = stopped.await;
    }));

    let outcome = tokio::spawn({
        let mysql = fixture.mysql.clone();
        let redis = redis.clone();
        let devices = devices.clone();
        async move {
            for device in devices {
                timeout(
                    Duration::from_secs(20),
                    assert_app_conflicts(&address, &token, &mysql, &redis, OWNER_ID, &device),
                )
                .await
                .expect("App registration scenario timed out");
            }
        }
    })
    .await;
    let _ = stop.send(());
    let stopped = server.await;
    for device in devices {
        redis.del(device.key).await.unwrap();
    }
    fixture.close().await;
    stopped.unwrap().unwrap();
    outcome.unwrap();
}

#[derive(brz_mysql::FromMysqlRow)]
struct AppDeviceRecord {
    id: i64,
    is_active: i8,
    json: Value,
}

#[derive(Clone)]
struct LegacyDevice {
    name: &'static str,
    legacy_type: &'static str,
    route: String,
    key: String,
}

async fn assert_app_conflicts(
    address: &str,
    token: &str,
    mysql: &brz_mysql::MysqlService,
    redis: &RedisService,
    owner_id: i32,
    device: &LegacyDevice,
) {
    let LegacyDevice {
        name,
        legacy_type,
        route,
        key,
    } = device;
    let connect = || async {
        PollClient::connect(address, NAMESPACE, &json!({"token": token}).to_string())
            .await
            .unwrap()
    };
    let read_records = || async {
        mysql
            .fetch_all::<_, _, AppDeviceRecord>(
                "SELECT id, is_active, json FROM kinds WHERE user_id = ? AND kind = 'Device'
             AND namespace = 'default' AND name = ?",
                (owner_id, *name),
            )
            .await
            .unwrap()
    };
    let registration = |runtime: &str, app_id: &str| {
        json!({
            "device_id": name, "name": "App E2E", "device_type": "app",
            "runtime_instance_id": runtime, "app_device_id": app_id,
        })
    };
    let conflict = json!({
        "error": "Registration failed: App device identity changed; reconnect using the original installation identity",
    });

    let original = connect().await;
    let contender = connect().await;
    assert_eq!(
        event_ack(
            &contender,
            1,
            "device:register",
            registration("runtime-original", "electron-new")
        )
        .await,
        conflict,
    );
    let rows = read_records().await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].is_active, 0);
    assert_eq!(rows[0].json["spec"]["deviceType"], *legacy_type);
    assert_eq!(rows[0].json["spec"]["appDeviceId"], "electron-original");
    assert!(redis.get::<_, String>(key).await.unwrap().is_none());

    assert_eq!(
        event_ack(
            &original,
            1,
            "device:register",
            registration("runtime-original", "electron-original")
        )
        .await,
        json!({"success": true, "device_id": name, "device_route_id": route}),
    );
    assert_eq!(
        event_ack(
            &contender,
            2,
            "device:register",
            registration("runtime-original", "electron-new")
        )
        .await,
        conflict,
    );
    assert_eq!(
        event_ack(
            &contender,
            3,
            "device:register",
            registration("runtime-other", "electron-other")
        )
        .await,
        json!({"error": "Registration failed: Device name is already registered; configure a unique persistent device ID for this installation"}),
    );

    let rows = read_records().await;
    assert_eq!(rows.len(), 1);
    assert_eq!(&format!("app-record-{}", rows[0].id), route);
    assert_eq!(rows[0].is_active, 1);
    assert_eq!(rows[0].json["spec"]["deviceType"], "app");
    assert_eq!(
        rows[0].json["spec"]["runtimeInstanceId"],
        "runtime-original"
    );
    assert_eq!(rows[0].json["spec"]["appDeviceId"], "electron-original");
    assert_eq!(online(redis, key).await["socket_id"], original.socket_id());
}
