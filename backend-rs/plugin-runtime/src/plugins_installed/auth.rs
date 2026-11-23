// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! User authentication for the plugins-installed API.
//!
//! Source: the FastAPI `OAuth2PasswordBearer` dependency in
//! `app/core/security.py` plus `get_current_user`, `app/core/jwt_compat.py`
//! and `app/core/session_token.py`. The scheme rejects a request that carries
//! no bearer credential with `401 {"detail":"Not authenticated"}` before any
//! verification runs. A present `Authorization: Bearer <jwt>` is verified with
//! the active signing key (then configured legacy decode-only keys), must be
//! an interactive user session payload, and must resolve to an active user
//! row; those checks report `401 "Could not validate credentials"` and
//! `401 "User not activated"`.
//!
//! `_get_plugin_sync_user` extends that dependency for
//! `POST /installed/sync-device`: a `wg-`-prefixed personal device key is
//! accepted only when `reconcile=true`, and is then verified as
//! `verify_api_key(..., update_last_used_at=False)` (`api_keys` lookup plus its
//! active owner) before the endpoint runs.
use std::sync::Arc;

use crate::auth::SessionClaims;
use brz_mysql::{FromMysqlRow, Mysql, MysqlResult};
use jsonwebtoken::Algorithm;
use sha2::{Digest, Sha256};

use crate::user_reader::{USER_BY_ID_QUERY, USER_BY_NAME_QUERY, UserRecord};
use wegent_backend_persistence::mysql_query::MysqlQuery;

/// Source `OAuth2PasswordBearer.make_not_authenticated_error`.
const NOT_AUTHENTICATED_DETAIL: &str = "Not authenticated";
/// Source `security.py` `verify_token` / `get_current_user` failure detail.
pub(crate) const UNAUTHORIZED_DETAIL: &str = "Could not validate credentials";
/// Source `security.py` `get_current_user` inactive-user detail.
pub(crate) const USER_NOT_ACTIVATED_DETAIL: &str = "User not activated";
/// Source `_get_plugin_sync_user` device-key failure detail.
pub(crate) const INVALID_API_KEY_DETAIL: &str = "Invalid or expired API key";

/// `API_KEY_PREFIX` (`app/core/auth_utils.py`).
const API_KEY_PREFIX: &str = "wg-";
/// `KEY_TYPE_PERSONAL` (`app/models/api_key.py`).
const KEY_TYPE_PERSONAL: &str = "personal";
/// `api_keys` columns of SQLAlchemy's `db.query(APIKey)` projection.
const API_KEY_COLUMNS: &str = "api_keys.id AS api_keys_id, \
     api_keys.user_id AS api_keys_user_id, api_keys.key_hash AS api_keys_key_hash, \
     api_keys.key_prefix AS api_keys_key_prefix, api_keys.name AS api_keys_name, \
     api_keys.key_type AS api_keys_key_type, api_keys.description AS api_keys_description, \
     api_keys.expires_at AS api_keys_expires_at, api_keys.last_used_at AS api_keys_last_used_at, \
     api_keys.is_active AS api_keys_is_active, api_keys.created_at AS api_keys_created_at, \
     api_keys.updated_at AS api_keys_updated_at";

/// One `users` row needed for authentication (`shared/models/db/user.py`).
///
/// `user_name` and `role` are decoded because the source row model selects
/// them; only `id` and `is_active` drive this endpoint's behavior, but the
/// columns stay in the projection so the row remains source-compatible for
/// sibling endpoints that will reuse this lookup.
#[derive(Debug, FromMysqlRow)]
pub struct UserRow {
    pub id: i64,
    #[allow(dead_code)]
    pub user_name: String,
    pub is_active: bool,
    #[allow(dead_code)]
    pub role: String,
}

pub struct InstalledPluginsUser(pub UserRow);

/// `AuthFailure` carries only a challenge string, so the two distinct
/// `InvalidCredentials` outcomes and the `MissingCredentials` outcome are
/// tagged here and recovered by the authenticator's `reject` implementation.
const NOT_AUTHENTICATED: &str = "Wegent-Plugins-Installed-Not-Authenticated";
const USER_NOT_ACTIVATED: &str = "Wegent-Plugins-Installed-User-Not-Activated";

impl std::ops::Deref for InstalledPluginsUser {
    type Target = UserRow;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl brz_http_server::Authenticator<InstalledPluginsUser> for crate::auth::AppAuthenticator {
    async fn authenticate<'a>(
        &'a self,
        request: brz_http_server::AuthRequest<'a>,
    ) -> Result<InstalledPluginsUser, brz_http_server::AuthFailure> {
        let authorization = request
            .header("authorization")
            .and_then(|v| std::str::from_utf8(v).ok());
        let headers = crate::headers::OwnedHeaders::from_pairs([("authorization", authorization)]);
        authenticate(
            &self.state().mysql,
            &headers.view(),
            &self.state().jwt_secret_keys,
            &self.state().jwt_algorithm,
        )
        .await
        .map(InstalledPluginsUser)
        .map_err(|error| match error {
            AuthError::NotAuthenticated => {
                brz_http_server::AuthFailure::missing_credentials(NOT_AUTHENTICATED)
            }
            AuthError::InvalidCredentials => {
                brz_http_server::AuthFailure::invalid_credentials("Bearer")
            }
            AuthError::UserNotActivated => {
                brz_http_server::AuthFailure::invalid_credentials(USER_NOT_ACTIVATED)
            }
            AuthError::Dependency => brz_http_server::AuthFailure::Internal,
        })
    }

    fn api_log_id<'a>(
        &'a self,
        principal: &'a InstalledPluginsUser,
    ) -> Option<&'a dyn std::fmt::Display> {
        Some(&principal.0.user_name)
    }

    fn reject(
        &self,
        _request: brz_http_server::AuthRequest<'_>,
        failure: brz_http_server::AuthFailure,
        arena: &brz_http_server::EphemeralBytesArena,
    ) -> brz_http_server::Response {
        use brz_http_server::IntoHttpError as _;
        match failure {
            brz_http_server::AuthFailure::MissingCredentials {
                challenge: NOT_AUTHENTICATED,
            } => crate::http_compat::FastApiError::unauthorized(NOT_AUTHENTICATED_DETAIL),
            brz_http_server::AuthFailure::InvalidCredentials {
                challenge: USER_NOT_ACTIVATED,
            } => crate::http_compat::FastApiError::unauthorized(USER_NOT_ACTIVATED_DETAIL),
            brz_http_server::AuthFailure::Internal | brz_http_server::AuthFailure::Unavailable => {
                crate::http_compat::FastApiError::internal()
            }
            _ => crate::http_compat::FastApiError::unauthorized(UNAUTHORIZED_DETAIL),
        }
        .into_http_error(arena)
    }
}

/// The verified identity for `POST /installed/sync-device`.
///
/// Source `_get_plugin_sync_user`: a personal device API key authenticates only
/// the plugin-only reconciliation branch (`reconcile=true`), where
/// `verify_api_key` reads the key and its active owner; every other request
/// takes `get_current_user`'s JWT path. The JWT branch verifies the bearer
/// token only and leaves the `users` read to the handler's request session.
///
/// Both branches leave every SQL read to the handler, because the source's
/// `get_db` dependency cache hands the endpoint and this dependency the same
/// request session: the `api_keys`/`users` reads and the handler's device reads
/// share one READ COMMITTED transaction on one connection. Carrying the device
/// key here lets the handler open that single transaction.
pub struct SyncDeviceUser {
    pub user_name: String,
    /// The still-unverified personal device key when `reconcile=true`; the
    /// handler resolves it inside the request-session transaction.
    pub api_key: Option<String>,
}

/// `AuthFailure` challenge for `_get_plugin_sync_user`'s device-key rejection.
const INVALID_API_KEY: &str = "Wegent-Plugins-Sync-Invalid-Api-Key";

impl brz_http_server::Authenticator<SyncDeviceUser> for crate::auth::AppAuthenticator {
    async fn authenticate<'a>(
        &'a self,
        request: brz_http_server::AuthRequest<'a>,
    ) -> Result<SyncDeviceUser, brz_http_server::AuthFailure> {
        let authorization = request
            .header("authorization")
            .and_then(|v| std::str::from_utf8(v).ok());
        let headers = crate::headers::OwnedHeaders::from_pairs([("authorization", authorization)]);
        // `_get_plugin_sync_user` binds `reconcile` from the same query string
        // the endpoint declares, so the dependency sees the flag before the
        // handler runs.
        let reconcile = query_bool(request.query(), "reconcile");
        if reconcile
            && let Some(token) = bearer_token(&headers.view())
            && token.starts_with(API_KEY_PREFIX)
        {
            // `verify_api_key(db, token, ...)` runs on the request session the
            // endpoint also receives; the handler resolves this key inside that
            // single READ COMMITTED transaction.
            return Ok(SyncDeviceUser {
                user_name: String::new(),
                api_key: Some(token.to_string()),
            });
        }
        verified_user_name(
            &headers.view(),
            &self.state().jwt_secret_keys,
            &self.state().jwt_algorithm,
        )
        .map(|user_name| SyncDeviceUser {
            user_name,
            api_key: None,
        })
        .map_err(|error| match error {
            AuthError::NotAuthenticated => {
                brz_http_server::AuthFailure::missing_credentials(NOT_AUTHENTICATED)
            }
            AuthError::UserNotActivated | AuthError::InvalidCredentials => {
                brz_http_server::AuthFailure::invalid_credentials("Bearer")
            }
            AuthError::Dependency => brz_http_server::AuthFailure::Internal,
        })
    }

    fn api_log_id<'a>(
        &'a self,
        principal: &'a SyncDeviceUser,
    ) -> Option<&'a dyn std::fmt::Display> {
        // A device key has no user name until the handler resolves its owner
        // inside the request-session transaction.
        (!principal.user_name.is_empty()).then_some(&principal.user_name as &dyn std::fmt::Display)
    }

    fn reject(
        &self,
        _request: brz_http_server::AuthRequest<'_>,
        failure: brz_http_server::AuthFailure,
        arena: &brz_http_server::EphemeralBytesArena,
    ) -> brz_http_server::Response {
        use brz_http_server::IntoHttpError as _;
        match failure {
            brz_http_server::AuthFailure::MissingCredentials {
                challenge: NOT_AUTHENTICATED,
            } => crate::http_compat::FastApiError::unauthorized(NOT_AUTHENTICATED_DETAIL),
            brz_http_server::AuthFailure::InvalidCredentials {
                challenge: INVALID_API_KEY,
            } => crate::http_compat::FastApiError::unauthorized(INVALID_API_KEY_DETAIL),
            brz_http_server::AuthFailure::Internal | brz_http_server::AuthFailure::Unavailable => {
                crate::http_compat::FastApiError::internal()
            }
            _ => crate::http_compat::FastApiError::unauthorized(UNAUTHORIZED_DETAIL),
        }
        .into_http_error(arena)
    }
}

/// FastAPI's scalar query binding for `reconcile: bool = False`: the first
/// occurrence wins and only the documented truthy spellings are true.
fn query_bool(query: Option<&str>, name: &str) -> bool {
    let Some(query) = query else {
        return false;
    };
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        if key != name {
            continue;
        }
        return matches!(
            value.to_ascii_lowercase().as_str(),
            "1" | "on" | "t" | "true" | "y" | "yes"
        );
    }
    false
}

/// `find_valid_api_key(key_type='personal')` and the owner read
/// (`app/core/auth_utils.py::verify_api_key` with `update_last_used_at=False`).
///
/// The hash, key type and active flag are rendered as literals exactly like the
/// source's client-side parameter substitution.
pub(crate) async fn verify_personal_api_key_on<Q>(
    query: &mut Q,
    api_key: &str,
) -> MysqlResult<Option<UserRecord>>
where
    Q: MysqlQuery,
{
    let key_hash = format!("{:x}", Sha256::digest(api_key.as_bytes()));
    let statement = format!(
        "SELECT {API_KEY_COLUMNS} \nFROM api_keys \n\
         WHERE api_keys.key_hash = '{key_hash}' \
         AND api_keys.key_type = '{KEY_TYPE_PERSONAL}' \
         AND api_keys.is_active = true \n LIMIT 1"
    );
    let Some(record) = query
        .fetch_optional::<_, _, brz_mysql::MysqlRow>(statement, ())
        .await?
    else {
        return Ok(None);
    };
    let user_id: i64 = record.get_required("api_keys_user_id")?;
    let expires_at: Option<chrono::NaiveDateTime> =
        record.get::<chrono::NaiveDateTime>("api_keys_expires_at")?;
    // `api_key_record.expires_at < datetime.utcnow()`.
    if expires_at.is_some_and(|expires_at| expires_at < chrono::Utc::now().naive_utc()) {
        return Ok(None);
    }
    let Some(owner) = query
        .fetch_optional::<_, _, brz_mysql::MysqlRow>(USER_BY_ID_QUERY, (user_id,))
        .await?
    else {
        return Ok(None);
    };
    let user = UserRecord::from_mysql_row(&owner)?;
    Ok(user.is_active.then_some(user))
}

/// `db.query(User).filter(User.user_name == user_name).first()` on the caller's
/// session handle (`get_current_user`'s user read).
pub async fn find_user_row_by_name_on<Q>(
    query: &mut Q,
    user_name: &str,
) -> MysqlResult<Option<UserRecord>>
where
    Q: MysqlQuery,
{
    let row: Option<brz_mysql::MysqlRow> = query
        .fetch_optional(USER_BY_NAME_QUERY, (user_name,))
        .await?;
    row.map(|row| UserRecord::from_mysql_row(&row)).transpose()
}

pub async fn find_user_by_name<M>(mysql: &M, user_name: &str) -> MysqlResult<Option<UserRow>>
where
    M: Mysql,
{
    let mut query = mysql;
    find_user_by_name_on(&mut query, user_name).await
}

/// `find_user_by_name` on a borrowed session handle.
pub async fn find_user_by_name_on<Q>(query: &mut Q, user_name: &str) -> MysqlResult<Option<UserRow>>
where
    Q: MysqlQuery,
{
    query
        .fetch_optional(
            "SELECT id, user_name, is_active, `role` FROM users WHERE user_name = ? LIMIT 1",
            (user_name,),
        )
        .await
}

/// Verify a bearer token against the active key, then legacy decode keys.
///
/// Mirrors `decode_jose_jwt`, which tries each configured key in order and
/// maps any failure to one 401 response.
pub fn verify_token(token: &str, keys: &[Arc<str>], algorithm: &str) -> Option<String> {
    let algorithm = match algorithm {
        "HS256" => Algorithm::HS256,
        "HS384" => Algorithm::HS384,
        "HS512" => Algorithm::HS512,
        _ => return None,
    };
    crate::jwt_compat::decode_jose::<SessionClaims>(
        token,
        keys.iter().map(|key| key.as_bytes()),
        algorithm,
    )?
    .username()
}

/// Extract the bearer credential like the source `OAuth2PasswordBearer`
/// dependency, whose `get_authorization_scheme_param` splits the header on the
/// first space and defaults both halves to the empty string.
///
/// `None` means the request supplied no bearer credential at all: no
/// `Authorization` header, an empty header, or a scheme other than `Bearer`.
/// FastAPI rejects that before `get_current_user` runs, so it must stay
/// distinct from a credential that verification rejects. A `Bearer` header with
/// an empty credential still reaches verification and reports the
/// invalid-credential detail.
fn bearer_token(headers: &impl crate::headers::Headers) -> Option<&str> {
    let value = headers.header("authorization")?;
    let (scheme, token) = value.split_once(' ').unwrap_or((value, ""));
    scheme.eq_ignore_ascii_case("bearer").then_some(token)
}

/// The source authentication chain's distinct failure outcomes.
///
/// The response detail depends on which check failed, so the target keeps them
/// apart instead of collapsing them into one 401.
#[derive(Debug)]
pub enum AuthError {
    /// `401 "Not authenticated"`: no bearer credential was supplied.
    NotAuthenticated,
    /// `401 "Could not validate credentials"`: verification failed, the token
    /// carried no usable `sub`, or no user row matched.
    InvalidCredentials,
    /// `401 "User not activated"`: the resolved row is inactive.
    UserNotActivated,
    /// The user lookup failed; the source maps unexpected failures to its 500
    /// handler outside this endpoint's control.
    Dependency,
}

/// `get_current_user`'s verification chain up to the `users` read:
/// `OAuth2PasswordBearer` credential extraction, `verify_token`, and the
/// interactive-session payload check.
pub fn verified_user_name(
    headers: &impl crate::headers::Headers,
    keys: &[Arc<str>],
    algorithm: &str,
) -> Result<String, AuthError> {
    let Some(token) = bearer_token(headers) else {
        return Err(AuthError::NotAuthenticated);
    };
    verify_token(token, keys, algorithm).ok_or(AuthError::InvalidCredentials)
}

/// Authenticate the request with the exact failure classification of the
/// source scheme plus `get_current_user`.
pub async fn authenticate<M>(
    mysql: &M,
    headers: &impl crate::headers::Headers,
    keys: &[Arc<str>],
    algorithm: &str,
) -> Result<UserRow, AuthError>
where
    M: Mysql,
{
    let username = verified_user_name(headers, keys, algorithm)?;
    match find_user_by_name(mysql, &username).await {
        Ok(Some(user)) if user.is_active => Ok(user),
        Ok(Some(_)) => Err(AuthError::UserNotActivated),
        Ok(None) => Err(AuthError::InvalidCredentials),
        Err(error) => {
            tracing::error!(%error, %username, "authentication user lookup failed");
            Err(AuthError::Dependency)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use hmac::{Hmac, Mac};
    use sha2::Sha256;

    fn make_token(key: &str, claims: &str) -> String {
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"HS256","typ":"JWT"}"#);
        let payload = URL_SAFE_NO_PAD.encode(claims.as_bytes());
        let mut mac =
            <Hmac<Sha256> as sha2::digest::KeyInit>::new_from_slice(key.as_bytes()).unwrap();
        mac.update(format!("{header}.{payload}").as_bytes());
        let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
        format!("{header}.{payload}.{signature}")
    }

    fn headers_with(value: &'static str) -> crate::headers::HeaderSlice<'static> {
        let slice: &'static [(&'static str, &'static str); 1] =
            Box::leak(Box::new([("authorization", value)]));
        crate::headers::HeaderSlice::new(slice)
    }

    fn test_keys() -> Vec<Arc<str>> {
        vec![Arc::from("secret"), Arc::from("legacy")]
    }

    #[test]
    fn bearer_extraction_matches_source() {
        assert_eq!(
            bearer_token(&headers_with("Bearer abc")).map(str::to_string),
            Some("abc".to_string())
        );
        assert_eq!(
            bearer_token(&headers_with("bearer abc")).map(str::to_string),
            Some("abc".to_string())
        );
        // A non-bearer scheme, a bare scheme, and an empty credential all keep
        // the source split: only the scheme selects the authentication branch.
        assert_eq!(bearer_token(&headers_with("abc")), None);
        assert_eq!(bearer_token(&headers_with("Basic abc")), None);
        assert_eq!(
            bearer_token(&headers_with("Bearer ")).map(str::to_string),
            Some(String::new())
        );
        assert_eq!(
            bearer_token(&headers_with("Bearer")).map(str::to_string),
            Some(String::new())
        );
        assert_eq!(bearer_token(&headers_with("")), None);
        assert_eq!(bearer_token(&crate::headers::HeaderSlice::new(&[])), None);
    }

    /// The representative recorded case sends no `Authorization` header. The
    /// source FastAPI dependency rejects it with `401 "Not authenticated"`
    /// before `get_current_user` runs, so the target must not report the
    /// invalid-credential detail for it.
    #[tokio::test]
    async fn missing_bearer_credential_is_not_authenticated() {
        let keys = test_keys();
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        let no_header = crate::headers::HeaderSlice::new(&[]);
        for (headers, header) in [
            (no_header, "no header"),
            (headers_with("Basic abc"), "non-bearer scheme"),
            (headers_with(""), "empty header"),
        ] {
            let error = authenticate(&mysql, &headers, &keys, "HS256")
                .await
                .err()
                .unwrap_or_else(|| panic!("{header} must be rejected"));
            assert!(
                matches!(error, AuthError::NotAuthenticated),
                "{header} reports the wrong failure"
            );
        }
        assert!(
            mysql.queries().is_empty(),
            "the scheme rejects before the user lookup"
        );
    }

    /// A `Bearer` header with an empty credential reaches verification, which
    /// the source reports as `401 "Could not validate credentials"`.
    #[tokio::test]
    async fn empty_bearer_credential_is_invalid_credentials() {
        let keys = test_keys();
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        for value in ["Bearer ", "Bearer"] {
            let error = authenticate(&mysql, &headers_with(value), &keys, "HS256")
                .await
                .err()
                .unwrap_or_else(|| panic!("{value:?} must be rejected"));
            assert!(
                matches!(error, AuthError::InvalidCredentials),
                "{value:?} reports the wrong failure"
            );
        }
    }

    #[test]
    fn verifies_session_token_and_rejects_other_uses() {
        let keys = test_keys();
        let ok = make_token("secret", r#"{"sub":"matao"}"#);
        assert_eq!(verify_token(&ok, &keys, "HS256").as_deref(), Some("matao"));

        let legacy = make_token("legacy", r#"{"sub":"matao"}"#);
        assert_eq!(
            verify_token(&legacy, &keys, "HS256").as_deref(),
            Some("matao")
        );

        let bad_signature = make_token("other", r#"{"sub":"matao"}"#);
        assert_eq!(verify_token(&bad_signature, &keys, "HS256"), None);

        let wework = make_token("secret", r#"{"sub":"matao","token_use":"wework_access"}"#);
        assert_eq!(
            verify_token(&wework, &keys, "HS256").as_deref(),
            Some("matao")
        );

        let refresh = make_token("secret", r#"{"sub":"matao","token_use":"wework_refresh"}"#);
        assert_eq!(verify_token(&refresh, &keys, "HS256"), None);

        let scoped = make_token("secret", r#"{"sub":"matao","scope":"read"}"#);
        assert_eq!(verify_token(&scoped, &keys, "HS256"), None);
    }

    #[test]
    fn rejects_unsupported_algorithm() {
        let keys = test_keys();
        let token = make_token("secret", r#"{"sub":"matao"}"#);
        assert_eq!(verify_token(&token, &keys, "RS256"), None);
    }

    #[test]
    fn reconcile_flag_matches_fastapi_bool_binding() {
        assert!(query_bool(Some("device_id=d1&reconcile=true"), "reconcile"));
        assert!(query_bool(Some("reconcile=1"), "reconcile"));
        assert!(query_bool(Some("reconcile=YES"), "reconcile"));
        assert!(!query_bool(Some("reconcile=false"), "reconcile"));
        assert!(!query_bool(Some("device_id=d1"), "reconcile"));
        assert!(!query_bool(Some("reconcile=maybe"), "reconcile"));
        assert!(!query_bool(None, "reconcile"));
    }

    /// `_get_plugin_sync_user`'s device-key branch reads
    /// `find_valid_api_key(key_type='personal')` with the source's rendered
    /// literals; a missing key stops before the owner read. The handler runs
    /// this on the request-session transaction, so the shared query handle is
    /// what the test drives.
    #[tokio::test]
    async fn device_key_lookup_uses_the_source_statement() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        let mut session = &mysql;
        assert!(
            verify_personal_api_key_on(&mut session, "wg-device-key")
                .await
                .unwrap()
                .is_none()
        );
        let queries = mysql.queries();
        assert_eq!(queries.len(), 1, "a missing key has no owner read");
        let hash = format!("{:x}", Sha256::digest(b"wg-device-key"));
        assert!(queries[0].sql.contains("api_keys.id AS api_keys_id"));
        assert!(
            queries[0]
                .sql
                .contains(&format!("api_keys.key_hash = '{hash}'"))
        );
        assert!(queries[0].sql.contains("api_keys.key_type = 'personal'"));
        assert!(queries[0].sql.contains("api_keys.is_active = true"));
    }
}

#[cfg(test)]
mod python_compatibility {
    #[test]
    fn session_entry_point_matches_python() {
        for (name, claims, expected) in crate::jwt_compat::tests::session_cases() {
            let token = crate::jwt_compat::tests::sign(&claims, b"test-key");
            assert_eq!(
                super::verify_token(&token, &[std::sync::Arc::from("test-key")], "HS256").is_some(),
                expected,
                "{name}"
            );
        }
    }
}
