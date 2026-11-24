// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/auth/oidc/cli-login` — initialize the CLI OIDC login flow.
//!
//! Mirrors `app.api.endpoints.oidc.cli_oidc_login_init` (router prefix
//! `/auth/oidc`, mounted under the application prefix `/api`):
//!
//! 1. `CLILoginInitRequest` (`app/schemas/user.py`) binds the required
//!    `session_id` body field before the handler body runs, so a missing or
//!    non-string field renders the application's 422 validation body and a
//!    non-object body renders the `model_attributes_type` 422.
//! 2. `uuid.UUID(session_id, version=4)` accepts every CPython string form
//!    (dashed, bare hex, braced, `urn:uuid:`-prefixed, any case) and only
//!    overrides the version/variant bits; a parse failure is the source's
//!    `400 {"detail": "Invalid session_id format"}`.
//! 3. `cache_manager.set("cli_login_session:{session_id}", {"status":
//!    "pending"}, expire=300)` — one `SET key value EX 300` over the process
//!    Redis service with `orjson`-compact serialization. `cache_manager.set`
//!    logs and swallows every failure into `False`, so an unreadable or
//!    missing service is the source's `500 {"detail": "Failed to create
//!    login session"}`.
//! 4. The `state` JWT (`nonce`/`iat`/`exp`/`cli_session_id`, HS256, in the
//!    source dict's insertion order) and the `token_urlsafe(32)` nonce are
//!    generated per request, then `get_authorization_url_for_cli` builds the
//!    provider URL with the `{client_id}-cli` client and the CLI redirect
//!    URI. Any failure here is wrapped into `500 {"detail": "Failed to
//!    initialize OIDC login: {e}"}`.
//!
//! The recorded case's Redis dependency is exactly one `SET
//! cli_login_session:{session_id} {"status":"pending"} EX 300`; the discovery
//! document was fetched and cached by an earlier OIDC-touching request of the
//! same recording run, so a warm process issues no HTTP dependency here.

use brz_http_server::StatusCode;
use brz_redis::{Redis, RedisKey2, SetExpiration, SetOptions};
use serde::Serialize;
use serde_json::Value;

use base64::Engine as _;

use crate::config::OidcConfig;
use crate::http_compat::FastApiError;
use crate::oidc_service::{OidcError, OidcService};
use crate::state::AppState;

/// `CLI_SESSION_KEY_PREFIX` (`app/api/endpoints/oidc.py`).
const CLI_SESSION_KEY_PREFIX: &str = "cli_login_session:";
/// `CLI_SESSION_EXPIRE_SECONDS` (`app/api/endpoints/oidc.py`).
const CLI_SESSION_EXPIRE_SECONDS: u64 = 300;

/// `CLILoginInitResponse` (`app/schemas/user.py`): the field order matches
/// the recorded response body.
#[derive(Debug, Serialize)]
struct CliLoginInitResponse {
    auth_url: String,
    session_id: String,
}

/// POST /api/auth/oidc/cli-login: the source's free function, injecting the
/// process-lifetime application state. The source declares no authentication
/// dependency, so the route is public.
#[brz_http_server::post("/api/auth/oidc/cli-login", access = public)]
async fn cli_oidc_login_init(
    #[inject(state)] state: &AppState,
    body: Value,
) -> Result<CliLoginInitResponse, FastApiError> {
    let session_id = bind_session_id(&body)?;
    // `uuid.UUID(session_id, version=4)`; a parse failure is the source 400.
    if !is_uuid_v4_string(&session_id) {
        return Err(FastApiError::detail(
            StatusCode::BAD_REQUEST,
            "Invalid session_id format",
        ));
    }
    // `cache_manager.set(...)`; a swallowed failure is the source 500.
    if !store_pending_session(state.redis.as_ref(), &session_id).await {
        return Err(FastApiError::detail(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to create login session",
        ));
    }
    init_login(&state.oidc_config, &state.oidc, &session_id)
        .await
        .map(|auth_url| CliLoginInitResponse {
            auth_url,
            session_id: session_id.clone(),
        })
}

/// The handler's second `try` block: the per-request nonce, the `state` JWT,
/// and the provider authorization URL. Every failure wraps into the source's
/// `500 {"detail": "Failed to initialize OIDC login: {e}"}`.
async fn init_login(
    config: &OidcConfig,
    oidc: &OidcService,
    session_id: &str,
) -> Result<String, FastApiError> {
    let nonce = random_nonce();
    let now = chrono::Utc::now().timestamp();
    let state =
        encode_state(config, &nonce, now, session_id).map_err(|error| init_error(&error))?;
    let auth_url = oidc
        .get_authorization_url_for_cli(config, &state, &nonce)
        .await
        .map_err(|error| init_error(&service_error_text(&error)))?;
    tracing::info!(session_id, "CLI OIDC login initialized");
    Ok(auth_url)
}

/// `CLILoginInitRequest` body binding: the required `session_id` string.
/// FastAPI validates the body before the handler body runs, so a failure
/// renders the application's `validation_exception_handler` body
/// (`app/core/exceptions.py`).
fn bind_session_id(body: &Value) -> Result<String, FastApiError> {
    let Value::Object(object) = body else {
        return Err(body_error(
            "model_attributes_type",
            "Input should be a valid dictionary or object to extract fields from",
            None,
            body,
        ));
    };
    match object.get("session_id") {
        None => Err(body_error(
            "missing",
            "Field required",
            Some("session_id"),
            body,
        )),
        Some(Value::String(session_id)) => Ok(session_id.clone()),
        Some(value) => Err(body_error(
            "string_type",
            "Input should be a valid string",
            Some("session_id"),
            value,
        )),
    }
}

/// One FastAPI body-validation error entry, rendered through the
/// application's 422 handler shape (`validation_exception_handler` in
/// `app/core/exceptions.py`).
fn body_error(kind: &str, message: &str, field: Option<&str>, input: &Value) -> FastApiError {
    FastApiError::json_body(
        StatusCode::UNPROCESSABLE_ENTITY,
        validation_body(kind, message, field, input),
    )
}

/// `{"error_code":422,"detail":"Request parameter validation failed",
/// "errors":[...]}` — the body `app/core/exceptions.py` renders for
/// FastAPI's `RequestValidationError` on the body binding.
fn validation_body(kind: &str, message: &str, field: Option<&str>, input: &Value) -> Value {
    serde_json::json!({
        "error_code": StatusCode::UNPROCESSABLE_ENTITY.as_u16(),
        "detail": "Request parameter validation failed",
        "errors": [{
            "type": kind,
            "loc": match field {
                Some(field) => serde_json::json!(["body", field]),
                None => serde_json::json!(["body"]),
            },
            "msg": message,
            "input": input,
        }],
    })
}

/// `uuid.UUID(session_id, version=4)` over the string form: strip an optional
/// `urn:`/`uuid:` prefix and braces, drop hyphens, and require exactly 32
/// hexadecimal digits. `version=4` only overrides the version and variant
/// bits, so any parseable 128-bit value is accepted.
fn is_uuid_v4_string(session_id: &str) -> bool {
    let mut hex = session_id;
    for prefix in ["urn:", "uuid:"] {
        if let Some(rest) = hex.strip_prefix(prefix) {
            hex = rest;
        }
    }
    let hex = hex.strip_prefix('{').unwrap_or(hex);
    let hex = hex.strip_suffix('}').unwrap_or(hex);
    let digits: String = hex.chars().filter(|c| *c != '-').collect();
    digits.len() == 32 && digits.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// Source `secrets.token_urlsafe(32)`: 32 random bytes rendered with the
/// URL-safe base64 alphabet and no `=` padding (a 43-character string).
fn random_nonce() -> String {
    let mut bytes = [0_u8; 32];
    getrandom::getrandom(&mut bytes).expect("OS randomness is available");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// State JWT payload for the CLI login. Field order matches the source dict
/// so the signed token serializes identically.
#[derive(Debug, Serialize)]
struct CliLoginStateClaims {
    nonce: String,
    iat: i64,
    exp: i64,
    cli_session_id: String,
}

/// Source `jwt.encode(payload, STATE_JWT_KEY, algorithm="HS256")` over the
/// CLI state payload.
fn encode_state(
    config: &OidcConfig,
    nonce: &str,
    now: i64,
    session_id: &str,
) -> Result<String, String> {
    let claims = CliLoginStateClaims {
        nonce: nonce.to_string(),
        iat: now,
        exp: now + config.state_expire_seconds,
        cli_session_id: session_id.to_string(),
    };
    jsonwebtoken::encode(
        &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::HS256),
        &claims,
        &jsonwebtoken::EncodingKey::from_secret(config.state_key.as_bytes()),
    )
    .map_err(|error| error.to_string())
}

/// The `str()` of the service's `HTTPException(502, ...)`, which the source
/// handler interpolates into its own 500 detail.
fn service_error_text(error: &OidcError) -> String {
    match error {
        OidcError::Metadata(inner) => {
            format!("502: Unable to retrieve OIDC metadata: {inner}")
        }
        OidcError::MetadataField(detail) => format!("502: {detail}"),
        other => other.detail(),
    }
}

fn init_error(message: &str) -> FastApiError {
    FastApiError::detail(
        StatusCode::INTERNAL_SERVER_ERROR,
        format!("Failed to initialize OIDC login: {message}"),
    )
}

/// `cache_manager.set(session_key, {"status": "pending"}, expire=300)`: one
/// `SET key value EX 300` over the process Redis service. The value is
/// serialized with `orjson.dumps` (compact UTF-8). The source logs and
/// swallows every failure into `False`, and an unavailable service degrades
/// the same way.
async fn store_pending_session(redis: Option<&brz_redis::RedisService>, session_id: &str) -> bool {
    let Some(redis) = redis else {
        return false;
    };
    let options =
        SetOptions::default().with_expiration(SetExpiration::Seconds(CLI_SESSION_EXPIRE_SECONDS));
    redis
        .set_with(
            RedisKey2(CLI_SESSION_KEY_PREFIX, session_id),
            pending_session_payload(),
            options,
        )
        .await
        .unwrap_or_else(|error| {
            tracing::error!(%error, session_id, "Error setting cache key");
            false
        })
}

/// `orjson.dumps({"status": "pending"})`.
fn pending_session_payload() -> &'static str {
    r#"{"status":"pending"}"#
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsonwebtoken::{Algorithm, DecodingKey, Validation};
    use serde_json::Value;

    /// The full application 422 body of one bound error: `validation_body`
    /// already renders the complete handler shape, so the assertion compares
    /// its serialization against the source's wire body.
    fn application_validation_body(
        error_kind: &str,
        message: &str,
        field: Option<&str>,
        input: &Value,
    ) -> String {
        serde_json::to_string(&validation_body(error_kind, message, field, input))
            .expect("body serializes")
    }

    const STATE_KEY: &str = "test-state-key";
    const CLIENT_ID: &str = "wegent";
    const CLI_REDIRECT_URI: &str = "https://oidc.example.test/api/auth/oidc/cli-callback";

    fn config() -> OidcConfig {
        OidcConfig {
            state_key: STATE_KEY.to_string(),
            state_expire_seconds: 600,
            discovery_url: "http://127.0.0.1:9/.well-known/openid-configuration".to_string(),
            client_id: CLIENT_ID.to_string(),
            cli_redirect_uri: CLI_REDIRECT_URI.to_string(),
            ..OidcConfig::default()
        }
    }

    fn decode_claims(token: &str) -> Value {
        let mut validation = Validation::new(Algorithm::HS256);
        validation.validate_exp = false;
        jsonwebtoken::decode::<Value>(
            token,
            &DecodingKey::from_secret(STATE_KEY.as_bytes()),
            &validation,
        )
        .expect("decode state")
        .claims
    }

    #[test]
    fn nonce_matches_token_urlsafe_width_and_alphabet() {
        let nonce = random_nonce();
        assert_eq!(nonce.len(), 43);
        assert!(
            nonce
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        );
        assert_ne!(random_nonce(), nonce);
    }

    #[test]
    fn state_claims_serialize_in_source_order() {
        let token = encode_state(
            &config(),
            "n0nce",
            1_000,
            "99503b24-1902-4910-8c06-1a2b6ece1b07",
        )
        .expect("sign state");
        let header = jsonwebtoken::decode_header(&token).expect("decode header");
        assert_eq!(header.alg, Algorithm::HS256);
        assert_eq!(header.typ.as_deref(), Some("JWT"));
        let claims = decode_claims(&token);
        assert_eq!(
            claims
                .as_object()
                .expect("object")
                .keys()
                .collect::<Vec<_>>(),
            ["nonce", "iat", "exp", "cli_session_id"],
        );
        assert_eq!(claims["nonce"], "n0nce");
        assert_eq!(claims["iat"], 1_000);
        assert_eq!(claims["exp"], 1_600);
        assert_eq!(
            claims["cli_session_id"],
            "99503b24-1902-4910-8c06-1a2b6ece1b07"
        );
    }

    #[test]
    fn uuid_v4_validation_matches_cpython_string_forms() {
        // Every CPython string form parses; version=4 only overrides bits.
        for accepted in [
            "99503b24-1902-4910-8c06-1a2b6ece1b07",
            "99503b24190249108c061a2b6ece1b07",
            "{99503B24-1902-4910-8C06-1A2B6ECE1B07}",
            "urn:uuid:99503b24-1902-4910-8c06-1a2b6ece1b07",
            "f81d4fae-7dec-11d0-a765-00a0c91e6bf6",
        ] {
            assert!(
                is_uuid_v4_string(accepted),
                "session_id={accepted:?} should parse"
            );
        }
        // An empty string fails the length check.
        assert!(!is_uuid_v4_string(""));
        // Wrong digit counts and non-hex digits are the source 400.
        for rejected in [
            "not-a-uuid",
            "99503b24-1902-4910-8c06-1a2b6ece1b0",
            "99503b24-1902-4910-8c06-1a2b6ece1b077",
            "z9503b24190249108c061a2b6ece1b07",
        ] {
            assert!(!is_uuid_v4_string(rejected), "session_id={rejected:?}");
        }
    }

    #[test]
    fn body_binding_matches_fastapi_validation() {
        // The recorded body shape binds the session id and ignores extras.
        let body = serde_json::json!({
            "session_id": "99503b24-1902-4910-8c06-1a2b6ece1b07",
            "username": ""
        });
        assert_eq!(
            bind_session_id(&body).expect("session id"),
            "99503b24-1902-4910-8c06-1a2b6ece1b07"
        );

        // A non-object body renders the model_attributes_type 422.
        let error = bind_session_id(&serde_json::json!([1, 2])).unwrap_err();
        assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(
            application_validation_body(
                "model_attributes_type",
                "Input should be a valid dictionary or object to extract fields from",
                None,
                &serde_json::json!([1, 2]),
            ),
            concat!(
                r#"{"error_code":422,"detail":"Request parameter validation failed","errors":"#,
                r#"[{"type":"model_attributes_type","loc":["body"],"msg":"Input should be a valid dictionary or object to extract fields from","input":[1,2]}]}"#
            )
        );

        // A missing field renders the missing 422 with the whole body input.
        let error = bind_session_id(&serde_json::json!({"username": ""})).unwrap_err();
        assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(
            application_validation_body(
                "missing",
                "Field required",
                Some("session_id"),
                &serde_json::json!({"username": ""}),
            ),
            concat!(
                r#"{"error_code":422,"detail":"Request parameter validation failed","errors":"#,
                r#"[{"type":"missing","loc":["body","session_id"],"msg":"Field required","input":{"username":""}}]}"#
            )
        );

        // A non-string field renders the string_type 422.
        let error = bind_session_id(&serde_json::json!({"session_id": 123})).unwrap_err();
        assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(
            application_validation_body(
                "string_type",
                "Input should be a valid string",
                Some("session_id"),
                &serde_json::json!(123),
            ),
            concat!(
                r#"{"error_code":422,"detail":"Request parameter validation failed","errors":"#,
                r#"[{"type":"string_type","loc":["body","session_id"],"msg":"Input should be a valid string","input":123}]}"#
            )
        );
    }

    #[test]
    fn service_error_text_matches_the_source_raise_sites() {
        assert_eq!(
            service_error_text(&OidcError::Metadata("certificate verify failed".into())),
            "502: Unable to retrieve OIDC metadata: certificate verify failed"
        );
        assert_eq!(
            service_error_text(&OidcError::MetadataField(
                "Missing authorization_endpoint in OIDC metadata".into()
            )),
            "502: Missing authorization_endpoint in OIDC metadata"
        );
    }

    #[test]
    fn pending_session_payload_is_orjson_compact() {
        assert_eq!(pending_session_payload(), r#"{"status":"pending"}"#);
    }

    #[tokio::test]
    async fn missing_redis_service_fails_the_session_create() {
        assert!(!store_pending_session(None, "99503b24-1902-4910-8c06-1a2b6ece1b07").await);
    }

    /// The handler is registered exactly once in the public route group;
    /// before this migration the path had no handler and the gateway answered
    /// the recorded request with its `404` fallback.
    #[test]
    fn cli_login_is_registered_in_the_public_group() {
        let paths: Vec<_> = brz_http_server::__private::inventory::iter::<
            crate::__http_registry_http_apis::Entry,
        >()
        .flat_map(|entry| (entry.0.routes)())
        .map(|route| route.path)
        .filter(|path| *path == "/api/auth/oidc/cli-login")
        .collect();
        assert_eq!(paths, ["/api/auth/oidc/cli-login"]);
    }
}
