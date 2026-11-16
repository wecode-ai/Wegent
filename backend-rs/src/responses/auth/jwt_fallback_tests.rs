// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The JWT/task-token fallback ordering tests.

use super::*;
use crate::headers::OwnedHeaders;

/// Counts the reader's calls so a fallback attempt cannot silently add one.
#[derive(Default)]
struct CountingReader {
    calls: std::sync::atomic::AtomicUsize,
}

impl CountingReader {
    fn calls(&self) -> usize {
        self.calls.load(std::sync::atomic::Ordering::SeqCst)
    }
}

#[async_trait::async_trait]
impl UserByIdReader for CountingReader {
    async fn get_by_id(&self, _: i64) -> anyhow::Result<Option<UserRecord>> {
        self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(None)
    }

    async fn get_by_name(&self, _: &str) -> anyhow::Result<Option<UserRecord>> {
        self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(None)
    }

    async fn get_entity_by_id(&self, _: i64) -> anyhow::Result<Option<UserRecord>> {
        self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(None)
    }

    async fn get_by_id_on(
        &self,
        _: &mut dyn crate::request_sql::RequestSql,
        _: i64,
    ) -> anyhow::Result<Option<UserRecord>> {
        unimplemented!("the JWT fallback never resolves a user on a transaction")
    }

    async fn get_by_name_on(
        &self,
        _: &mut dyn crate::request_sql::RequestSql,
        _: &str,
    ) -> anyhow::Result<Option<UserRecord>> {
        unimplemented!("the JWT fallback never resolves a user on a transaction")
    }
}

fn config() -> AuthConfig {
    AuthConfig {
        jwt_key: "test-key".to_string(),
        legacy_jwt_keys: Vec::new(),
        algorithm: "HS256".to_string(),
    }
}

/// The fallback ordering is contractual: no bearer, a bearer that is not a
/// decodable JWT, and an API-key-shaped bearer all reach neither verifier's
/// user read, and the caller's rejection stays `ApiKeyRequired`.
#[tokio::test]
async fn jwt_fallback_ordering_is_pinned() {
    for authorization in [None, Some("Bearer not-a-jwt"), Some("Bearer wg-deadbeef")] {
        let reader = CountingReader::default();
        let headers = OwnedHeaders::from_pairs([("authorization", authorization)]);
        let user = jwt_fallback(&config(), &reader, &headers.view())
            .await
            .expect("fallback");
        assert!(user.is_none(), "{authorization:?}");
        assert_eq!(reader.calls(), 0, "{authorization:?}");
        // The caller's rejection point is unchanged.
        assert!(auth_required(user).is_err());
    }
}

fn auth_required(user: Option<CurrentUser>) -> Result<CurrentUser, AuthError> {
    user.ok_or(AuthError::ApiKeyRequired)
}

/// A decodable session token resolves through `get_by_name` exactly once,
/// so the task-token branch does not also run.
#[tokio::test]
async fn a_session_token_reads_the_user_once() {
    let token = jsonwebtoken::encode(
        &jsonwebtoken::Header::new(Algorithm::HS256),
        &serde_json::json!({"sub": "alice"}),
        &jsonwebtoken::EncodingKey::from_secret("test-key".as_bytes()),
    )
    .expect("token");
    let authorization = format!("Bearer {token}");
    let reader = CountingReader::default();
    let headers = OwnedHeaders::from_pairs([("authorization", Some(authorization.as_str()))]);
    let user = jwt_fallback(&config(), &reader, &headers.view())
        .await
        .expect("fallback");
    // The stub returns no row, so the user is absent; the session branch
    // still made exactly one read and the task-token branch was skipped.
    assert!(user.is_none());
    assert_eq!(reader.calls(), 1);
}
