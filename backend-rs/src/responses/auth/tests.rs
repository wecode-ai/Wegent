// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Response-auth unit tests: rejection rendering, the deferred principal,
//! and the request-handle statement shapes.

/// Records the statements issued through the request handle.
#[derive(Default)]
struct RecordedRequestSql {
    calls: std::sync::Mutex<Vec<(crate::request_sql::RouteKey, String, usize)>>,
}

impl RecordedRequestSql {
    fn calls(&self) -> Vec<(crate::request_sql::RouteKey, String, usize)> {
        self.calls.lock().unwrap().clone()
    }
}

#[async_trait::async_trait]
impl crate::request_sql::RequestSql for RecordedRequestSql {
    async fn execute_statement(
        &mut self,
        route: crate::request_sql::RouteKey,
        sql: &str,
        arguments: crate::request_sql::StatementArgs,
    ) -> brz_mysql::MysqlResult<brz_mysql::MysqlExecution> {
        self.calls
            .lock()
            .unwrap()
            .push((route, sql.to_string(), arguments.len()));
        Ok(brz_mysql::MysqlExecution {
            rows_affected: 1,
            last_insert_id: 0,
        })
    }

    async fn fetch_optional_row(
        &mut self,
        route: crate::request_sql::RouteKey,
        sql: &str,
        arguments: crate::request_sql::StatementArgs,
    ) -> brz_mysql::MysqlResult<Option<brz_mysql::MysqlRow>> {
        self.calls
            .lock()
            .unwrap()
            .push((route, sql.to_string(), arguments.len()));
        Ok(None)
    }

    async fn fetch_all_rows(
        &mut self,
        route: crate::request_sql::RouteKey,
        sql: &str,
        arguments: crate::request_sql::StatementArgs,
    ) -> brz_mysql::MysqlResult<Vec<brz_mysql::MysqlRow>> {
        self.calls
            .lock()
            .unwrap()
            .push((route, sql.to_string(), arguments.len()));
        Ok(Vec::new())
    }
}

/// The deferred post-commit refresh runs through the request handle with
/// the extractor's exact statement shape: the labeled projection and the
/// literal primary key, with no bound parameters (`RouteKey::None`).
#[tokio::test]
async fn deferred_api_key_refresh_uses_the_request_handle() {
    let mut sql = RecordedRequestSql::default();
    let row = reload_api_key_on(&mut sql, 6539).await.expect("refresh");
    assert!(row.is_none(), "the fake returns no row");
    let calls = sql.calls();
    assert_eq!(calls.len(), 1, "{calls:?}");
    assert_eq!(calls[0].0, crate::request_sql::RouteKey::None);
    assert_eq!(calls[0].2, 0, "the extractor inlines the id as a literal");
    assert!(
        calls[0].1.contains("FROM api_keys") && calls[0].1.contains("api_keys.id = 6539"),
        "unexpected statement: {}",
        calls[0].1
    );
    assert!(
        calls[0]
            .1
            .contains("api_keys.key_type AS api_keys_key_type"),
        "the refreshed row keeps the extractor's projection"
    );
}

use super::*;
use crate::user_reader::PublicUserReader;

fn headers<'a>(pairs: &'a [(&'a str, &'a str)]) -> crate::headers::HeaderSlice<'a> {
    crate::headers::HeaderSlice::new(pairs)
}

#[test]
fn api_key_extraction_priority() {
    let both = headers(&[("x-api-key", "wg-abc"), ("authorization", "Bearer wg-def")]);
    assert_eq!(
        api_key_from_headers(&both).as_deref(),
        Some("wg-abc"),
        "X-API-Key wins"
    );
    let bearer = headers(&[("authorization", "Bearer wg-def")]);
    assert_eq!(api_key_from_headers(&bearer).as_deref(), Some("wg-def"));
    let lower = headers(&[("authorization", "bearer wg-def")]);
    assert_eq!(api_key_from_headers(&lower).as_deref(), Some("wg-def"));
    let source = headers(&[("wegent-source", "wg-src")]);
    assert_eq!(api_key_from_headers(&source).as_deref(), Some("wg-src"));
    let jwt = headers(&[("authorization", "Bearer eyJ...")]);
    assert_eq!(api_key_from_headers(&jwt), None);
}

#[test]
fn key_with_username_split() {
    assert_eq!(
        split_key_with_username("wg-key#user"),
        ("wg-key".to_string(), Some("user".to_string()))
    );
    assert_eq!(
        split_key_with_username("wg-key#"),
        ("wg-key".to_string(), None)
    );
    assert_eq!(
        split_key_with_username("wg-key"),
        ("wg-key".to_string(), None)
    );
}

#[test]
fn sha256_is_lowercase_hex() {
    assert_eq!(
        super::api_key::hex_sha256(b"abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
}

#[test]
fn session_payload_filter() {
    let claims = |scope: Option<serde_json::Value>, token_use: Option<&str>| SessionClaims {
        sub: Some("yingeng".to_string()),
        scope,
        token_use: token_use.map(str::to_string),
        exp: None,
    };
    assert!(claims(None, None).is_user_session_payload());
    assert!(claims(None, Some("wework_access")).is_user_session_payload());
    assert!(!claims(Some(serde_json::json!("read")), None).is_user_session_payload());
    assert!(!claims(None, Some("other")).is_user_session_payload());
}

#[test]
fn service_username_format() {
    let valid = |name: &str| {
        !name.is_empty()
            && name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    };
    assert!(valid("yingeng"));
    assert!(valid("user-1_x"));
    assert!(!valid("user name"));
    assert!(!valid(""));
}

/// A deferred rejection must be the extractor's rejection: same status,
/// same headers, same body, for every error the shared mapper produces.
/// `FastApiError` keeps its fields private, so the comparison uses its
/// complete `Debug` form (status, body and the header list).
/// One rejection case: the label, the error constructor and the optional
/// `username` header value.
type RejectionCase = (&'static str, fn() -> AuthError, Option<&'static str>);

#[test]
fn a_deferred_rejection_renders_exactly_like_the_extractor_rejection() {
    let cases: [RejectionCase; 10] = [
        ("api key required", || AuthError::ApiKeyRequired, None),
        ("invalid api key", || AuthError::InvalidApiKey, None),
        ("expired api key", || AuthError::ApiKeyExpired, None),
        ("user missing", || AuthError::UserNotFoundOrInactive, None),
        ("username required", || AuthError::UsernameRequired, None),
        (
            "invalid username",
            || AuthError::InvalidUsernameFormat,
            None,
        ),
        (
            "inactive user",
            || AuthError::UserInactive("yingeng".to_string()),
            Some("yingeng"),
        ),
        (
            "unknown key type",
            || AuthError::InvalidAuthenticationCredentials,
            None,
        ),
        (
            "unverifiable token",
            || AuthError::CouldNotValidateCredentials,
            None,
        ),
        (
            "dependency failure",
            || AuthError::Dependency("connection reset".to_string()),
            None,
        ),
    ];
    for (name, error, username) in cases {
        // What `Authenticator::reject` builds for a request whose headers
        // name `username`.
        let extractor = auth_error_response(auth_failure(error()), username.map(str::to_string));
        let deferred = deferred_auth_error(error());
        assert_eq!(format!("{extractor:?}"), format!("{deferred:?}"), "{name}");
    }
}

/// The public reader on a lazily-connected pool: the deferred reads only
/// use the request handle, so no server is needed.
fn user_reader() -> crate::user_reader::PublicUserReader {
    PublicUserReader::new(
        brz_mysql::MysqlService::connect_lazy("mysql://test:test@127.0.0.1:1/test")
            .expect("lazy pool"),
    )
}

/// A rejected deferred `users` read ends the request with the extractor's
/// 401 and leaves the transaction without a write.
#[tokio::test]
async fn a_rejected_deferred_user_read_writes_nothing() {
    let mut sql = RecordedRequestSql::default();
    let error = resolve_authenticated_key_on(
        &user_reader(),
        &mut sql,
        AuthenticatedKey {
            api_key_id: 6539,
            api_key_name: None,
            lookup: UserLookup::ById(509),
        },
    )
    .await
    .expect_err("the fake returns no user");
    assert!(
        matches!(error, AuthError::UserNotFoundOrInactive),
        "{error:?}"
    );
    let calls = sql.calls();
    assert_eq!(calls.len(), 1, "{calls:?}");
    assert!(
        calls
            .iter()
            .all(|(_, sql, _)| sql.trim_start().starts_with("SELECT")),
        "the rejection wrote nothing: {calls:?}"
    );
    assert_eq!(
        deferred_auth_error(error).status(),
        brz_http_server::StatusCode::UNAUTHORIZED
    );
}

/// The deferred personal-key path issues the api_keys refresh and then the
/// `users` read on the same request handle, in the recorded order and with
/// the extractor's statement shapes: the key id inlined as a literal, the
/// user id bound exactly like the pooled reader binds it.
#[tokio::test]
async fn the_deferred_user_read_follows_the_api_keys_reload_on_one_handle() {
    let mut sql = RecordedRequestSql::default();
    let reloaded = reload_api_key_on(&mut sql, 6539).await.expect("refresh");
    assert!(reloaded.is_none(), "the fake returns no row");
    let _ = resolve_authenticated_key_on(
        &user_reader(),
        &mut sql,
        AuthenticatedKey {
            api_key_id: 6539,
            api_key_name: None,
            lookup: UserLookup::ById(509),
        },
    )
    .await
    .expect_err("the fake returns no user");
    let calls = sql.calls();
    assert_eq!(calls.len(), 2, "{calls:?}");
    assert_eq!(calls[0].0, crate::request_sql::RouteKey::None);
    assert!(
        calls[0].1.contains("FROM api_keys") && calls[0].1.contains("api_keys.id = 6539"),
        "unexpected refresh: {}",
        calls[0].1
    );
    assert_eq!(calls[0].2, 0, "the key id is inlined as a literal");
    assert_eq!(calls[1].0, crate::request_sql::RouteKey::None);
    assert_eq!(calls[1].1, crate::user_reader::USER_BY_ID_QUERY);
    assert_eq!(
        calls[1].2, 1,
        "the user id is bound, like the pooled reader binds it"
    );
}

/// A service key reads `users` by name and, on a miss, repeats the source's
/// follow-up lookup with the name inlined.
#[tokio::test]
async fn the_service_key_deferred_read_repeats_the_follow_up_lookup() {
    let mut sql = RecordedRequestSql::default();
    let _ = resolve_authenticated_key_on(
        &user_reader(),
        &mut sql,
        AuthenticatedKey {
            api_key_id: 6539,
            api_key_name: None,
            lookup: UserLookup::ByName("yingeng".to_string()),
        },
    )
    .await
    .expect_err("the fake returns no user");
    let calls = sql.calls();
    assert_eq!(calls.len(), 2, "{calls:?}");
    assert_eq!(calls[0].1, crate::user_reader::USER_BY_NAME_QUERY);
    assert_eq!(calls[0].2, 1);
    assert!(calls[1].1.contains("FROM users"));
    assert!(calls[1].1.contains("users.user_name = 'yingeng'"));
    assert_eq!(calls[1].2, 0, "the follow-up read inlines the name");
}
