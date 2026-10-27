// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Real HTTP gateway, application, authentication, MySQL and Redis coverage.

use brz_mysql::MysqlService;
use brz_redis::Redis;
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use wegent_backend_rs::{
    Application, Gateway, HybridConfig, OriginService, RouteTable, auth::AppAuthenticator, bind,
    build_app_state, config::AuthConfig, serve, task_store::TaskStore,
    user_reader::PublicUserReader,
};

use super::fixture::{LARGE_RESULT_BYTES, LONG_CONVERSATION_ROWS};

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
) {
    // Require explicitly configured disposable services, never local dotenv defaults.
    for name in ["DATABASE_URL", "REDIS_URL"] {
        let url = url::Url::parse(&std::env::var(name).expect("explicit E2E service URL")).unwrap();
        assert_eq!(
            url.host_str(),
            Some("127.0.0.1"),
            "loopback fixture required"
        );
    }
    let mut state = build_app_state().await.unwrap();
    state.mysql = mysql.clone();
    state.task_store = store;
    state.user_reader = Arc::new(PublicUserReader::new(mysql));
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
        AppAuthenticator::new(state),
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
    stop.send(()).unwrap();
    gateway_task.await.unwrap();
    api_stop.send(()).unwrap();
    api_task.await.unwrap();
}

pub fn runtime_config() -> HybridConfig {
    HybridConfig::new(
        "127.0.0.1:0".parse().unwrap(),
        "http://127.0.0.1:1".parse().unwrap(),
        RouteTable::empty(),
    )
}

fn token_for(user_id: i32) -> String {
    jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &json!({"sub":format!("responses-fixture-{user_id}"),"exp":chrono::Utc::now().timestamp()+300}),
        &jsonwebtoken::EncodingKey::from_secret(b"responses-fixture-signing-key"),
    ).unwrap()
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
