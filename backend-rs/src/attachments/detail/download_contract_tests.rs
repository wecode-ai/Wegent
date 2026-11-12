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
                text(if video { ".mp4" } else { ".txt" }),
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
            "original_filename": if video { "protected.mp4" } else { "protected.txt" },
            "file_extension": if video { ".mp4" } else { ".txt" },
            "mime_type": if video { "video/mp4" } else { "text/plain" },
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
    state: &Arc<AppState>,
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
        let state = crate::app_test_support::app(fixture.mysql.clone());
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
        let state = crate::app_test_support::app(fixture.mysql.clone());
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
