use super::*;
use axum::{
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    routing::get,
    Json, Router,
};
use futures_util::StreamExt;

pub(in crate::runtime_work) async fn start_server(
) -> (ConnectionConfig, tokio::task::JoinHandle<()>) {
    start_server_with_archive_failure(false).await
}

pub(in crate::runtime_work) async fn start_server_with_archive_failure(
    archive_failure: bool,
) -> (ConnectionConfig, tokio::task::JoinHandle<()>) {
    start_server_config(archive_failure, false, true).await
}

pub(in crate::runtime_work) async fn start_server_with_slow_device(
) -> (ConnectionConfig, tokio::task::JoinHandle<()>) {
    start_server_config(false, true, true).await
}

pub(in crate::runtime_work) async fn start_server_with_separate_socket(
) -> (ConnectionConfig, [tokio::task::JoinHandle<()>; 2]) {
    let (mut connection, http_server) = start_server_config(false, false, false).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let socket_url = format!("ws://{}/relay/socket.io/", listener.local_addr().unwrap());
    let app = Router::new().route(
        "/relay/socket.io/",
        get(|upgrade: WebSocketUpgrade| async move {
            upgrade.on_upgrade(|socket| serve_socket(socket, false))
        }),
    );
    let socket_server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    connection.socket_url = socket_url;
    (connection, [http_server, socket_server])
}

async fn start_server_config(
    archive_failure: bool,
    slow_device: bool,
    serve_websocket: bool,
) -> (ConnectionConfig, tokio::task::JoinHandle<()>) {
    let mut app = Router::new()
        .route("/deployment/api/devices", get(move || async move {
            let mut items = json!([
            {"device_id":"control-test-device","status":"online"},
            {"device_id":"app-alias","runtime_instance_id":"control-test-device","status":"online"},
            {"device_id":"unrelated-shell","bind_shell":"chat","status":"online"},
            {"device_id":"other-device","device_type":"remote","status":"online"}
            ]).as_array().unwrap().clone();
            if slow_device { items.push(json!({"device_id":"slow-device","status":"online"})); }
            Json(json!({"items":items}))
        }))
        .route("/deployment/api/tasks", get(|headers:axum::http::HeaderMap, axum::extract::Query(params):axum::extract::Query<std::collections::HashMap<String,String>>| async move {
            assert_eq!(headers["authorization"],"Bearer synthetic-token");
            let items = if params["page"] == "1" {
                (1..=100).map(|id|json!({"id":id,"client_origin":"frontend"})).collect::<Vec<_>>()
            } else if params["page"] == "2" {
                Vec::new()
            } else {
                assert_eq!(params["page"],"3");
                vec![json!({"id":1,"client_origin":"frontend"}),json!({"id":123,"title":"Cloud conversation","client_origin":"wework","is_group_chat":false,"updated_at":"2026-10-30T00:00:00Z"})]
            };
            Json(json!({"total":201,"items":items}))
        }))
        .route("/deployment/api/tasks/archived", get(move || async move {
            if archive_failure {(axum::http::StatusCode::FORBIDDEN,Json(json!({"detail":"Forbidden"})))}
            else {(axum::http::StatusCode::OK,Json(json!({"total":0,"items":[]})))}
        }))
        .route("/deployment/api/tasks/{id}", get(|axum::extract::Path(id):axum::extract::Path<i64>| async move {
            if id != 123 {return (axum::http::StatusCode::NOT_FOUND,Json(json!({"detail":"Task not found"})));}
            (axum::http::StatusCode::OK,Json(json!({"id":123,"client_origin":"wework","is_group_chat":false,"title":"Cloud conversation",
                "subtasks":[{"id":500,"inherited":true,"role":"USER","prompt":"inherited weekly history","contexts":[{"name":"inherited-file.txt"}]}]})))
        }))
        .route("/deployment/api/subtasks", get(|axum::extract::Query(params):axum::extract::Query<std::collections::HashMap<String,String>>| async move {
            assert_eq!(params["task_id"],"123");
            assert_eq!(params["from_latest"],"false");
            let page:usize = params["page"].parse().unwrap();
            let items:Vec<_> = (((page-1)*100)..(page*100).min(251)).map(|index|json!({"id":index+1,"role":"ASSISTANT","message_id":index+1,"result":{"value":"cloud weekly work"}})).collect();
            Json(json!({"total":251,"items":items}))
        }));
    if serve_websocket {
        app = app.route(
            "/deployment/socket.io/",
            get(move |upgrade: WebSocketUpgrade| async move {
                upgrade.on_upgrade(move |socket| serve_socket(socket, slow_device))
            }),
        );
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let connection = ConnectionConfig {
        backend_url: format!("http://{address}/deployment/api/"),
        socket_url: format!("ws://{address}/deployment/socket.io/"),
        auth_token: "synthetic-token".into(),
        ..Default::default()
    };
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (connection, server)
}

async fn serve_socket(mut socket: WebSocket, slow_device: bool) {
    socket.send(Message::Text(r#"0{"sid":"reader-test","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}"#.into())).await.unwrap();
    while let Some(message) = socket.next().await {
        let Message::Text(packet) = message.unwrap() else {
            continue;
        };
        if packet.starts_with("40/wework-runtime,") {
            let auth: Value =
                serde_json::from_str(packet.strip_prefix("40/wework-runtime,").unwrap()).unwrap();
            assert_eq!(auth["token"], "synthetic-token");
            socket
                .send(Message::Text(
                    r#"40/wework-runtime,{"sid":"reader-test"}"#.into(),
                ))
                .await
                .unwrap();
            continue;
        }
        if packet.starts_with("41") {
            break;
        }
        if packet == "3" {
            continue;
        }
        let packet = packet
            .strip_prefix("42/wework-runtime,")
            .expect("existing desktop namespace");
        let (ack_id, args) = packet.split_at(packet.find('[').unwrap());
        let args: Value = serde_json::from_str(args).unwrap();
        assert_eq!(args[0], "runtime:request");
        let request = &args[1];
        let method = request["method"].as_str().unwrap();
        if slow_device && request["device_id"] == "slow-device" {
            continue;
        }
        let ack = if request["device_id"] == "denied-device" {
            json!({"id":request["id"],"ok":false,"error":{"code":"remote_control_disabled"}})
        } else {
            assert_eq!(request["device_id"], "other-device");
            let task = json!({"taskId":"remote-task","runtime":"codex","title":"Remote conversation","workspacePath":"/code/aigc-video-agent","updatedAt":100,
                "runtimeHandle":{"wegentTeam":{"id":91},"executionRequest":{"auth_token":"private-secret"},"modelSelection":{"modelName":"test","api_key":"private-secret"}}});
            let result = match method {
                // A legacy device needs no new RPC or query-specific response fields.
                "runtime.tasks.list" => {
                    json!({"success":true,"workspaces":[{"projectKey":"remote-project","workspacePath":"/code/aigc-video-agent","tasks":[task]}]})
                }
                "runtime.archived_conversations.list" => {
                    json!({"success":true,"items":[{"taskId":"archived-task","title":"Archived remote conversation","workspacePath":"/code/archive"}]})
                }
                "runtime.tasks.get" => json!({"success":true,"task":task}),
                "runtime.tasks.transcript.search" => {
                    json!({"totalMatches":1,"matches":[{"snippet":"remote weekly work"}]})
                }
                "runtime.tasks.transcript" => {
                    assert_eq!(request["params"]["transcriptProtocolVersion"], 2);
                    let root = tempfile::tempdir().unwrap();
                    crate::runtime_work::transcript_transport::encode(root.path(),json!({"success":true,"messages":[{"content":format!("remote weekly work{}FULL_HISTORY_SUFFIX","x".repeat(70_000))}],"hasMoreBefore":false})).unwrap()
                }
                _ => panic!("A new Runtime method must not be used: {method}"),
            };
            json!({"id":request["id"],"ok":true,"result":result})
        };
        if socket
            .send(Message::Text(
                format!("43/wework-runtime,{ack_id}[{ack}]").into(),
            ))
            .await
            .is_err()
        {
            break;
        }
    }
}

#[test]
fn runtime_reader_preserves_desktop_authorization_and_rejects_mutations() {
    let _guard = crate::test_env::lock();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let _backend =
                crate::runtime_work::handler::tests::ScalarEnv::set("WEGENT_BACKEND_URL", "");
            let _domain =
                crate::runtime_work::handler::tests::ScalarEnv::set("TASK_API_DOMAIN", "");
            let (connection, server) = start_server().await;
            let request = ExecutionRequest {
                backend_url: Some(connection.backend_url.clone()),
                auth_token: Some("synthetic-token".into()),
                ..ExecutionRequest::default()
            };
            let reader = RuntimeReader::connect(&request, &connection, ReadBudget::default())
                .await
                .unwrap();
            let denied = reader
                .request("denied-device", "runtime.tasks.list", json!({}))
                .await
                .unwrap_err();
            assert_eq!(denied.code, "remote_control_disabled");
            let mutation = reader
                .request("other-device", "runtime.tasks.send", json!({}))
                .await
                .unwrap_err();
            assert_eq!(mutation.code, "permission_denied");
            let legacy = reader
                .request("other-device", "runtime.tasks.list", json!({}))
                .await
                .unwrap();
            assert_eq!(legacy["workspaces"][0]["tasks"][0]["taskId"], "remote-task");
            let history = reader
                .transcript("other-device", json!({"taskId":"remote-task"}))
                .await
                .unwrap();
            assert!(history["messages"][0]["content"]
                .as_str()
                .unwrap()
                .ends_with("FULL_HISTORY_SUFFIX"));
            reader.close().await;
            server.abort();
        });
}

#[test]
fn runtime_reader_uses_the_desktop_socket_route_only_for_the_same_backend() {
    let mut connection = ConnectionConfig {
        backend_url: "https://api.example.com/deployment".into(),
        socket_url: "wss://socket.example.com/relay/socket.io/".into(),
        ..Default::default()
    };
    assert_eq!(
        configured_socket_url("https://api.example.com/deployment/api/", &connection).unwrap(),
        connection.socket_url
    );
    assert_eq!(
        configured_socket_url("https://other-backend.example.com", &connection)
            .unwrap_err()
            .code,
        "backend_connection_changed"
    );
    connection.socket_url.clear();
    assert_eq!(
        configured_socket_url("https://api.example.com/deployment/api/", &connection)
            .unwrap_err()
            .code,
        "backend_connection_unavailable"
    );
}
