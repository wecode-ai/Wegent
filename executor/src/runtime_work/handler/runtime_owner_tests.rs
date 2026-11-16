use super::*;
use axum::{
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};

#[tokio::test]
async fn stand_in_device_identity_rpc_distinguishes_local_alias_and_owned_route() {
    let slot = Arc::new(Mutex::new(None));
    let handler = RuntimeWorkRpcHandler::new("electron-desktop", "unused")
        .with_backend_device_route(slot.clone());
    let identity = || handler.dispatch_method("runtime.stand_in.device_identity", json!({}));
    assert_eq!(identity().await.unwrap_err().code, "cloud_unavailable");
    *slot.lock().unwrap() = Some("app-record-42".into());
    assert_eq!(
        identity().await.unwrap(),
        json!({"deviceId":"electron-desktop","backendDeviceId":"app-record-42"})
    );
    assert!(handler.stand_in_role_runs_here(&json!({"executionDeviceId":"electron-desktop"})));
    assert!(handler.stand_in_role_runs_here(&json!({"executionDeviceId":"app-record-42"})));
    assert!(!handler.stand_in_role_runs_here(&json!({"executionDeviceId":"app-record-71"})));
    *slot.lock().unwrap() = Some("app-record-71".into());
    assert!(!handler.stand_in_role_runs_here(&json!({"executionDeviceId":"app-record-42"})));
}

#[tokio::test]
async fn stand_in_reservation_uses_registered_device_for_each_assignment_and_receipt() {
    let captured = Arc::new(Mutex::new(Vec::new()));
    let writes = captured.clone();
    let router = Router::new()
        .route("/api/users/me", get(|| async { Json(json!({"id":7})) }))
        .route("/api/v1/loop-items/issue/tasks", post(move |Json(body): Json<Value>| {
            writes.lock().unwrap().push(body.clone());
            async move {
                if body["deviceId"] == "app-record-42" {
                    (StatusCode::CREATED, Json(body))
                } else {
                    (StatusCode::FORBIDDEN, Json(json!({"detail":"Stand-in conversations require an active owned device"})))
                }
            }
        }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let backend_url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async { axum::serve(listener, router).await.unwrap() });
    let root = tempfile::tempdir().unwrap();
    let handler = RuntimeWorkRpcHandler {
        store: RuntimeWorkStore::new(root.path().join("runtime-index.json")),
        task_store_path: Arc::new(root.path().join("tasks.sqlite")),
        backend_connection: Arc::new(Mutex::new(Some(ConnectionConfig {
            backend_url,
            auth_token: "test".into(),
            ..Default::default()
        }))),
        ..RuntimeWorkRpcHandler::new("electron-desktop", "unused")
    }
    .with_backend_device_route(Arc::new(Mutex::new(Some("app-record-42".into()))));
    let config = json!({"id":"review","userId":7,"projectId":"project","projectStore":"cloud"});
    let issue = json!({"id":"issue","title":"Review"});
    let mut task_ids = Vec::new();
    for assignment in ["first", "reassigned"] {
        let accepted = handler
            .accept_stand_in_assignment(
                &config,
                &issue,
                &json!({"assignmentId":assignment,"humanAssignmentId":assignment}),
            )
            .await
            .unwrap();
        assert_eq!(accepted["deviceId"], "app-record-42");
        task_ids.push(accepted["taskId"].clone());
    }
    assert_eq!(task_ids[0], task_ids[1]);
    assert_eq!(captured.lock().unwrap().len(), 2);
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let receipts = store.pending_assignment_receipts().unwrap();
    assert_eq!(receipts.len(), 2);
    assert!(receipts
        .iter()
        .all(|(_, receipt)| receipt["deviceId"] == "app-record-42"));
    assert_eq!(handler.device_id, "electron-desktop");
    let mut moved = config.clone();
    moved["executionDeviceId"] = json!("other-device");
    assert!(handler.local_task_links(false).is_empty());
    assert!(handler.stand_in_issue_runs_here(&moved, &issue));
    assert!(!handler.stand_in_issue_runs_here(&moved, &json!({"id":"new-issue"})));
    server.abort();
}

#[test]
fn cloud_device_identity_tracks_registration_without_changing_local_identity() {
    let slot = Arc::new(Mutex::new(None));
    let handler = RuntimeWorkRpcHandler::new("electron-desktop", "unused")
        .with_backend_device_route(slot.clone());
    assert_eq!(
        handler.cloud_device_id().unwrap_err().code,
        "cloud_unavailable"
    );
    *slot.lock().unwrap() = Some("app-record-42".into());
    assert_eq!(handler.cloud_device_id().unwrap(), "app-record-42");
    assert_eq!(handler.device_id, "electron-desktop");
    *slot.lock().unwrap() = None;
    assert_eq!(
        handler.cloud_device_id().unwrap_err().code,
        "cloud_unavailable"
    );
    *slot.lock().unwrap() = Some("app-record-71".into());
    assert_eq!(handler.cloud_device_id().unwrap(), "app-record-71");
}

#[tokio::test]
async fn cloud_denials_identify_the_request_without_leaking_response_content() {
    let router = Router::new().route(
        "/api/v1/loop-items/issue/tasks",
        post(|Json(body): Json<Value>| async move {
            (
                StatusCode::FORBIDDEN,
                Json(json!({"detail":body["detail"]})),
            )
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let backend_url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async { axum::serve(listener, router).await.unwrap() });
    let handler = RuntimeWorkRpcHandler {
        backend_connection: Arc::new(Mutex::new(Some(ConnectionConfig {
            backend_url,
            auth_token: "test".into(),
            ..Default::default()
        }))),
        ..RuntimeWorkRpcHandler::new("electron-desktop", "unused")
    };
    for (detail, reason) in [
        (
            "Stand-in conversations require an active owned device",
            "active_owned_device_required",
        ),
        ("secret response content", "unknown"),
    ] {
        let error = handler
            .runtime_http(
                reqwest::Method::POST,
                "/v1/loop-items/issue/tasks?private=secret-query",
                Some(&json!({"detail":detail})),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "cloud_request_failed");
        assert_eq!(
            error.message,
            format!(
                "Cloud request POST /v1/loop-items/issue/tasks returned 403 Forbidden ({reason})"
            )
        );
        assert!(!error.message.contains("secret"));
    }
    server.abort();
}
