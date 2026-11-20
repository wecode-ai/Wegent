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

use brz_mysql::MysqlService;
use brz_redis::{Redis, RedisService, cmd};
use brz_socket_io::SocketIo;
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
    let redis = fixture_redis(address).await;
    let fixture = fixture::Fixture::new().await;
    initialize_schema(&fixture.mysql).await;
    fixture
        .mysql
        .execute(
            "INSERT INTO users (id, user_name, password_hash, is_active, role, auth_source, preferences)
             VALUES (?, 'heartbeat-e2e', '', true, 'user', 'password', '{}')",
            (USER_ID,),
        )
        .await
        .unwrap();
    let mut state = build_app_state_with_clients(fixture.mysql.clone(), Some(redis.clone()))
        .await
        .unwrap();
    state.background_jobs = wegent_backend_rs::background_jobs::BackgroundJobsClient::new(
        wegent_backend_rs::background_jobs::config::BackgroundJobsConfig {
            scheduler_enabled: false,
            worker_enabled: true,
            job_allowlist: ["device_heartbeat_monitor".to_owned()].into(),
            shutdown_grace: Duration::from_secs(3),
        },
    );
    let state = Arc::new(state);
    let jobs = wegent_backend_rs::Application::build(Arc::clone(&state))
        .await
        .unwrap();
    let background = wegent_job_runtime::BackgroundJobsRuntime::start(
        jobs.background_jobs,
        &state.background_jobs,
    )
    .await
    .unwrap();
    let token = jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &json!({"sub": "heartbeat-e2e", "exp": chrono::Utc::now().timestamp() + 60}),
        &jsonwebtoken::EncodingKey::from_secret(state.auth.jwt_key.as_bytes()),
    )
    .unwrap();
    let server = socketio::handlers::build(Arc::clone(&state)).await.unwrap();
    let io = server.io().clone();
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
    let mysql = fixture.mysql.clone();
    let outcome = tokio::spawn({
        let state = Arc::clone(&state);
        let redis = redis.clone();
        let key = key.clone();
        async move {
            timeout(Duration::from_secs(20), async {
                let client = assert_heartbeats(&address, &token, &redis, &device_id, &key).await;
                assert_managed_cloud_identity(&address, &token, &mysql, &redis, &device_id, &io)
                    .await;
                assert_terminal_delivery(&client, &redis, &mysql, &device_id).await;
                assert_offline_timeout(&state, &redis, &mysql).await;
            })
            .await
            .expect("device heartbeat scenario timed out");
        }
    })
    .await;
    let _ = stop.send(());
    let stopped = server.await;
    background.shutdown(Duration::from_secs(3)).await.unwrap();
    redis.del(key).await.unwrap();
    fixture.close().await;
    stopped.unwrap().unwrap();
    outcome.unwrap();
}

async fn initialize_schema(mysql: &brz_mysql::MysqlService) {
    let row: brz_mysql::MysqlRow = mysql
        .fetch_one("SELECT DATABASE() AS name", ())
        .await
        .unwrap();
    let database: String = row.get_required("name").unwrap();
    let address = std::env::var("WEGENT_TEST_MYSQL_ADDRESS").unwrap();
    // Schema DDL needs the migration callback budget, not the fixture's ordinary
    // 10-second query budget. Keep heartbeat queries on the original client.
    let migration = migrations::connect(&format!(
        "mysql://root@{address}/{database}?ssl-mode=disabled"
    ))
    .unwrap();
    let result = timeout(Duration::from_secs(60), migrations::upgrade(&migration)).await;
    migration.close().await;
    result
        .expect("heartbeat schema preparation timed out")
        .unwrap();
}

async fn fixture_redis(address: SocketAddr) -> RedisService {
    // Keep cold Redis setup within the existing integration request budget.
    RedisService::single_with_options(
        address.to_string(),
        brz_redis::RedisServiceOptions::default().with_timeout(Duration::from_secs(5)),
    )
    .await
    .unwrap()
}

async fn assert_heartbeats(
    address: &str,
    token: &str,
    redis: &RedisService,
    device_id: &str,
    key: &str,
) -> PollClient {
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
    client
}

async fn assert_terminal_delivery(
    client: &PollClient,
    redis: &RedisService,
    mysql: &MysqlService,
    device_id: &str,
) {
    let (task_id, subtask_id) = (810_i64, 811_i64);
    mysql.execute(
        "INSERT INTO tasks (id,user_id,kind,name,namespace,json,is_active,created_at,updated_at,project_id,is_group_chat)
         VALUES (?,?,'Task','heartbeat-terminal','default',JSON_OBJECT('status',JSON_OBJECT('status','RUNNING')),1,NOW(),NOW(),0,false)",
        (task_id, USER_ID),
    ).await.unwrap();
    mysql.execute(
        "INSERT INTO subtasks (id,task_id,user_id,team_id,title,bot_ids,role,executor_name,executor_namespace,message_id,status,progress,executor_deleted_at,completed_at,sender_type,sender_user_id,reply_to_subtask_id)
         VALUES (?,?,?,0,'Device terminal',JSON_ARRAY(),'ASSISTANT',?,?,1,'RUNNING',0,false,'1970-01-01 00:00:00','',0,0)",
        (subtask_id, task_id, USER_ID, format!("device-{device_id}"), format!("user-{USER_ID}")),
    ).await.unwrap();
    let channel = format!("callback:channel:{subtask_id}");
    let mut subscription = redis.subscribe(channel.as_str()).await.unwrap();
    // Fail the runtime projection after the terminal rows commit, before
    // any terminal frame is published.
    mysql
        .execute(
            "RENAME TABLE loop_item_executions TO loop_item_executions_unavailable",
            (),
        )
        .await
        .unwrap();
    let mut raw_events = redis.subscribe("socketio").await.unwrap();
    let completed = json!({
        "task_id":task_id, "subtask_id":subtask_id, "message_id":1,
        "data":{"response":{"output":[{"type":"message","content":[{"type":"output_text","text":"device result"}]}]}}
    });
    let failed = event_ack(client, 2, "response.completed", completed.clone()).await;
    assert!(failed["error"].is_string(), "{failed}");
    let status: String = mysql
        .fetch_one("SELECT status FROM subtasks WHERE id = ?", (subtask_id,))
        .await
        .unwrap();
    assert_eq!(status, "COMPLETED");
    let barrier = json!({"type":"fixture-barrier"});
    redis
        .publish(channel.as_str(), barrier.to_string())
        .await
        .unwrap();
    assert_eq!(next_callback(&mut subscription).await, barrier);

    mysql
        .execute(
            "RENAME TABLE loop_item_executions_unavailable TO loop_item_executions",
            (),
        )
        .await
        .unwrap();
    let mut replay = completed.clone();
    replay["data"]["response"]["output"][0]["content"][0]["text"] = json!("different retry result");
    assert_eq!(
        event_ack(client, 3, "response.completed", replay).await,
        json!({"success":true})
    );
    assert_eq!(
        next_callback(&mut subscription).await["result"]["value"],
        "device result"
    );
    loop {
        let frame = next_callback(&mut raw_events).await;
        if frame["event"] == "response.completed" && frame["data"][0]["subtask_id"] == subtask_id {
            let data = &frame["data"][0]["data"];
            assert_eq!(
                data["response"]["output"][0]["content"][0]["text"],
                "device result"
            );
            assert_eq!(data["result"]["value"], "device result");
            break;
        }
    }
    raw_events.close().await.unwrap();

    assert_eq!(
        event_ack(client, 4, "error", completed).await,
        json!({"success":true})
    );
    redis
        .publish(channel.as_str(), barrier.to_string())
        .await
        .unwrap();
    assert_eq!(next_callback(&mut subscription).await, barrier);
    subscription.close().await.unwrap();
}

async fn assert_managed_cloud_identity(
    address: &str,
    token: &str,
    mysql: &MysqlService,
    redis: &RedisService,
    prefix: &str,
    io: &SocketIo,
) {
    let name = format!("{prefix}-cloud");
    let key = format!("device:online:{USER_ID}:{name}");
    let client = PollClient::connect(address, NAMESPACE, &json!({"token": token}).to_string())
        .await
        .unwrap();
    let registration = json!({
        "device_id": name, "name": "Managed Cloud", "device_type": "local",
        "runtime_instance_id": "runtime-cloud", "runtime_transfer_port": 17888,
    });
    // Warm the local registration cache before the server repairs provisioning.
    assert_eq!(
        event_ack(&client, 9, "device:register", registration.clone()).await,
        json!({"success": true, "device_id": name, "device_route_id": name}),
    );
    let (record_id, mut document): (i64, Value) = mysql
        .fetch_one(
            "SELECT id, json FROM kinds WHERE user_id = ? AND kind = 'Device'
             AND namespace = 'default' AND name = ?",
            (USER_ID, name.as_str()),
        )
        .await
        .unwrap();
    let original_presence = online(redis, &key).await;
    document["spec"]["deviceType"] = json!("cloud");
    document["spec"]["cloudConfig"] = json!({
        "deviceId": name, "sandboxId": "sandbox-cloud",
    });
    mysql
        .execute(
            "UPDATE kinds SET json = ? WHERE id = ? AND user_id = ?",
            (document.to_string(), record_id, USER_ID),
        )
        .await
        .unwrap();
    for (id, field, value) in [
        (10, "runtime_instance_id", Value::Null),
        (11, "runtime_instance_id", json!("another-runtime")),
        (12, "app_device_id", json!("another-app")),
    ] {
        let mut invalid = registration.clone();
        invalid[field] = value;
        let ack = event_ack(&client, id, "device:register", invalid).await;
        assert!(
            ack["error"]
                .as_str()
                .unwrap()
                .starts_with("Registration failed:")
        );
        let (stored,): (Value,) = mysql
            .fetch_one(
                "SELECT json FROM kinds WHERE id = ? AND user_id = ?",
                (record_id, USER_ID),
            )
            .await
            .unwrap();
        assert_eq!(
            stored, document,
            "a rejected registration cannot mutate the managed record"
        );
        assert_eq!(online(redis, &key).await, original_presence);
    }
    assert_eq!(
        event_ack(&client, 13, "device:register", registration.clone()).await,
        json!({"success": true, "device_id": name, "device_route_id": name}),
    );
    let records: Vec<AppDeviceRecord> = mysql
        .fetch_all(
            "SELECT id, is_active, json FROM kinds WHERE user_id = ? AND kind = 'Device'
         AND namespace = 'default' AND name = ?",
            (USER_ID, name.as_str()),
        )
        .await
        .unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].id, record_id);
    assert_eq!(records[0].json["spec"]["deviceId"], name);
    assert_eq!(records[0].json["spec"]["deviceType"], "cloud");
    assert_eq!(
        records[0].json["spec"]["runtimeInstanceId"],
        "runtime-cloud"
    );
    assert_eq!(
        records[0].json["spec"]["cloudConfig"],
        document["spec"]["cloudConfig"]
    );
    let presence = online(redis, &key).await;
    assert_eq!(presence["socket_id"], client.socket_id());
    assert_eq!(presence["runtime_instance_id"], "runtime-cloud");

    // Keep Redis presence live for both attempts. The first reuses the
    // original local fingerprint. The second changes only a fingerprint field.
    assert_stale_local_reactivation(mysql, redis, io, &client, record_id, registration).await;
    redis.del(key).await.unwrap();

    // Formal cloud records without an optional sandbox pointer stay compatible.
    let mut without_sandbox = document.clone();
    without_sandbox["spec"]["cloudConfig"] = json!({"deviceId": name});
    mysql
        .execute(
            "UPDATE kinds SET json = ? WHERE id = ? AND user_id = ?",
            (without_sandbox.to_string(), record_id, USER_ID),
        )
        .await
        .unwrap();
    assert_eq!(
        event_ack(
            &client,
            15,
            "device:register",
            json!({
                "device_id": name, "name": "Managed Cloud", "device_type": "cloud",
                "runtime_instance_id": "runtime-cloud",
            })
        )
        .await,
        json!({"success": true, "device_id": name, "device_route_id": name}),
    );

    // The record-only deletion API soft-deletes the record, after which the
    // original executor must be able to register and reactivate it.
    mysql
        .execute(
            "UPDATE kinds SET is_active = 0 WHERE id = ? AND user_id = ?",
            (record_id, USER_ID),
        )
        .await
        .unwrap();
    // The original executor must reactivate the record without creating a
    // replacement or losing its managed-cloud metadata.
    assert_eq!(
        event_ack(
            &client,
            16,
            "device:register",
            json!({
                "device_id": name, "name": "Managed Cloud", "device_type": "cloud",
                "runtime_instance_id": "runtime-cloud",
            })
        )
        .await,
        json!({"success": true, "device_id": name, "device_route_id": name}),
    );
    let reactivated: Vec<AppDeviceRecord> = mysql
        .fetch_all(
            "SELECT id, is_active, json FROM kinds WHERE user_id = ? AND kind = 'Device'
         AND namespace = 'default' AND name = ?",
            (USER_ID, name.as_str()),
        )
        .await
        .unwrap();
    assert_eq!(reactivated.len(), 1);
    assert_eq!(reactivated[0].id, record_id);
    assert_eq!(reactivated[0].is_active, 1);
    assert_eq!(reactivated[0].json["spec"]["deviceType"], "cloud");
    assert_eq!(
        reactivated[0].json["spec"]["runtimeInstanceId"],
        "runtime-cloud"
    );
    assert_eq!(
        reactivated[0].json["spec"]["cloudConfig"],
        json!({"deviceId": name})
    );

    let foreign = format!("{prefix}-foreign-cloud");
    mysql.execute(
        "INSERT INTO users (id, user_name, password_hash, is_active, role, auth_source, preferences)
         VALUES (9, 'foreign-cloud-e2e', '', true, 'user', 'password', '{}')",
        (),
    ).await.unwrap();
    let foreign_document = json!({"spec": {
        "deviceType": "cloud", "deviceId": foreign, "runtimeInstanceId": "runtime-cloud",
        "cloudConfig": {"deviceId": foreign, "sandboxId": "sandbox-foreign"},
    }});
    mysql.execute(
        "INSERT INTO kinds (user_id, kind, name, namespace, json, is_active, created_at, updated_at)
         VALUES (9, 'Device', ?, 'default', ?, true, now(), now())",
        (foreign.as_str(), foreign_document.to_string()),
    ).await.unwrap();
    assert_eq!(
        event_ack(
            &client,
            14,
            "device:register",
            json!({
                "device_id": foreign, "name": "Managed Cloud", "device_type": "local",
                "runtime_instance_id": "runtime-cloud",
            })
        )
        .await,
        json!({"error": "Registration failed: Managed cloud device identity conflict"}),
    );
    let (count,): (i64,) = mysql
        .fetch_one(
            "SELECT COUNT(*) FROM kinds WHERE user_id = ? AND kind = 'Device'
         AND namespace = 'default' AND name = ?",
            (USER_ID, foreign.as_str()),
        )
        .await
        .unwrap();
    assert_eq!(
        count, 0,
        "a foreign managed identity cannot allocate an owned replacement"
    );
    let (stored,): (Value,) = mysql
        .fetch_one(
            "SELECT json FROM kinds WHERE user_id = 9 AND kind = 'Device'
         AND namespace = 'default' AND name = ?",
            (foreign.as_str(),),
        )
        .await
        .unwrap();
    assert_eq!(stored, foreign_document);
    assert!(
        redis
            .get::<_, String>(format!("device:online:{USER_ID}:{foreign}"))
            .await
            .unwrap()
            .is_none()
    );
}

async fn assert_stale_local_reactivation(
    mysql: &MysqlService,
    redis: &RedisService,
    io: &SocketIo,
    client: &PollClient,
    record_id: i64,
    mut registration: Value,
) {
    let name = registration["device_id"].as_str().unwrap().to_owned();
    let key = format!("device:online:{USER_ID}:{name}");
    let socket = io
        .of(NAMESPACE)
        .unwrap()
        .get_socket(client.socket_id().parse().unwrap())
        .unwrap();
    let session =
        brz_socket_io::__private::session::<socketio::session::DeviceSession, _>(&socket).unwrap();
    for (ack_id, transfer_port, case) in [
        (17, 17888, "cached local registration"),
        (18, 17889, "uncached local registration"),
    ] {
        mysql
            .execute(
                "UPDATE kinds SET is_active = 0 WHERE id = ? AND user_id = ?",
                (record_id, USER_ID),
            )
            .await
            .unwrap();
        registration["runtime_transfer_port"] = json!(transfer_port);
        assert_eq!(
            event_ack(client, ack_id, "device:register", registration.clone()).await,
            json!({"success": true, "device_id": name, "device_route_id": name}),
            "{case}",
        );
        let records: Vec<AppDeviceRecord> = mysql
            .fetch_all(
                "SELECT id, is_active, json FROM kinds WHERE user_id = ? AND kind = 'Device'
                 AND namespace = 'default' AND name = ?",
                (USER_ID, name.as_str()),
            )
            .await
            .unwrap();
        assert_eq!(records.len(), 1, "{case}");
        assert_eq!(records[0].id, record_id, "{case}");
        assert_eq!(records[0].is_active, 1, "{case}");
        assert_eq!(records[0].json["spec"]["deviceType"], "cloud", "{case}");
        assert_eq!(
            records[0].json["spec"]["runtimeInstanceId"], "runtime-cloud",
            "{case}"
        );
        assert_eq!(
            records[0].json["spec"]["cloudConfig"],
            json!({"deviceId": name, "sandboxId": "sandbox-cloud"}),
            "{case}",
        );
        let snapshot = session.snapshot().device;
        assert_eq!(
            snapshot.device_type,
            Some(socketio::device::DeviceType::Cloud),
            "{case}"
        );
        assert_eq!(snapshot.device_id.as_deref(), Some(name.as_str()), "{case}");
        assert_eq!(
            snapshot.logical_device_id.as_deref(),
            Some(name.as_str()),
            "{case}"
        );
        let presence = online(redis, &key).await;
        assert_eq!(presence["socket_id"], client.socket_id(), "{case}");
        assert_eq!(presence["runtime_instance_id"], "runtime-cloud", "{case}");
        assert_eq!(presence["runtime_transfer_port"], transfer_port, "{case}");
    }
}

async fn assert_offline_timeout(
    state: &wegent_backend_rs::AppState,
    redis: &RedisService,
    mysql: &MysqlService,
) {
    let (task_id, subtask_id) = (820_i64, 821_i64);
    mysql.execute(
        "INSERT INTO tasks (id,user_id,kind,name,namespace,json,is_active,created_at,updated_at,project_id,is_group_chat)
         VALUES (?,?,'Task','heartbeat-timeout','default',JSON_OBJECT('status',JSON_OBJECT('status','RUNNING')),1,NOW(),NOW(),0,false)",
        (task_id, USER_ID),
    ).await.unwrap();
    mysql.execute(
        "INSERT INTO subtasks (id,task_id,user_id,team_id,title,bot_ids,role,executor_name,executor_namespace,message_id,status,progress,executor_deleted_at,completed_at,sender_type,sender_user_id,reply_to_subtask_id)
         VALUES (?,?,?,0,'Heartbeat timeout',JSON_ARRAY(),'ASSISTANT','device-offline-fixture',?,1,'RUNNING',0,false,'1970-01-01 00:00:00','',0,0)",
        (subtask_id, task_id, USER_ID, format!("user-{USER_ID}")),
    ).await.unwrap();
    let mut events = redis.subscribe("socketio").await.unwrap();
    state
        .background_jobs
        .submit("device_heartbeat_monitor", Value::Null, None, None)
        .await
        .unwrap();

    loop {
        let event = next_callback(&mut events).await;
        if event["event"] == "chat:error" && event["data"][0]["subtask_id"] == subtask_id {
            break;
        }
    }
    let (subtask_status, task): (String, brz_mysql::Json<Value>) = mysql
        .fetch_one(
            "SELECT subtasks.status, tasks.json
             FROM subtasks JOIN tasks ON subtasks.task_id = tasks.id WHERE subtasks.id = ?",
            (subtask_id,),
        )
        .await
        .unwrap();
    assert_eq!(subtask_status, "FAILED");
    assert_eq!(task.0["status"]["status"], "FAILED");
    events.close().await.unwrap();
}

async fn next_callback(subscription: &mut brz_redis::RedisSubscription) -> Value {
    let message = timeout(Duration::from_secs(5), subscription.next_message())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    serde_json::from_slice(&message.payload).unwrap()
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
    let redis = fixture_redis(address).await;

    let fixture = fixture::Fixture::new().await;
    initialize_schema(&fixture.mysql).await;
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
