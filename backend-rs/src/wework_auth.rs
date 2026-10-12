// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/auth/wework/sessions/{session_id}/approve` — approve a Wework
//! desktop authorization session from the cloud Web app.
//!
//! Mirrors `app.api.endpoints.wework_auth.approve_wework_auth_session`
//! (router prefix `/auth/wework`, mounted under the app prefix `/api`):
//! validate the UUIDv4 `session_id` (else 400), `GET` the Redis
//! `wework_auth_session:{id}` record (miss → 404, undecodable bytes or a
//! non-dict value → 500), short-circuit an already-processed session to
//! `200 {"status": <status>}` with no write, mint the device-bound or legacy
//! access/refresh JWTs from the authenticated `users` row, apply the in-place
//! session update and rewrite `SET key <json> EX 300`, then return
//! `200 {"status":"approved"}`.
//!
//! Both cache operations go through `cache_manager`, which swallows every
//! Redis failure: `get` renders a read failure as a miss (404 here), and `set`
//! logs the failure and returns `False` while `_write_session` ignores the
//! result, so a failed write never changes the endpoint's response.
//!
//! The recorded Redis `SET` payload embeds freshly minted JWTs (`exp`, `jti`)
//! and the request-time `approved_at`, so it cannot byte-match the recording
//! at replay time; the recording is a structural reference, not a literal
//! value fixture.
use brz_redis::{Redis, SetExpiration, SetOptions};
use serde::Serialize;

use crate::auth::SessionUser;
use crate::http_compat::FastApiError;
use crate::state::AppState;
use crate::wework_auth_tokens::{access_claims, create_token, refresh_claims};

/// `SESSION_KEY_PREFIX` (`app.api.endpoints.wework_auth`).
const SESSION_KEY_PREFIX: &str = "wework_auth_session:";
/// `SESSION_TTL_SECONDS` (5 minutes).
const SESSION_TTL_SECONDS: u64 = 5 * 60;
const LEGACY_ACCESS_AUTH_MODE: &str = "legacy_access";
const DEVICE_BOUND_REFRESH_AUTH_MODE: &str = "device_bound_refresh";

/// `200 {"status": <status>}` for every approve outcome.
#[derive(Serialize)]
struct Approval {
    status: String,
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

/// Handler body for `POST /api/auth/wework/sessions/{session_id}/approve`.
async fn approve_session(
    state: &AppState,
    session_id: String,
    user: crate::auth::UserRow,
) -> Result<Approval, FastApiError> {
    // `_validate_session_id`: UUIDv4 else 400.
    if !valid_uuid4(&session_id) {
        return Err(FastApiError::detail(
            brz_http_server::StatusCode::BAD_REQUEST,
            "Invalid session_id format",
        ));
    }

    // `cache_manager.get` over the shared Redis service.
    let Some(redis) = state.redis.as_ref() else {
        // The source's Redis client is always created; a missing service here
        // is an environment defect, not an observed source path.
        return Err(FastApiError::internal());
    };
    let key = format!("{SESSION_KEY_PREFIX}{session_id}");
    // `cache_manager.get` swallows every Redis failure and returns `None`
    // (`except Exception: return None`), so a failed read renders the same 404
    // as an absent key rather than surfacing the transport error.
    let session_bytes: Option<brz_redis::RedisBytes> = match redis.get(key.clone()).await {
        Ok(value) => value,
        Err(error) => {
            tracing::warn!(%error, session_id, "wework auth session read failed");
            None
        }
    };
    let Some(session_bytes) = session_bytes else {
        // `_read_session` renders a miss or swallowed read failure as 404.
        return Err(session_expired());
    };

    // `cache_manager._decode` renders `orjson.loads(data)` and otherwise keeps
    // the raw bytes; `_read_session` then applies `if not session_data` (404)
    // before `isinstance(session_data, dict)` (500).
    let decoded: serde_json::Value = match serde_json::from_slice(&session_bytes) {
        Ok(value) => value,
        Err(_) => {
            // Undecodable bytes stay raw: empty is falsy (404); any other value
            // is not a dict, so `_read_session` raises its 500.
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
    let serde_json::Value::Object(mut session) = decoded else {
        return Err(invalid_session());
    };

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
    let uses_device_bound_refresh =
        match session.get("auth_mode").and_then(serde_json::Value::as_str) {
            Some(DEVICE_BOUND_REFRESH_AUTH_MODE) => true,
            Some(LEGACY_ACCESS_AUTH_MODE) => false,
            _ => {
                let thumbprint = session
                    .get("device_thumbprint")
                    .and_then(serde_json::Value::as_str);
                matches!(thumbprint, Some(v) if !v.is_empty())
            }
        };

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
    let payload = serde_json::Value::Object(session).to_string();
    if let Err(error) = redis
        .set_with(
            key,
            payload,
            SetOptions::default().with_expiration(SetExpiration::Seconds(SESSION_TTL_SECONDS)),
        )
        .await
    {
        tracing::warn!(%error, session_id, "wework auth session write failed");
    }

    Ok(Approval {
        status: "approved".to_string(),
    })
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
mod tests {
    use super::*;

    #[test]
    fn accepts_a_valid_uuid4() {
        assert!(valid_uuid4("4b0dbdec-4da8-42ae-b96f-9382abcf3972"));
        assert!(valid_uuid4("00000000-0000-4000-8000-000000000000"));
        assert!(valid_uuid4("6f2b1c2b-1234-4abc-9def-0123456789ab"));
    }

    #[test]
    fn rejects_malformed_or_non_v4_ids() {
        assert!(!valid_uuid4(""));
        assert!(!valid_uuid4("4b0dbdec-4da8-42ae-b96f-9382abcf397")); // too short
        assert!(!valid_uuid4("4b0dbdec-4da8-52ae-b96f-9382abcf3972")); // not v4
        assert!(!valid_uuid4("4b0dbdec-4da8-42ae-b96f-9382abcf397g")); // bad hex
        assert!(!valid_uuid4("4b0dbdec4da842aeb96f9382abcf3972")); // no dashes
    }

    #[test]
    fn approval_body_matches_the_recorded_response() {
        assert_eq!(
            serde_json::to_string(&Approval {
                status: "approved".to_string()
            })
            .unwrap(),
            r#"{"status":"approved"}"#
        );
    }

    /// `_read_session`'s `if not session_data`: the falsy JSON values render
    /// the 404 while any other decoded value proceeds to the dict check.
    #[test]
    fn js_truthy_matches_python_truthiness() {
        assert!(!js_truthy(&serde_json::json!(null)));
        assert!(!js_truthy(&serde_json::json!(false)));
        assert!(!js_truthy(&serde_json::json!(0)));
        assert!(!js_truthy(&serde_json::json!("")));
        assert!(!js_truthy(&serde_json::json!([])));
        assert!(!js_truthy(&serde_json::json!({})));
        assert!(js_truthy(&serde_json::json!(true)));
        assert!(js_truthy(&serde_json::json!(1)));
        assert!(js_truthy(&serde_json::json!("x")));
        assert!(js_truthy(&serde_json::json!([1])));
        assert!(js_truthy(&serde_json::json!({"status": "pending"})));
    }

    #[test]
    fn read_failure_bodies_match_the_source() {
        assert_eq!(
            session_expired().detail_message(),
            Some("Authorization session expired or not found")
        );
        assert_eq!(
            session_expired().status(),
            brz_http_server::StatusCode::NOT_FOUND
        );
        assert_eq!(
            invalid_session().detail_message(),
            Some("Authorization session is invalid")
        );
        assert_eq!(
            invalid_session().status(),
            brz_http_server::StatusCode::INTERNAL_SERVER_ERROR
        );
    }
}
