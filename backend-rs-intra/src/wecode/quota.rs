//! `GET /api/quota/claude/quota`: the Wecode AIGC quota proxy.
//!
//! Source `wecode/api/quota_endpoint_patch.py`, which wraps the open-source
//! `GET /api/quota/{path:path}` handler. Only this one path is served, so the
//! route is registered exactly rather than as a `{path:path}` capture.

pub(crate) mod auth;
pub(crate) mod users;

use brz_http::Endpoint;
use brz_http_server::StatusCode;
use brz_mysql::Mysql;
use serde::Serialize;
use wegent_backend_rs::config::AuthConfig;
use wegent_backend_rs::http_compat::FastApiError;

use super::SharedWecodeAppState;
use super::aigc::{self, QuotaDetails};

/// The captured `path` the source logs; the route serves exactly this one.
const QUOTA_PATH: &str = "claude/quota";

/// The endpoint's response: the transformed AIGC payload, or the open-source
/// empty object the source patch falls back to.
#[derive(Serialize)]
#[serde(untagged)]
enum QuotaResponse {
    Aigc(Box<QuotaDetails>),
    Empty {},
}

#[brz_http_server::get(
    "/api/quota/claude/quota",
    group = crate::wecode::wecode_apis
)]
async fn claude_quota(
    #[inject(wecode)] state: &SharedWecodeAppState,
    #[header] authorization: Option<&str>,
) -> Result<QuotaResponse, FastApiError> {
    quota_response(
        &state.public().auth,
        &state.public().mysql,
        state.aigc_quota_endpoint(),
        authorization,
    )
    .await
}

/// Resolves the authenticated user, then proxies the AIGC quota service.
async fn quota_response<M>(
    auth: &AuthConfig,
    mysql: &M,
    endpoint: &Endpoint,
    authorization: Option<&str>,
) -> Result<QuotaResponse, FastApiError>
where
    M: Mysql,
{
    let token = auth::extract_bearer_token(authorization).map_err(|error| match error {
        auth::AuthError::NotAuthenticated => FastApiError::unauthorized("Not authenticated"),
        auth::AuthError::InvalidCredentials => {
            FastApiError::unauthorized("Could not validate credentials")
        }
    })?;
    let session = auth::verify_session_token(token, auth)
        .map_err(|_| FastApiError::unauthorized("Could not validate credentials"))?;
    let user = users::find_user_by_name(mysql, &session.username)
        .await
        .map_err(|error| match error {
            users::UserLookupError::Mysql(error) => {
                tracing::error!(%error, "quota user lookup failed");
                FastApiError::detail(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error")
            }
        })?
        .ok_or_else(|| FastApiError::unauthorized("Could not validate credentials"))?;
    if user.users_is_active == 0 {
        return Err(FastApiError::unauthorized("User not activated"));
    }
    tracing::info!(email = ?user.users_email, path = QUOTA_PATH, "get quota for user");

    Ok(
        match aigc::fetch_aigc_quota(endpoint, &user.users_user_name).await {
            Some(details) => QuotaResponse::Aigc(Box::new(details)),
            None => QuotaResponse::Empty {},
        },
    )
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use brz_http_server::StatusCode;
    use brz_mysql::{MysqlService, MysqlServiceOptions};
    use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};

    use super::*;

    const TEST_JWT_KEY: &str = "test-secret";
    /// A port nothing listens on, so a lookup against it fails immediately.
    const UNREACHABLE_MYSQL: &str = "mysql://user:pw@127.0.0.1:1/task_manager";

    fn auth() -> AuthConfig {
        AuthConfig {
            jwt_key: TEST_JWT_KEY.to_owned(),
            legacy_jwt_keys: Vec::new(),
            algorithm: "HS256".to_owned(),
        }
    }

    fn mysql() -> MysqlService {
        // A short acquire timeout keeps the failing lookup fast; the defaults
        // would wait the pool's full 30-second timeout. The slow-acquire
        // threshold may not exceed the acquire timeout.
        let options = MysqlServiceOptions {
            acquire_timeout: Duration::from_secs(1),
            slow_acquire_threshold: Duration::from_secs(1),
            ..MysqlServiceOptions::default()
        };
        MysqlService::connect_lazy_with_options(UNREACHABLE_MYSQL, options)
            .expect("a lazy pool needs no server")
    }

    fn endpoint() -> Endpoint {
        // Never reached by these cases: they all fail before the AIGC call.
        aigc::build_endpoint(aigc::AIGC_QUOTA_URL).expect("valid quota URL")
    }

    fn valid_token() -> String {
        let exp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after the epoch")
            .as_secs()
            + 3600;
        encode(
            &Header::new(Algorithm::HS256),
            &serde_json::json!({"sub": "liting9", "exp": exp}),
            &EncodingKey::from_secret(TEST_JWT_KEY.as_bytes()),
        )
        .expect("mint token")
    }

    /// The status of the error this request produces.
    async fn status_for(authorization: Option<&str>) -> StatusCode {
        match quota_response(&auth(), &mysql(), &endpoint(), authorization).await {
            Err(error) => error.status(),
            Ok(_) => panic!("the request must not authenticate"),
        }
    }

    #[tokio::test]
    async fn rejects_a_request_without_an_authorization_header() {
        assert_eq!(status_for(None).await, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn rejects_a_non_bearer_scheme() {
        assert_eq!(
            status_for(Some("Basic bGl0aW5nOQ==")).await,
            StatusCode::UNAUTHORIZED
        );
    }

    #[tokio::test]
    async fn rejects_a_bearer_scheme_without_a_credential() {
        // The empty credential is not an auto-error: it reaches the verifier
        // and fails as an invalid token.
        assert_eq!(status_for(Some("Bearer")).await, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn rejects_a_token_signed_with_another_key() {
        let foreign = encode(
            &Header::new(Algorithm::HS256),
            &serde_json::json!({"sub": "liting9"}),
            &EncodingKey::from_secret(b"other-secret"),
        )
        .expect("mint token");
        assert_eq!(
            status_for(Some(&format!("Bearer {foreign}"))).await,
            StatusCode::UNAUTHORIZED
        );
    }

    #[tokio::test]
    async fn reports_a_failed_user_lookup_as_an_internal_error() {
        // The token is valid, so authentication reaches the `users` query,
        // which fails against the unreachable address.
        let token = valid_token();
        assert_eq!(
            status_for(Some(&format!("Bearer {token}"))).await,
            StatusCode::INTERNAL_SERVER_ERROR
        );
    }
}
