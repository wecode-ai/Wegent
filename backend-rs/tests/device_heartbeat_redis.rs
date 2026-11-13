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
use wegent_backend_rs::{
    Application, Gateway, HybridConfig, OriginService, RouteTable, auth::AppAuthenticator, bind,
    build_app_state_with_clients, migrations, serve, socketio,
};

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
        "INSERT INTO users (id, user_name, password_hash, git_info, is_active, role, auth_source,
         preferences, created_at, updated_at)
         VALUES (?, ?, '', JSON_ARRAY(), true, 'user', 'password', '{}', NOW(), NOW()),
         (9, 'app-registration-admin', '', JSON_ARRAY(), true, 'admin', 'password', '{}', NOW(), NOW())",
        (OWNER_ID, USERNAME),
    ).await.unwrap();
    let registration = fixture.mysql.execute(
        "INSERT INTO kinds (user_id, kind, name, namespace, json, is_active, created_at, updated_at)
         VALUES (?, 'Device', 'local-device', 'default', ?, false, now(), now())",
        (OWNER_ID, json!({
            "kind": "Device",
            "metadata": {"name": "local-device", "namespace": "default"},
            "spec": {
                "deviceType": "remote", "deviceId": "local-device",
                "runtimeInstanceId": "runtime-original", "appDeviceId": "local-device",
            },
        }).to_string()),
    ).await.unwrap();
    let route = format!("app-record-{}", registration.last_insert_id);
    let key = format!("device:online:{OWNER_ID}:{route}");

    let state = build_app_state_with_clients(fixture.mysql.clone(), Some(redis.clone()))
        .await
        .unwrap();
    assert!(
        state.unique_app_device_names,
        "enable legacy unique names for this test"
    );
    let token = device_token(USERNAME, &state.auth.jwt_key);
    let admin = device_token("app-registration-admin", &state.auth.jwt_key);
    let state = Arc::new(state);
    let path = format!(
        "/api/admin/users/{OWNER_ID}/devices/records/{}/rebind",
        registration.last_insert_id
    );
    let http = RebindServer::start(state.clone(), &path).await;
    let server = socketio::handlers::build(state).await.unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap().to_string();
    let (stop, stopped) = oneshot::channel();
    let server = tokio::spawn(server.serve(listener, async {
        let _ = stopped.await;
    }));

    let outcome = tokio::spawn({
        let mysql = fixture.mysql.clone();
        let redis = redis.clone();
        let key = key.clone();
        let rebind_url = format!("http://{}{path}", http.address);
        async move {
            timeout(
                Duration::from_secs(20),
                assert_app_conflicts(
                    &address,
                    &token,
                    &mysql,
                    &redis,
                    &key,
                    &route,
                    OWNER_ID,
                    RebindRequest {
                        url: &rebind_url,
                        admin: &admin,
                        owner: &token,
                    },
                ),
            )
            .await
            .expect("App registration scenario timed out");
        }
    })
    .await;
    let _ = stop.send(());
    let stopped = server.await;
    http.stop().await;
    redis.del(key).await.unwrap();
    fixture.close().await;
    stopped.unwrap().unwrap();
    outcome.unwrap();
}

fn device_token(user: &str, key: &str) -> String {
    jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &json!({"sub": user, "exp": chrono::Utc::now().timestamp() + 60}),
        &jsonwebtoken::EncodingKey::from_secret(key.as_bytes()),
    )
    .unwrap()
}

struct RebindServer {
    address: SocketAddr,
    api_stop: oneshot::Sender<()>,
    gateway_stop: oneshot::Sender<()>,
    api_task: tokio::task::JoinHandle<()>,
    gateway_task: tokio::task::JoinHandle<()>,
}

impl RebindServer {
    async fn start(state: Arc<wegent_backend_rs::AppState>, path: &str) -> Self {
        let app = Application::build(state.clone()).await.unwrap();
        let api = wegent_backend_rs::http_server::Server::bind_with_authenticator(
            "127.0.0.1:0".parse().unwrap(),
            app.routes,
            AppAuthenticator::new(state.authentication_services()),
        )
        .await
        .unwrap();
        let api_uri = format!("http://{}", api.local_addr().unwrap())
            .parse()
            .unwrap();
        let config = HybridConfig::new(
            "127.0.0.1:0".parse().unwrap(),
            "http://127.0.0.1:1".parse().unwrap(),
            RouteTable::empty(),
        )
        .with_routes_file(
            &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml"),
        )
        .unwrap();
        assert!(config.selects_rust(&http::Method::POST, path));
        let gateway = Gateway::new(
            config.routes,
            OriginService::new(&api_uri).unwrap(),
            &config.python_upstream,
        )
        .unwrap();
        let listener = bind(config.listen_address).await.unwrap();
        let address = listener.local_addr().unwrap();
        let (api_stop, api_stopped) = oneshot::channel();
        let (gateway_stop, gateway_stopped) = oneshot::channel();
        let api_task = tokio::spawn(async move {
            api.serve_until(async {
                let _ = api_stopped.await;
            })
            .await
            .unwrap();
        });
        let gateway_task = tokio::spawn(async move {
            serve(
                listener,
                gateway,
                async {
                    let _ = gateway_stopped.await;
                },
                Duration::from_secs(1),
            )
            .await
            .unwrap();
        });
        Self {
            address,
            api_stop,
            gateway_stop,
            api_task,
            gateway_task,
        }
    }

    async fn stop(self) {
        let _ = self.gateway_stop.send(());
        let _ = self.api_stop.send(());
        self.gateway_task.await.unwrap();
        self.api_task.await.unwrap();
    }
}

struct RebindRequest<'a> {
    url: &'a str,
    admin: &'a str,
    owner: &'a str,
}

#[derive(brz_mysql::FromMysqlRow)]
struct AppDeviceRecord {
    id: i64,
    is_active: i8,
    json: Value,
}

#[allow(clippy::too_many_arguments)]
async fn assert_app_conflicts(
    address: &str,
    token: &str,
    mysql: &brz_mysql::MysqlService,
    redis: &RedisService,
    key: &str,
    route: &str,
    owner_id: i32,
    rebind: RebindRequest<'_>,
) {
    let connect = || async {
        PollClient::connect(address, NAMESPACE, &json!({"token": token}).to_string())
            .await
            .unwrap()
    };
    let read_records = || async {
        mysql
            .fetch_all::<_, _, AppDeviceRecord>(
                "SELECT id, is_active, json FROM kinds WHERE user_id = ? AND kind = 'Device'
             AND namespace = 'default' AND name = 'local-device'",
                (owner_id,),
            )
            .await
            .unwrap()
    };
    let registration = |runtime: &str, app_id: &str| {
        json!({
            "device_id": "local-device", "name": "App E2E", "device_type": "app",
            "runtime_instance_id": runtime, "app_device_id": app_id,
        })
    };
    let conflict = json!({
        "error": "Registration failed: App device identity changed; ask an administrator to verify and rebind this installation",
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
    assert!(redis.get::<_, String>(key).await.unwrap().is_none());

    assert_eq!(
        event_ack(
            &original,
            1,
            "device:register",
            registration("runtime-original", "local-device")
        )
        .await,
        json!({"success": true, "device_id": "local-device", "device_route_id": route}),
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
    assert_eq!(format!("app-record-{}", rows[0].id), route);
    assert_eq!(rows[0].is_active, 1);
    assert_eq!(
        rows[0].json["spec"]["runtimeInstanceId"],
        "runtime-original"
    );
    assert_eq!(rows[0].json["spec"]["appDeviceId"], "local-device");
    assert_eq!(rows[0].json["spec"]["deviceType"], "app");
    assert_eq!(online(redis, key).await["socket_id"], original.socket_id());
    assert_rebind(
        &rebind, &original, &contender, redis, key, route, rows[0].id,
    )
    .await;
    let rows = read_records().await;
    assert_eq!(rows.len(), 1);
    assert_eq!(
        rows[0].json["spec"]["runtimeInstanceId"],
        "runtime-original"
    );
    assert_eq!(rows[0].json["spec"]["appDeviceId"], "electron-new");
}

async fn assert_rebind(
    request: &RebindRequest<'_>,
    original: &PollClient,
    contender: &PollClient,
    redis: &RedisService,
    key: &str,
    route: &str,
    record_id: i64,
) {
    let http = brz_http::Client::builder()
        .timeout(Duration::from_secs(5))
        .read_timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    let send = |url: &str, token: Option<&str>, expected: &str| {
        let mut req = http.post(url).unwrap().json(&json!({
            "runtime_instance_id": "runtime-original",
            "expected_app_device_id": expected,
            "new_app_device_id": "electron-new",
        }));
        if let Some(token) = token {
            req = req.header("authorization", format!("Bearer {token}"));
        }
        async move {
            let response = req.send().await.unwrap();
            (
                response.status().as_u16(),
                response.json::<Value>().await.unwrap(),
            )
        }
    };
    let call = |token, expected| send(request.url, token, expected);
    assert_eq!(
        call(None, "local-device").await,
        (401, json!({"detail": "Not authenticated"})),
    );
    assert_eq!(
        call(Some(request.owner), "local-device").await,
        (
            403,
            json!({"detail": "Permission denied. Admin access required."})
        ),
    );
    let wrong_owner = request.url.replace("/users/8/", "/users/9/");
    assert_eq!(
        send(&wrong_owner, Some(request.admin), "local-device")
            .await
            .0,
        404
    );
    assert_eq!(
        call(Some(request.admin), "local-device").await,
        (
            409,
            json!({"detail": "Device is online or busy; disconnect it before rebinding"})
        ),
    );
    assert_eq!(online(redis, key).await["socket_id"], original.socket_id());

    // An old socket can outlive an expired presence key. Exercise the
    // production recovery path before and after the stored binding changes.
    redis.del(key).await.unwrap();
    assert_eq!(call(Some(request.admin), "stale-app").await.0, 409);
    let legacy_key = key.rsplit_once(':').unwrap().0.to_owned() + ":local-device";
    redis
        .set_ex(legacy_key.as_str(), 10, r#"{"status":"online"}"#)
        .await
        .unwrap();
    let legacy_result = call(Some(request.admin), "local-device").await;
    redis.del(legacy_key.as_str()).await.unwrap();
    assert_eq!(legacy_result.0, 409);
    let heartbeat = json!({"device_id": "local-device", "runtime_instance_id": "runtime-original"});
    assert_eq!(
        event_ack(original, 4, "device:heartbeat", heartbeat.clone()).await,
        json!({"success": true}),
    );
    redis.del(key).await.unwrap();
    assert_eq!(
        call(Some(request.admin), "local-device").await,
        (200, json!({"record_id": record_id})),
    );
    assert_eq!(call(Some(request.admin), "local-device").await.0, 409);
    let stale = json!({"error": "Stale device connection"});
    assert_eq!(
        event_ack(original, 5, "device:heartbeat", heartbeat.clone()).await,
        stale
    );
    assert_eq!(
        event_ack(original, 6, "runtime.tasks.pull", json!({})).await,
        stale
    );
    assert!(redis.get::<_, String>(key).await.unwrap().is_none());

    let registration = |id: &str| {
        json!({
            "device_id": "local-device", "name": "App E2E", "device_type": "app",
            "runtime_instance_id": "runtime-original", "app_device_id": id,
        })
    };
    let ack = event_ack(original, 7, "device:register", registration("local-device")).await;
    assert!(ack["error"].as_str().unwrap().contains("verify and rebind"));
    let mut legacy_registration = registration("local-device");
    legacy_registration["device_type"] = json!("remote");
    assert_eq!(
        event_ack(original, 9, "device:register", legacy_registration).await,
        json!({"error": "Registration failed: App device ID mismatch for device local-device"}),
    );
    assert_eq!(
        event_ack(
            contender,
            4,
            "device:register",
            registration("electron-new")
        )
        .await,
        json!({"success": true, "device_id": "local-device", "device_route_id": route}),
    );
    assert_eq!(
        event_ack(original, 8, "device:heartbeat", heartbeat.clone()).await,
        stale
    );
    assert_eq!(
        event_ack(contender, 5, "device:heartbeat", heartbeat).await,
        json!({"success": true})
    );
    assert_eq!(online(redis, key).await["socket_id"], contender.socket_id());
}
