//! `GET /api/quota/claude/quota`: the Wecode AIGC quota proxy.
//!
//! Source `wecode/api/quota_endpoint_patch.py`, which wraps the open-source
//! `GET /api/quota/{path:path}` handler. Only this one path is served, so the
//! route is registered exactly rather than as a `{path:path}` capture.

pub(crate) mod auth;
pub(crate) mod users;

use brz_http_server::StatusCode;
use brz_mysql::Mysql;
use serde::Serialize;
use wegent_backend_rs::auth::AppAuthenticator;
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

/// Fully authenticated quota caller, including the endpoint-specific user
/// projection needed to preserve its recorded SQL.
struct QuotaUser(users::UserRow);

#[derive(Clone, Copy)]
enum QuotaAuthFailure {
    NotAuthenticated,
    InvalidCredentials,
    UserNotActivated,
    Internal,
}

const QUOTA_NOT_AUTHENTICATED: &str = "Wegent-Quota-Not-Authenticated";
const QUOTA_USER_NOT_ACTIVATED: &str = "Wegent-Quota-User-Not-Activated";

impl brz_http_server::Authenticator<QuotaUser> for AppAuthenticator {
    async fn authenticate<'a>(
        &'a self,
        request: brz_http_server::AuthRequest<'a>,
    ) -> Result<QuotaUser, brz_http_server::AuthFailure> {
        let authorization = request
            .header("authorization")
            .and_then(|value| std::str::from_utf8(value).ok());
        resolve_quota_user(&self.state().auth, &self.state().mysql, authorization)
            .await
            .map_err(|failure| match failure {
                QuotaAuthFailure::NotAuthenticated => {
                    brz_http_server::AuthFailure::missing_credentials(QUOTA_NOT_AUTHENTICATED)
                }
                QuotaAuthFailure::InvalidCredentials => {
                    brz_http_server::AuthFailure::invalid_credentials("Bearer")
                }
                QuotaAuthFailure::UserNotActivated => {
                    brz_http_server::AuthFailure::invalid_credentials(QUOTA_USER_NOT_ACTIVATED)
                }
                QuotaAuthFailure::Internal => brz_http_server::AuthFailure::Internal,
            })
    }

    fn api_log_id<'a>(&'a self, principal: &'a QuotaUser) -> Option<&'a dyn std::fmt::Display> {
        Some(&principal.0.users_user_name)
    }

    fn reject(
        &self,
        _request: brz_http_server::AuthRequest<'_>,
        failure: brz_http_server::AuthFailure,
        arena: &brz_http_server::EphemeralBytesArena,
    ) -> brz_http_server::Response {
        use brz_http_server::IntoHttpError as _;

        let error = match failure {
            brz_http_server::AuthFailure::MissingCredentials {
                challenge: QUOTA_NOT_AUTHENTICATED,
            } => FastApiError::unauthorized("Not authenticated"),
            brz_http_server::AuthFailure::InvalidCredentials {
                challenge: QUOTA_USER_NOT_ACTIVATED,
            } => FastApiError::unauthorized("User not activated"),
            brz_http_server::AuthFailure::Internal | brz_http_server::AuthFailure::Unavailable => {
                FastApiError::detail(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error")
            }
            _ => FastApiError::unauthorized("Could not validate credentials"),
        };
        error.into_http_error(arena)
    }
}

#[brz_http_server::get(
    "/api/quota/claude/quota",
    group = crate::wecode::wecode_apis
)]
async fn claude_quota(
    #[inject(wecode)] state: &SharedWecodeAppState,
    #[auth] user: QuotaUser,
) -> Result<QuotaResponse, FastApiError> {
    quota_for_user(state.aigc_quota(), &user.0).await
}

async fn resolve_quota_user<M>(
    auth: &AuthConfig,
    mysql: &M,
    authorization: Option<&str>,
) -> Result<QuotaUser, QuotaAuthFailure>
where
    M: Mysql,
{
    let token = auth::extract_bearer_token(authorization).map_err(|error| match error {
        auth::AuthError::NotAuthenticated => QuotaAuthFailure::NotAuthenticated,
        auth::AuthError::InvalidCredentials => QuotaAuthFailure::InvalidCredentials,
    })?;
    let session = auth::verify_session_token(token, auth)
        .map_err(|_| QuotaAuthFailure::InvalidCredentials)?;
    let user = users::find_user_by_name(mysql, &session.username)
        .await
        .map_err(|error| match error {
            users::UserLookupError::Mysql(error) => {
                tracing::error!(%error, "quota user lookup failed");
                QuotaAuthFailure::Internal
            }
        })?
        .ok_or(QuotaAuthFailure::InvalidCredentials)?;
    if user.users_is_active == 0 {
        return Err(QuotaAuthFailure::UserNotActivated);
    }
    Ok(QuotaUser(user))
}

async fn quota_for_user(
    aigc_quota: &aigc::AigcQuotaService,
    user: &users::UserRow,
) -> Result<QuotaResponse, FastApiError> {
    tracing::info!(email = ?user.users_email, path = QUOTA_PATH, "get quota for user");

    Ok(match aigc_quota.fetch(&user.users_user_name).await {
        Some(details) => QuotaResponse::Aigc(Box::new(details)),
        None => QuotaResponse::Empty {},
    })
}

#[cfg(test)]
async fn quota_response<M>(
    auth: &AuthConfig,
    mysql: &M,
    aigc_quota: &aigc::AigcQuotaService,
    authorization: Option<&str>,
) -> Result<QuotaResponse, FastApiError>
where
    M: Mysql,
{
    let user = resolve_quota_user(auth, mysql, authorization)
        .await
        .map_err(|failure| match failure {
            QuotaAuthFailure::NotAuthenticated => FastApiError::unauthorized("Not authenticated"),
            QuotaAuthFailure::InvalidCredentials => {
                FastApiError::unauthorized("Could not validate credentials")
            }
            QuotaAuthFailure::UserNotActivated => FastApiError::unauthorized("User not activated"),
            QuotaAuthFailure::Internal => {
                FastApiError::detail(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error")
            }
        })?;
    quota_for_user(aigc_quota, &user.0).await
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

    fn aigc_quota() -> aigc::AigcQuotaService {
        // Never reached by these cases: they all fail before the AIGC call.
        let endpoint = aigc::build_endpoint(aigc::AIGC_QUOTA_URL).expect("valid quota URL");
        aigc::AigcQuotaService::new(endpoint, None)
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
        match quota_response(&auth(), &mysql(), &aigc_quota(), authorization).await {
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
