// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! OIDC callback validation, code exchange, and redirect handling.
//! Provider failures retain their HTTP error response.
use crate::config::OidcConfig;
use crate::oidc_service::OidcService;
use async_trait::async_trait;
use serde::Deserialize;

/// Applications may replace this callback when they need additional login hooks.
/// Async methods are boxed for dynamic dispatch and return Send futures.
#[async_trait]
pub trait OidcCallbackHandler: Send + Sync {
    /// Handle the OIDC callback: decode the `state` JWT, exchange the code,
    /// and return the source's `302` redirect or a `FastApiError` body.
    async fn handle(
        &self,
        state: &crate::state::AppState,
        query: CallbackQuery,
    ) -> Result<brz_http_server::Redirect, crate::http_compat::FastApiError>;
}

/// Open-source default callback handler. Constructed
/// and injected in `main` at startup; delegates to the free
/// [`callback_response`] function. A private crate may replace this injection
/// with an enhanced impl of [`OidcCallbackHandler`].
pub struct DefaultOidcCallbackHandler;

#[async_trait]
impl OidcCallbackHandler for DefaultOidcCallbackHandler {
    async fn handle(
        &self,
        state: &crate::state::AppState,
        query: CallbackQuery,
    ) -> Result<brz_http_server::Redirect, crate::http_compat::FastApiError> {
        callback_response_with_state(
            &state.oidc_config,
            &state.oidc,
            Some(&state.auth),
            Some(&state.mysql),
            query,
        )
        .await
    }
}

/// Query parameters; `code` and `state` are required by the source's
/// `Query(...)` declarations, `error` is optional (`Query(None)`).
#[derive(Debug, Deserialize)]
pub struct CallbackQuery {
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
}

/// The two dependency fields the callback path reads, borrowed from
/// `AppState` (or a minimal test state) by [`oidc_callback_inner`].
struct OidcParts<'a> {
    oidc_config: &'a OidcConfig,
    oidc: &'a OidcService,
    auth: Option<&'a crate::config::AuthConfig>,
    mysql: Option<&'a brz_mysql::MysqlService>,
}

/// Decoded `state` JWT payload (`oidc_login` in `app/api/endpoints/oidc.py`).
#[derive(Debug)]
pub struct StateClaims {
    pub nonce: String,
    #[allow(dead_code)]
    pub exp: i64,
    #[allow(dead_code)]
    pub redirect: Option<String>,
    pub frontend_base_path: Option<String>,
}

#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct StateClaimsInput {
    nonce: Option<String>,
    exp: Option<i64>,
    redirect: Option<String>,
    frontend_base_path: Option<String>,
}

/// Serves `GET /api/auth/oidc/callback`, exposed to `main.rs`'s API struct.
/// Returns the source's `302` redirects; the 422/502 failure bodies map to
/// [`FastApiError`].
// Migrated from the Python source; not yet wired into the gateway.
#[allow(dead_code)]
pub async fn callback_response(
    config: &OidcConfig,
    oidc: &OidcService,
    query: CallbackQuery,
) -> Result<brz_http_server::Redirect, crate::http_compat::FastApiError> {
    callback_response_with_state(config, oidc, None, None, query).await
}

/// Callback entry point with the application dependencies needed by the
/// successful login path. The smaller [`callback_response`] helper remains
/// available for provider failure tests and embedders that only need the
/// redirect contract.
pub async fn callback_response_with_state(
    config: &OidcConfig,
    oidc: &OidcService,
    auth: Option<&crate::config::AuthConfig>,
    mysql: Option<&brz_mysql::MysqlService>,
    query: CallbackQuery,
) -> Result<brz_http_server::Redirect, crate::http_compat::FastApiError> {
    let app = OidcParts {
        oidc_config: config,
        oidc,
        auth,
        mysql,
    };
    let app = &app;
    if let Some(error) = query.error.as_deref() {
        tracing::error!(error, "OIDC callback error");
        return Ok(redirect(
            &app.oidc_config.frontend_url,
            &format!("/login?error=oidc_error&message={error}"),
        ));
    }

    // Missing required query parameters surface as FastAPI's 422 validation
    // response before the handler body runs.
    let (Some(code), Some(state)) = (query.code, query.state) else {
        return Err(crate::http_compat::FastApiError::validation(
            serde_json::json!([
                { "type": "missing", "loc": ["query", "state"], "msg": "Field required",
                  "input": crate::json_compat::JsonNull }
            ]),
        ));
    };

    // Verify the state parameter (HS256 JWT), including its short expiry and
    // required nonce, exactly as the source callback does.
    let claims = match decode_state(app, state.as_str()) {
        Ok(claims) => claims,
        Err(error) => {
            tracing::error!(state, %error, "Invalid state parameter");
            return Ok(redirect(
                &app.oidc_config.frontend_url,
                "/login?error=invalid_state&message=Invalid state parameter",
            ));
        }
    };

    // Token exchange: `oidc_service.exchange_code_for_tokens` fetches the
    // provider metadata first. Its `HTTPException(502)` propagates through
    // the patch's `except HTTPException: raise` branch unchanged.
    match exchange_and_login(app, code.as_str(), &claims.nonce).await {
        Ok(access_token) => {
            let mut path = format!(
                "/login/oidc?access_token={access_token}&token_type=bearer&login_success=true"
            );
            if let Some(redirect_after_login) = claims.redirect.as_deref() {
                path.push_str("&redirect=");
                let encoded = url::form_urlencoded::byte_serialize(redirect_after_login.as_bytes())
                    .collect::<String>()
                    .replace("%2F", "/");
                path.push_str(&encoded);
            }
            Ok(redirect_with_base_path(
                &app.oidc_config.frontend_url,
                &path,
                &claims.frontend_base_path,
            ))
        }
        Err(ExchangeError::Metadata(detail)) => Err(crate::http_compat::FastApiError::detail(
            brz_http_server::StatusCode::BAD_GATEWAY,
            detail,
        )),
        Err(ExchangeError::AuthenticationFailed(message)) => {
            let path = format!("/login?error=authentication_failed&message={message}");
            Ok(redirect_with_base_path(
                &app.oidc_config.frontend_url,
                &path,
                &claims.frontend_base_path,
            ))
        }
    }
}

/// Decodes and validates the state JWT with the source's signing key.
fn decode_state(app: &OidcParts, state: &str) -> Result<StateClaims, String> {
    let mut validation = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::HS256);
    validation.validate_exp = true;
    let claims: StateClaimsInput = jsonwebtoken::decode(
        state,
        &jsonwebtoken::DecodingKey::from_secret(app.oidc_config.state_key.as_bytes()),
        &validation,
    )
    .map_err(|error| error.to_string())?
    .claims;
    let nonce = claims
        .nonce
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "missing nonce".to_string())?;
    let exp = claims.exp.ok_or_else(|| "missing exp".to_string())?;
    let redirect = claims.redirect;
    let frontend_base_path = claims.frontend_base_path;
    Ok(StateClaims {
        nonce,
        exp,
        redirect,
        frontend_base_path,
    })
}

/// Provider interaction failures, preserving the source's error mapping.
enum ExchangeError {
    /// `HTTPException(502, "Unable to retrieve OIDC metadata: ...")`,
    /// re-raised unchanged by the application patch.
    Metadata(String),
    /// Any other exception in the callback body: the source redirects with
    /// `?error=authentication_failed&message=...`.
    AuthenticationFailed(String),
}

/// The provider interaction path: metadata first, then token exchange and
/// downstream user handling.
async fn exchange_and_login(
    app: &OidcParts<'_>,
    code: &str,
    nonce: &str,
) -> Result<String, ExchangeError> {
    let tokens = app
        .oidc
        .exchange_code_for_tokens(app.oidc_config, code)
        .await
        .map_err(|error| match error {
            crate::oidc_service::OidcError::Metadata(detail) => ExchangeError::Metadata(
                if detail.starts_with("Unable to retrieve OIDC metadata:") {
                    detail
                } else {
                    format!("Unable to retrieve OIDC metadata: {detail}")
                },
            ),
            crate::oidc_service::OidcError::MetadataField(detail) => {
                ExchangeError::Metadata(detail)
            }
            other => ExchangeError::AuthenticationFailed(other.detail()),
        })?;
    let id_token = tokens
        .get("id_token")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| {
            ExchangeError::AuthenticationFailed("Missing ID Token in response".into())
        })?;
    let claims = app
        .oidc
        .verify_id_token(app.oidc_config, id_token, nonce)
        .await
        .map_err(|error| ExchangeError::AuthenticationFailed(error.detail()))?;
    let mut user_data = claims;
    if let (Some(access_token), Some(userinfo_endpoint)) = (
        tokens
            .get("access_token")
            .and_then(serde_json::Value::as_str),
        app.oidc.get_metadata().await.ok().and_then(|metadata| {
            metadata
                .to_value()
                .get("userinfo_endpoint")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        }),
    ) && let Some(extra) = app
        .oidc
        .get_user_info(&userinfo_endpoint, access_token)
        .await
        && let (Some(base), Some(extra)) = (user_data.as_object_mut(), extra.as_object())
    {
        for (key, value) in extra {
            base.insert(key.clone(), value.clone());
        }
    }
    let subject = user_data
        .get("sub")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            ExchangeError::AuthenticationFailed("Missing user identifier in ID Token".into())
        })?;
    let email = user_data
        .get("email")
        .or_else(|| user_data.get("preferred_username"))
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("{subject}@unknown.email"));
    let user_name = email
        .split('@')
        .next()
        .filter(|value| !value.is_empty())
        .unwrap_or(subject);
    let (Some(auth), Some(mysql)) = (app.auth, app.mysql) else {
        return Err(ExchangeError::AuthenticationFailed(
            "OIDC database state unavailable".into(),
        ));
    };
    let user_id = upsert_oidc_user(mysql, user_name, &email)
        .await
        .map_err(ExchangeError::AuthenticationFailed)?;
    crate::auth_login::create_access_token(auth, user_name, user_id)
        .map_err(|_| ExchangeError::AuthenticationFailed("Unable to create access token".into()))
}

#[derive(brz_mysql::FromMysqlRow)]
struct OidcUserRow {
    id: i32,
    email: Option<String>,
    auth_source: String,
    is_active: i8,
}

async fn upsert_oidc_user(
    mysql: &brz_mysql::MysqlService,
    user_name: &str,
    email: &str,
) -> Result<i32, String> {
    let existing: Option<OidcUserRow> = mysql
        .fetch_optional(
            "SELECT id, email, auth_source, is_active FROM users WHERE user_name = ? LIMIT 1",
            (user_name,),
        )
        .await
        .map_err(|error| error.to_string())?;
    if let Some(user) = existing {
        if user.is_active == 0 {
            return Err("User not active".into());
        }
        if user.email.as_deref() != Some(email) || user.auth_source == "unknown" {
            mysql
                .execute(
                    "UPDATE users SET email = ?, auth_source = 'oidc' WHERE id = ?",
                    (email, user.id),
                )
                .await
                .map_err(|error| error.to_string())?;
        }
        return Ok(user.id);
    }
    let password = bcrypt::hash(
        format!(
            "oidc:{}:{}",
            user_name,
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ),
        bcrypt::DEFAULT_COST,
    )
    .map_err(|error| error.to_string())?;
    mysql
        .execute(
            "INSERT INTO users (user_name, password_hash, email, git_info, is_active, `role`, auth_source, preferences) VALUES (?, ?, ?, ?, 1, 'user', 'oidc', '{}')",
            (user_name, password, email, "[]"),
        )
        .await
        .map_err(|error| error.to_string())?;
    let created: OidcUserRow = mysql
        .fetch_optional(
            "SELECT id, email, auth_source, is_active FROM users WHERE user_name = ? LIMIT 1",
            (user_name,),
        )
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "OIDC user insert did not return a user".to_string())?;
    Ok(created.id)
}

/// Source `_normalize_frontend_base_path` (identical in both modules).
pub fn normalize_frontend_base_path(value: Option<&str>) -> String {
    let Some(trimmed) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return String::new();
    };
    if trimmed == "/" {
        return String::new();
    }
    if !trimmed.starts_with('/') || trimmed.starts_with("//") {
        return String::new();
    }
    if trimmed.contains('\\') || trimmed.contains('?') || trimmed.contains('#') {
        return String::new();
    }
    let mut parts: Vec<&str> = Vec::new();
    for part in trimmed.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            parts.pop();
            continue;
        }
        parts.push(part);
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!("/{}", parts.join("/"))
    }
}

/// Source `_build_frontend_url` (identical in both modules).
pub fn build_frontend_url(
    frontend_url: &str,
    path: &str,
    frontend_base_path: Option<&str>,
) -> String {
    let base = frontend_url.trim_end_matches('/');
    let app_base_path = normalize_frontend_base_path(frontend_base_path);
    let normalized_path = if path.starts_with('/') {
        path
    } else {
        &format!("/{path}")
    };
    format!("{base}{app_base_path}{normalized_path}")
}

/// Source `RedirectResponse(url=..., status_code=302)`.
fn redirect_response(url: &str) -> brz_http_server::Redirect {
    brz_http_server::Redirect::found(url)
}

fn redirect(frontend_url: &str, path: &str) -> brz_http_server::Redirect {
    redirect_response(&build_frontend_url(frontend_url, path, None))
}

fn redirect_with_base_path(
    frontend_url: &str,
    path: &str,
    base_path: &Option<String>,
) -> brz_http_server::Redirect {
    redirect_response(&build_frontend_url(
        frontend_url,
        path,
        base_path.as_deref(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::OidcConfig;
    use crate::oidc_service::OidcService;
    use serde_json::{Value, json};

    #[test]
    fn normalizes_frontend_base_path_like_source() {
        assert_eq!(normalize_frontend_base_path(None), "");
        assert_eq!(normalize_frontend_base_path(Some("")), "");
        assert_eq!(normalize_frontend_base_path(Some("/")), "");
        assert_eq!(normalize_frontend_base_path(Some(" /wework ")), "/wework");
        assert_eq!(normalize_frontend_base_path(Some("//wework")), "");
        assert_eq!(normalize_frontend_base_path(Some("wework")), "");
        assert_eq!(normalize_frontend_base_path(Some("/a/../b/./c")), "/b/c");
        assert_eq!(normalize_frontend_base_path(Some("/a?b")), "");
        assert_eq!(normalize_frontend_base_path(Some("/a#b")), "");
        assert_eq!(normalize_frontend_base_path(Some("/a\\b")), "");
    }

    fn sign_state(claims: &Value) -> String {
        jsonwebtoken::encode(
            &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::HS256),
            claims,
            &jsonwebtoken::EncodingKey::from_secret(b"test-key"),
        )
        .expect("sign state")
    }

    /// Minimal state the callback path reads: just the OIDC config and the
    /// retained provider client (the same two fields `AppState` exposes).
    struct TestApp {
        oidc_config: OidcConfig,
        #[allow(dead_code, reason = "mirrors the AppState field set")]
        oidc: OidcService,
    }

    /// Test frontend base assembled the way the mounted source .env defines
    /// FRONTEND_URL, avoiding a bare public-domain literal in test code.
    const TEST_FRONTEND_URL: &str = "https://wegent.example.invalid";

    fn frontend_login_url(error: &str, message: &str) -> String {
        if message.is_empty() {
            format!("{TEST_FRONTEND_URL}/login?error={error}")
        } else {
            format!("{TEST_FRONTEND_URL}/login?error={error}&message={message}")
        }
    }

    fn app_with(state_key: &str, frontend_url: &str) -> TestApp {
        let config = OidcConfig {
            state_key: state_key.to_string(),
            frontend_url: frontend_url.to_string(),
            discovery_url: "http://127.0.0.1:9/.well-known/openid-configuration".to_string(),
            ..OidcConfig::default()
        };
        let oidc = OidcService::new(&config).expect("valid discovery URL");
        TestApp {
            oidc_config: config,
            oidc,
        }
    }

    /// Drives the callback over a real `http-server` socket so status and
    /// `Location` are asserted exactly as the runtime renders them.
    async fn callback(app: &TestApp, query: &str) -> String {
        callback_probe(app, query).await
    }

    /// The probe module: a dedicated test group (separate from the crate's
    /// real `http_apis` group) carrying its own OIDC config as a named
    /// dependency. Declared as a sibling module so the registry macro's
    /// generated items land in the test module's namespace.
    mod probe {
        use super::{CallbackQuery, OidcConfig, OidcService, callback_response};
        use crate::http_compat::FastApiError;

        pub(super) struct OidcProbeState {
            pub(super) state_key: String,
            pub(super) frontend_url: String,
            pub(super) discovery_url: String,
        }
        brz_http_server::registry!(
            group = oidc_probe,
            dependencies(cfg: OidcProbeState)
        );

        #[brz_http_server::get("/api/auth/oidc/callback", group = super::probe::oidc_probe)]
        async fn callback(
            #[inject(cfg)] cfg: &OidcProbeState,
            code: Option<String>,
            state: Option<String>,
            error: Option<String>,
        ) -> Result<brz_http_server::Redirect, FastApiError> {
            let config = OidcConfig {
                state_key: cfg.state_key.clone(),
                frontend_url: cfg.frontend_url.clone(),
                discovery_url: cfg.discovery_url.clone(),
                ..OidcConfig::default()
            };
            let oidc = OidcService::new(&config).expect("valid discovery URL");
            callback_response(&config, &oidc, CallbackQuery { code, state, error }).await
        }

        pub(super) fn handler(
            state_key: String,
            frontend_url: String,
            discovery_url: String,
        ) -> brz_http_server::Router<brz_http_server::NoAuthenticator> {
            brz_http_server::handlers!(
                cfg = OidcProbeState {
                    state_key,
                    frontend_url,
                    discovery_url,
                };
                group = super::probe::oidc_probe
            )
            .expect("probe router")
        }
    }

    async fn callback_probe(app: &TestApp, query: &str) -> String {
        (async {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            use tokio::net::TcpStream;

            let handler = probe::handler(
                app.oidc_config.state_key.clone(),
                app.oidc_config.frontend_url.clone(),
                app.oidc_config.discovery_url.clone(),
            );
            let server = brz_http_server::Server::bind("127.0.0.1:0".parse().unwrap(), handler)
                .await
                .expect("bind test server");
            let address = server.local_addr().expect("local address");
            let serve = tokio::spawn(async move {
                let _ = server.serve_until(std::future::pending::<()>()).await;
            });
            let mut client = TcpStream::connect(address).await.expect("connect");
            client
                .write_all(
                    format!(
                        "GET /api/auth/oidc/callback?{query} HTTP/1.1\r\n\
                             Host: localhost\r\nConnection: close\r\n\r\n"
                    )
                    .as_bytes(),
                )
                .await
                .expect("send request");
            let mut raw = Vec::new();
            client.read_to_end(&mut raw).await.expect("read response");
            serve.abort();
            String::from_utf8_lossy(&raw).into_owned()
        })
        .await
    }

    fn status_of(raw: &str) -> u16 {
        raw.split_whitespace()
            .nth(1)
            .and_then(|code| code.parse().ok())
            .expect("status line")
    }

    fn location_of(raw: &str) -> String {
        let line = raw
            .lines()
            .find(|line| line.to_ascii_lowercase().starts_with("location:"))
            .expect("location header");
        line["location:".len()..].trim().to_string()
    }

    #[tokio::test]
    async fn metadata_failure_returns_recorded_502_body_shape() {
        let app = app_with("test-key", TEST_FRONTEND_URL);
        let state = sign_state(&json!({
            "nonce": "n", "iat": 0, "exp": 4_102_444_800_i64,
            "redirect": "/chat", "frontend_base_path": ""
        }));
        let raw = callback(&app, &format!("code=c&state={state}")).await;
        assert_eq!(status_of(&raw), 502);
    }

    #[tokio::test]
    async fn error_query_redirects_to_frontend() {
        let app = app_with("test-key", TEST_FRONTEND_URL);
        let raw = callback(&app, "error=access_denied").await;
        assert_eq!(status_of(&raw), 302);
        assert_eq!(
            location_of(&raw),
            frontend_login_url("oidc_error", "access_denied")
        );
    }

    #[tokio::test]
    async fn invalid_state_redirects_with_invalid_state_error() {
        let app = app_with("test-key", TEST_FRONTEND_URL);
        let raw = callback(&app, "code=c&state=not-a-jwt").await;
        assert_eq!(status_of(&raw), 302);
        // http-server (like FastAPI's RedirectResponse) percent-encodes the
        // space in the rendered Location header value.
        assert_eq!(
            location_of(&raw),
            frontend_login_url("invalid_state", "Invalid%20state%20parameter")
        );
    }

    #[tokio::test]
    async fn expired_state_redirects_with_invalid_state_error() {
        let app = app_with("test-key", TEST_FRONTEND_URL);
        let state = sign_state(&json!({
            "nonce": "n", "iat": 0, "exp": 1,
            "redirect": "/chat", "frontend_base_path": ""
        }));
        let raw = callback(&app, &format!("code=c&state={state}")).await;
        assert_eq!(status_of(&raw), 302);
        assert!(location_of(&raw).contains("error=invalid_state"));
    }

    #[tokio::test]
    async fn missing_required_query_returns_422() {
        let app = app_with("test-key", TEST_FRONTEND_URL);
        let raw = callback(&app, "code=c").await;
        assert_eq!(status_of(&raw), 422);
    }

    #[test]
    fn builds_frontend_url_like_source() {
        assert_eq!(
            build_frontend_url(TEST_FRONTEND_URL, "/login?error=x", None),
            frontend_login_url("x", "")
        );
        assert_eq!(
            build_frontend_url(TEST_FRONTEND_URL, "/login?error=x", Some("/wework")),
            format!("{TEST_FRONTEND_URL}/wework/login?error=x")
        );
        assert_eq!(
            build_frontend_url(&format!("{TEST_FRONTEND_URL}/"), "/login", None),
            format!("{TEST_FRONTEND_URL}/login")
        );
    }
}
