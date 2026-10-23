// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/auth/oidc/cli-callback` — finish a CLI OIDC login.
//!
//! Mirrors `app.api.endpoints.oidc.cli_oidc_callback` (router prefix
//! `/auth/oidc`, mounted under the application prefix `/api`):
//!
//! 1. `jwt.decode(state, STATE_JWT_KEY, algorithms=["HS256"])` — the JWT
//!    signature and, with PyJWT's zero-second leeway, the `exp` claim — then
//!    the `cli_session_id` presence check. Every failure in this block
//!    renders `"Invalid login session."`.
//! 2. `if error:` short-circuits an OIDC error reported on the query string.
//! 3. `oidc_service.exchange_code_for_tokens_for_cli` (the `-cli` client id
//!    and the CLI redirect URI), the signature-only `verify_id_token` (the
//!    source's `authlib` call validates no claim, so the nonce and the
//!    `{client_id}-cli` audience it passes are inert), and the optional
//!    warning-only `get_user_info` lookup.
//! 4. The local `users` row is resolved by `user_name`, updated when the
//!    email, `auth_source`, or `employee_id` preference changed, or created.
//! 5. `create_access_token` mints the session token, which is written to the
//!    `cli_login_session:{session_id}` Redis record as
//!    `{"status":"success","access_token":...,"username":...}` with a 300
//!    second TTL.
//!
//! Every outcome except the required-parameter binding answers `200
//! text/html; charset=utf-8`: the source's literal success page, or its error
//! page carrying `"Authentication failed: {e}"` / `"Invalid login session."`.
//!
//! The source seeds default resources for a newly created user through
//! `app.services.k_batch.apply_default_resources_sync`. After the user write
//! commits, the shared resource initializer applies those defaults with the
//! application-owned Task/Workspace storage adapter and best-effort errors.

use brz_http_server::{Html, StatusCode};
use brz_redis::{Redis, RedisKey2, SetExpiration, SetOptions};
use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::config::OidcConfig;
use crate::http_compat::FastApiError;
use crate::oidc_service::OidcError;
use crate::state::AppState;
#[cfg(test)]
use crate::user_reader::USER_ENTITY_BY_ID_QUERY;
#[cfg(test)]
use users::USER_ENTITY_BY_NAME_QUERY;

mod users;

/// `CLI_SESSION_KEY_PREFIX` (`app.api.endpoints.oidc`).
const CLI_SESSION_KEY_PREFIX: &str = "cli_login_session:";
/// `CLI_SESSION_EXPIRE_SECONDS` (`app.api.endpoints.oidc`).
const CLI_SESSION_EXPIRE_SECONDS: u64 = 300;
/// `EMPLOYEE_ID_PREFERENCE_KEY` (`app.api.endpoints.oidc`).
const EMPLOYEE_ID_PREFERENCE_KEY: &str = "employee_id";

/// Source `_cli_callback_success_page`: the exact literal template.
const SUCCESS_PAGE: &str = r#"
    <!DOCTYPE html>
    <html>
    <head>
        <title>Login Successful</title>
        <style>
            body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                display: flex;
                justify-content: center;
                align-items: center;
                height: 100vh;
                margin: 0;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            }
            .container {
                text-align: center;
                background: white;
                padding: 40px 60px;
                border-radius: 16px;
                box-shadow: 0 10px 40px rgba(0,0,0,0.2);
            }
            .success-icon {
                font-size: 64px;
                margin-bottom: 20px;
            }
            h1 {
                color: #10b981;
                margin-bottom: 10px;
            }
            p {
                color: #666;
                font-size: 16px;
            }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="success-icon">✓</div>
            <h1>Login Successful!</h1>
            <p>You can now close this window and return to the terminal.</p>
        </div>
    </body>
    </html>
    "#;

/// Source `_cli_callback_error_page` up to and including the `<p>` that opens
/// the interpolated message, and the remainder from that message's closing
/// `</p>`. Kept as two literals so the message needs no brace escaping.
const ERROR_PAGE_PREFIX: &str = r#"
    <!DOCTYPE html>
    <html>
    <head>
        <title>Login Failed</title>
        <style>
            body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                display: flex;
                justify-content: center;
                align-items: center;
                height: 100vh;
                margin: 0;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            }
            .container {
                text-align: center;
                background: white;
                padding: 40px 60px;
                border-radius: 16px;
                box-shadow: 0 10px 40px rgba(0,0,0,0.2);
            }
            .error-icon {
                font-size: 64px;
                margin-bottom: 20px;
            }
            h1 {
                color: #ef4444;
                margin-bottom: 10px;
            }
            p {
                color: #666;
                font-size: 16px;
            }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="error-icon">✗</div>
            <h1>Login Failed</h1>
            <p>"#;

const ERROR_PAGE_SUFFIX: &str = r#"</p>
            <p>Please close this window and try again.</p>
        </div>
    </body>
    </html>
    "#;

/// GET /api/auth/oidc/cli-callback: the source's free function. It declares no
/// authentication dependency, so the route is public.
#[brz_http_server::get("/api/auth/oidc/cli-callback", access = public)]
async fn cli_oidc_callback(
    #[inject(state)] app: &AppState,
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
) -> Result<Html, FastApiError> {
    // FastAPI binds both required query parameters before the handler body
    // runs; a missing value renders the application's 422 validation body.
    let (code, state) = match (code, state) {
        (Some(code), Some(state)) => (code, state),
        (code, state) => return Err(validation_error(code.is_none(), state.is_none())),
    };

    // `payload = jwt.decode(state, ...)` plus the `cli_session_id` check; the
    // source's own `now > payload["exp"]` comparison is unreachable because
    // PyJWT already rejects an expired token inside this `try` block, and both
    // failures answer the same page.
    let claims = match decode_state(&app.oidc_config, &state) {
        Ok(claims) => claims,
        Err(reason) => {
            tracing::error!(%reason, "CLI callback: invalid state parameter");
            return Ok(error_page("Invalid login session."));
        }
    };

    // `if error:` — Python truthiness, so an empty value falls through.
    if let Some(error) = error.filter(|value| !value.is_empty()) {
        tracing::error!(%error, "CLI OIDC callback error");
        store_session(
            app.redis.as_ref(),
            &claims.session_id,
            &failed_session(&error),
        )
        .await;
        return Ok(error_page(&format!("Authentication failed: {error}")));
    }

    match complete_login(app, &code, claims.nonce.as_deref()).await {
        Ok((user_name, access_token)) => {
            store_session(
                app.redis.as_ref(),
                &claims.session_id,
                &success_session(&access_token, &user_name),
            )
            .await;
            tracing::info!(user_name, "CLI OIDC login success");
            Ok(Html(SUCCESS_PAGE.to_string()))
        }
        Err(message) => {
            store_session(
                app.redis.as_ref(),
                &claims.session_id,
                &failed_session(&message),
            )
            .await;
            Ok(error_page(&format!("Authentication failed: {message}")))
        }
    }
}

/// The `state` JWT fields the callback reads.
struct CliStateClaims {
    /// `payload.get("cli_session_id")`, required to be a non-empty string.
    session_id: String,
    /// `payload["nonce"]`; the source raises when the claim is absent, and any
    /// non-string value simply fails the ID-token nonce comparison.
    nonce: Option<String>,
}

/// `jwt.decode(state, STATE_JWT_KEY, algorithms=["HS256"])` followed by the
/// `cli_session_id` presence check. The signing key, algorithm, and
/// zero-second expiration leeway match PyJWT's defaults for the source call.
fn decode_state(config: &OidcConfig, state: &str) -> Result<CliStateClaims, String> {
    let mut validation = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::HS256);
    validation.validate_exp = true;
    // PyJWT's `decode` default leeway is zero.
    validation.leeway = 0;
    let claims = jsonwebtoken::decode::<Value>(
        state,
        &jsonwebtoken::DecodingKey::from_secret(config.state_key.as_bytes()),
        &validation,
    )
    .map_err(|error| error.to_string())?
    .claims;

    // `nonce = payload["nonce"]` raises `KeyError` for an absent claim.
    let nonce = claims
        .get("nonce")
        .ok_or_else(|| "missing nonce".to_string())?;
    let nonce = nonce.as_str().map(str::to_owned);

    // `session_id = payload.get("cli_session_id")` then `if not session_id`.
    let session_id = claims
        .get("cli_session_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "missing cli_session_id".to_string())?;
    Ok(CliStateClaims {
        session_id: session_id.to_string(),
        nonce,
    })
}

/// The source's success path inside the second `try` block: token exchange,
/// ID-token verification, optional user info, user resolution, and the access
/// token. Any failure becomes the `str(e)` the source interpolates into
/// `"Authentication failed: {e}"`.
async fn complete_login(
    app: &AppState,
    code: &str,
    nonce: Option<&str>,
) -> Result<(String, String), String> {
    let tokens = app
        .oidc
        .exchange_code_for_tokens_for_cli(&app.oidc_config, code)
        .await
        .map_err(|error| http_exception_text(&error))?;

    let id_token = tokens
        .get("id_token")
        .and_then(Value::as_str)
        .ok_or_else(|| "Missing ID Token in response".to_string())?;

    let mut user_data = app
        .oidc
        .verify_id_token(&app.oidc_config, id_token, nonce.unwrap_or_default())
        .await
        .map_err(|error| http_exception_text(&error))?;

    // `if access_token:` then the warning-only `get_user_info` lookup; its
    // claims are merged over the ID-token claims (`{**claims, **user_info}`).
    if let Some(access_token) = tokens
        .get("access_token")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        && let Some(endpoint) = userinfo_endpoint(app).await
        && let Some(extra) = app.oidc.get_user_info(&endpoint, access_token).await
        && let (Some(base), Some(extra)) = (user_data.as_object_mut(), extra.as_object())
    {
        for (key, value) in extra {
            base.insert(key.clone(), value.clone());
        }
    }

    let subject = user_data
        .get("sub")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty());
    let email = user_data
        .get("email")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            user_data
                .get("preferred_username")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
        })
        .map(str::to_owned)
        .unwrap_or_else(|| {
            // `f"{user_id}@unknown.email"` renders a missing identifier as
            // the literal `None`.
            format!("{}@unknown.email", subject.unwrap_or("None"))
        });

    let Some(subject) = subject else {
        return Err("Missing user identifier in ID Token".to_string());
    };

    // `email.split("@")[0] if "@" in email else user_id`.
    let user_name = email
        .split_once('@')
        .map_or(subject, |(local, _)| local)
        .to_string();

    let employee_id = clean_string(user_data.get("userid"));
    let user = users::resolve_user(&app.mysql, &user_name, &email, employee_id.as_deref()).await?;
    if user.created {
        crate::new_user_resources::apply(app, app.seed_tasks.as_ref(), i64::from(user.id)).await;
    }
    if !user.is_active {
        return Err("User not active".to_string());
    }
    let user_id = user.id;
    let resolved_name = user.user_name;

    let access_token = crate::auth_login::create_access_token(&app.auth, &resolved_name, user_id)
        .map_err(|_| "Unable to create access token".to_string())?;
    Ok((resolved_name, access_token))
}

/// `oidc_service.get_metadata()["userinfo_endpoint"]`; `get_user_info` treats
/// a missing endpoint as a warning and returns no claims.
async fn userinfo_endpoint(app: &AppState) -> Option<String> {
    app.oidc
        .get_metadata()
        .await
        .ok()?
        .to_value()
        .get("userinfo_endpoint")
        .and_then(Value::as_str)
        .map(str::to_owned)
}

/// `_store_employee_id_preference`: `Some(serialized preferences)` when the
/// stored `employee_id` differs, `None` when there is nothing to write.
fn store_employee_id_preference(preferences: &str, employee_id: Option<&str>) -> Option<String> {
    // `if not employee_id: return False` — an absent or empty claim writes
    // nothing.
    let employee_id = employee_id.filter(|value| !value.is_empty())?;
    let mut map = load_preferences(preferences);
    if map.get(EMPLOYEE_ID_PREFERENCE_KEY).and_then(Value::as_str) == Some(employee_id) {
        return None;
    }
    map.insert(
        EMPLOYEE_ID_PREFERENCE_KEY.to_string(),
        Value::String(employee_id.to_string()),
    );
    // `json.dumps(preferences, ensure_ascii=False)`.
    Some(crate::internal_callback::py_json::python_dumps_utf8(
        &Value::Object(map),
    ))
}

/// `_load_preferences`: a decoded JSON object, or `{}` for every other shape.
fn load_preferences(raw: &str) -> Map<String, Value> {
    if raw.is_empty() {
        return Map::new();
    }
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

/// Source `_clean_string(user_data.get("userid"))`: a scalar is stringified,
/// trimmed, and an empty result becomes `None`. The CAS `userid` claim is a
/// scalar, which is the only shape this path receives.
fn clean_string(value: Option<&Value>) -> Option<String> {
    let text = match value? {
        Value::Null => return None,
        Value::String(text) => text.clone(),
        Value::Bool(true) => "True".to_string(),
        Value::Bool(false) => "False".to_string(),
        Value::Number(number) => number.to_string(),
        Value::Array(_) | Value::Object(_) => return None,
    };
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// `str(e)` for a service failure: Starlette renders `HTTPException` as
/// `"{status_code}: {detail}"`, and the source interpolates that into the
/// error page.
///
/// [`OidcError`] collates the source's 400 failures (`Token exchange failed`,
/// `ID Token verification failed`) and 502 failures (`Unable to retrieve
/// JWKS`, `OIDC JWKS payload invalid`) into the shared `Provider` and
/// `InvalidToken` variants, so the status is recovered from the source message
/// the variant carries.
fn http_exception_text(error: &OidcError) -> String {
    match error {
        OidcError::Metadata(inner) => format!("502: Unable to retrieve OIDC metadata: {inner}"),
        OidcError::MetadataField(detail) => format!("502: {detail}"),
        OidcError::Provider(detail) | OidcError::InvalidToken(detail) => {
            format!("{}: {detail}", source_status(detail))
        }
    }
}

/// The source status behind a shared provider detail string: `get_jwks`
/// raises its failures as 502, while the token exchange and ID-token
/// verification raise 400.
fn source_status(detail: &str) -> u16 {
    if detail.starts_with("Unable to retrieve JWKS") || detail == "OIDC JWKS payload invalid" {
        502
    } else {
        400
    }
}

/// `cache_manager.set(session_key, value, expire=300)`: one `SET key value EX
/// 300` over the process Redis service. The source logs and swallows every
/// failure, and an unavailable service degrades the same way.
async fn store_session(redis: Option<&brz_redis::RedisService>, session_id: &str, payload: &str) {
    let Some(redis) = redis else {
        return;
    };
    let options =
        SetOptions::default().with_expiration(SetExpiration::Seconds(CLI_SESSION_EXPIRE_SECONDS));
    if let Err(error) = redis
        .set_with(
            RedisKey2(CLI_SESSION_KEY_PREFIX, session_id),
            payload,
            options,
        )
        .await
    {
        tracing::error!(%error, session_id, "cli login session cache write failed");
    }
}

/// `{"status": "success", "access_token": ..., "username": ...}`
/// (`cache_manager.set` serializes with `orjson.dumps`, i.e. compact UTF-8).
#[derive(Debug, Serialize)]
struct SuccessSession<'a> {
    status: &'static str,
    access_token: &'a str,
    username: &'a str,
}

fn success_session(access_token: &str, username: &str) -> String {
    serde_json::to_string(&SuccessSession {
        status: "success",
        access_token,
        username,
    })
    .expect("session record serializes")
}

/// `{"status": "failed", "error": ...}`.
#[derive(Debug, Serialize)]
struct FailedSession<'a> {
    status: &'static str,
    error: &'a str,
}

fn failed_session(error: &str) -> String {
    serde_json::to_string(&FailedSession {
        status: "failed",
        error,
    })
    .expect("session record serializes")
}

/// `_cli_callback_error_page(message)`.
fn error_page(message: &str) -> Html {
    let mut html =
        String::with_capacity(ERROR_PAGE_PREFIX.len() + message.len() + ERROR_PAGE_SUFFIX.len());
    html.push_str(ERROR_PAGE_PREFIX);
    html.push_str(message);
    html.push_str(ERROR_PAGE_SUFFIX);
    Html(html)
}

/// The application's `validation_exception_handler` body
/// (`app/core/exceptions.py`) for the missing required query parameters, in
/// FastAPI's declaration order (`code`, `state`).
fn validation_error(missing_code: bool, missing_state: bool) -> FastApiError {
    FastApiError::json_body(
        StatusCode::UNPROCESSABLE_ENTITY,
        validation_body(missing_code, missing_state),
    )
}

fn validation_body(missing_code: bool, missing_state: bool) -> Value {
    let mut errors = Vec::new();
    if missing_code {
        errors.push(validation_entry("code"));
    }
    if missing_state {
        errors.push(validation_entry("state"));
    }
    json!({
        "error_code": StatusCode::UNPROCESSABLE_ENTITY.as_u16(),
        "detail": "Request parameter validation failed",
        "errors": errors,
    })
}

fn validation_entry(field: &str) -> Value {
    json!({
        "type": "missing",
        "loc": ["query", field],
        "msg": "Field required",
        "input": Value::Null,
    })
}

/// `security.get_password_hash(str(uuid.uuid4()))`'s random input: one
/// RFC 4122 version 4 UUID rendered in the canonical dashed form.
fn random_uuid_v4() -> String {
    use std::fmt::Write as _;

    let mut bytes = [0_u8; 16];
    getrandom::getrandom(&mut bytes).expect("OS randomness is available");
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let mut out = String::with_capacity(36);
    for (index, byte) in bytes.iter().enumerate() {
        if matches!(index, 4 | 6 | 8 | 10) {
            out.push('-');
        }
        let _ = write!(out, "{byte:02x}");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const STATE_KEY: &str = "test-state-key";

    fn config() -> OidcConfig {
        OidcConfig {
            state_key: STATE_KEY.to_string(),
            discovery_url: "http://127.0.0.1:9/.well-known/openid-configuration".to_string(),
            ..OidcConfig::default()
        }
    }

    fn sign_state(claims: &Value) -> String {
        jsonwebtoken::encode(
            &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::HS256),
            claims,
            &jsonwebtoken::EncodingKey::from_secret(STATE_KEY.as_bytes()),
        )
        .expect("sign state")
    }

    #[test]
    fn success_page_matches_the_source_template() {
        // The source template is 1297 UTF-8 bytes and opens with a newline.
        assert_eq!(SUCCESS_PAGE.len(), 1297);
        assert!(SUCCESS_PAGE.starts_with("\n    <!DOCTYPE html>\n"));
        assert!(SUCCESS_PAGE.ends_with("    </html>\n    "));
        assert!(SUCCESS_PAGE.contains("<title>Login Successful</title>"));
    }

    #[test]
    fn error_page_matches_the_source_template() {
        let page = error_page("boom");
        assert!(page.0.starts_with("\n    <!DOCTYPE html>\n"));
        assert!(page.0.contains("<title>Login Failed</title>"));
        assert!(page.0.contains("<p>boom</p>"));
        assert!(page
            .0
            .ends_with("<p>Please close this window and try again.</p>\n        </div>\n    </body>\n    </html>\n    "));
        // The source error template is 1286 bytes around the interpolated
        // message (1179 before it and 107 after it).
        assert_eq!(ERROR_PAGE_PREFIX.len() + ERROR_PAGE_SUFFIX.len(), 1286);
        assert_eq!(
            page.0.len(),
            ERROR_PAGE_PREFIX.len() + "boom".len() + ERROR_PAGE_SUFFIX.len()
        );
    }

    #[test]
    fn state_claims_require_nonce_and_session_id() {
        let config = config();
        let state = sign_state(&json!({
            "nonce": "n",
            "iat": 0,
            "exp": 4_102_444_800_i64,
            "cli_session_id": "95d2e788-57d7-43db-811b-4522c9bc19d4",
        }));
        let claims = decode_state(&config, &state).expect("valid state");
        assert_eq!(claims.session_id, "95d2e788-57d7-43db-811b-4522c9bc19d4");
        assert_eq!(claims.nonce.as_deref(), Some("n"));

        for claims in [
            json!({"exp": 4_102_444_800_i64, "cli_session_id": "s"}),
            json!({"nonce": "n", "exp": 4_102_444_800_i64}),
            json!({"nonce": "n", "exp": 4_102_444_800_i64, "cli_session_id": ""}),
        ] {
            assert!(decode_state(&config, &sign_state(&claims)).is_err());
        }
    }

    #[test]
    fn expired_state_is_rejected_without_leeway() {
        // PyJWT rejects an expired `state` inside the source `try` block, so
        // the page is the generic "Invalid login session." one.
        let config = config();
        let state = sign_state(&json!({
            "nonce": "n", "iat": 0, "exp": 1, "cli_session_id": "s"
        }));
        assert!(decode_state(&config, &state).is_err());
    }

    #[test]
    fn state_signed_with_another_key_is_rejected() {
        let state = jsonwebtoken::encode(
            &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::HS256),
            &json!({"nonce": "n", "exp": 4_102_444_800_i64, "cli_session_id": "s"}),
            &jsonwebtoken::EncodingKey::from_secret(b"other-key"),
        )
        .expect("sign state");
        assert!(decode_state(&config(), &state).is_err());
    }

    #[test]
    fn missing_required_query_parameters_render_the_application_422_body() {
        let error = validation_error(true, true);
        assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(
            serde_json::to_string(&validation_body(true, true)).expect("body serializes"),
            concat!(
                r#"{"error_code":422,"detail":"Request parameter validation failed","errors":"#,
                r#"[{"type":"missing","loc":["query","code"],"msg":"Field required","input":null},"#,
                r#"{"type":"missing","loc":["query","state"],"msg":"Field required","input":null}]}"#
            )
        );

        // Only the absent parameter is reported, in declaration order.
        assert_eq!(
            serde_json::to_string(&validation_body(false, true)).expect("body serializes"),
            concat!(
                r#"{"error_code":422,"detail":"Request parameter validation failed","errors":"#,
                r#"[{"type":"missing","loc":["query","state"],"msg":"Field required","input":null}]}"#
            )
        );
    }

    #[test]
    fn session_records_serialize_in_source_field_order() {
        assert_eq!(
            success_session("tok", "example-user"),
            r#"{"status":"success","access_token":"tok","username":"example-user"}"#
        );
        assert_eq!(
            failed_session("boom"),
            r#"{"status":"failed","error":"boom"}"#
        );
    }

    #[test]
    fn employee_id_preference_matches_the_source_updates() {
        // A missing claim, and a preference that already matches, write nothing.
        assert!(store_employee_id_preference("{}", None).is_none());
        assert!(store_employee_id_preference("{}", Some("")).is_none());
        assert_eq!(
            store_employee_id_preference(r#"{"employee_id": "220577"}"#, Some("220577")),
            None
        );
        // A changed preference keeps the existing keys and Python's spacing.
        assert_eq!(
            store_employee_id_preference(r#"{"a": 1, "employee_id": "1"}"#, Some("220577")),
            Some(r#"{"a": 1, "employee_id": "220577"}"#.to_string())
        );
        // A non-string stored value never matches the string claim.
        assert_eq!(
            store_employee_id_preference(r#"{"employee_id": 220577}"#, Some("220577")),
            Some(r#"{"employee_id": "220577"}"#.to_string())
        );
        // Undecodable and non-object payloads restart from an empty object.
        assert_eq!(
            store_employee_id_preference("not json", Some("220577")),
            Some(r#"{"employee_id": "220577"}"#.to_string())
        );
    }

    #[test]
    fn preferences_keep_non_ascii_characters() {
        // `json.dumps(..., ensure_ascii=False)` keeps the source UTF-8 bytes.
        assert_eq!(
            store_employee_id_preference(r#"{"name": "胡伟"}"#, Some("220577")),
            Some(r#"{"name": "胡伟", "employee_id": "220577"}"#.to_string())
        );
    }

    #[test]
    fn clean_string_matches_the_source_coercions() {
        assert_eq!(clean_string(None), None);
        assert_eq!(clean_string(Some(&Value::Null)), None);
        assert_eq!(
            clean_string(Some(&json!("  220577 "))),
            Some("220577".into())
        );
        assert_eq!(clean_string(Some(&json!(""))), None);
        assert_eq!(clean_string(Some(&json!("  "))), None);
        assert_eq!(clean_string(Some(&json!(220577))), Some("220577".into()));
        assert_eq!(clean_string(Some(&json!(true))), Some("True".into()));
        assert_eq!(clean_string(Some(&json!(["x"]))), None);
    }

    #[test]
    fn provider_status_matches_the_source_raise_sites() {
        assert_eq!(
            http_exception_text(&OidcError::Provider(
                "Token exchange failed: 400 Bad Request".into()
            )),
            "400: Token exchange failed: 400 Bad Request"
        );
        assert_eq!(
            http_exception_text(&OidcError::Provider(
                "Unable to retrieve JWKS: timeout".into()
            )),
            "502: Unable to retrieve JWKS: timeout"
        );
        assert_eq!(
            http_exception_text(&OidcError::InvalidToken(
                "ID Token verification failed: bad signature".into()
            )),
            "400: ID Token verification failed: bad signature"
        );
        assert_eq!(
            http_exception_text(&OidcError::InvalidToken("OIDC JWKS payload invalid".into())),
            "502: OIDC JWKS payload invalid"
        );
        assert_eq!(
            http_exception_text(&OidcError::Metadata("certificate verify failed".into())),
            "502: Unable to retrieve OIDC metadata: certificate verify failed"
        );
        assert_eq!(
            http_exception_text(&OidcError::MetadataField(
                "Missing token_endpoint in OIDC metadata".into()
            )),
            "502: Missing token_endpoint in OIDC metadata"
        );
    }

    #[test]
    fn user_lookup_and_refresh_statements_match_the_source_rendering() {
        assert_eq!(USER_ENTITY_BY_NAME_QUERY.matches('?').count(), 1);
        assert!(USER_ENTITY_BY_NAME_QUERY.contains("WHERE users.user_name = ?"));
        assert!(!USER_ENTITY_BY_NAME_QUERY.contains("LIMIT"));
        assert!(!USER_ENTITY_BY_NAME_QUERY.contains(" AS users_"));
        // `db.refresh(user)` reuses the shared identity-map statement.
        assert!(USER_ENTITY_BY_ID_QUERY.contains("WHERE users.id = ?"));
        assert!(!USER_ENTITY_BY_ID_QUERY.contains("LIMIT"));
    }

    #[test]
    fn generated_uuid_is_a_version_4_identifier() {
        let uuid = random_uuid_v4();
        assert_eq!(uuid.len(), 36);
        let parts: Vec<&str> = uuid.split('-').collect();
        assert_eq!(
            parts.iter().map(|part| part.len()).collect::<Vec<_>>(),
            [8, 4, 4, 4, 12]
        );
        assert!(parts[2].starts_with('4'));
        assert!(matches!(parts[3].as_bytes()[0], b'8' | b'9' | b'a' | b'b'));
        assert_ne!(random_uuid_v4(), uuid);
    }

    /// The callback is registered exactly once in the public route group;
    /// before this migration the path had no handler and the gateway answered
    /// the recorded request with its `404` fallback.
    #[test]
    fn cli_callback_is_registered_in_the_public_group() {
        let paths: Vec<_> = brz_http_server::__private::inventory::iter::<
            crate::__http_registry_http_apis::Entry,
        >()
        .flat_map(|entry| (entry.0.routes)())
        .map(|route| route.path)
        .filter(|path| *path == "/api/auth/oidc/cli-callback")
        .collect();
        assert_eq!(paths, ["/api/auth/oidc/cli-callback"]);
    }
}
