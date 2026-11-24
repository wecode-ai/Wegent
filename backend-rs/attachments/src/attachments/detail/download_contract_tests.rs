// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Execute the production issuer and download-token handler branch, not a
//! share-token exit or an isolated policy predicate.
use super::*;
use crate::attachments::{download_token, handler};
use crate::sql_test_support::mysql_rows::{MysqlRows, Row, Value};
use brz_http_server::{EphemeralBytesArena, IntoHttpResponse};
use std::sync::atomic::{AtomicBool, Ordering};

fn text(value: impl Into<String>) -> Value {
    Value::Text(value.into())
}

fn fixture_row(sql: &str, allowed: bool, video: bool) -> Row {
    let (extension, mime_type) = if video {
        ("mp4", "video/mp4")
    } else {
        ("txt", "text/plain")
    };
    fixture_file_row(sql, allowed, extension, mime_type)
}

fn fixture_file_row(sql: &str, allowed: bool, extension: &str, mime_type: &str) -> Row {
    if sql.contains("FROM users") {
        return vec![
            ("users_id", Value::I32(7)),
            ("users_user_name", text("owner")),
            ("users_password_hash", text("")),
            ("users_email", Value::Null),
            ("users_git_info", text("{}")),
            ("users_is_active", Value::I8(1)),
            ("users_role", text("user")),
            ("users_auth_source", text("local")),
            ("users_preferences", text("{}")),
            ("users_created_at", Value::DateTime),
            ("users_updated_at", Value::DateTime),
        ];
    }
    if sql.contains("FROM knowledge_documents") {
        return vec![
            ("knowledge_documents_kind_id", Value::I64(19)),
            (
                "knowledge_documents_file_extension",
                text(format!(".{extension}")),
            ),
        ];
    }
    if sql.contains("FROM kinds") {
        assert!(sql.contains("'KnowledgeBase'"));
        return vec![(
            "kinds_json",
            text(format!(
                r#"{{"spec":{{"allowDocumentDownload":{allowed}}}}}"#
            )),
        )];
    }
    if sql.contains("FROM subtask_contexts") {
        if !sql.contains("subtask_contexts_type_data") {
            return vec![(
                "subtask_contexts_binary_data",
                Value::Bytes(b"original".to_vec()),
            )];
        }
        let metadata = serde_json::json!({
            "original_filename": format!("protected.{extension}"),
            "file_extension": format!(".{extension}"),
            "mime_type": mime_type,
            "storage_backend": "mysql", "storage_key": "attachments/test_1_7_42",
            "file_size": 8
        });
        return vec![
            ("subtask_contexts_id", Value::I64(42)),
            ("subtask_contexts_subtask_id", Value::I64(0)),
            ("subtask_contexts_user_id", Value::I32(7)),
            ("subtask_contexts_context_type", text("attachment")),
            ("subtask_contexts_name", text("protected")),
            ("subtask_contexts_status", text("ready")),
            ("subtask_contexts_error_message", Value::Null),
            ("subtask_contexts_binary_data", Value::Bytes(vec![])),
            ("subtask_contexts_image_base64", Value::Null),
            ("subtask_contexts_extracted_text", Value::Null),
            ("subtask_contexts_text_length", Value::I32(0)),
            ("subtask_contexts_type_data", text(metadata.to_string())),
            ("subtask_contexts_created_at", Value::Null),
            ("subtask_contexts_updated_at", Value::Null),
        ];
    }
    panic!("unexpected attachment contract query: {sql}");
}

fn user() -> crate::auth::SessionUser {
    let now = chrono::Utc::now().naive_utc();
    crate::auth::SessionUser(crate::auth::UserRow {
        id: 7,
        user_name: "owner".into(),
        email: None,
        is_active: 1,
        role: "user".into(),
        auth_source: "local".into(),
        users_password_hash: String::new(),
        git_info: brz_mysql::Json(brz_json::OpaqueJson::from(serde_json::json!({}))),
        preferences: "{}".into(),
        created_at: now,
        updated_at: now,
    })
}

fn body(response: &Response) -> &[u8] {
    match response.body() {
        brz_http_server::ResponseBody::Owned(bytes) => bytes,
        brz_http_server::ResponseBody::Arena(bytes) => bytes.as_ref(),
        brz_http_server::ResponseBody::Static(bytes) => bytes,
        other => panic!("expected buffered response, got {other:?}"),
    }
}

async fn download(
    state: &Arc<AttachmentState>,
    token: &str,
) -> Result<Response, crate::http_compat::FastApiError> {
    let request = handler::AnonymousRequest {
        accept: None,
        host: None,
        forwarded_host: None,
        forwarded_proto: None,
        attachment_id: 42,
        purpose: None,
    };
    let outcome =
        handler::download_attachment(state, 42, Some(token), None, None, None, None, &request)
            .await?;
    Ok(outcome.into_http_response(&EphemeralBytesArena::new(4096)))
}

fn assert_disabled(result: Result<Response, crate::http_compat::FastApiError>) {
    let error = match result {
        Ok(response) => panic!(
            "protected original unexpectedly returned {}",
            response.status()
        ),
        Err(error) => error,
    };
    assert_eq!(error.status(), StatusCode::FORBIDDEN);
    let detail: serde_json::Value = serde_json::from_str(&error.validation_detail()).unwrap();
    assert_eq!(detail["code"], "DOCUMENT_DOWNLOAD_DISABLED");
    assert_eq!(detail["message"], "Document download is disabled");
}

#[tokio::test]
async fn issued_download_token_rechecks_policy_after_knowledge_base_flip() {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        let allowed = Arc::new(AtomicBool::new(true));
        let policy = allowed.clone();
        let fixture =
            MysqlRows::start(move |sql| fixture_row(sql, policy.load(Ordering::SeqCst), false))
                .await;
        let state = crate::test_support::state(fixture.mysql.clone());
        let issued = create_attachment_download_token(&state, 42, user())
            .await
            .unwrap();
        assert_eq!(issued.status(), StatusCode::OK);
        let payload: serde_json::Value = serde_json::from_slice(body(&issued)).unwrap();
        let token = payload["download_token"].as_str().unwrap();
        let response = download(&state, token).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(body(&response), b"original");

        allowed.store(false, Ordering::SeqCst);
        // The same, still-valid credential must not retain the old policy.
        assert_disabled(download(&state, token).await);
        assert_disabled(create_attachment_download_token(&state, 42, user()).await);
    })
    .await
    .expect("attachment policy contract timed out");
}

#[tokio::test]
async fn protected_video_allows_playback_token_but_not_download_token() {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        let fixture = MysqlRows::start(|sql| fixture_row(sql, false, true)).await;
        let state = crate::test_support::state(fixture.mysql.clone());
        let token = |purpose| {
            download_token::create_download_token(&state.auth, 42, 7, "owner", purpose).unwrap()
        };
        assert_disabled(download(&state, &token(download_token::DOWNLOAD_PURPOSE)).await);
        let response = download(&state, &token(download_token::PLAYBACK_PURPOSE))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(body(&response), b"original");
    })
    .await
    .expect("attachment playback contract timed out");
}

// Preserve the internal preview/download matrix at the active Rust handler.
async fn protected_original(
    extension: &'static str,
    mime_type: &'static str,
    purpose: Option<&str>,
) -> Result<Response, crate::http_compat::FastApiError> {
    let fixture =
        MysqlRows::start(move |sql| fixture_file_row(sql, false, extension, mime_type)).await;
    let state = crate::test_support::state(fixture.mysql.clone());
    let identity = user().0;
    let session = super::super::auth::UserRow {
        users_id: identity.id,
        users_user_name: identity.user_name,
        users_password_hash: identity.users_password_hash,
        users_email: identity.email,
        users_git_info: Some(identity.git_info),
        users_is_active: identity.is_active,
        users_role: identity.role,
        users_auth_source: identity.auth_source,
        users_preferences: identity.preferences,
        users_created_at: identity.created_at,
        users_updated_at: identity.updated_at,
    };
    let request = handler::AnonymousRequest {
        accept: None,
        host: None,
        forwarded_host: None,
        forwarded_proto: None,
        attachment_id: 42,
        purpose,
    };
    let outcome = handler::download_attachment(
        &state,
        42,
        None,
        None,
        purpose,
        None,
        Some(&session),
        &request,
    )
    .await?;
    Ok(outcome.into_http_response(&EphemeralBytesArena::new(4096)))
}

#[tokio::test]
async fn protected_original_preview_allows_only_previewable_formats() {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        for (extension, mime_type) in [
            ("pdf", "application/pdf"),
            (
                "docx",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            ),
            ("doc", "application/msword"),
            ("xls", "application/vnd.ms-excel"),
            (
                "xlsx",
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            ),
            (
                "pptx",
                "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            ),
            ("jpg", "image/jpeg"),
            ("jpeg", "image/jpeg"),
            ("png", "image/png"),
            ("gif", "image/gif"),
            ("bmp", "image/bmp"),
            ("webp", "image/webp"),
            ("tif", "image/tiff"),
            ("tiff", "image/tiff"),
        ] {
            let response = protected_original(extension, mime_type, Some("preview"))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK, "{extension}");
            assert_eq!(body(&response), b"original", "{extension}");
            assert_inline_response(response).await;
        }
    })
    .await
    .expect("protected original preview matrix timed out");
}

#[tokio::test]
async fn protected_original_preview_rejects_unsupported_formats() {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        for (extension, mime_type) in [
            ("zip", "application/zip"),
            ("svg", "image/svg+xml"),
            ("mp4", "video/mp4"),
            ("ppt", "application/vnd.ms-powerpoint"),
        ] {
            assert_disabled(protected_original(extension, mime_type, Some("preview")).await);
        }
    })
    .await
    .expect("unsupported preview matrix timed out");
}

#[tokio::test]
async fn protected_original_download_rejects_previewable_formats() {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        for (extension, mime_type) in [
            ("pdf", "application/pdf"),
            ("png", "image/png"),
            ("jpg", "image/jpg"),
            ("tiff", "image/tiff"),
        ] {
            assert_disabled(protected_original(extension, mime_type, None).await);
        }
    })
    .await
    .expect("protected original download matrix timed out");
}

async fn assert_inline_response(response: Response) {
    struct OneResponse(std::sync::Mutex<Option<Response>>);
    impl brz_http_server::Handler for OneResponse {
        async fn call<'a>(
            &'a self,
            _request: brz_http_server::Request<'a>,
            _authenticator: &'a brz_http_server::NoAuthenticator,
        ) -> Response {
            self.0
                .lock()
                .unwrap()
                .take()
                .expect("one request per response")
        }
    }
    let server = brz_http_server::Server::bind(
        "127.0.0.1:0".parse().unwrap(),
        OneResponse(std::sync::Mutex::new(Some(response))),
    )
    .await
    .unwrap();
    let address = server.local_addr().unwrap();
    let (finish, finished) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(server.serve_until(async {
        let _ = finished.await;
    }));
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
    stream.write_all(b"GET /api/attachments/42/download?purpose=preview HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n").await.unwrap();
    let mut wire = Vec::new();
    stream.read_to_end(&mut wire).await.unwrap();
    let boundary = wire
        .windows(4)
        .position(|bytes| bytes == b"\r\n\r\n")
        .unwrap();
    let headers = std::str::from_utf8(&wire[..boundary])
        .unwrap()
        .to_lowercase();
    assert!(headers.starts_with("http/1.1 200 "));
    assert!(
        headers
            .lines()
            .any(|line| line.starts_with("content-disposition: inline"))
    );
    assert_eq!(&wire[boundary + 4..], b"original");
    finish.send(()).unwrap();
    task.await.unwrap().unwrap();
}
