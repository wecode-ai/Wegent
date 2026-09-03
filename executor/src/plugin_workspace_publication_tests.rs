// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use axum::{
    body::Bytes,
    extract::State,
    http::HeaderMap,
    routing::{post, put},
    Json, Router,
};
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Clone, Debug)]
struct RecordedPublicationCall {
    method: &'static str,
    path: &'static str,
    idempotency_key: Option<String>,
    authorization: Option<String>,
    body: Vec<u8>,
}

#[derive(Clone)]
struct PublicationServerState {
    base_url: String,
    calls: Arc<Mutex<Vec<RecordedPublicationCall>>>,
    fail_upload: bool,
    fail_complete: bool,
}

fn header_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(ToOwned::to_owned)
}

async fn record_publication_call(
    state: &PublicationServerState,
    method: &'static str,
    path: &'static str,
    headers: &HeaderMap,
    body: Bytes,
) {
    state.calls.lock().await.push(RecordedPublicationCall {
        method,
        path,
        idempotency_key: header_value(headers, "Idempotency-Key"),
        authorization: header_value(headers, "Authorization"),
        body: body.to_vec(),
    });
}

async fn initialize_publication(
    State(state): State<PublicationServerState>,
    headers: HeaderMap,
    body: Bytes,
) -> (StatusCode, Json<Value>) {
    record_publication_call(
        &state,
        "POST",
        "/api/plugins/publication-requests",
        &headers,
        body,
    )
    .await;
    (
        StatusCode::CREATED,
        Json(json!({
            "requestId": 41,
            "sourcePluginId": 12,
            "revision": {"number": 1},
            "uploadUrl": format!("{}/upload/41", state.base_url),
            "expiresAt": "2026-08-29T12:00:00Z",
        })),
    )
}

async fn upload_publication(
    State(state): State<PublicationServerState>,
    headers: HeaderMap,
    body: Bytes,
) -> StatusCode {
    record_publication_call(&state, "PUT", "/upload/41", &headers, body).await;
    if state.fail_upload {
        StatusCode::BAD_GATEWAY
    } else {
        StatusCode::NO_CONTENT
    }
}

async fn complete_publication(
    State(state): State<PublicationServerState>,
    headers: HeaderMap,
    body: Bytes,
) -> (StatusCode, Json<Value>) {
    record_publication_call(
        &state,
        "POST",
        "/api/plugins/publication-requests/41/revisions/1/complete",
        &headers,
        body,
    )
    .await;
    if state.fail_complete {
        (
            StatusCode::BAD_GATEWAY,
            Json(json!({"detail": "completion failed"})),
        )
    } else {
        (
            StatusCode::OK,
            Json(json!({
                "id": 41,
                "status": "awaiting_admin",
                "pluginId": 12,
            })),
        )
    }
}

async fn withdraw_publication(
    State(state): State<PublicationServerState>,
    headers: HeaderMap,
    body: Bytes,
) -> Json<Value> {
    record_publication_call(
        &state,
        "POST",
        "/api/plugins/publication-requests/41/withdraw",
        &headers,
        body,
    )
    .await;
    Json(json!({"id": 41, "status": "withdrawn"}))
}

async fn publication_test_server(
    fail_upload: bool,
    fail_complete: bool,
) -> (String, PublicationServerState, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let state = PublicationServerState {
        base_url: base_url.clone(),
        calls: Arc::new(Mutex::new(Vec::new())),
        fail_upload,
        fail_complete,
    };
    let app = Router::new()
        .route(
            "/api/plugins/publication-requests",
            post(initialize_publication),
        )
        .route("/upload/41", put(upload_publication))
        .route(
            "/api/plugins/publication-requests/{request_id}/revisions/{revision}/complete",
            post(complete_publication),
        )
        .route(
            "/api/plugins/publication-requests/{request_id}/withdraw",
            post(withdraw_publication),
        )
        .with_state(state.clone());
    let handle = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (base_url, state, handle)
}

fn enterprise_request() -> Value {
    json!({
        "intent": "enterprise",
        "visibility": "workspace",
        "operationAttemptId": "attempt-99",
        "releaseNotes": "  Add enterprise search  ",
        "testNotes": "  Windows and macOS verified  ",
        "riskDeclaration": {
            "externalNetworkAccess": true,
            "externalDomains": ["api.example.com"]
        }
    })
}

#[tokio::test]
async fn enterprise_publication_uses_new_contract_with_stable_idempotency_keys() {
    let (backend, state, server) = publication_test_server(false, false).await;
    let package = b"immutable plugin snapshot".to_vec();
    let digest = format!("{:x}", Sha256::digest(&package));
    let artifact = PublishArtifact {
        task_id: "task-7",
        listing_type: "plugin",
        slug: "example",
        display_name: "Example",
        version: "1.2.0",
        filename: "example.zip",
        digest: &digest,
        package: &package,
    };
    let request = enterprise_request();
    let client = http_client().unwrap();

    let first =
        publish_enterprise_publication(&client, &backend, "secret-token", &artifact, &request)
            .await
            .unwrap();
    let second =
        publish_enterprise_publication(&client, &backend, "secret-token", &artifact, &request)
            .await
            .unwrap();

    assert_eq!(first.status, "pending_review");
    assert_eq!(first.plugin_id, Some(12));
    assert_eq!(second.plugin_id, Some(12));
    let calls = state.calls.lock().await.clone();
    assert_eq!(calls.len(), 6);
    assert_eq!(
        calls.iter().map(|call| call.method).collect::<Vec<_>>(),
        vec!["POST", "PUT", "POST", "POST", "PUT", "POST"]
    );
    assert_eq!(
        calls.iter().map(|call| call.path).collect::<Vec<_>>(),
        vec![
            "/api/plugins/publication-requests",
            "/upload/41",
            "/api/plugins/publication-requests/41/revisions/1/complete",
            "/api/plugins/publication-requests",
            "/upload/41",
            "/api/plugins/publication-requests/41/revisions/1/complete",
        ]
    );
    assert_eq!(
        calls[0].authorization.as_deref(),
        Some("Bearer secret-token")
    );
    assert_eq!(
        calls[2].authorization.as_deref(),
        Some("Bearer secret-token")
    );
    assert_eq!(calls[1].body, package);
    assert_eq!(calls[0].idempotency_key, calls[3].idempotency_key);
    assert_eq!(calls[2].idempotency_key, calls[5].idempotency_key);
    assert_ne!(calls[0].idempotency_key, calls[2].idempotency_key);
    assert!(calls[0]
        .idempotency_key
        .as_deref()
        .is_some_and(|value| value.len() >= 8 && value.len() <= 200));
    let payload: Value = serde_json::from_slice(&calls[0].body).unwrap();
    assert_eq!(payload["slug"], "example");
    assert_eq!(payload["requestedVersion"], "1.2.0");
    assert_eq!(payload["snapshotSha256"], digest);
    assert_eq!(payload["releaseNotes"], "Add enterprise search");
    assert_eq!(payload["testNotes"], "Windows and macOS verified");
    assert_eq!(payload["riskDeclaration"]["externalNetworkAccess"], true);
    server.abort();
}

#[tokio::test]
async fn enterprise_publication_withdraws_after_upload_or_completion_failure() {
    for (fail_upload, fail_complete) in [(true, false), (false, true)] {
        let (backend, state, server) = publication_test_server(fail_upload, fail_complete).await;
        let package = b"immutable plugin snapshot".to_vec();
        let digest = format!("{:x}", Sha256::digest(&package));
        let artifact = PublishArtifact {
            task_id: "task-7",
            listing_type: "plugin",
            slug: "example",
            display_name: "Example",
            version: "1.2.0",
            filename: "example.zip",
            digest: &digest,
            package: &package,
        };
        let error = publish_enterprise_publication(
            &http_client().unwrap(),
            &backend,
            "secret-token",
            &artifact,
            &enterprise_request(),
        )
        .await
        .unwrap_err();

        assert!(error.contains("failed with HTTP 502 Bad Gateway"));
        let calls = state.calls.lock().await.clone();
        let withdraw = calls.last().unwrap();
        assert_eq!(
            withdraw.path,
            "/api/plugins/publication-requests/41/withdraw"
        );
        assert_eq!(
            withdraw.authorization.as_deref(),
            Some("Bearer secret-token")
        );
        assert!(withdraw.idempotency_key.is_some());
        assert_ne!(withdraw.idempotency_key, calls[0].idempotency_key);
        server.abort();
    }
}
