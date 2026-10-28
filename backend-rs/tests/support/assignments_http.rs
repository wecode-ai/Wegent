// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Production application, authenticator and hybrid gateway for assignment E2E.

use brz_mysql::MysqlService;
use brz_redis::Redis;
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio::{sync::oneshot, task::JoinHandle};
use wegent_backend_rs::{
    AppState, Application, Gateway, HybridConfig, OriginService, RouteTable,
    auth::AppAuthenticator, bind, build_app_state, config::AuthConfig, serve,
};

const SIGNING_KEY: &str = "assignment-e2e-signing-key";

pub struct Server {
    pub base: String,
    api_stop: oneshot::Sender<()>,
    gateway_stop: oneshot::Sender<()>,
    api_task: JoinHandle<()>,
    gateway_task: JoinHandle<()>,
}

impl Server {
    pub async fn start(mysql: MysqlService) -> Self {
        let state = application_state(mysql).await;
        let application = Application::build(state.clone()).await.unwrap();
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
        let config = hybrid_config();
        let gateway = Gateway::new(
            config.routes,
            OriginService::new(&api_uri).unwrap(),
            &config.python_upstream,
        )
        .unwrap();
        let listener = bind(config.listen_address).await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let (api_stop, api_stopped) = oneshot::channel();
        let api_task = tokio::spawn(async move {
            server
                .serve_until(async {
                    let _ = api_stopped.await;
                })
                .await
                .unwrap()
        });
        let (gateway_stop, gateway_stopped) = oneshot::channel();
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
            .unwrap()
        });
        Self {
            base,
            api_stop,
            gateway_stop,
            api_task,
            gateway_task,
        }
    }

    pub async fn close(self) {
        self.gateway_stop.send(()).unwrap();
        self.gateway_task.await.unwrap();
        self.api_stop.send(()).unwrap();
        self.api_task.await.unwrap();
    }
}

async fn application_state(mysql: MysqlService) -> Arc<AppState> {
    for name in ["DATABASE_URL", "REDIS_URL"] {
        let url =
            url::Url::parse(&std::env::var(name).expect("explicit E2E URL required")).unwrap();
        assert_eq!(
            url.host_str(),
            Some("127.0.0.1"),
            "disposable loopback service required"
        );
    }
    let mut state = build_app_state().await.unwrap();
    state.mysql = mysql;
    state.auth = AuthConfig {
        jwt_key: SIGNING_KEY.into(),
        legacy_jwt_keys: Vec::new(),
        algorithm: "HS256".into(),
    };
    let redis = state.redis.as_ref().expect("real Redis required");
    assert_eq!(
        redis
            .get::<_, String>("assignment-e2e-no-such-key")
            .await
            .unwrap(),
        None
    );
    Arc::new(state)
}

fn hybrid_config() -> HybridConfig {
    let config = HybridConfig::new(
        "127.0.0.1:0".parse().unwrap(),
        "http://127.0.0.1:1".parse().unwrap(),
        RouteTable::empty(),
    )
    .with_routes_file(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml"))
    .unwrap();
    for (method, path) in [
        (http::Method::GET, "/api/v1/loop-items/issue-1/assignments"),
        (
            http::Method::POST,
            "/api/v1/loop-items/issue-1/assignments/102/receipt",
        ),
    ] {
        assert!(
            config.selects_rust(&method, path),
            "the real route table must select Rust"
        );
    }
    config
}

pub fn token(user: i32, lifetime: i64) -> String {
    jsonwebtoken::encode(&jsonwebtoken::Header::default(),
        &json!({"sub":format!("assignment-e2e-{user}"),"exp":chrono::Utc::now().timestamp()+lifetime}),
        &jsonwebtoken::EncodingKey::from_secret(SIGNING_KEY.as_bytes())).unwrap()
}

pub async fn get(base: &str, issue: &str, user: Option<i32>) -> (u16, Value) {
    request(
        base,
        "GET",
        issue,
        user.map(|id| token(id, 300)).as_deref(),
        None,
    )
    .await
}

pub async fn request(
    base: &str,
    method: &str,
    target: &str,
    token: Option<&str>,
    payload: Option<Value>,
) -> (u16, Value) {
    let client = brz_http::Client::builder()
        .timeout(Duration::from_secs(5))
        .read_timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    let path = if method == "GET" {
        format!("{target}/assignments")
    } else {
        target.to_owned()
    };
    let url = format!("{base}/api/v1/loop-items/{path}");
    let mut request = if method == "GET" {
        client.get(&url)
    } else {
        client.post(&url)
    }
    .unwrap();
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    if let Some(payload) = payload {
        request = request.json(&payload);
    }
    let response = request.send().await.unwrap();
    let status = response.status().as_u16();
    let body = response.json::<Value>().await.unwrap();
    (status, body)
}
