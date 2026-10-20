// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Wework desktop authorization sessions: session creation, the cloud Web
//! app's approve action, and the desktop app's poll loop.
//!
//! All mirror `app.api.endpoints.wework_auth` (router prefix `/auth/wework`,
//! mounted under the app prefix `/api`):
//!
//! - `GET /api/auth/wework/config` (`get_wework_web_config`): return the
//!   public Web URL (`FRONTEND_URL` without trailing slashes) and the
//!   Socket.IO URL (`WEGENT_SOCKET_URL`, stripped; `null` when empty).
//! - `POST /api/auth/wework/sessions` (`create_wework_auth_session`): mint a
//!   UUIDv4 session id and a 32-byte `poll_token`, optionally bind the
//!   request's EC P-256 device public key (validating it and storing its RFC
//!   7638 thumbprint), write the pending record as
//!   `SET wework_auth_session:{id} <json> EX 300`, then answer with the
//!   session id, poll token, authorize URL, Web URL, expiry, and poll
//!   interval.
//! - `POST /api/auth/wework/sessions/{session_id}/approve`
//!   (`approve_wework_auth_session`): read the Redis `wework_auth_session:{id}`
//!   record, short-circuit an already-processed session to
//!   `200 {"status": <status>}` with no write, mint the device-bound or legacy
//!   access/refresh JWTs from the authenticated `users` row, apply the in-place
//!   session update and rewrite `SET key <json> EX 300`, then return
//!   `200 {"status":"approved"}`.
//! - `GET /api/auth/wework/sessions/{session_id}/poll`
//!   (`poll_wework_auth_session`): after the UUIDv4 check (400), the Redis
//!   read (miss → 404, non-dict → 500), and the required `poll_token` query
//!   parameter match (401), dispatch on the stringified session `status`:
//!   `pending`/`declined` echo the status, `claimed` and every unknown status
//!   render `failed` with the recorded error text, and `approved` claims the
//!   tokens once — rewriting the session without them and answering
//!   `success` with the access/refresh tokens and the approving username.
//!
//! All cache operations go through `cache_manager`, which swallows every
//! Redis failure: `get` renders a read failure as a miss (404 here), and `set`
//! logs the failure and returns `False` while `_write_session` ignores the
//! result, so a failed write never changes the endpoint's response — except
//! on session creation, where the source's own `raise HTTPException(500)`
//! makes a failed first write the `500 {"detail":"Failed to create
//! authorization session"}` response.
//!
//! The recorded Redis payloads embed freshly minted JWTs (`exp`, `jti`) and
//! request-time timestamps, so they cannot byte-match the recording at replay
//! time; the recordings are structural references, not literal value
//! fixtures.
use base64::Engine as _;
use brz_redis::{Redis, RedisBytes, SetExpiration, SetOptions};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest as _, Sha256};

use crate::auth::SessionUser;
use crate::http_compat::FastApiError;
use crate::state::AppState;
use crate::wework_auth_tokens::{access_claims, create_token, refresh_claims};

/// `SESSION_KEY_PREFIX` (`app.api.endpoints.wework_auth`).
const SESSION_KEY_PREFIX: &str = "wework_auth_session:";
/// `SESSION_TTL_SECONDS` (5 minutes).
const SESSION_TTL_SECONDS: u64 = 5 * 60;
/// `POLL_INTERVAL_SECONDS` (`app.api.endpoints.wework_auth`).
const POLL_INTERVAL_SECONDS: i64 = 2;
const LEGACY_ACCESS_AUTH_MODE: &str = "legacy_access";
const DEVICE_BOUND_REFRESH_AUTH_MODE: &str = "device_bound_refresh";

/// `200 {"status": <status>}` for every approve outcome.
#[derive(Serialize)]
struct Approval {
    status: String,
}

/// `WeworkAuthSessionPollResponse` (`app/schemas/user.py`): the field order
/// matches the recorded response body; absent fields serialize as JSON
/// `null` because pydantic always emits them.
#[derive(Debug, Serialize)]
struct PollResponse {
    status: String,
    access_token: Option<String>,
    refresh_token: Option<String>,
    token_type: Option<String>,
    username: Option<String>,
    error: Option<String>,
}

/// `WeworkAuthSessionCreateResponse` (`app/schemas/user.py`): field order as
/// declared, matching the recorded response body.
#[derive(Debug, Serialize)]
struct CreateResponse {
    session_id: String,
    poll_token: String,
    authorize_url: String,
    web_url: String,
    expires_at: i64,
    poll_interval_seconds: i64,
}

/// `WeworkWebConfigResponse` (`app/schemas/user.py`): field order as declared,
/// with `socket_url` emitted as `null` when unconfigured because pydantic
/// always serializes response-model fields.
#[derive(Debug, Serialize)]
struct WebConfigResponse {
    web_url: String,
    socket_url: Option<String>,
}

/// GET /api/auth/wework/config: the source declares no authentication
/// dependency, so the route is public.
#[brz_http_server::get("/api/auth/wework/config", access = public)]
async fn get_wework_web_config(
    #[inject(state)] state: &AppState,
) -> Result<WebConfigResponse, FastApiError> {
    Ok(web_config(
        &state.oidc_config.frontend_url,
        crate::config::env_or_dotenv("WEGENT_SOCKET_URL"),
    ))
}

/// Handler body of `get_wework_web_config`:
/// `web_url=settings.FRONTEND_URL.rstrip("/")` and
/// `socket_url=settings.WEGENT_SOCKET_URL.strip().rstrip("/") or None`.
fn web_config(frontend_url: &str, socket_url: Option<String>) -> WebConfigResponse {
    let socket_url = socket_url
        .unwrap_or_default()
        .trim()
        .trim_end_matches('/')
        .to_string();
    WebConfigResponse {
        web_url: frontend_url.trim_end_matches('/').to_string(),
        socket_url: (!socket_url.is_empty()).then_some(socket_url),
    }
}

/// POST /api/auth/wework/sessions: the create free function. The source
/// declares no authentication dependency, so the route is public; the session
/// id and poll token it mints are the credentials of the flow that follows.
#[brz_http_server::post("/api/auth/wework/sessions", access = public)]
async fn create_wework_auth_session(
    #[inject(state)] state: &AppState,
    body: Option<Value>,
) -> Result<CreateResponse, FastApiError> {
    create_session(state, bind_create_body(body.as_ref())?).await
}

/// Bind the optional `WeworkAuthSessionCreateRequest` body the way FastAPI
/// does before the handler body runs. Absent, JSON `null`, and `{}` leave the
/// optional model unset; any other non-object body fails the model with the
/// application's 422. A present `device_public_key` must be an object whose
/// values all bind as strings (`Optional[dict[str, str]]`); the EC/P-256 and
/// coordinate checks then run inside `_validated_device_public_key` as the
/// handler body's 400s.
fn bind_create_body(body: Option<&Value>) -> Result<Option<Value>, FastApiError> {
    let Some(Value::Object(object)) = body else {
        return match body {
            None | Some(Value::Null) => Ok(None),
            Some(other) => Err(invalid_body_type(other)),
        };
    };
    match object.get("device_public_key") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Object(components)) => {
            // Pydantic validates every value in the dict, including keys the
            // handler ignores, and reports all offending entries in insertion
            // order.
            let errors = device_public_key_errors(components);
            if errors.is_empty() {
                Ok(Some(Value::Object(components.clone())))
            } else {
                Err(validation_body(errors))
            }
        }
        Some(other) => Err(validation_body(vec![serde_json::json!({
            "type": "dict_type",
            "loc": ["body", "device_public_key"],
            "msg": "Input should be a valid dictionary",
            "input": other,
        })])),
    }
}

/// Pydantic's `dict[str, str]` errors for one `device_public_key` object: one
/// `string_type` entry per non-string value, in insertion order.
fn device_public_key_errors(components: &serde_json::Map<String, Value>) -> Vec<Value> {
    components
        .iter()
        .filter(|(_, value)| !value.is_string())
        .map(|(name, value)| {
            serde_json::json!({
                "type": "string_type",
                "loc": ["body", "device_public_key", name],
                "msg": "Input should be a valid string",
                "input": value,
            })
        })
        .collect()
}

/// Handler body of `create_wework_auth_session`: mint the session record,
/// write it, and render the create response.
async fn create_session(
    state: &AppState,
    device_public_key: Option<Value>,
) -> Result<CreateResponse, FastApiError> {
    let session_id = crate::wework_auth_tokens::uuid4_hex()?;
    let poll_token = random_poll_token()?;
    let now = chrono::Utc::now().timestamp();
    let expires_at = now + i64::try_from(SESSION_TTL_SECONDS).expect("constant fits");
    let session = build_session_record(poll_token.clone(), now, expires_at, device_public_key)?;

    // `cache_manager.set` returns `False` on a swallowed failure; the create
    // endpoint is the one caller that surfaces it as its own 500.
    if !write_new_session(state, &session_id, Value::Object(session)).await {
        return Err(FastApiError::detail(
            brz_http_server::StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to create authorization session",
        ));
    }

    Ok(CreateResponse {
        session_id: session_id.clone(),
        poll_token,
        authorize_url: build_authorize_url(
            state.oidc_config.frontend_url.trim_end_matches('/'),
            &session_id,
        )?,
        web_url: state
            .oidc_config
            .frontend_url
            .trim_end_matches('/')
            .to_string(),
        expires_at,
        poll_interval_seconds: POLL_INTERVAL_SECONDS,
    })
}

/// The `session_data` dict of `create_wework_auth_session`: the shared
/// pending fields first; `session_data.update` then appends the device-bound
/// fields in its literal order.
fn build_session_record(
    poll_token: String,
    created_at: i64,
    expires_at: i64,
    device_public_key: Option<Value>,
) -> Result<serde_json::Map<String, Value>, FastApiError> {
    let mut session = serde_json::Map::new();
    session.insert("status".to_string(), "pending".into());
    session.insert("auth_mode".to_string(), LEGACY_ACCESS_AUTH_MODE.into());
    session.insert("poll_token".to_string(), poll_token.into());
    session.insert("created_at".to_string(), created_at.into());
    session.insert("expires_at".to_string(), expires_at.into());
    if let Some(device_public_key) = device_public_key {
        let public_key = validated_device_public_key(&device_public_key)?;
        session.insert(
            "auth_mode".to_string(),
            DEVICE_BOUND_REFRESH_AUTH_MODE.into(),
        );
        session.insert(
            "device_public_key".to_string(),
            render_device_public_key(&public_key),
        );
        session.insert(
            "device_thumbprint".to_string(),
            device_key_thumbprint(&public_key).into(),
        );
    }
    Ok(session)
}

/// `cache_manager.set(_session_key(session_id), session_data, expire=300)`
/// for the create endpoint's first write: the source checks the returned
/// flag, so a swallowed Redis failure answers `false` instead of being
/// ignored. The payload is the compact `orjson.dumps` rendering.
async fn write_new_session(state: &AppState, session_id: &str, session: Value) -> bool {
    write_new_session_over(state.redis.as_ref(), session_id, session).await
}

/// [`write_new_session`] over an injected Redis service, so tests can
/// capture the write without a live connection.
async fn write_new_session_over<R: Redis>(
    redis: Option<&R>,
    session_id: &str,
    session: Value,
) -> bool {
    let Some(redis) = redis else {
        // The source's Redis client is always created; a missing service here
        // is an environment defect, rendered like a swallowed failure.
        tracing::warn!(session_id, "wework auth session write has no Redis service");
        return false;
    };
    let payload = session.to_string();
    match redis
        .set_with(
            format!("{SESSION_KEY_PREFIX}{session_id}"),
            payload,
            SetOptions::default().with_expiration(SetExpiration::Seconds(SESSION_TTL_SECONDS)),
        )
        .await
    {
        Ok(stored) => stored,
        Err(error) => {
            tracing::warn!(%error, session_id, "wework auth session write failed");
            false
        }
    }
}

/// `secrets.token_urlsafe(32)`: 32 random bytes rendered with the
/// URL-safe base64 alphabet and no `=` padding (a 43-character string).
fn random_poll_token() -> Result<String, FastApiError> {
    let mut bytes = [0_u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|error| {
        tracing::error!(%error, "wework auth poll token random source failed");
        FastApiError::internal()
    })?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes))
}

/// `_authorize_base_url`: `WEWORK_AUTHORIZE_BASE_URL or FRONTEND_URL`,
/// stripped; an empty or unparseable value is the source's 500.
fn authorize_base_url(frontend_url: &str) -> Result<String, FastApiError> {
    let raw = crate::config::env_or_dotenv("WEWORK_AUTHORIZE_BASE_URL")
        .unwrap_or_default()
        .trim()
        .to_string();
    let raw = if raw.is_empty() {
        frontend_url.trim().to_string()
    } else {
        raw
    };
    if raw.is_empty() {
        return Err(unconfigured_authorize_url());
    }
    if !has_http_scheme_and_netloc(&raw) {
        return Err(invalid_authorize_url());
    }
    Ok(raw.trim_end_matches('/').to_string())
}

/// `urlparse(raw).scheme in {"http", "https"} and parsed.netloc`: a minimal
/// scheme://netloc check over the raw value, matching the source's parse.
fn has_http_scheme_and_netloc(raw: &str) -> bool {
    let Some((scheme, rest)) = raw.split_once("://") else {
        return false;
    };
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return false;
    }
    // `urlparse(raw).netloc` is the authority before any path, query, or
    // fragment, so `https:///path` and `https://?q` have none.
    rest.split(['/', '?', '#'])
        .next()
        .is_some_and(|authority| !authority.is_empty())
}

/// `_build_authorize_url`:
/// `{base}/auth/wework/authorize?session_id={urlencoded id}`. The source's
/// `urlencode` uses `quote_plus`, which form-encodes; a UUIDv4 needs no
/// escaping, so the encoded value is the id itself.
fn build_authorize_url(frontend_url: &str, session_id: &str) -> Result<String, FastApiError> {
    let base = authorize_base_url(frontend_url)?;
    Ok(format!(
        "{base}/auth/wework/authorize?session_id={session_id}"
    ))
}

/// The validated EC P-256 device public key of a create request: the
/// original `kty`/`crv`/`x`/`y` string values stored in the session record.
#[derive(Debug)]
struct CreateDevicePublicKey {
    kty: String,
    crv: String,
    x: String,
    y: String,
}

/// `_validated_device_public_key`: keep `kty`/`crv`/`x`/`y` (missing
/// components default to `""`), require `EC`/`P-256`, and require the decoded
/// `x`/`y` to be 32 bytes. Every failure is a 400 with the source's detail.
fn validated_device_public_key(value: &Value) -> Result<CreateDevicePublicKey, FastApiError> {
    let component = |key: &str| -> String {
        value
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let kty = component("kty");
    let crv = component("crv");
    let x = component("x");
    let y = component("y");
    if kty != "EC" || crv != "P-256" {
        return Err(FastApiError::detail(
            brz_http_server::StatusCode::BAD_REQUEST,
            "Device public key must use EC P-256",
        ));
    }
    if decoded_length(&x) != Some(32) || decoded_length(&y) != Some(32) {
        return Err(FastApiError::detail(
            brz_http_server::StatusCode::BAD_REQUEST,
            "Invalid device public key",
        ));
    }
    Ok(CreateDevicePublicKey { kty, crv, x, y })
}

/// `_base64url_decode(value).length` for one component: `None` on any decode
/// failure renders the invalid-key 400 (a non-string component is impossible
/// here; FastAPI's `dict[str, str]` binding has already rejected it).
fn decoded_length(value: &str) -> Option<usize> {
    decode_b64url(value).map(|bytes| bytes.len())
}

/// The stored `device_public_key` member: the four kept components in the
/// source dict-literal order.
fn render_device_public_key(key: &CreateDevicePublicKey) -> Value {
    serde_json::json!({"kty": key.kty, "crv": key.crv, "x": key.x, "y": key.y})
}

/// `_device_key_thumbprint`: the RFC 7638 JWK thumbprint — the SHA-256 of the
/// canonical `{"crv","kty","x","y"}` object, base64url without padding.
/// `json.dumps(..., sort_keys=True)` orders the members alphabetically.
fn device_key_thumbprint(key: &CreateDevicePublicKey) -> String {
    let canonical = serde_json::json!({
        "crv": key.crv,
        "kty": key.kty,
        "x": key.x,
        "y": key.y,
    })
    .to_string();
    base64url_nopad(&Sha256::digest(canonical.as_bytes()))
}

/// Base64url encoding without padding.
fn base64url_nopad(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// `base64.urlsafe_b64decode(value + padding)`: base64url with optional
/// padding; `None` on any decode failure.
fn decode_b64url(value: &str) -> Option<Vec<u8>> {
    let padded_len = value.len().div_ceil(4) * 4;
    let mut padded = String::with_capacity(padded_len);
    padded.push_str(value);
    while padded.len() < padded_len {
        padded.push('=');
    }
    base64::engine::general_purpose::URL_SAFE
        .decode(padded.as_bytes())
        .ok()
}

/// `500 {"detail":"Wework authorization Web URL is not configured"}` —
/// `_authorize_base_url` for an empty base.
fn unconfigured_authorize_url() -> FastApiError {
    FastApiError::detail(
        brz_http_server::StatusCode::INTERNAL_SERVER_ERROR,
        "Wework authorization Web URL is not configured",
    )
}

/// `500 {"detail":"Wework authorization Web URL is invalid"}` —
/// `_authorize_base_url` for a base without an http(s) scheme and netloc.
fn invalid_authorize_url() -> FastApiError {
    FastApiError::detail(
        brz_http_server::StatusCode::INTERNAL_SERVER_ERROR,
        "Wework authorization Web URL is invalid",
    )
}

/// The application's 422 body (`app/core/exceptions.py`
/// `validation_exception_handler`) for a `WeworkAuthSessionCreateRequest`
/// bind failure: pydantic's error array wrapped in the source's envelope.
fn validation_body(errors: Vec<Value>) -> FastApiError {
    FastApiError::json_body(
        brz_http_server::StatusCode::UNPROCESSABLE_ENTITY,
        serde_json::json!({
            "error_code": 422,
            "detail": "Request parameter validation failed",
            "errors": errors,
        }),
    )
}

/// The application's 422 body for a body that is not the optional
/// `WeworkAuthSessionCreateRequest` object.
fn invalid_body_type(input: &Value) -> FastApiError {
    validation_body(vec![serde_json::json!({
        "type": "model_attributes_type",
        "loc": ["body"],
        "msg": "Input should be a valid dictionary or object to extract fields from",
        "input": input,
    })])
}

/// POST /api/auth/wework/sessions/{session_id}/approve: the approve free
/// function, injecting the process-lifetime application state.
#[brz_http_server::post("/api/auth/wework/sessions/:session_id/approve")]
async fn approve_wework_auth_session(
    #[inject(state)] state: &AppState,
    session_id: String,
    #[auth] user: SessionUser,
) -> Result<Approval, FastApiError> {
    approve_session(state, session_id, user.0).await
}

/// GET /api/auth/wework/sessions/{session_id}/poll: the poll free function.
/// The source declares no authentication dependency, so the route is public;
/// the `poll_token` query parameter is the credential.
#[brz_http_server::get("/api/auth/wework/sessions/:session_id/poll", access = public)]
async fn poll_wework_auth_session(
    #[inject(state)] state: &AppState,
    session_id: String,
    poll_token: Option<String>,
) -> Result<PollResponse, FastApiError> {
    // FastAPI binds the required `poll_token` query parameter before the
    // handler body runs; a missing value renders the application's 422 body.
    let Some(poll_token) = poll_token else {
        return Err(missing_poll_token());
    };
    // `_read_session`: UUIDv4 check, then the Redis read with its swallowed
    // failures.
    let session = read_session(state, &session_id).await?;
    // `_require_poll_token` runs after the read.
    if session
        .get("poll_token")
        .and_then(Value::as_str)
        .is_none_or(|stored| stored != poll_token)
    {
        return Err(invalid_poll_token());
    }
    poll_from_session(state.redis.as_ref(), &session_id, session).await
}

/// Handler body for `POST /api/auth/wework/sessions/{session_id}/approve`.
async fn approve_session(
    state: &AppState,
    session_id: String,
    user: crate::auth::UserRow,
) -> Result<Approval, FastApiError> {
    // `_read_session`: UUIDv4 else 400, then the Redis read.
    let mut session = read_session(state, &session_id).await?;

    // `current_status = str(session_data.get("status", "pending"))`.
    let current_status = session
        .get("status")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("pending")
        .to_string();
    if current_status != "pending" {
        // The source returns the existing status with no write.
        return Ok(Approval {
            status: current_status,
        });
    }

    // `_uses_device_bound_refresh`: the explicit auth modes, then the
    // device-thumbprint fallback.
    let uses_device_bound_refresh = uses_device_bound_refresh(&session);

    let device_thumbprint = session
        .get("device_thumbprint")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    if uses_device_bound_refresh
        && !matches!(device_thumbprint.as_deref(), Some(v) if !v.is_empty())
    {
        return Err(FastApiError::detail(
            brz_http_server::StatusCode::INTERNAL_SERVER_ERROR,
            "Authorization session is missing its device binding",
        ));
    }

    // Mint the access token: device-bound carries `token_use=wework_access`
    // with `WEWORK_ACCESS_TOKEN_EXPIRE_MINUTES`; legacy carries neither with
    // `ACCESS_TOKEN_EXPIRE_MINUTES`.
    let access_token = if uses_device_bound_refresh {
        let claims = access_claims(&user.user_name, user.id, true)?;
        create_token(&state.auth.jwt_key, &state.auth.algorithm, claims)?
    } else {
        let claims = access_claims(&user.user_name, user.id, false)?;
        create_token(&state.auth.jwt_key, &state.auth.algorithm, claims)?
    };

    // The in-place `session_data.update({...})`: insert in the same order the
    // source dict lists the fields, appending after any pre-existing keys.
    let now = chrono::Utc::now().timestamp();
    session.insert("status".to_string(), "approved".into());
    session.insert("access_token".to_string(), access_token.into());
    session.insert("username".to_string(), user.user_name.clone().into());
    session.insert(
        "approved_user_id".to_string(),
        serde_json::Value::from(user.id),
    );
    session.insert("approved_at".to_string(), now.into());
    if uses_device_bound_refresh {
        let refresh_token = create_token(
            &state.auth.jwt_key,
            &state.auth.algorithm,
            refresh_claims(
                &user.user_name,
                user.id,
                device_thumbprint.as_deref().expect("checked device-bound"),
            )?,
        )?;
        session.insert("refresh_token".to_string(), refresh_token.into());
    }

    // `_write_session` -> `cache_manager.set(...)`: `payload = orjson.dumps(
    // session_data)` is the compact JSON the recorded `SET` value holds, and
    // `cache_manager.set` swallows every Redis failure (`except Exception:
    // return False`) with `_write_session` ignoring the result. The write is
    // still attempted, but a failure never reaches the response; the approval
    // succeeds with the session cache simply left unchanged.
    write_session(state.redis.as_ref(), &session_id, Value::Object(session)).await;

    Ok(Approval {
        status: "approved".to_string(),
    })
}

/// Handler body of `poll_wework_auth_session` over one stored session dict:
/// dispatch on the stringified `status`, claiming the tokens on `approved`.
/// `redis` is the process Redis service; `None` mirrors an unavailable
/// service, whose swallowed write failure never changes the response.
async fn poll_from_session<R: brz_redis::Redis>(
    redis: Option<&R>,
    session_id: &str,
    mut session: serde_json::Map<String, Value>,
) -> Result<PollResponse, FastApiError> {
    // `current_status = str(session_data.get("status", "pending"))`; the
    // source only ever stores a string `status`, and `str()` of a corrupted
    // non-string falls back to "pending" only when the key is absent.
    let current_status = session
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("pending")
        .to_string();
    if current_status == "pending" || current_status == "declined" {
        return Ok(poll_status(&current_status));
    }
    if current_status == "claimed" {
        return Ok(PollResponse {
            status: "failed".to_owned(),
            error: Some("Authorization token has already been claimed".to_owned()),
            ..empty_poll()
        });
    }
    if current_status != "approved" {
        // `str(session_data.get("error") or "Authorization failed")`: an
        // absent, null, or empty error falls back to the literal.
        let fallback = "Authorization failed".to_owned();
        let error = match session.get("error") {
            Some(Value::String(text)) if !text.is_empty() => text.clone(),
            _ => fallback,
        };
        return Ok(PollResponse {
            status: "failed".to_owned(),
            error: Some(error),
            ..empty_poll()
        });
    }

    // `approved`: claim the tokens. A missing or non-string `access_token`
    // fails the claim (and a device-bound session needs a string
    // `refresh_token` too); the tokens are then removed from the stored
    // session and the record is rewritten as `claimed`.
    let access_token = opt_str(session.get("access_token"));
    let refresh_token = opt_str(session.get("refresh_token"));
    let username = opt_str(session.get("username"));
    let uses_device_bound_refresh = uses_device_bound_refresh(&session);
    let (access_token, refresh_token) = match (access_token, refresh_token) {
        (Some(access_token), refresh_token) if !uses_device_bound_refresh => {
            (access_token, refresh_token)
        }
        (Some(access_token), Some(refresh_token)) => (access_token, Some(refresh_token)),
        _ => {
            return Ok(PollResponse {
                status: "failed".to_owned(),
                error: Some("Authorization token is missing".to_owned()),
                ..empty_poll()
            });
        }
    };

    // The in-place claim: `status` is overwritten in place, the token keys
    // are removed, and `_write_session` rewrites the record.
    session.insert("status".to_string(), "claimed".into());
    session.remove("access_token");
    session.remove("refresh_token");
    write_session(redis, session_id, Value::Object(session)).await;

    Ok(PollResponse {
        status: "success".to_owned(),
        access_token: Some(access_token),
        refresh_token,
        token_type: Some("bearer".to_owned()),
        username,
        error: None,
    })
}

/// `WeworkAuthSessionPollResponse(status=<status>)`: every other field is
/// `None` and pydantic still emits it as JSON `null`.
fn poll_status(status: &str) -> PollResponse {
    PollResponse {
        status: status.to_owned(),
        ..empty_poll()
    }
}

/// The all-`None` tail of `WeworkAuthSessionPollResponse`.
fn empty_poll() -> PollResponse {
    PollResponse {
        status: String::new(),
        access_token: None,
        refresh_token: None,
        token_type: None,
        username: None,
        error: None,
    }
}

/// `_uses_device_bound_refresh`: the explicit auth modes, then the
/// device-thumbprint fallback. Shared by the approve and poll handlers.
fn uses_device_bound_refresh(session: &serde_json::Map<String, Value>) -> bool {
    match session.get("auth_mode").and_then(Value::as_str) {
        Some(DEVICE_BOUND_REFRESH_AUTH_MODE) => true,
        Some(LEGACY_ACCESS_AUTH_MODE) => false,
        _ => {
            let thumbprint = session.get("device_thumbprint").and_then(Value::as_str);
            matches!(thumbprint, Some(v) if !v.is_empty())
        }
    }
}

/// `session_data.get(field)` bound to an `Optional[str]` response field: a
/// missing key or JSON `null` stays `None` and a string is kept; any other
/// value would fail pydantic's response-model validation, which source
/// writers never store, so it is treated as absent.
fn opt_str(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(text)) => Some(text.clone()),
        _ => None,
    }
}

/// `_read_session`: `_validate_session_id` (UUIDv4 else 400), then the Redis
/// `wework_auth_session:{id}` read with `cache_manager`'s swallowed failures
/// (miss or read failure → 404, non-dict value → 500).
async fn read_session(
    state: &AppState,
    session_id: &str,
) -> Result<serde_json::Map<String, Value>, FastApiError> {
    if !valid_uuid4(session_id) {
        return Err(FastApiError::detail(
            brz_http_server::StatusCode::BAD_REQUEST,
            "Invalid session_id format",
        ));
    }
    let Some(redis) = state.redis.as_ref() else {
        // The source's Redis client is always created; a missing service here
        // is an environment defect, not an observed source path.
        return Err(FastApiError::internal());
    };
    // `cache_manager.get` swallows every Redis failure and returns `None`
    // (`except Exception: return None`), so a failed read renders the same
    // 404 as an absent key rather than surfacing the transport error.
    let session_bytes: Option<RedisBytes> = match redis
        .get::<_, RedisBytes>(format!("{SESSION_KEY_PREFIX}{session_id}"))
        .await
    {
        Ok(value) => value,
        Err(error) => {
            tracing::warn!(%error, session_id, "wework auth session read failed");
            None
        }
    };
    let Some(session_bytes) = session_bytes else {
        return Err(session_expired());
    };
    // `cache_manager._decode` renders `orjson.loads(data)` and otherwise
    // keeps the raw bytes; `_read_session` then applies `if not
    // session_data` (404) before `isinstance(session_data, dict)` (500).
    let decoded: Value = match serde_json::from_slice(session_bytes.as_ref()) {
        Ok(value) => value,
        Err(_) => {
            // Undecodable bytes stay raw: empty is falsy (404); any other
            // value is not a dict, so `_read_session` raises its 500.
            return Err(if session_bytes.is_empty() {
                session_expired()
            } else {
                invalid_session()
            });
        }
    };
    if !js_truthy(&decoded) {
        return Err(session_expired());
    }
    match decoded {
        Value::Object(session) => Ok(session),
        _ => Err(invalid_session()),
    }
}

/// `_write_session` -> `cache_manager.set(key, session_data, expire=300)`:
/// `orjson.dumps` renders the compact JSON the recorded `SET` value holds,
/// and a Redis failure is logged and swallowed (`return False` with the
/// caller ignoring the result), so it never changes the response.
async fn write_session<R: brz_redis::Redis>(redis: Option<&R>, session_id: &str, session: Value) {
    let Some(redis) = redis else {
        return;
    };
    let payload = session.to_string();
    if let Err(error) = redis
        .set_with(
            format!("{SESSION_KEY_PREFIX}{session_id}"),
            payload,
            SetOptions::default().with_expiration(SetExpiration::Seconds(SESSION_TTL_SECONDS)),
        )
        .await
    {
        tracing::warn!(%error, session_id, "wework auth session write failed");
    }
}

/// `401 {"detail":"Invalid authorization polling token"}` —
/// `_require_poll_token` for a missing match.
fn invalid_poll_token() -> FastApiError {
    FastApiError::detail(
        brz_http_server::StatusCode::UNAUTHORIZED,
        "Invalid authorization polling token",
    )
}

/// `422 {"error_code":422,...}` — the application's
/// `validation_exception_handler` body (`app/core/exceptions.py`) for the
/// missing required `poll_token` query parameter.
fn missing_poll_token() -> FastApiError {
    FastApiError::json_body(
        brz_http_server::StatusCode::UNPROCESSABLE_ENTITY,
        serde_json::json!({
            "error_code": 422,
            "detail": "Request parameter validation failed",
            "errors": [
                {
                    "type": "missing",
                    "loc": ["query", "poll_token"],
                    "msg": "Field required",
                    "input": null,
                },
            ],
        }),
    )
}

/// `404 {"detail":"Authorization session expired or not found"}` — the
/// `_read_session` body for a missing or unreadable session.
fn session_expired() -> FastApiError {
    FastApiError::detail(
        brz_http_server::StatusCode::NOT_FOUND,
        "Authorization session expired or not found",
    )
}

/// `500 {"detail":"Authorization session is invalid"}` — the `_read_session`
/// body for a decoded value that is not a session dict.
fn invalid_session() -> FastApiError {
    FastApiError::detail(
        brz_http_server::StatusCode::INTERNAL_SERVER_ERROR,
        "Authorization session is invalid",
    )
}

/// Python truthiness of a decoded JSON value, used by `_read_session`'s
/// `if not session_data`: `None`, `false`, zero, `""`, and empty arrays or
/// objects are falsy; everything else is truthy.
fn js_truthy(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Null => false,
        serde_json::Value::Bool(flag) => *flag,
        serde_json::Value::Number(number) => number.as_f64() != Some(0.0),
        serde_json::Value::String(text) => !text.is_empty(),
        serde_json::Value::Array(items) => !items.is_empty(),
        serde_json::Value::Object(map) => !map.is_empty(),
    }
}

/// `_validate_session_id`: a valid UUIDv4 (the version and variant nibbles are
/// enough to distinguish a v4 string from any other UUID form).
fn valid_uuid4(id: &str) -> bool {
    let parts: Vec<&str> = id.split('-').collect();
    if parts.len() != 5
        || parts[0].len() != 8
        || parts[1].len() != 4
        || parts[2].len() != 4
        || parts[3].len() != 4
        || parts[4].len() != 12
    {
        return false;
    }
    if !id.chars().all(|c| c == '-' || c.is_ascii_hexdigit()) {
        return false;
    }
    let version = u8::from_str_radix(&id[14..15], 16).ok();
    let variant = u8::from_str_radix(&id[19..20], 16).ok();
    version == Some(4) && matches!(variant, Some(8) | Some(9) | Some(0xa) | Some(0xb))
}

#[cfg(test)]
#[path = "wework_auth/tests.rs"]
mod tests;
