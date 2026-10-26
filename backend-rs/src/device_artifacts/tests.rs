// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use base64::Engine as _;
use serde_json::json;

fn config() -> crate::config::AuthConfig {
    crate::config::AuthConfig {
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
    json!({"type":"task_token", "task_id":42,"subtask_id":7,"user_id":3,
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

#[test]
fn api_routes_are_registered_and_selected_for_rust_only() {
    let config = crate::hybrid::load_routes_config(
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml"),
    )
    .unwrap();
    let table = crate::RouteTable::compile(config).unwrap();
    assert!(table.matches(
        &http::Method::POST,
        "/api/tasks/42/remote-workspace/artifacts"
    ));
    assert!(table.matches(
        &http::Method::GET,
        "/api/tasks/42/remote-workspace/artifacts/7/file"
    ));
    let routes: Vec<_> =
        brz_http_server::__private::inventory::iter::<crate::__http_registry_http_apis::Entry>()
            .flat_map(|entry| (entry.0.routes)())
            .collect();
    for (path, bit) in [
        ("/api/tasks/:task_id/remote-workspace/artifacts", 1 << 5),
        (
            "/api/tasks/:task_id/remote-workspace/artifacts/:context_id/file",
            1 << 1,
        ),
    ] {
        assert!(
            routes
                .iter()
                .any(|route| route.path == path && route.methods & bit != 0)
        );
    }
    let python = include_str!("../../../backend/app/api/endpoints/adapter/tasks.py");
    assert!(!python.contains("def declare_remote_workspace_artifact("));
    assert!(!python.contains("def download_remote_workspace_artifact("));
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
    for (upstream, expected) in [(400, 400), (403, 403), (404, 404), (413, 413), (500, 502)] {
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
