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
use engineio_poll_client::PollClient;
use serde_json::{Value, json};
use tokio::{net::TcpListener, sync::oneshot, time::timeout};
use wegent_backend_rs::{build_app_state_with_clients, migrations, socketio};

const USER_ID: i32 = 7;
const NAMESPACE: &str = "/local-executor";
const SHORT_TTL_SECONDS: u64 = 30;
// Registration uses the redis-py lock release script by digest. Load the
// canonical bytes into the isolated Redis before registering a device.
const LOCK_RELEASE_SCRIPT: &str = r#"
        local token = redis.call('get', KEYS[1])
        if not token or token ~= ARGV[1] then
            return 0
        end
        redis.call('del', KEYS[1])
        return 1
    "#;

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
    let mut load = cmd("SCRIPT");
    load.arg("LOAD").arg(LOCK_RELEASE_SCRIPT);
    let digest: String = redis.command(load).await.unwrap();
    assert_eq!(digest, "c3f8721cbb97f72bc19e972846bd7aaf91901658");
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
    assert_eq!(
        event_ack(client, 3, "response.completed", completed.clone()).await,
        json!({"success":true})
    );
    assert_eq!(
        next_callback(&mut subscription).await["result"]["value"],
        "device result"
    );

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
    let (subtask_status, task_status): (String, String) = mysql
        .fetch_one(
            "SELECT subtasks.status, JSON_UNQUOTE(JSON_EXTRACT(tasks.json, '$.status.status'))
         FROM subtasks JOIN tasks ON subtasks.task_id = tasks.id WHERE subtasks.id = ?",
            (subtask_id,),
        )
        .await
        .unwrap();
    assert_eq!(subtask_status, "FAILED");
    assert_eq!(task_status, "FAILED");
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
