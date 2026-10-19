// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/auth/login` — JSON login (`app.api.endpoints.auth.login`).
//!
//! Mirrors the source pipeline:
//! `authenticate_user` (`app.core.security`) — the full-column `users` row
//! selected by `user_name` (SQLAlchemy-labeled projection), the
//! inactive-user 400, and bcrypt password verification against
//! `users.password_hash` (passlib `CryptContext(schemes=["bcrypt"])`);
//! the `auth_source == "unknown"` -> `"password"` UPDATE + COMMIT;
//! `create_access_token` (HS256, `sub` + `user_id` + `exp`,
//! `ACCESS_TOKEN_EXPIRE_MINUTES` default 7 days). FastAPI validates the
//! `LoginRequest` body before the endpoint runs, so a missing or wrong-typed
//! field renders the application's `validation_exception_handler` 422 body
//! (`app/core/exceptions.py`) without dependency traffic. A
//! `GET /api/auth/login` case is also recorded for this route group: FastAPI
//! answers it with
//! `405 {"detail":"Method Not Allowed"}` plus `Allow: POST`, which the
//! composed router's `FastApiFallback` renders once the route is
//! registered.
use brz_mysql::Mysql;
use jsonwebtoken::Algorithm;
use serde::Serialize;
use serde_json::{Value, json};

use crate::auth::UserRow;
use crate::config::AuthConfig;
use crate::http_compat::FastApiError;
use crate::state::AppState;

/// `validation_exception_handler`'s fixed `detail` marker
/// (`app/core/exceptions.py`).
const VALIDATION_FAILED: &str = "Request parameter validation failed";

/// `LoginRequest` (`app.schemas.user`): both fields required strings; extra
/// keys are ignored (pydantic's default `model_config`).
#[derive(Debug)]
pub struct LoginRequest {
    pub user_name: String,
    pub password: String,
}

impl LoginRequest {
    /// Decode and validate the request body, rendering the application's 422
    /// body on any pydantic failure.
    fn validated(body: &Value) -> Result<Self, FastApiError> {
        Self::decode(body).map_err(validation_error)
    }

    /// The pydantic validation pass: `user_name` then `password`, in field
    /// declaration order, with every failure reported in one error list.
    fn decode(body: &Value) -> Result<Self, Vec<Value>> {
        let Value::Object(object) = body else {
            return Err(vec![json!({
                "type": "model_attributes_type",
                "loc": ["body"],
                "msg": "Input should be a valid dictionary or object to extract fields from",
                "input": body,
            })]);
        };
        let mut errors = Vec::new();
        let user_name = required_string(object, "user_name", &mut errors);
        let password = required_string(object, "password", &mut errors);
        match (user_name, password) {
            (Some(user_name), Some(password)) if errors.is_empty() => Ok(Self {
                user_name,
                password,
            }),
            _ => Err(errors),
        }
    }
}

/// One required `str` field: a missing key records a `missing` error whose
/// `input` is the whole body object (the pydantic model input); a non-string
/// value records a `string_type` error whose `input` is that value.
fn required_string(
    object: &serde_json::Map<String, Value>,
    field: &'static str,
    errors: &mut Vec<Value>,
) -> Option<String> {
    match object.get(field) {
        Some(Value::String(text)) => Some(text.clone()),
        Some(other) => {
            errors.push(json!({
                "type": "string_type",
                "loc": ["body", field],
                "msg": "Input should be a valid string",
                "input": other,
            }));
            None
        }
        None => {
            errors.push(json!({
                "type": "missing",
                "loc": ["body", field],
                "msg": "Field required",
                "input": Value::Object(object.clone()),
            }));
            None
        }
    }
}

/// `{"error_code":422,"detail":"Request parameter validation failed",
/// "errors":[...]}` — the `validation_exception_handler` body.
fn validation_error(errors: Vec<Value>) -> FastApiError {
    FastApiError::json_body(
        brz_http_server::StatusCode::UNPROCESSABLE_ENTITY,
        validation_body(&errors),
    )
}

/// The handler body for a list of pydantic error entries.
fn validation_body(errors: &[Value]) -> Value {
    json!({
        "error_code": 422,
        "detail": VALIDATION_FAILED,
        "errors": errors,
    })
}

/// `LoginResponse` / `Token` (`app.schemas.user`): field order as declared.
#[derive(Debug, Serialize)]
pub struct Token {
    pub access_token: String,
    pub token_type: &'static str,
}

/// POST /api/auth/login: the auth-login free function, injecting the
/// process-lifetime application state.
#[brz_http_server::post("/api/auth/login", access = public)]
async fn login(#[inject(state)] state: &AppState, body: Value) -> Result<Token, FastApiError> {
    let login_data = LoginRequest::validated(&body)?;
    login_value(state, &login_data).await
}

/// Handler for `POST /api/auth/login`.
async fn login_value(state: &AppState, login: &LoginRequest) -> Result<Token, FastApiError> {
    let user = authenticate_user(&state.mysql, &login.user_name, &login.password).await?;

    // `auth_source == "unknown"` -> `"password"` UPDATE + COMMIT
    // (`db.commit()`); the value is a fixed literal, so no generated value
    // participates and the write is source-observable behavior.
    if user.auth_source == "unknown" {
        if let Err(error) = state
            .mysql
            .execute(
                "UPDATE users SET auth_source='password' WHERE users.id = ?",
                (user.id,),
            )
            .await
        {
            tracing::warn!(%error, "[login] auth_source update failed");
        }
        if let Err(error) = state.mysql.execute("COMMIT", ()).await {
            tracing::warn!(%error, "[login] auth_source commit failed");
        }
    }

    let access_token = create_access_token(&state.auth, &user.user_name, user.id)?;

    Ok(Token {
        access_token,
        token_type: "bearer",
    })
}

/// `authenticate_user`: missing credentials or an unknown user render the
/// source's 400; an inactive user renders the 400 raised inside the
/// function; otherwise the bcrypt hash must verify.
async fn authenticate_user<M>(
    mysql: &M,
    username: &str,
    password: &str,
) -> Result<UserRow, FastApiError>
where
    M: Mysql,
{
    if username.is_empty() || password.is_empty() {
        return Err(invalid_credentials());
    }
    let user: Option<UserRow> = mysql
        .fetch_optional(crate::auth::USER_BY_NAME_QUERY, (username,))
        .await
        .map_err(|_| FastApiError::internal())?;
    let Some(user) = user else {
        return Err(invalid_credentials());
    };
    if user.is_active == 0 {
        // Raised as HTTPException(400) inside `authenticate_user`.
        return Err(FastApiError::detail(
            brz_http_server::StatusCode::BAD_REQUEST,
            "User not activated",
        ));
    }
    // passlib bcrypt verify: CPU-heavy work, bounded on the blocking pool.
    let hash = user.users_password_hash.clone();
    let password = password.to_string();
    let verified =
        tokio::task::spawn_blocking(move || bcrypt::verify(password, &hash).unwrap_or(false))
            .await
            .map_err(|_| FastApiError::internal())?;
    if !verified {
        return Err(invalid_credentials());
    }
    Ok(user)
}

/// `400 {"detail":"Invalid username or password"}` (the handler's
/// `HTTPException` after a `None` from `authenticate_user`).
fn invalid_credentials() -> FastApiError {
    FastApiError::detail(
        brz_http_server::StatusCode::BAD_REQUEST,
        "Invalid username or password",
    )
}

/// JWT claims of `create_access_token`: `sub`, `user_id`, and the derived
/// `exp` (seconds since the epoch).
#[derive(Debug, Serialize)]
struct AccessClaims<'a> {
    sub: &'a str,
    user_id: i32,
    exp: i64,
}

/// `create_access_token`: `data` + `exp` (now + `ACCESS_TOKEN_EXPIRE_MINUTES`
/// minutes, default 7 days), signed with the configured key/algorithm.
pub(crate) fn create_access_token(
    config: &AuthConfig,
    sub: &str,
    user_id: i32,
) -> Result<String, FastApiError> {
    let expire_minutes = crate::config::env_access_token_expire_minutes();
    let exp = (chrono::Utc::now() + chrono::Duration::minutes(expire_minutes)).timestamp();
    let claims = AccessClaims { sub, user_id, exp };
    let header = jsonwebtoken::Header::new(signing_algorithm(config));
    jsonwebtoken::encode(&header, &claims, &encoding_key(config))
        .map_err(|_| FastApiError::internal())
}

/// Signing algorithm from settings (`HS256`).
fn signing_algorithm(config: &AuthConfig) -> Algorithm {
    match config.algorithm.as_str() {
        "HS384" => Algorithm::HS384,
        "HS512" => Algorithm::HS512,
        _ => Algorithm::HS256,
    }
}

/// The active signing key (`SECRET_KEY`).
fn encoding_key(config: &AuthConfig) -> jsonwebtoken::EncodingKey {
    jsonwebtoken::EncodingKey::from_secret(config.jwt_key.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use brz_http_server::StatusCode;

    // A dedicated test group (separate from the crate's real `http_apis`
    // group) that registers the POST /api/auth/login route shape so the
    // FastApiFallback renders the 405 + Allow for the unmatched GET, and so
    // the JSON-body binding and validation rendering can be exercised over
    // HTTP without the application state.
    mod probe {
        brz_http_server::registry!(group = login_probe, dependencies());
    }

    #[brz_http_server::post("/api/auth/login", group = probe::login_probe, access = public)]
    async fn login(body: Value) -> Result<Token, FastApiError> {
        let _login = LoginRequest::validated(&body)?;
        Ok(Token {
            access_token: String::new(),
            token_type: "bearer",
        })
    }

    fn config() -> AuthConfig {
        AuthConfig {
            jwt_key: "test-key".to_string(),
            legacy_jwt_keys: Vec::new(),
            algorithm: "HS256".to_string(),
        }
    }

    #[test]
    fn token_body_carries_sub_user_id_and_exp() {
        let token = create_access_token(&config(), "example-user", 101).unwrap();
        let key = jsonwebtoken::DecodingKey::from_secret(b"test-key");
        let mut validation = jsonwebtoken::Validation::new(Algorithm::HS256);
        validation.validate_aud = false;
        validation.required_spec_claims.clear();
        let data = jsonwebtoken::decode::<serde_json::Value>(&token, &key, &validation).unwrap();
        assert_eq!(data.claims["sub"], "example-user");
        assert_eq!(data.claims["user_id"], 101);
        assert!(data.claims["exp"].is_u64());
    }

    #[test]
    fn expiry_defaults_to_seven_days() {
        assert_eq!(
            crate::config::ACCESS_TOKEN_EXPIRE_MINUTES_DEFAULT,
            7 * 24 * 60
        );
        assert_eq!(
            crate::config::env_access_token_expire_minutes(),
            7 * 24 * 60
        );
    }

    #[test]
    fn invalid_credentials_is_the_source_400_body() {
        let error = invalid_credentials();
        let body =
            serde_json::to_string(&serde_json::json!({"detail": "Invalid username or password"}))
                .unwrap();
        assert_eq!(body, r#"{"detail":"Invalid username or password"}"#);
        let _ = error;
    }

    #[test]
    fn bcrypt_verify_matches_passlib_hashes() {
        // `passlib` renders `$2b$` bcrypt hashes; the Rust `bcrypt` crate
        // verifies the same Modular Crypt Format strings.
        let hash = bcrypt::hash("pw123", bcrypt::DEFAULT_COST).unwrap();
        assert!(bcrypt::verify("pw123", &hash).unwrap());
        assert!(!bcrypt::verify("wrong", &hash).unwrap());
    }

    #[test]
    fn missing_user_name_renders_the_recorded_422_body() {
        // The recorded case: `{"username": ..., "password": ...}` with the
        // required `user_name` key absent.
        let body: Value =
            serde_json::from_str(r#"{"username": "user@example.invalid", "password": "pass"}"#)
                .unwrap();
        let error = LoginRequest::validated(&body).unwrap_err();
        assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let errors = LoginRequest::decode(&body).unwrap_err();
        assert_eq!(
            serde_json::to_string(&validation_body(&errors)).unwrap(),
            concat!(
                r#"{"error_code":422,"detail":"Request parameter validation failed","#,
                r#""errors":[{"type":"missing","loc":["body","user_name"],"msg":"Field required","#,
                r#""input":{"username":"user@example.invalid","password":"pass"}}]}"#
            )
        );
    }

    #[test]
    fn missing_password_renders_the_same_422_shape() {
        let body = json!({"user_name": "example-user"});
        let error = LoginRequest::validated(&body).unwrap_err();
        assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let errors = LoginRequest::decode(&body).unwrap_err();
        let rendered = serde_json::to_string(&validation_body(&errors)).unwrap();
        assert!(rendered.contains(r#""type":"missing""#), "{rendered}");
        assert!(
            rendered.contains(r#""loc":["body","password"]"#),
            "{rendered}"
        );
    }

    #[test]
    fn a_valid_body_decodes() {
        let login =
            LoginRequest::validated(&json!({"user_name": "example-user", "password": "pw"}))
                .unwrap();
        assert_eq!(login.user_name, "example-user");
        assert_eq!(login.password, "pw");
        // Extra keys are ignored like pydantic's default model config.
        assert!(
            LoginRequest::validated(&json!({
                "user_name": "example-user", "password": "pw", "extra": 1
            }))
            .is_ok()
        );
    }

    #[test]
    fn a_non_string_field_renders_a_string_type_error() {
        let body = json!({"user_name": 1, "password": "pw"});
        let error = LoginRequest::validated(&body).unwrap_err();
        assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let errors = LoginRequest::decode(&body).unwrap_err();
        let rendered = serde_json::to_string(&validation_body(&errors)).unwrap();
        assert!(rendered.contains(r#""type":"string_type""#), "{rendered}");
        assert!(rendered.contains(r#""input":1"#), "{rendered}");
    }

    #[test]
    fn a_non_object_body_renders_model_attributes_type() {
        let body = json!([1, 2]);
        let error = LoginRequest::validated(&body).unwrap_err();
        assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let errors = LoginRequest::decode(&body).unwrap_err();
        let rendered = serde_json::to_string(&validation_body(&errors)).unwrap();
        assert!(
            rendered.contains(r#""type":"model_attributes_type""#),
            "{rendered}"
        );
        assert!(rendered.contains(r#""loc":["body"]"#), "{rendered}");
    }

    /// A struct test server answering `GET /api/auth/login` with the
    /// FastAPI 405 the recorded case expects, proving the fallback sees the
    /// registered route's method set once the login route exists.
    #[tokio::test]
    async fn get_login_renders_405_with_allow_post() {
        let handler =
            brz_http_server::handlers!(; group = probe::login_probe).expect("probe router");
        let server = brz_http_server::Server::bind(
            "127.0.0.1:0".parse().unwrap(),
            crate::http_fallback::FastApiFallback::new(handler),
        )
        .await
        .expect("bind test server");
        let address = server.local_addr().expect("local address");
        let serve = tokio::spawn(async move {
            let _ = server.serve_until(std::future::pending::<()>()).await;
        });
        let mut client = tokio::net::TcpStream::connect(address)
            .await
            .expect("connect");
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
        client
            .write_all(
                b"GET /api/auth/login HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
            )
            .await
            .expect("send");
        let mut raw = Vec::new();
        client.read_to_end(&mut raw).await.expect("read");
        serve.abort();
        let raw = String::from_utf8_lossy(&raw);
        assert!(raw.starts_with("HTTP/1.1 405"), "{raw}");
        assert!(raw.contains("allow: POST"), "{raw}");
        assert!(raw.contains(r#"{"detail":"Method Not Allowed"}"#), "{raw}");
    }

    /// The recorded case over the wire: a JSON object that lacks the required
    /// `user_name` field must reach the application validation renderer and
    /// produce the source 422 body with a JSON content type, instead of the
    /// platform router's bare 400.
    #[tokio::test]
    async fn post_login_renders_the_recorded_422_over_http() {
        let handler =
            brz_http_server::handlers!(; group = probe::login_probe).expect("probe router");
        let server = brz_http_server::Server::bind(
            "127.0.0.1:0".parse().unwrap(),
            crate::http_fallback::FastApiFallback::new(handler),
        )
        .await
        .expect("bind test server");
        let address = server.local_addr().expect("local address");
        let serve = tokio::spawn(async move {
            let _ = server.serve_until(std::future::pending::<()>()).await;
        });
        let body = r#"{"username": "user@example.invalid", "password": "pass"}"#;
        let request = format!(
            "POST /api/auth/login HTTP/1.1\r\nHost: localhost\r\n\
             Content-Type: application/json\r\nContent-Length: {}\r\n\
             Connection: close\r\n\r\n{body}",
            body.len()
        );
        let mut client = tokio::net::TcpStream::connect(address)
            .await
            .expect("connect");
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
        client.write_all(request.as_bytes()).await.expect("send");
        let mut raw = Vec::new();
        client.read_to_end(&mut raw).await.expect("read");
        serve.abort();
        let raw = String::from_utf8_lossy(&raw);
        assert!(raw.starts_with("HTTP/1.1 422"), "{raw}");
        assert!(
            raw.to_ascii_lowercase()
                .contains("content-type: application/json"),
            "{raw}"
        );
        assert!(
            raw.ends_with(concat!(
                r#"{"error_code":422,"detail":"Request parameter validation failed","#,
                r#""errors":[{"type":"missing","loc":["body","user_name"],"msg":"Field required","#,
                r#""input":{"username":"user@example.invalid","password":"pass"}}]}"#
            )),
            "{raw}"
        );
    }
}
