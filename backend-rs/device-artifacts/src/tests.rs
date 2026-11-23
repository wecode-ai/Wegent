// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use base64::Engine as _;
use serde_json::json;

fn config() -> wegent_backend_config::AuthConfig {
    wegent_backend_config::AuthConfig {
        jwt_key: "artifact-unit-test".to_owned(),
        legacy_jwt_keys: vec![],
        algorithm: "HS256".to_owned(),
    }
}

fn token(payload: &Value) -> String {
    jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        payload,
        &jsonwebtoken::EncodingKey::from_secret(config().jwt_key.as_bytes()),
    )
    .unwrap()
}

fn claims() -> Value {
    json!({"type":"task_token", "task_id":42,"subtask_id":7,"user_id":3,"user_name":"artifact-owner",
        "exp":chrono::Utc::now().timestamp()+3600})
}

fn request() -> Value {
    json!({"workspace_root":"/workspace/original", "relative_path":"outputs/报告.md",
        "name":"报告.md", "file_size":17, "sha256":"A".repeat(64)})
}

#[test]
fn declaration_requires_exact_task_and_user_and_positive_assistant_identity() {
    for (field, value) in [
        ("type", json!("session")),
        ("task_id", json!(0)),
        ("task_id", json!(41)),
        ("subtask_id", json!(0)),
        ("user_id", json!(9)),
    ] {
        let mut payload = claims();
        payload[field] = value;
        assert_eq!(
            matching_task_token(&config(), Some(&token(&payload)), 42, 3)
                .unwrap_err()
                .status(),
            StatusCode::FORBIDDEN
        );
    }
    for invalid in ["", "wg-personal-api-key", "invalid-token"] {
        assert_eq!(
            matching_task_token(&config(), Some(invalid), 42, 3)
                .unwrap_err()
                .status(),
            StatusCode::FORBIDDEN
        );
    }
    let jwt = token(&json!({"sub":"owner", "user_id":3}));
    assert!(matching_task_token(&config(), Some(&jwt), 42, 3).is_err());
    let mut incomplete = claims();
    incomplete.as_object_mut().unwrap().remove("user_name");
    assert!(matching_task_token(&config(), Some(&token(&incomplete)), 42, 3).is_err());
    let valid = token(&claims());
    for prefix in ["Bearer ", "bearer ", "BeArEr ", ""] {
        assert_eq!(
            matching_task_token(&config(), Some(&format!("{prefix}{valid}")), 42, 3).unwrap(),
            7
        );
    }
}

#[test]
fn expired_future_and_bad_signature_tokens_are_rejected() {
    for (claim, timestamp) in [
        ("exp", chrono::Utc::now().timestamp() - 1),
        ("nbf", chrono::Utc::now().timestamp() + 30),
    ] {
        let mut payload = claims();
        payload[claim] = json!(timestamp);
        assert!(matching_task_token(&config(), Some(&token(&payload)), 42, 3).is_err());
    }
    let mut wrong = config();
    wrong.jwt_key = "other".to_owned();
    assert!(matching_task_token(&wrong, Some(&token(&claims())), 42, 3).is_err());
}

#[test]
fn workspace_root_must_be_absolute_non_root_and_without_traversal() {
    for root in [
        "/workspace/repo",
        "/Users/test/project",
        "C:\\Users\\test\\project",
        "C:/workspace/repo",
        "\\\\server\\share\\repo",
        "\\\\?\\C:\\Projects\\artifacts",
    ] {
        assert!(models::valid_workspace_root(root), "{root}");
    }
    for root in [
        "",
        "/",
        "relative",
        "C:\\",
        "\\\\server\\share",
        "/repo/../secret",
        "/repo\n",
    ] {
        assert!(!models::valid_workspace_root(root), "{root}");
    }
}

#[test]
fn declaration_roots_must_match_native_workspace_for_device_and_http_sources() {
    for executor in ["device-native", "executor-original"] {
        let source = models::Source {
            executor_name: executor.into(),
            executor_namespace: "original-namespace".into(),
            workspace_root: "/native/custom-worktree".into(),
            workspace_binding_id: "a".repeat(64),
        };
        let mut payload = request();
        payload["workspace_root"] = json!("/existing/unrelated-directory");
        let forged = models::DeclareRequest::validated(payload).unwrap();
        assert_eq!(
            source::validate_declared_root(&source.workspace_root, &forged.workspace_root)
                .unwrap_err()
                .status(),
            StatusCode::FORBIDDEN
        );
        source::validate_declared_root(&source.workspace_root, "/native/custom-worktree").unwrap();
        let query = serde_json::to_value(models::ArtifactQuery::new(&source, 42, 7)).unwrap();
        assert_eq!(
            query,
            json!({"task_id":"42","subtask_id":"7","binding_id":"a".repeat(64)})
        );
        assert!(
            query.get("root_path").is_none(),
            "Root discovery must not send the untrusted declaration root"
        );
    }
}

#[test]
fn credential_refresh_keeps_the_original_location_without_rebinding_permissions() {
    let original = models::Source {
        executor_name: "device-original".into(),
        executor_namespace: "original-namespace".into(),
        workspace_root: "/native/custom-worktree".into(),
        workspace_binding_id: "a".repeat(64),
    };
    let mut refreshed = original.clone();
    refreshed.workspace_binding_id = "b".repeat(64);
    source::validate_declared_root(&refreshed.workspace_root, &original.workspace_root).unwrap();
    repository::validate_original_source(Some(&original), &refreshed).unwrap();
    for changed in [
        models::Source {
            executor_name: "device-rebound".into(),
            ..refreshed.clone()
        },
        models::Source {
            executor_namespace: "other-namespace".into(),
            ..refreshed.clone()
        },
        models::Source {
            workspace_root: "/existing/unrelated".into(),
            ..refreshed.clone()
        },
    ] {
        assert_eq!(
            repository::validate_original_source(Some(&original), &changed)
                .unwrap_err()
                .status(),
            StatusCode::CONFLICT
        );
    }
    assert!(repository::validate_original_source(None, &refreshed).is_err());
}

#[test]
fn relative_paths_reject_absolute_traversal_and_unsafe_separators() {
    for path in [
        "",
        "/etc/passwd",
        "C:/Windows/file.txt",
        "../secret",
        "outputs/../../secret",
        "outputs\\secret",
        ".",
        "file\n",
    ] {
        assert!(models::normalize_relative_path(path).is_err(), "{path}");
    }
    assert_eq!(
        models::normalize_relative_path(" ./outputs//report.pdf ").unwrap(),
        "outputs/report.pdf"
    );
}

#[test]
fn metadata_validates_size_digest_and_headers_before_persisting() {
    let parsed = models::DeclareRequest::validated(request()).unwrap();
    assert_eq!(parsed.sha256, "a".repeat(64));
    assert_eq!(parsed.mime_type, "application/octet-stream");
    for (field, value) in [
        ("file_size", json!(-1)),
        ("sha256", json!("wrong")),
        ("name", json!("")),
        ("name", json!("bad\r\nname")),
        ("modified_at", json!(-1)),
        ("mime_type", json!("text/plain\r\nX-Unsafe: true")),
        ("workspace_root", json!("/")),
    ] {
        let mut payload = request();
        payload[field] = value;
        assert!(
            models::DeclareRequest::validated(payload).is_err(),
            "{field}"
        );
    }
}

#[test]
fn device_chunk_protocol_is_strict_and_bounded() {
    let chunk = json!({"content_base64":"aGVsbG8=","size":5,"offset":0,"eof":true});
    assert_eq!(
        files::decode_chunk(chunk.clone(), 0).unwrap(),
        (b"hello".to_vec(), 5, true)
    );
    for (key, value) in [
        ("content_base64", json!("!bad")),
        ("size", json!(-1)),
        ("size", json!(true)),
        ("offset", json!(1)),
        ("offset", json!(true)),
        ("eof", json!(false)),
        ("eof", json!("true")),
    ] {
        let mut invalid = chunk.clone();
        invalid[key] = value;
        assert!(files::decode_chunk(invalid, 0).is_err(), "{key}");
    }
    assert!(
        files::decode_chunk(
            json!({"content_base64":"","size":1,"offset":0,"eof":false}),
            0
        )
        .is_err()
    );
    let error = files::decode_chunk(
        json!({"content_base64":"","size":models::MAX_FILE_BYTES+1,"offset":0,"eof":true}),
        0,
    )
    .unwrap_err();
    assert_eq!(error.status(), StatusCode::PAYLOAD_TOO_LARGE);
    let empty = files::decode_chunk(
        json!({"content_base64":"","size":0,"offset":0,"eof":true}),
        0,
    )
    .unwrap();
    assert_eq!(empty, (vec![], 0, true));
    let second=files::decode_chunk(json!({"content_base64":base64::engine::general_purpose::STANDARD.encode(b"tail"),"size":9,"offset":5,"eof":true}),5).unwrap();
    assert_eq!(second, (b"tail".to_vec(), 9, true));
}

async fn http_response(status: u16, headers: &str, body: &str) -> brz_http::Response {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let response = format!("HTTP/1.1 {status} Test\r\nConnection: close\r\n{headers}\r\n{body}");
    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        while !request.windows(4).any(|window| window == b"\r\n\r\n") {
            let mut buffer = [0; 2048];
            let count = socket.read(&mut buffer).await.unwrap();
            assert!(count > 0 && request.len() + count <= 8192);
            request.extend_from_slice(&buffer[..count]);
        }
        // A size rejection may close the connection before the complete body.
        let _ = socket.write_all(response.as_bytes()).await;
    });
    brz_http::Client::builder()
        .build()
        .unwrap()
        .get(format!("http://{address}/filesystem/artifact"))
        .unwrap()
        .send()
        .await
        .unwrap()
}

#[tokio::test]
async fn executor_download_enforces_declared_and_streamed_size_without_fallback() {
    for (headers, body) in [
        ("Content-Length: 6\r\n", "123456"),
        (
            "Transfer-Encoding: chunked\r\n",
            "4\r\n1234\r\n2\r\n56\r\n0\r\n\r\n",
        ),
        (
            "Content-Length: 1\r\nTransfer-Encoding: chunked\r\n",
            "4\r\n1234\r\n2\r\n56\r\n0\r\n\r\n",
        ),
    ] {
        let response = http_response(200, headers, body).await;
        assert_eq!(
            files::bounded_body(response, 5).await.unwrap_err().status(),
            StatusCode::PAYLOAD_TOO_LARGE
        );
    }
    assert_eq!(
        files::bounded_body(
            http_response(200, "Content-Length: 5\r\n", "hello").await,
            5
        )
        .await
        .unwrap(),
        b"hello"
    );
}

#[tokio::test]
async fn canonical_executor_read_rejections_remain_explicit() {
    for (upstream, expected) in [
        (400, 400),
        (403, 403),
        (404, 404),
        (413, 413),
        (500, 502),
        (502, 502),
        (503, 503),
        (504, 503),
    ] {
        let response = http_response(upstream, "Content-Length: 0\r\n", "").await;
        assert_eq!(
            files::bounded_body(response, 5)
                .await
                .unwrap_err()
                .status()
                .as_u16(),
            expected
        );
    }
}

#[test]
fn manager_artifact_query_includes_executor_and_namespace() {
    let source = models::Source {
        executor_name: "executor-original".into(),
        executor_namespace: "original-namespace".into(),
        workspace_root: "/workspace/repo".into(),
        workspace_binding_id: "b".repeat(64),
    };
    let query = models::ArtifactQuery::new(&source, 42, 7);
    assert_eq!(
        serde_json::to_value(source::ManagerArtifactQuery::new(&source, &query)).unwrap(),
        json!({
            "binding_id": "b".repeat(64),
            "task_id": "42",
            "subtask_id": "7",
            "executor_name": "executor-original",
            "executor_namespace": "original-namespace",
        })
    );

    let mut without_ns = source.clone();
    without_ns.executor_namespace.clear();
    let mut file_query = models::ArtifactQuery::new(&without_ns, 42, 7);
    file_query.root_path = Some("/workspace/repo".into());
    file_query.path = Some("outputs/report.md".into());
    file_query.offset = Some(0);
    assert_eq!(
        serde_json::to_value(source::ManagerArtifactQuery::new(&without_ns, &file_query)).unwrap(),
        json!({
            "binding_id": "b".repeat(64),
            "task_id": "42",
            "subtask_id": "7",
            "executor_name": "executor-original",
            "root_path": "/workspace/repo",
            "path": "outputs/report.md",
            "offset": 0,
        })
    );
}

async fn spawn_mock_manager(
    status: u16,
    headers: &'static str,
    body: &'static str,
) -> (std::net::SocketAddr, tokio::sync::oneshot::Receiver<String>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (tx, rx) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        while !request.windows(4).any(|window| window == b"\r\n\r\n") {
            let mut buffer = [0; 2048];
            let count = socket.read(&mut buffer).await.unwrap();
            if count == 0 {
                break;
            }
            request.extend_from_slice(&buffer[..count]);
        }
        let request_text = String::from_utf8_lossy(&request);
        let first_line = request_text.lines().next().unwrap_or_default().to_owned();
        let _ = tx.send(first_line);
        let response = format!(
            "HTTP/1.1 {status} Test\r\nConnection: close\r\nContent-Length: {}\r\n{headers}\r\n{body}",
            body.len()
        );
        let _ = socket.write_all(response.as_bytes()).await;
    });
    (address, rx)
}

#[tokio::test]
async fn workspace_root_and_executor_file_proxy_via_executor_manager() {
    let mysql =
        brz_mysql::MysqlService::connect_lazy("mysql://test:test@127.0.0.1:1/test").unwrap();
    let state = DeviceArtifactState {
        task_store: std::sync::Arc::new(wegent_task_store::task_store::DefaultTaskStore::new(
            mysql.clone(),
        )),
        mysql,
        redis: None,
        socketio_rpc: None,
        auth: config(),
        attachment_http: brz_http::Client::builder().build().unwrap(),
    };
    let source = models::Source {
        executor_name: "executor-original".into(),
        executor_namespace: "wegent-pod".into(),
        workspace_root: "/workspace/42".into(),
        workspace_binding_id: "b".repeat(64),
    };
    let query = models::ArtifactQuery::new(&source, 42, 7);

    let (addr, rx) = spawn_mock_manager(
        200,
        "Content-Type: application/json\r\n",
        r#"{"workspace_root":"/workspace/42"}"#,
    )
    .await;
    let manager_url = format!("http://{addr}");
    let root = source::workspace_root_via_manager(&state, &manager_url, &source, &query)
        .await
        .unwrap();
    assert_eq!(root, "/workspace/42");
    let request_line = rx.await.unwrap();
    assert!(
        request_line.starts_with("GET /executor-manager/executor/workspace/artifact?"),
        "unexpected request line: {request_line}"
    );
    assert!(request_line.contains("task_id=42"));
    assert!(request_line.contains("subtask_id=7"));
    assert!(request_line.contains("executor_name=executor-original"));
    assert!(request_line.contains("executor_namespace=wegent-pod"));
    assert!(!request_line.contains("root_path="));

    for (upstream, expected) in [
        (404, StatusCode::CONFLICT),
        (413, StatusCode::CONFLICT),
        (502, StatusCode::SERVICE_UNAVAILABLE),
        (503, StatusCode::SERVICE_UNAVAILABLE),
        (504, StatusCode::SERVICE_UNAVAILABLE),
    ] {
        let (addr, _rx) = spawn_mock_manager(upstream, "", "").await;
        let manager_url = format!("http://{addr}");
        let err = source::workspace_root_via_manager(&state, &manager_url, &source, &query)
            .await
            .unwrap_err();
        assert_eq!(err.status(), expected, "workspace_root upstream {upstream}");
    }

    let (addr, rx) = spawn_mock_manager(200, "Content-Type: text/markdown\r\n", "# Report\n").await;
    let manager_url = format!("http://{addr}");
    let bytes =
        files::executor_file_via_manager(&state, &manager_url, &source, 42, 7, "outputs/report.md")
            .await
            .unwrap();
    assert_eq!(bytes, b"# Report\n");
    let file_request_line = rx.await.unwrap();
    assert!(
        file_request_line.starts_with("GET /executor-manager/executor/workspace/artifact?"),
        "unexpected request line: {file_request_line}"
    );
    assert!(file_request_line.contains("executor_name=executor-original"));
    assert!(file_request_line.contains("executor_namespace=wegent-pod"));
    assert!(file_request_line.contains("root_path=%2Fworkspace%2F42"));
    assert!(file_request_line.contains("path=outputs%2Freport.md"));

    for (upstream, expected) in [
        (404, StatusCode::NOT_FOUND),
        (413, StatusCode::PAYLOAD_TOO_LARGE),
        (502, StatusCode::BAD_GATEWAY),
        (503, StatusCode::SERVICE_UNAVAILABLE),
        (504, StatusCode::SERVICE_UNAVAILABLE),
    ] {
        let (addr, _rx) = spawn_mock_manager(upstream, "", "").await;
        let manager_url = format!("http://{addr}");
        let err = files::executor_file_via_manager(
            &state,
            &manager_url,
            &source,
            42,
            7,
            "outputs/report.md",
        )
        .await
        .unwrap_err();
        assert_eq!(err.status(), expected, "executor_file upstream {upstream}");
    }
}
