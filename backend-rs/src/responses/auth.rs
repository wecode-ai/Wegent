// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `app.core.security.get_auth_context` — flexible authentication for the
//! responses API (personal API key, service key, or JWT Bearer token).
//!
//! Priority order (`get_api_key_from_header` then `get_auth_context`):
//! 1. API key via `X-API-Key` header (prefix `wg-`),
//! 2. API key via `Authorization: Bearer` header (prefix `wg-`),
//! 3. API key via `wegent-source` header (prefix `wg-`),
//! 4. user-session JWT via `Authorization: Bearer`,
//! 5. task token (JWT with `type=task_token`) as fallback.
//!
//! The recorded case authenticates with a personal API key: the source
//! selects the key by SHA-256 hash, updates `last_used_at` (UPDATE + COMMIT in
//! its helper session), reloads the expired row (SELECT by id), and resolves
//! the owner user through the configured `userReader`
//! (`user_reader::UserByIdReader`).
#[cfg(test)]
use jsonwebtoken::Algorithm;
use serde::Deserialize;

use super::auth_error::AuthError;
#[cfg(test)]
use crate::auth::SessionClaims;
use crate::config::AuthConfig;
use crate::headers::Headers as _;
use crate::user_reader::{UserByIdReader, UserRecord};

mod api_key;
pub(crate) use api_key::{
    ApiKeyReloadRow, AuthenticatedKey, UserLookup, authenticate_api_key, reload_api_key_on,
    reload_current_user, resolve_authenticated_key_on,
};
use api_key::{resolve_personal_user, resolve_service_user, split_key_with_username};

/// API key prefix (`app.core.auth_utils.API_KEY_PREFIX`).
const API_KEY_PREFIX: &str = "wg-";

/// The authenticated user of one request.
#[derive(Debug)]
pub struct CurrentUser {
    pub id: i32,
    #[allow(dead_code)]
    pub user_name: String,
    /// `AuthContext.api_key_name`: the authenticating `api_keys.name` for an
    /// API-key request (`app/core/security.py:get_auth_context`), `None` for a
    /// JWT/task-token request. `create_response` writes it into the Task CRD's
    /// `metadata.labels.api_key_name`.
    pub api_key_name: Option<String>,
    /// The authenticating `api_keys.id`, when the request used an API key.
    /// `POST /api/v1/responses` defers the post-commit api_keys refresh into
    /// its request transaction, so the handler needs the id to re-read it.
    pub api_key_id: Option<i64>,
    /// `users.git_info`: the identity the create path classifies into
    /// `metadata.user` and `metadata.git_auth_transport`
    /// (`build_execution_git_user_info` + `classify_git_auth_transport`).
    pub git_info: serde_json::Value,
    /// `users.preferences`: the request user's stored preferences document,
    /// read by `_build_skill_data`'s user-managed provider branch.
    pub preferences: String,
}

pub struct ResponsesUser {
    pub user: CurrentUser,
    pub rate_limit_key: Option<String>,
    /// See [`CurrentUser::api_key_id`].
    pub api_key_id: Option<i64>,
}

impl std::ops::Deref for ResponsesUser {
    type Target = CurrentUser;

    fn deref(&self) -> &Self::Target {
        &self.user
    }
}

/// `POST /api/v1/responses`'s principal.
///
/// An API-key request stops at [`AuthenticatedKey`]: the `users` row it needs
/// is read inside the request transaction the create path opens, so resolving
/// it here would issue the read on a pooled connection first. A JWT/task-token
/// request has no such deferred read and carries its resolved user.
pub(crate) enum DeferredResponsesUser {
    Resolved(ResponsesUser),
    Deferred {
        key: AuthenticatedKey,
        rate_limit_key: Option<String>,
    },
}

impl DeferredResponsesUser {
    /// The rate-limit key the extractor's header inspection produced; the
    /// create body needs it before it opens the request transaction.
    pub(crate) fn rate_limit_key(&self) -> Option<&str> {
        match self {
            Self::Resolved(user) => user.rate_limit_key.as_deref(),
            Self::Deferred { rate_limit_key, .. } => rate_limit_key.as_deref(),
        }
    }
}

const RESPONSE_API_KEY_REQUIRED: &str = "Wegent-Response-Api-Key-Required";
const RESPONSE_INVALID_API_KEY: &str = "Wegent-Response-Invalid-Api-Key";
const RESPONSE_API_KEY_EXPIRED: &str = "Wegent-Response-Api-Key-Expired";
const RESPONSE_USER_NOT_FOUND: &str = "Wegent-Response-User-Not-Found";
const RESPONSE_USERNAME_REQUIRED: &str = "Wegent-Response-Username-Required";
const RESPONSE_INVALID_USERNAME: &str = "Wegent-Response-Invalid-Username";
const RESPONSE_USER_INACTIVE: &str = "Wegent-Response-User-Inactive";
const RESPONSE_INVALID_AUTH: &str = "Wegent-Response-Invalid-Auth";
const RESPONSE_UNVERIFIABLE_AUTH: &str = "Wegent-Response-Unverifiable-Auth";

/// The `AuthError` -> HTTP rejection mapping, shared by every responses
/// principal so a deferred rejection renders exactly like the immediate one.
fn auth_failure(error: AuthError) -> brz_http_server::AuthFailure {
    match error {
        AuthError::ApiKeyRequired => {
            brz_http_server::AuthFailure::missing_credentials(RESPONSE_API_KEY_REQUIRED)
        }
        AuthError::InvalidApiKey => {
            brz_http_server::AuthFailure::invalid_credentials(RESPONSE_INVALID_API_KEY)
        }
        AuthError::ApiKeyExpired => {
            brz_http_server::AuthFailure::invalid_credentials(RESPONSE_API_KEY_EXPIRED)
        }
        AuthError::UserNotFoundOrInactive => {
            brz_http_server::AuthFailure::invalid_credentials(RESPONSE_USER_NOT_FOUND)
        }
        AuthError::UsernameRequired => {
            brz_http_server::AuthFailure::invalid_credentials(RESPONSE_USERNAME_REQUIRED)
        }
        AuthError::InvalidUsernameFormat => {
            brz_http_server::AuthFailure::invalid_credentials(RESPONSE_INVALID_USERNAME)
        }
        AuthError::UserInactive(_) => {
            brz_http_server::AuthFailure::invalid_credentials(RESPONSE_USER_INACTIVE)
        }
        AuthError::InvalidAuthenticationCredentials => {
            brz_http_server::AuthFailure::invalid_credentials(RESPONSE_INVALID_AUTH)
        }
        AuthError::CouldNotValidateCredentials => {
            brz_http_server::AuthFailure::invalid_credentials(RESPONSE_UNVERIFIABLE_AUTH)
        }
        AuthError::Dependency(_) => brz_http_server::AuthFailure::Internal,
    }
}

impl brz_http_server::Authenticator<ResponsesUser> for crate::auth::AppAuthenticator {
    async fn authenticate<'a>(
        &'a self,
        request: brz_http_server::AuthRequest<'a>,
    ) -> Result<ResponsesUser, brz_http_server::AuthFailure> {
        let value = |name| {
            request
                .header(name)
                .and_then(|v| std::str::from_utf8(v).ok())
        };
        let headers = crate::headers::OwnedHeaders::from_pairs([
            ("authorization", value("authorization")),
            ("x-api-key", value("x-api-key")),
            ("wegent-source", value("wegent-source")),
            ("wegent-username", value("wegent-username")),
        ]);
        let rate_limit_key = super::rate_limit::limit_key(&headers.view(), "");
        let rate_limit_key = rate_limit_key
            .starts_with("apikey:")
            .then_some(rate_limit_key);
        let defer_post_commit_refresh =
            request.method() == "POST" && request.path() == "/api/v1/responses";
        get_current_user_flexible(
            &self.state().auth,
            self.state().user_reader.as_ref(),
            &self.state().mysql,
            &headers.view(),
            defer_post_commit_refresh,
        )
        .await
        .map(|user| ResponsesUser {
            api_key_id: user.api_key_id,
            user,
            rate_limit_key,
        })
        .map_err(auth_failure)
    }

    fn api_log_id<'a>(&'a self, principal: &'a ResponsesUser) -> Option<&'a dyn std::fmt::Display> {
        Some(&principal.user.user_name)
    }

    fn reject(
        &self,
        request: brz_http_server::AuthRequest<'_>,
        failure: brz_http_server::AuthFailure,
        arena: &brz_http_server::EphemeralBytesArena,
    ) -> brz_http_server::Response {
        reject_auth_failure(request, failure, arena)
    }
}

impl brz_http_server::Authenticator<DeferredResponsesUser> for crate::auth::AppAuthenticator {
    async fn authenticate<'a>(
        &'a self,
        request: brz_http_server::AuthRequest<'a>,
    ) -> Result<DeferredResponsesUser, brz_http_server::AuthFailure> {
        let value = |name| {
            request
                .header(name)
                .and_then(|v| std::str::from_utf8(v).ok())
        };
        let headers = crate::headers::OwnedHeaders::from_pairs([
            ("authorization", value("authorization")),
            ("x-api-key", value("x-api-key")),
            ("wegent-source", value("wegent-source")),
            ("wegent-username", value("wegent-username")),
        ]);
        let rate_limit_key = super::rate_limit::limit_key(&headers.view(), "");
        let rate_limit_key = rate_limit_key
            .starts_with("apikey:")
            .then_some(rate_limit_key);
        let wegent_username = headers
            .view()
            .header("wegent-username")
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let Some(api_key) = api_key_from_headers(&headers.view()) else {
            let user = get_current_user_flexible(
                &self.state().auth,
                self.state().user_reader.as_ref(),
                &self.state().mysql,
                &headers.view(),
                false,
            )
            .await
            .map_err(auth_failure)?;
            return Ok(DeferredResponsesUser::Resolved(ResponsesUser {
                api_key_id: user.api_key_id,
                user,
                rate_limit_key,
            }));
        };
        // The create path owns the api_keys reload and the `users` read; both
        // belong to the transaction it starts after this extractor returns.
        let key = authenticate_api_key(&self.state().mysql, &api_key, wegent_username, true)
            .await
            .map_err(auth_failure)?;
        Ok(DeferredResponsesUser::Deferred {
            key,
            rate_limit_key,
        })
    }

    fn api_log_id<'a>(
        &'a self,
        principal: &'a DeferredResponsesUser,
    ) -> Option<&'a dyn std::fmt::Display> {
        match principal {
            DeferredResponsesUser::Resolved(user) => Some(&user.user.user_name),
            // The API-key branch leaves the user unresolved by design; the
            // create handler logs the id it authenticated.
            DeferredResponsesUser::Deferred { .. } => None,
        }
    }

    fn reject(
        &self,
        request: brz_http_server::AuthRequest<'_>,
        failure: brz_http_server::AuthFailure,
        arena: &brz_http_server::EphemeralBytesArena,
    ) -> brz_http_server::Response {
        reject_auth_failure(request, failure, arena)
    }
}

/// The rejection rendering shared by every responses principal: a deferred
/// rejection is byte-identical to the immediate one because both go through
/// this function with the same [`AuthFailure`].
fn reject_auth_failure(
    request: brz_http_server::AuthRequest<'_>,
    failure: brz_http_server::AuthFailure,
    arena: &brz_http_server::EphemeralBytesArena,
) -> brz_http_server::Response {
    use brz_http_server::IntoHttpError as _;
    auth_error_response(failure, response_username(request)).into_http_error(arena)
}

/// The handler-side rendering of a rejection that only the deferred `users`
/// read can produce.
///
/// The handler cannot call the extractor's `reject` (the request is gone), so
/// it returns this error and the framework renders it through the same
/// `IntoHttpError` conversion. The challenge still comes from [`auth_failure`],
/// and the username the `UserInactive` arm needs is the one the deferred read
/// rejected, which is the value the extractor would have recovered from the
/// request headers (`username_from_key`/`wegent-username`).
pub(crate) fn deferred_auth_error(error: AuthError) -> crate::http_compat::FastApiError {
    let username = match &error {
        AuthError::UserInactive(name) => Some(name.clone()),
        _ => None,
    };
    auth_error_response(auth_failure(error), username)
}

/// `AuthFailure` -> the source's FastAPI error, shared by the extractor's
/// rejection and the deferred one.
fn auth_error_response(
    failure: brz_http_server::AuthFailure,
    username: Option<String>,
) -> crate::http_compat::FastApiError {
    match failure {
        brz_http_server::AuthFailure::MissingCredentials {
            challenge: RESPONSE_API_KEY_REQUIRED,
        } => crate::http_compat::FastApiError::unauthorized("API key is required"),
        brz_http_server::AuthFailure::InvalidCredentials {
            challenge: RESPONSE_INVALID_API_KEY,
        } => crate::http_compat::FastApiError::unauthorized("Invalid API key"),
        brz_http_server::AuthFailure::InvalidCredentials {
            challenge: RESPONSE_API_KEY_EXPIRED,
        } => crate::http_compat::FastApiError::unauthorized("API key has expired"),
        brz_http_server::AuthFailure::InvalidCredentials {
            challenge: RESPONSE_USER_NOT_FOUND,
        } => crate::http_compat::FastApiError::unauthorized("User not found or inactive"),
        brz_http_server::AuthFailure::InvalidCredentials {
            challenge: RESPONSE_USERNAME_REQUIRED,
        } => crate::http_compat::FastApiError::detail(
            brz_http_server::StatusCode::BAD_REQUEST,
            "Username is required for service key authentication (use wegent-username header)",
        ),
        brz_http_server::AuthFailure::InvalidCredentials {
            challenge: RESPONSE_INVALID_USERNAME,
        } => crate::http_compat::FastApiError::detail(
            brz_http_server::StatusCode::BAD_REQUEST,
            "Username can only contain letters, numbers, underscores, and hyphens",
        ),
        brz_http_server::AuthFailure::InvalidCredentials {
            challenge: RESPONSE_USER_INACTIVE,
        } => crate::http_compat::FastApiError::unauthorized(format!(
            "User '{}' is inactive",
            username.unwrap_or_default()
        )),
        brz_http_server::AuthFailure::Internal | brz_http_server::AuthFailure::Unavailable => {
            crate::http_compat::FastApiError::detail(
                brz_http_server::StatusCode::INTERNAL_SERVER_ERROR,
                "Internal server error",
            )
        }
        brz_http_server::AuthFailure::InvalidCredentials {
            challenge: RESPONSE_UNVERIFIABLE_AUTH,
        } => crate::http_compat::FastApiError::unauthorized("Could not validate credentials"),
        _ => crate::http_compat::FastApiError::unauthorized("Invalid authentication credentials"),
    }
}

fn response_username(request: brz_http_server::AuthRequest<'_>) -> Option<String> {
    let value = |name| {
        request
            .header(name)
            .and_then(|value| std::str::from_utf8(value).ok())
    };
    let headers = crate::headers::OwnedHeaders::from_pairs([
        ("authorization", value("authorization")),
        ("x-api-key", value("x-api-key")),
        ("wegent-source", value("wegent-source")),
        ("wegent-username", value("wegent-username")),
    ]);
    let headers = headers.view();
    let username_from_key =
        api_key_from_headers(&headers).and_then(|key| split_key_with_username(&key).1);
    username_from_key.or_else(|| {
        headers
            .header("wegent-username")
            .map(str::trim)
            .filter(|username| !username.is_empty())
            .map(str::to_owned)
    })
}

/// The reader's user id narrowed to the auth id type (`users.id` is INT).
fn auth_id(user: &UserRecord) -> i32 {
    i32::try_from(user.id).unwrap_or(i32::MAX)
}

/// Task-token JWT claims (`app.services.auth.task_token.verify_task_token`).
#[derive(Debug, Deserialize)]
struct TaskTokenClaims {
    #[serde(rename = "type")]
    token_type: Option<String>,
    user_id: Option<i64>,
}

/// `is_api_key`: a token is an API key when it starts with `wg-`.
fn is_api_key(token: &str) -> bool {
    token.starts_with(API_KEY_PREFIX)
}

/// `get_api_key_from_header`: X-API-Key > Authorization Bearer >
/// wegent-source, each only when `wg-` prefixed.
fn api_key_from_headers(headers: &impl crate::headers::Headers) -> Option<String> {
    let header_str = |name: &str| {
        headers
            .header(name)
            .map(str::trim)
            .filter(|value| !value.is_empty())
    };
    if let Some(key) = header_str("x-api-key").filter(|key| key.starts_with(API_KEY_PREFIX)) {
        return Some(key.to_string());
    }
    if let Some(authorization) = header_str("authorization") {
        // Case-insensitive, whitespace-tolerant Bearer parsing (RFC 7235).
        let mut parts = authorization.splitn(2, char::is_whitespace);
        let scheme = parts.next().unwrap_or("");
        if scheme.eq_ignore_ascii_case("bearer")
            && let Some(token) = parts.next().map(str::trim)
            && token.starts_with(API_KEY_PREFIX)
        {
            return Some(token.to_string());
        }
    }
    if let Some(key) = header_str("wegent-source").filter(|key| key.starts_with(API_KEY_PREFIX)) {
        return Some(key.to_string());
    }
    None
}

/// The raw bearer credential from the Authorization header (any scheme).
fn bearer_token(headers: &impl crate::headers::Headers) -> Option<String> {
    let value = headers.header("authorization")?;
    let (scheme, token) = match value.split_once(' ') {
        Some((scheme, token)) => (scheme, token.trim()),
        None => return None,
    };
    if !scheme.eq_ignore_ascii_case("bearer") || token.is_empty() {
        return None;
    }
    Some(token.to_string())
}

/// Decode keys derived from the active key and legacy decode-only keys.
fn decoding_keys(config: &AuthConfig) -> Vec<Vec<u8>> {
    let mut keys = vec![config.jwt_key.as_bytes().to_vec()];
    for key in &config.legacy_jwt_keys {
        if !keys.iter().any(|existing| existing == key.as_bytes()) {
            keys.push(key.as_bytes().to_vec());
        }
    }
    keys
}

/// Task-token decoding with the configured HMAC algorithm.
fn decode_with_keys<T: for<'de> Deserialize<'de>>(config: &AuthConfig, token: &str) -> Option<T> {
    crate::jwt_compat::decode_task(
        token,
        decoding_keys(config),
        crate::auth::algorithm(config)?,
    )
}

/// A reader infrastructure failure mapped to the source dependency error.
pub(super) fn reader_failure(error: anyhow::Error) -> AuthError {
    AuthError::dependency(brz_mysql::MysqlError::InvalidQuery {
        reason: error.to_string(),
    })
}

/// `userReader.get_by_id` through the deployment-configured reader
/// (`user_reader::UserByIdReader`); the public default performs a direct
/// SQL lookup while an internal deployment supplies the cached reader.
/// A reader infrastructure failure maps to the source dependency error.
pub(crate) async fn cached_user_by_id(
    user_reader: &dyn UserByIdReader,
    user_id: i64,
) -> Result<Option<UserRecord>, AuthError> {
    user_reader.get_by_id(user_id).await.map_err(reader_failure)
}

/// `userReader.get_by_name` through the deployment-configured reader.
async fn cached_user_by_name(
    user_reader: &dyn UserByIdReader,
    user_name: &str,
) -> Result<Option<UserRecord>, AuthError> {
    user_reader
        .get_by_name(user_name)
        .await
        .map_err(reader_failure)
}

/// `verify_jwt_token_with_db`: decode a user-session JWT and load the user.
async fn verify_jwt_token_with_db(
    config: &AuthConfig,
    user_reader: &dyn UserByIdReader,
    token: &str,
) -> Result<Option<UserRecord>, AuthError> {
    let Some(claims) = crate::auth::decode_session_claims(config, token) else {
        return Ok(None);
    };
    let Some(user_name) = claims.username() else {
        return Ok(None);
    };
    let user = cached_user_by_name(user_reader, &user_name).await?;
    Ok(user.filter(|user| user.is_active))
}

/// `verify_task_token` fallback: `type=task_token` JWT resolving a user id.
async fn verify_task_token_user(
    config: &AuthConfig,
    user_reader: &dyn UserByIdReader,
    token: &str,
) -> Result<Option<UserRecord>, AuthError> {
    let Some(claims) = decode_with_keys::<TaskTokenClaims>(config, token) else {
        return Ok(None);
    };
    if claims.token_type.as_deref() != Some("task_token") {
        return Ok(None);
    }
    let Some(user_id) = claims.user_id else {
        return Ok(None);
    };
    let user = cached_user_by_id(user_reader, user_id).await?;
    Ok(user.filter(|user| user.is_active))
}

// `get_auth_context` with the source priority order.

/// The no-API-key fallback: a user-session JWT, then a `type=task_token` JWT.
///
/// Ordering is contractual and pinned by `jwt_fallback_ordering_is_pinned`: a
/// valid session token wins over a task token, both attempts are skipped for an
/// API-key request, and a bearer value that is not a decodable JWT (or is an
/// API key itself) reaches neither verifier's database read.
async fn jwt_fallback(
    config: &AuthConfig,
    user_reader: &dyn UserByIdReader,
    headers: &impl crate::headers::Headers,
) -> Result<Option<CurrentUser>, AuthError> {
    let Some(token) = bearer_token(headers).filter(|token| !is_api_key(token)) else {
        return Ok(None);
    };
    if let Some(user) = verify_jwt_token_with_db(config, user_reader, &token).await? {
        return Ok(Some(session_user(user)));
    }
    if let Some(user) = verify_task_token_user(config, user_reader, &token).await? {
        return Ok(Some(session_user(user)));
    }
    Ok(None)
}

/// The `CurrentUser` a JWT/task-token request yields: no API key identity.
fn session_user(user: UserRecord) -> CurrentUser {
    CurrentUser {
        id: auth_id(&user),
        user_name: user.user_name,
        api_key_name: None,
        api_key_id: None,
        git_info: user.git_info,
        preferences: user.preferences,
    }
}

pub async fn get_current_user_flexible(
    config: &AuthConfig,
    user_reader: &dyn UserByIdReader,
    mysql: &brz_mysql::MysqlService,
    headers: &impl crate::headers::Headers,
    defer_post_commit_refresh: bool,
) -> Result<CurrentUser, AuthError> {
    let wegent_username = headers
        .header("wegent-username")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    let api_key = api_key_from_headers(headers);

    // Fallback: JWT Bearer token when no API key is present.
    let Some(api_key) = api_key else {
        return jwt_fallback(config, user_reader, headers)
            .await?
            .ok_or(AuthError::ApiKeyRequired);
    };

    let key =
        authenticate_api_key(mysql, &api_key, wegent_username, defer_post_commit_refresh).await?;
    let (id, user_name, git_info, preferences) = match key.lookup {
        UserLookup::ById(user_id) => resolve_personal_user(user_reader, user_id).await?,
        UserLookup::ByName(user_name) => {
            resolve_service_user(user_reader, mysql, &user_name).await?
        }
    };
    Ok(CurrentUser {
        id,
        user_name,
        api_key_name: key.api_key_name,
        api_key_id: Some(key.api_key_id),
        git_info,
        preferences,
    })
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod jwt_fallback_tests;

#[cfg(test)]
mod task_jwt_compatibility {
    #[test]
    fn task_fallback_validates_pyjwt_claims() {
        let config = crate::config::AuthConfig {
            jwt_key: "test-key".to_string(),
            legacy_jwt_keys: Vec::new(),
            algorithm: "HS256".to_string(),
        };
        let now = jsonwebtoken::get_current_timestamp();
        for (delta, expected) in [
            (serde_json::json!({}), true),
            (serde_json::json!({"exp":(now+600).to_string()}), true),
            (serde_json::json!({"exp":now-30}), false),
            (serde_json::json!({"nbf":now+300}), false),
            (serde_json::json!({"iat":now+300}), false),
            (serde_json::json!({"aud":"other-service"}), false),
            (serde_json::json!({"jti":123}), false),
        ] {
            let mut claims = serde_json::json!({"type":"task_token","user_id":1,
                "user_name":"u","task_id":1,"subtask_id":1});
            claims
                .as_object_mut()
                .unwrap()
                .extend(delta.as_object().unwrap().clone());
            let token = crate::jwt_compat::tests::sign(&claims, b"test-key");
            assert_eq!(
                super::decode_with_keys::<serde_json::Value>(&config, &token).is_some(),
                expected,
                "{delta}"
            );
        }
    }
}
