// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Real HTTP gateway, application, authentication, MySQL and Redis coverage.

use brz_mysql::{Json, MysqlService};
use brz_redis::{Redis, RedisSubscription};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use wegent_backend_rs::{
    Application, Gateway, HybridConfig, OriginService, RouteTable, auth::AppAuthenticator, bind,
    build_app_state, config::AuthConfig, serve, task_store::TaskStore,
    user_reader::PublicUserReader,
};

use super::fixture::{LARGE_RESULT_BYTES, LONG_CONVERSATION_ROWS};

#[path = "history_window.rs"]
mod history_window;
#[path = "session_auth.rs"]
mod session_auth;
#[path = "subscription_history_window.rs"]
mod subscription_history_window;

// The source limits package registers this exact script before EVALSHA.
const RATE_SCRIPT: &str = "local current\nlocal amount = tonumber(ARGV[2])\ncurrent = redis.call(\"incrby\", KEYS[1], amount)\n\nif tonumber(current) == amount then\n    redis.call(\"expire\", KEYS[1], ARGV[1])\nend\n\nreturn current\n";

pub async fn seed_task(mysql: &MysqlService, table: &str, task_id: i64, user_id: i32) {
    for sql in [
        "CREATE TABLE IF NOT EXISTS users (
            id INT PRIMARY KEY, user_name VARCHAR(100) NOT NULL, password_hash VARCHAR(100) DEFAULT '',
            email VARCHAR(100), git_info JSON, is_active TINYINT DEFAULT 1,
            role VARCHAR(20) DEFAULT 'user', auth_source VARCHAR(20) DEFAULT 'password',
            preferences TEXT, created_at DATETIME, updated_at DATETIME)",
        "CREATE TABLE IF NOT EXISTS resource_members (
            id BIGINT PRIMARY KEY, resource_type VARCHAR(20), resource_id BIGINT,
            entity_type VARCHAR(20), entity_id VARCHAR(20), status VARCHAR(20), copied_resource_id BIGINT)",
    ] {
        mysql.execute(sql, ()).await.unwrap();
    }
    for id in [user_id, user_id + 1] {
        mysql
            .execute(
                "INSERT IGNORE INTO users (id,user_name,git_info,preferences,created_at,updated_at)
             VALUES (?, ?, JSON_OBJECT(), '{}', NOW(), NOW())",
                (id, format!("responses-fixture-{id}")),
            )
            .await
            .unwrap();
    }
    mysql
        .execute(
            format!(
                "CREATE TABLE IF NOT EXISTS {table} (
            id BIGINT PRIMARY KEY, user_id INT, kind VARCHAR(20), name VARCHAR(100),
            namespace VARCHAR(100), json JSON, is_active TINYINT DEFAULT 1,
            created_at DATETIME DEFAULT '2026-01-01', updated_at DATETIME DEFAULT '2026-01-01',
            project_id BIGINT DEFAULT 0, client_origin VARCHAR(20) DEFAULT 'web',
            is_group_chat TINYINT DEFAULT 0)"
            ),
            (),
        )
        .await
        .unwrap();
    mysql
        .execute(
            format!(
                "INSERT INTO {table} (id,user_id,kind,name,namespace,json)
         VALUES (?,?,'Task','responses-fixture','default',
                 JSON_OBJECT('status',JSON_OBJECT('status','COMPLETED')))"
            ),
            (task_id, user_id),
        )
        .await
        .unwrap();
}

/// The supplied store is the production base-table or deployment-routed store.
pub async fn assert_http_reads(
    mysql: MysqlService,
    store: Arc<dyn TaskStore>,
    config: HybridConfig,
    task_ids: &[i64],
    user_id: i32,
    long_conversation: bool,
    history_tables: &[&str],
) {
    require_loopback_services();
    let mut state = build_app_state().await.unwrap();
    state.mysql = mysql.clone();
    state.task_store = store;
    state.user_reader = Arc::new(PublicUserReader::new(mysql.clone()));
    state.internal_chat.internal_service_token = Some(history_window::TOKEN.into());
    state.auth = AuthConfig {
        jwt_key: "responses-fixture-signing-key".into(),
        legacy_jwt_keys: Vec::new(),
        algorithm: "HS256".into(),
    };
    let redis = state.redis.clone().expect("real Redis is required for E2E");
    let bootstrap: i64 = redis
        .eval(RATE_SCRIPT, ["responses-fixture-bootstrap"], ["60", "0"])
        .await
        .unwrap();
    assert_eq!(bootstrap, 0);
    let state = Arc::new(state);
    let application = Application::build(Arc::clone(&state)).await.unwrap();
    let server = wegent_backend_rs::http_server::Server::bind_with_authenticator(
        "127.0.0.1:0".parse().unwrap(),
        application.routes,
        AppAuthenticator::new(state.authentication_services()),
    )
    .await
    .unwrap();
    let api_uri = format!("http://{}", server.local_addr().unwrap())
        .parse()
        .unwrap();
    for task_id in task_ids {
        assert!(config.selects_rust(
            &http::Method::GET,
            &format!("/api/v1/responses/resp_{task_id}")
        ));
    }
    assert!(config.selects_rust(&http::Method::GET, session_auth::SKILL_PATH));
    // Python owns no request in this scenario: any accidental fallback fails.
    let gateway = Gateway::new(
        config.routes,
        OriginService::new(&api_uri).unwrap(),
        &config.python_upstream,
    )
    .unwrap();
    let listener = bind(config.listen_address).await.unwrap();
    let address = listener.local_addr().unwrap();
    let (api_stop, api_stopped) = tokio::sync::oneshot::channel();
    let api_task = tokio::spawn(async move {
        server
            .serve_until(async {
                let _ = api_stopped.await;
            })
            .await
            .unwrap()
    });
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let gateway_task = tokio::spawn(async move {
        serve(
            listener,
            gateway,
            async {
                let _ = stopped.await;
            },
            Duration::from_secs(1),
        )
        .await
        .unwrap();
    });
    let client = brz_http::Client::builder()
        .timeout(Duration::from_secs(30))
        // Breeze defaults each socket read to 400 ms; use the test's total budget.
        .read_timeout(Duration::from_secs(30))
        .build()
        .unwrap();
    for task_id in task_ids {
        let path = format!("/api/v1/responses/resp_{task_id}");
        let url = format!("http://{address}{path}");
        let unauthenticated = client.get(&url).unwrap().send().await.unwrap();
        assert_eq!(unauthenticated.status().as_u16(), 401);
        let token = token_for(user_id);
        let forwarded_ip = format!("responses-fixture-{address}");
        let response = client
            .get(&url)
            .unwrap()
            .header("authorization", format!("Bearer {token}"))
            .header("x-forwarded-for", &forwarded_ip)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), 200);
        let bytes = response.bytes().await.unwrap();
        let response: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(response["id"], format!("resp_{task_id}"));
        assert_eq!(response["status"], "completed");
        assert_output(&response, *task_id, long_conversation);
        // A real rate-limit write proves Redis has not silently degraded away.
        let key = format!("LIMITS:LIMITER/ip:{forwarded_ip}/{path}/120/1/minute");
        assert_eq!(redis.get::<_, i64>(&key).await.unwrap(), Some(1));
        let denied = client
            .get(&url)
            .unwrap()
            .header(
                "authorization",
                format!("Bearer {}", token_for(user_id + 1)),
            )
            .header("x-forwarded-for", &forwarded_ip)
            .send()
            .await
            .unwrap();
        assert_eq!(
            denied.status().as_u16(),
            404,
            "another user's task must remain inaccessible"
        );
        eprintln!(
            "Responses HTTP E2E: task={task_id}, items={}, bytes={}",
            response["output"].as_array().unwrap().len(),
            bytes.len()
        );
    }
    session_auth::assert_session_compatibility(&client, address, task_ids[0], user_id + 1).await;
    session_auth::assert_skill_identity_compatibility(&client, address, &mysql, user_id).await;
    if !long_conversation {
        assert_eq!(task_ids.len(), history_tables.len());
        for (task_id, table) in task_ids.iter().zip(history_tables) {
            history_window::assert_history_windows(
                &client, address, &mysql, *task_id, table, user_id,
            )
            .await;
            subscription_history_window::assert_store_windows(
                &mysql,
                state.task_store.as_ref(),
                *task_id,
                table,
                user_id,
            )
            .await;
        }
    }
    stop.send(()).unwrap();
    gateway_task.await.unwrap();
    api_stop.send(()).unwrap();
    api_task.await.unwrap();
}

pub async fn assert_terminal_callback_atomic(mysql: &MysqlService, task_id: i64, subtask_id: i64) {
    require_loopback_services();
    let mut state = build_app_state().await.unwrap();
    state.mysql = mysql.clone();
    state.task_store = Arc::new(wegent_backend_rs::task_store::DefaultTaskStore::new(
        mysql.clone(),
    ));
    let redis = state.redis.clone().expect("real Redis is required for E2E");
    let state = Arc::new(state);
    let application = Application::build(Arc::clone(&state)).await.unwrap();
    let server = wegent_backend_rs::http_server::Server::bind_with_authenticator(
        "127.0.0.1:0".parse().unwrap(),
        application.routes,
        AppAuthenticator::new(state.authentication_services()),
    )
    .await
    .unwrap();
    let url = format!(
        "http://{}/api/internal/callback",
        server.local_addr().unwrap()
    );
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        server
            .serve_until(async {
                let _ = stopped.await;
            })
            .await
            .unwrap();
    });
    let client = brz_http::Client::builder()
        .timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(15))
        .build()
        .unwrap();
    let send = async |event_type: &str, data: Value| {
        client
            .post(&url)
            .unwrap()
            .json(&json!({
                "event_type": event_type, "data": data,
                "task_id": task_id, "subtask_id": subtask_id,
            }))
            .send()
            .await
            .unwrap()
            .status()
            .as_u16()
    };
    let statuses = async || {
        let subtask: String = mysql
            .fetch_one("SELECT status FROM subtasks WHERE id = ?", (subtask_id,))
            .await
            .unwrap();
        let task: Json<Value> = mysql
            .fetch_one("SELECT json FROM tasks WHERE id = ?", (task_id,))
            .await
            .unwrap();
        let task_status = task.0["status"]["status"]
            .as_str()
            .expect("task status")
            .to_owned();
        (task_status, subtask)
    };
    let completed = json!({
        "response": {"output": [{"type": "message", "content": [{"type":"output_text", "text":"saved result"}]}]}
    });
    let channel = format!("callback:channel:{subtask_id}");
    let mut subscription = redis.subscribe(channel.as_str()).await.unwrap();
    let mut socket_events = redis.subscribe("socketio").await.unwrap();
    // Publications on the same channel are ordered. A barrier sent after the
    // HTTP response detects an unwanted callback without waiting for silence.
    let barrier = json!({"type": "fixture-barrier"});
    let assert_no_callback = async |subscription: &mut RedisSubscription| {
        redis
            .publish(channel.as_str(), barrier.to_string())
            .await
            .unwrap();
        assert_eq!(next_callback(subscription).await, barrier);
    };
    let marker = format!("chat:task_streaming:{task_id}");
    redis.set(marker.as_str(), "true").await.unwrap();
    mysql
        .execute(
            "ALTER TABLE tasks ADD CONSTRAINT reject_terminal_update \
         CHECK (JSON_UNQUOTE(JSON_EXTRACT(json, '$.status.status')) <> 'COMPLETED')",
            (),
        )
        .await
        .unwrap();

    assert_eq!(send("response.completed", completed.clone()).await, 500);
    assert_eq!(statuses().await, ("RUNNING".into(), "RUNNING".into()));
    assert_eq!(
        redis
            .get::<_, String>(marker.as_str())
            .await
            .unwrap()
            .as_deref(),
        Some("true")
    );

    assert_no_callback(&mut subscription).await;

    mysql
        .execute("ALTER TABLE tasks DROP CHECK reject_terminal_update", ())
        .await
        .unwrap();
    // A MySQL trigger fails only the post-commit acknowledgement, preserving
    // the committed result and pending delivery across the failed request.
    let label_path = format!("$.metadata.labels.\"terminal-delivery-callback-{subtask_id}\"");
    mysql.execute(
        format!("CREATE TRIGGER reject_delivery_ack BEFORE UPDATE ON tasks FOR EACH ROW
            BEGIN
                IF JSON_CONTAINS_PATH(OLD.json, 'one', '{label_path}')
                    AND NOT JSON_CONTAINS_PATH(NEW.json, 'one', '{label_path}') THEN
                    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'injected delivery acknowledgement failure';
                END IF;
            END"),
        (),
    ).await.unwrap();
    assert_eq!(send("response.completed", completed).await, 500);
    assert_eq!(statuses().await, ("COMPLETED".into(), "COMPLETED".into()));
    let first_delivery = next_callback(&mut subscription).await;
    assert_eq!(first_delivery["result"]["value"], "saved result");

    let stored: (Json<Value>, chrono::NaiveDateTime) = mysql
        .fetch_one(
            "SELECT result, completed_at FROM subtasks WHERE id = ?",
            (subtask_id,),
        )
        .await
        .unwrap();
    assert_eq!(stored.0.0["value"], "saved result");
    assert_eq!(redis.get::<_, String>(marker.as_str()).await.unwrap(), None);
    mysql
        .execute("DROP TRIGGER reject_delivery_ack", ())
        .await
        .unwrap();

    // Concurrent retries only acknowledge the original publication, even
    // when the retried callback contains a different result.
    let retry = json!({
        "response": {"output": [{"type":"message","content":[{"type":"output_text","text":"retry payload"}]}]}
    });
    let (first, second) = tokio::join!(
        send("response.completed", retry.clone()),
        send("response.completed", retry),
    );
    assert_eq!((first, second), (200, 200));
    assert_eq!(first_delivery["type"], "done");
    assert_eq!(first_delivery["subtask_id"], subtask_id);
    let after_retry: (Json<Value>, chrono::NaiveDateTime) = mysql
        .fetch_one(
            "SELECT result, completed_at FROM subtasks WHERE id = ?",
            (subtask_id,),
        )
        .await
        .unwrap();
    assert_eq!(stored.0.0, after_retry.0.0);
    assert_eq!(stored.1, after_retry.1);
    assert_eq!(send("error", json!({"message": "late error"})).await, 200);
    assert_eq!(statuses().await, ("COMPLETED".into(), "COMPLETED".into()));

    redis
        .publish("socketio", barrier.to_string())
        .await
        .unwrap();
    let mut done_count = 0;
    loop {
        let frame = next_callback(&mut socket_events).await;
        if frame == barrier {
            break;
        }
        if frame["event"] == "chat:done" && frame["data"][0]["subtask_id"] == subtask_id {
            done_count += 1;
        }
    }
    assert_eq!(done_count, 1);
    socket_events.close().await.unwrap();
    assert_no_callback(&mut subscription).await;
    subscription.close().await.unwrap();
    stop.send(()).unwrap();
    server.await.unwrap();
}

async fn next_callback(subscription: &mut RedisSubscription) -> Value {
    let message = tokio::time::timeout(Duration::from_secs(5), subscription.next_message())
        .await
        .expect("callback publication")
        .unwrap()
        .expect("callback subscription is open");
    serde_json::from_slice(&message.payload).unwrap()
}

fn require_loopback_services() {
    // Require explicitly configured disposable services, never local dotenv defaults.
    for name in ["DATABASE_URL", "REDIS_URL"] {
        let url = url::Url::parse(&std::env::var(name).expect("explicit E2E service URL")).unwrap();
        assert_eq!(
            url.host_str(),
            Some("127.0.0.1"),
            "loopback fixture required"
        );
    }
}

pub fn runtime_config() -> HybridConfig {
    HybridConfig::new(
        "127.0.0.1:0".parse().unwrap(),
        "http://127.0.0.1:1".parse().unwrap(),
        RouteTable::empty(),
    )
}

fn token_for(user_id: i32) -> String {
    signed_claims(
        &json!({"sub":format!("responses-fixture-{user_id}"),"exp":chrono::Utc::now().timestamp()+300}),
    )
}

fn signed_claims(claims: &Value) -> String {
    jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        claims,
        &jsonwebtoken::EncodingKey::from_secret(b"responses-fixture-signing-key"),
    )
    .unwrap()
}

fn assert_output(response: &Value, task_id: i64, long_conversation: bool) {
    let output = response["output"].as_array().unwrap();
    if long_conversation {
        assert_eq!(
            output.len(),
            LONG_CONVERSATION_ROWS,
            "no history may be truncated"
        );
        for (index, item) in output.iter().enumerate() {
            let id = LONG_CONVERSATION_ROWS - index;
            assert_eq!(item["id"], format!("msg_{id}"));
            assert_eq!(item["content"][0]["text"], format!("row:{task_id}:{id}"));
        }
    } else {
        assert_eq!(output.len(), 2);
        assert_eq!(output[0]["id"], "msg_20");
        assert_eq!(output[1]["id"], "msg_10");
        assert_eq!(output[0]["content"][0]["text"], "xxxx");
        let text = output[1]["content"][0]["text"].as_str().unwrap();
        assert_eq!(text.len(), LARGE_RESULT_BYTES);
        assert!(text.bytes().all(|byte| byte == b'x'));
    }
}
