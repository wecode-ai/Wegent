// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/external/mcp-identity/userinfo` — resolve the Wegent user behind
//! an MCP caller's Wegent task token.
//!
//! Mirrors `app/api/endpoints/mcp_identity.py:read_mcp_identity_userinfo`. The
//! source route carries no security dependency: it reads
//! `Authorization: Bearer <task_token>` as a plain `Header` and builds its own
//! `401`/`404` responses, so the slowapi rate limiter decorates the endpoint
//! body and runs before the token check on every request.
//!
//! Source pipeline:
//! 1. `@limiter.limit(settings.RATE_LIMIT_MCP_IDENTITY)` — the slowapi
//!    fixed-window Redis limiter (`app.core.rate_limit`, default `60/minute`)
//!    on the key
//!    `LIMITS:LIMITER/<key>/<path>/<amount>/<multiples>/<granularity>`, where
//!    `<key>` is `apikey:<wg-key>` when a Wegent API-key header is present and
//!    `ip:<client>` otherwise;
//! 2. `extract_token_from_header` then `verify_task_token`
//!    (`app/services/auth/task_token.py`): the bearer credential must be a
//!    `type=task_token` JWT whose signature and any present `exp`/`nbf` validate
//!    against the active `SECRET_KEY`/`ALGORITHM` and then the legacy
//!    decode-only keys, and it must carry `task_id`, `subtask_id`, `user_id`,
//!    and `user_name`; any failure yields
//!    `401 {"detail": "Invalid Wegent task token"}` with
//!    `WWW-Authenticate: Bearer`;
//! 3. `db.query(User).filter(User.id == user_id, User.is_active.is_(True))
//!    .first()`; no active row yields `404 {"detail": "User not found"}`;
//! 4. the `{"id", "user_name", "email"}` body.

use brz_http_server::{EphemeralBytesArena, IntoHttpError, Response, StatusCode};
use brz_mysql::Mysql;
use brz_redis::Redis;
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode};

use crate::auth::UserRow;
use crate::config::{AuthConfig, env_or_dotenv};
use crate::headers::OwnedHeaders;
use crate::http_compat::FastApiError;
use crate::responses::error::{RateLimitError, rate_limit_exceeded};
use crate::responses::rate_limit::{self, RateLimit};
use crate::state::AppState;

/// `settings.RATE_LIMIT_MCP_IDENTITY` (`app/core/config.py`),
/// default `60/minute`.
const RATE_LIMIT_MCP_IDENTITY_ENV: &str = "RATE_LIMIT_MCP_IDENTITY";
/// The source default `RATE_LIMIT_MCP_IDENTITY` amount (`60/minute`).
const RATE_LIMIT_MCP_IDENTITY_DEFAULT: i64 = 60;
/// The route path as embedded in the slowapi limiter key.
const MCP_IDENTITY_PATH: &str = "/api/external/mcp-identity/userinfo";
/// `TaskTokenData.type` written by `create_task_token` and required by
/// `verify_task_token`.
const TASK_TOKEN_TYPE: &str = "task_token";
/// `uvicorn`'s `ProxyHeadersMiddleware` default `--forwarded-allow-ips`. The
/// source derives `request.client.host` through this middleware, so the target
/// mirrors the same trusted-proxy walk (see [`client_ip`]).
const TRUSTED_PROXIES: [&str; 1] = ["127.0.0.1"];

/// `db.query(User).filter(User.id == user_id, User.is_active.is_(True)).first()`:
/// every mapped column, aliased `users_<column>` like SQLAlchemy's labeled
/// rendering; the source's `.is_(True)` renders `IS true`.
const USER_BY_ID_QUERY: &str = "SELECT users.id AS users_id, \
     users.user_name AS users_user_name, \
     users.password_hash AS users_password_hash, users.email AS users_email, \
     users.git_info AS users_git_info, users.is_active AS users_is_active, \
     users.`role` AS users_role, users.auth_source AS users_auth_source, \
     users.preferences AS users_preferences, users.created_at AS users_created_at, \
     users.updated_at AS users_updated_at \
     FROM users \
     WHERE users.id = ? AND users.is_active IS true \
     LIMIT 1";

/// `McpIdentityUserInfo` (`app/api/endpoints/mcp_identity.py`): basic current
/// user info resolvable from a Wegent task token. Field order matches the
/// model so the rendered JSON key order is stable.
#[derive(Debug, serde::Serialize)]
struct McpIdentityUserInfo {
    id: i32,
    user_name: String,
    email: Option<String>,
}

/// `verify_task_token` claims (`app/services/auth/task_token.py`).
///
/// `task_id`, `subtask_id`, `user_id`, and `user_name` are read with
/// `payload[...]`, so a missing one raises `KeyError` and collapses to `None`;
/// they are required here for the same reason. `type` is checked separately.
#[derive(Debug, serde::Deserialize)]
struct TaskTokenClaims {
    #[allow(dead_code, reason = "required by verify_task_token's payload access")]
    task_id: i64,
    #[allow(dead_code, reason = "required by verify_task_token's payload access")]
    subtask_id: i64,
    user_id: i64,
    #[allow(dead_code, reason = "required by verify_task_token's payload access")]
    user_name: String,
    #[serde(rename = "type")]
    token_type: Option<String>,
}

/// The request headers this route reads, bound by the route macro.
struct IdentityRequest<'a> {
    authorization: Option<&'a str>,
    x_api_key: Option<&'a str>,
    wegent_source: Option<&'a str>,
    x_forwarded_for: Option<&'a str>,
}

/// GET /api/external/mcp-identity/userinfo: the mcp-identity free function,
/// injecting the process-lifetime application state. The route is public
/// because the source reads the bearer credential as a plain header and always
/// reaches the body (the rate limiter runs before the token check).
#[brz_http_server::get("/api/external/mcp-identity/userinfo", access = public)]
async fn read_mcp_identity_userinfo(
    #[inject(state)] state: &AppState,
    #[header("authorization")] authorization: Option<&str>,
    #[header("x-api-key")] x_api_key: Option<&str>,
    #[header("wegent-source")] wegent_source: Option<&str>,
    #[header("x-forwarded-for")] x_forwarded_for: Option<&str>,
) -> Result<McpIdentityUserInfo, McpIdentityError> {
    let request = IdentityRequest {
        authorization,
        x_api_key,
        wegent_source,
        x_forwarded_for,
    };
    run(&state.auth, &state.mysql, state.redis.as_ref(), &request).await
}

/// The endpoint body, kept generic so tests can supply query and Redis doubles.
async fn run<M, R>(
    config: &AuthConfig,
    mysql: &M,
    redis: Option<&R>,
    request: &IdentityRequest<'_>,
) -> Result<McpIdentityUserInfo, McpIdentityError>
where
    M: Mysql,
    R: Redis,
{
    // `@limiter.limit(settings.RATE_LIMIT_MCP_IDENTITY)`.
    let limit = mcp_identity_limit();
    let limit_key = identity_limit_key(request);
    if !rate_limit::hit(redis, limit, &limit_key, MCP_IDENTITY_PATH).await {
        return Err(McpIdentityError::RateLimited(rate_limit_exceeded(limit)));
    }

    // `extract_token_from_header` then `verify_task_token`.
    let Some(claims) = extract_token_from_header(request.authorization)
        .and_then(|token| verify_task_token(config, &token))
    else {
        return Err(McpIdentityError::Api(FastApiError::unauthorized(
            "Invalid Wegent task token",
        )));
    };

    // `db.query(User).filter(User.id == user_id, User.is_active.is_(True)).first()`.
    let user: Option<UserRow> = mysql
        .fetch_optional(USER_BY_ID_QUERY, (claims.user_id,))
        .await
        .map_err(|error| {
            tracing::error!(%error, "mcp-identity userinfo database dependency failure");
            McpIdentityError::Api(FastApiError::unhandled())
        })?;
    let Some(user) = user else {
        return Err(McpIdentityError::Api(FastApiError::detail(
            StatusCode::NOT_FOUND,
            "User not found",
        )));
    };

    Ok(McpIdentityUserInfo {
        id: user.id,
        user_name: user.user_name,
        email: user.email,
    })
}

/// The slowapi fixed window for this route: `settings.RATE_LIMIT_MCP_IDENTITY`
/// (`RATE_LIMIT_MCP_IDENTITY`), falling back to the source default when the
/// value is absent or malformed.
fn mcp_identity_limit() -> RateLimit {
    env_or_dotenv(RATE_LIMIT_MCP_IDENTITY_ENV)
        .and_then(|value| RateLimit::parse(&value))
        .unwrap_or_else(|| RateLimit::per_minute(RATE_LIMIT_MCP_IDENTITY_DEFAULT))
}

/// `get_api_key_from_request` for this request (`app/core/rate_limit.py`): a
/// Wegent API-key header wins (X-API-Key, then `Authorization: Bearer wg-...`,
/// then `wegent-source`), otherwise the client IP.
fn identity_limit_key(request: &IdentityRequest<'_>) -> String {
    let headers = OwnedHeaders::from_pairs([
        ("x-api-key", request.x_api_key),
        ("authorization", request.authorization),
        ("wegent-source", request.wegent_source),
    ]);
    rate_limit::limit_key(&headers.view(), &client_ip(request.x_forwarded_for))
}

/// The client address the source reports as `request.client.host`.
///
/// The source runs behind `uvicorn`'s `ProxyHeadersMiddleware`, which rewrites
/// `client` from `x-forwarded-for` with the default trusted proxy
/// (`127.0.0.1`): it scans the list from the right and returns the first entry
/// that is not a trusted proxy, falling back to the leftmost when every entry
/// is trusted. Mirroring that walk keeps the limiter key source-compatible.
fn client_ip(x_forwarded_for: Option<&str>) -> String {
    let Some(value) = x_forwarded_for else {
        return "unknown".to_string();
    };
    let hosts: Vec<&str> = value
        .split(',')
        .map(str::trim)
        .filter(|host| !host.is_empty())
        .collect();
    match hosts
        .iter()
        .rev()
        .find(|host| !TRUSTED_PROXIES.contains(host))
    {
        Some(host) => (*host).to_string(),
        None => hosts
            .first()
            .map_or_else(|| "unknown".to_string(), |host| (*host).to_string()),
    }
}

/// `extract_token_from_header`: the header must split into exactly two
/// whitespace-separated fields whose first is `bearer` (case-insensitive);
/// every other shape yields no token.
fn extract_token_from_header(authorization: Option<&str>) -> Option<String> {
    let mut fields = authorization?.split_whitespace();
    let scheme = fields.next()?;
    let token = fields.next()?;
    if fields.next().is_some() || !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    Some(token.to_string())
}

/// `verify_task_token`: decode with the active key then the legacy decode-only
/// keys under PyJWT's defaults (signature and a present `exp`/`nbf`, no leeway,
/// no required claims) and require `type == task_token`.
fn verify_task_token(config: &AuthConfig, token: &str) -> Option<TaskTokenClaims> {
    let mut validation = Validation::new(signing_algorithm(config));
    validation.validate_aud = false;
    validation.validate_exp = true;
    validation.validate_nbf = true;
    validation.leeway = 0;
    validation.required_spec_claims.clear();
    decoding_keys(config)
        .into_iter()
        .find_map(|key_bytes| {
            decode::<TaskTokenClaims>(token, &DecodingKey::from_secret(&key_bytes), &validation)
                .ok()
                .map(|data| data.claims)
        })
        .filter(|claims| claims.token_type.as_deref() == Some(TASK_TOKEN_TYPE))
}

/// The active `SECRET_KEY` followed by the legacy decode-only keys.
fn decoding_keys(config: &AuthConfig) -> Vec<Vec<u8>> {
    let mut keys = vec![config.jwt_key.as_bytes().to_vec()];
    for key in &config.legacy_jwt_keys {
        if !keys.iter().any(|existing| existing == key.as_bytes()) {
            keys.push(key.as_bytes().to_vec());
        }
    }
    keys
}

/// The signing algorithm from `settings.ALGORITHM` (`HS256`).
fn signing_algorithm(config: &AuthConfig) -> Algorithm {
    match config.algorithm.as_str() {
        "HS384" => Algorithm::HS384,
        "HS512" => Algorithm::HS512,
        _ => Algorithm::HS256,
    }
}

/// The endpoint's failure shapes: the standard FastAPI `{"detail": ...}` error
/// and the slowapi 429 `{"error": ...}` body.
enum McpIdentityError {
    Api(FastApiError),
    RateLimited(RateLimitError),
}

impl IntoHttpError for McpIdentityError {
    fn into_http_error(self, arena: &EphemeralBytesArena) -> Response {
        match self {
            Self::Api(error) => error.into_http_error(arena),
            Self::RateLimited(error) => error.into_http_error(arena),
        }
    }
}

#[cfg(test)]
impl McpIdentityError {
    /// The FastAPI `detail` message, when this is an `Api` failure.
    fn api_detail(&self) -> Option<&str> {
        match self {
            Self::Api(error) => error.detail_message(),
            Self::RateLimited(_) => None,
        }
    }

    fn is_rate_limited(&self) -> bool {
        matches!(self, Self::RateLimited(_))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sql_test_support::KindQueryCapture;
    use jsonwebtoken::{EncodingKey, Header};

    fn auth_config() -> AuthConfig {
        AuthConfig {
            jwt_key: "secret-key".to_string(),
            legacy_jwt_keys: Vec::new(),
            algorithm: "HS256".to_string(),
        }
    }

    fn token(config: &AuthConfig, claims: serde_json::Value) -> String {
        jsonwebtoken::encode(
            &Header::new(signing_algorithm(config)),
            &claims,
            &EncodingKey::from_secret(config.jwt_key.as_bytes()),
        )
        .expect("claims and key always encode")
    }

    fn task_token(config: &AuthConfig) -> String {
        token(
            config,
            serde_json::json!({
                "task_id": 1,
                "subtask_id": 2,
                "user_id": 4771,
                "user_name": "example",
                "type": "task_token",
            }),
        )
    }

    fn request<'a>(
        authorization: Option<&'a str>,
        forwarded: Option<&'a str>,
    ) -> IdentityRequest<'a> {
        IdentityRequest {
            authorization,
            x_api_key: None,
            wegent_source: None,
            x_forwarded_for: forwarded,
        }
    }

    #[test]
    fn extract_token_requires_a_single_bearer_field() {
        assert_eq!(
            extract_token_from_header(Some("Bearer abc")),
            Some("abc".to_string())
        );
        assert_eq!(
            extract_token_from_header(Some("bearer abc")),
            Some("abc".to_string())
        );
        for header in [
            None,
            Some(""),
            Some("Bearer"),
            Some("Bearer a b"),
            Some("Basic abc"),
        ] {
            assert_eq!(extract_token_from_header(header), None, "{header:?}");
        }
    }

    #[test]
    fn client_ip_matches_uvicorns_trusted_proxy_walk() {
        // Rightmost untrusted entry wins, as uvicorn does behind a trusted proxy.
        assert_eq!(client_ip(Some("198.51.100.7, 203.0.113.9")), "203.0.113.9");
        // A trusted trailing proxy is skipped and the prior entry is used.
        assert_eq!(client_ip(Some("203.0.113.9, 127.0.0.1")), "203.0.113.9");
        // A single entry is returned as-is.
        assert_eq!(client_ip(Some("203.0.113.9")), "203.0.113.9");
        // All-trusted chains keep the leftmost entry.
        assert_eq!(client_ip(Some("127.0.0.1, 127.0.0.1")), "127.0.0.1");
        assert_eq!(client_ip(None), "unknown");
    }

    #[test]
    fn limit_key_falls_back_to_the_client_ip() {
        let request = request(
            Some("Bearer eyJ.some.jwt"),
            Some("198.51.100.7, 203.0.113.9"),
        );
        assert_eq!(identity_limit_key(&request), "ip:203.0.113.9");
    }

    #[test]
    fn limit_key_prefers_wegent_api_key_headers() {
        let mut request = request(Some("Bearer wg-abc#user"), None);
        assert_eq!(identity_limit_key(&request), "apikey:wg-abc");
        request.x_api_key = Some("wg-xyz");
        assert_eq!(identity_limit_key(&request), "apikey:wg-xyz");
    }

    #[test]
    fn verify_task_token_accepts_a_task_token_and_rejects_others() {
        let config = auth_config();
        let claims = verify_task_token(&config, &task_token(&config)).expect("valid task token");
        assert_eq!(claims.user_id, 4771);

        // A session token has no `type`, so it is rejected.
        let session = token(
            &config,
            serde_json::json!({ "sub": "example", "role": "user" }),
        );
        assert!(verify_task_token(&config, &session).is_none());

        // A missing required claim is rejected (the source `KeyError` path).
        let missing = token(
            &config,
            serde_json::json!({ "task_id": 1, "subtask_id": 2, "user_id": 4771, "type": "task_token" }),
        );
        assert!(verify_task_token(&config, &missing).is_none());

        // A wrongly signed token is rejected.
        let mut other = auth_config();
        other.jwt_key = "secret-key-other".to_string();
        assert!(verify_task_token(&config, &task_token(&other)).is_none());
    }

    #[test]
    fn verify_task_token_accepts_a_legacy_decode_key() {
        let mut config = auth_config();
        config.legacy_jwt_keys = vec!["secret-key-legacy".to_string()];
        let mut signer = config.clone();
        signer.jwt_key = "secret-key-legacy".to_string();
        assert!(verify_task_token(&config, &task_token(&signer)).is_some());
    }

    #[tokio::test]
    async fn invalid_token_is_unauthorized_without_a_query() {
        let config = auth_config();
        let mysql = KindQueryCapture::default();
        let request = request(Some("Bearer not-a-jwt"), None);
        let error = run(&config, &mysql, None::<&brz_redis::RedisService>, &request)
            .await
            .expect_err("invalid token must fail");
        assert_eq!(error.api_detail(), Some("Invalid Wegent task token"));
        assert!(mysql.queries().is_empty());
    }

    #[tokio::test]
    async fn missing_token_is_unauthorized() {
        let config = auth_config();
        let mysql = KindQueryCapture::default();
        let request = request(None, None);
        let error = run(&config, &mysql, None::<&brz_redis::RedisService>, &request)
            .await
            .expect_err("missing token must fail");
        assert_eq!(error.api_detail(), Some("Invalid Wegent task token"));
        assert!(mysql.queries().is_empty());
    }

    #[tokio::test]
    async fn valid_token_reads_the_active_user_by_id() {
        let config = auth_config();
        let auth = format!("Bearer {}", task_token(&config));
        let mysql = KindQueryCapture::default();
        let request = request(Some(auth.as_str()), None);
        // `KindQueryCapture::fetch_optional` returns no row -> the source's
        // `first()` None -> `404 {"detail": "User not found"}`.
        let error = run(&config, &mysql, None::<&brz_redis::RedisService>, &request)
            .await
            .expect_err("no row must map to not-found");
        assert_eq!(error.api_detail(), Some("User not found"));

        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        assert!(queries[0].sql.contains("FROM users"));
        assert!(
            queries[0]
                .sql
                .contains("WHERE users.id = ? AND users.is_active IS true")
        );
        assert!(queries[0].sql.contains("LIMIT 1"));
        assert_eq!(queries[0].first_integer, Some(4771));
    }

    #[test]
    fn response_serializes_id_user_name_and_email() {
        let rendered = crate::json_contract_tests::serialized(McpIdentityUserInfo {
            id: 7,
            user_name: "example".to_string(),
            email: Some("example@example.com".to_string()),
        })
        .unwrap();
        let keys: Vec<&str> = rendered
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(keys, ["id", "user_name", "email"]);

        let rendered = crate::json_contract_tests::serialized(McpIdentityUserInfo {
            id: 7,
            user_name: "example".to_string(),
            email: None,
        })
        .unwrap();
        assert!(rendered["email"].is_null());
    }

    #[test]
    fn rate_limit_error_is_classified_separately() {
        let error = McpIdentityError::RateLimited(rate_limit_exceeded(RateLimit::per_minute(
            RATE_LIMIT_MCP_IDENTITY_DEFAULT,
        )));
        assert!(error.is_rate_limited());
        assert_eq!(error.api_detail(), None);
    }
}
