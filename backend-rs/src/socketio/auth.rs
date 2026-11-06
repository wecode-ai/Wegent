// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Socket.IO connection authentication.
//!
//! Sources:
//! - `app/api/ws/device_namespace.py::on_connect` (the `/local-executor`
//!   namespace: runner credential, personal API key, else JWT).
//! - `app/api/ws/chat_namespace.py::on_connect` (the `/chat` namespace: JWT).
//!
//! The credential decides the rejection message, so each branch keeps the
//! source's exact string: `Invalid or revoked runner credential`,
//! `Invalid or expired API key`, `Invalid or expired token`, and
//! `Authentication service unavailable` when the API-key read fails.

use brz_mysql::Mysql;
use sha2::{Digest, Sha256};

use crate::auth::{USER_BY_NAME_QUERY, UserRow};
use crate::state::AppState;

/// Authenticated connection identity stored on the namespace socket.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identity {
    pub user_id: i64,
    pub user_name: String,
    /// `workspace_runner`, `api_key`, or `jwt`.
    pub auth_type: &'static str,
    /// `users.email`, stored on the source connect session and used when the
    /// runtime relay binds the authenticated Wework identity.
    pub email: Option<String>,
}

/// `API_KEY_PREFIX` (`app/core/auth_utils.py`).
const API_KEY_PREFIX: &str = "wg-";
/// `TOKEN_PREFIX` (`app/services/workspaces/runner_registration.py`).
const RUNNER_TOKEN_PREFIX: &str = "wgr-";
const API_KEY_BY_HASH_QUERY: &str = "SELECT api_keys.id AS api_keys_id, \
     api_keys.user_id AS api_keys_user_id, api_keys.key_hash AS api_keys_key_hash, \
     api_keys.key_prefix AS api_keys_key_prefix, api_keys.name AS api_keys_name, \
     api_keys.key_type AS api_keys_key_type, api_keys.description AS api_keys_description, \
     api_keys.expires_at AS api_keys_expires_at, api_keys.last_used_at AS api_keys_last_used_at, \
     api_keys.is_active AS api_keys_is_active, api_keys.created_at AS api_keys_created_at, \
     api_keys.updated_at AS api_keys_updated_at \
     FROM api_keys \
     WHERE api_keys.key_hash = ? AND api_keys.key_type = ? AND api_keys.is_active = true \
     LIMIT 1";

const USER_BY_ID_QUERY: &str = "SELECT users.id AS users_id, users.user_name AS users_user_name, \
     users.password_hash AS users_password_hash, users.email AS users_email, \
     users.git_info AS users_git_info, users.is_active AS users_is_active, \
     users.`role` AS users_role, users.auth_source AS users_auth_source, \
     users.preferences AS users_preferences, users.created_at AS users_created_at, \
     users.updated_at AS users_updated_at \
     FROM users \
     WHERE users.id = ? \
     LIMIT 1";

const RUNNER_DEVICE_QUERY: &str = "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, kinds.namespace AS kinds_namespace, \
     kinds.json AS kinds_json, kinds.is_active AS kinds_is_active, \
     kinds.created_at AS kinds_created_at, kinds.updated_at AS kinds_updated_at FROM kinds \
     WHERE kinds.id = ? AND kinds.kind = 'Device' AND kinds.namespace = 'default' \
     AND kinds.is_active = true";

/// `get_workspace_kind`: the owning `CollaborationWorkspace` must exist.
const WORKSPACE_QUERY: &str = "SELECT kinds.id AS kinds_id FROM kinds WHERE kinds.id = ? \
     AND kinds.kind = 'CollaborationWorkspace' AND kinds.is_active = true LIMIT 1";

#[derive(Debug, brz_mysql::FromMysqlRow)]
struct ApiKeyRow {
    #[mysql(rename = "api_keys_id")]
    id: i64,
    #[mysql(rename = "api_keys_user_id")]
    user_id: i64,
    #[mysql(rename = "api_keys_expires_at")]
    expires_at: chrono::NaiveDateTime,
}

#[derive(Debug, brz_mysql::FromMysqlRow)]
struct RunnerDeviceRow {
    #[mysql(rename = "kinds_user_id")]
    user_id: i64,
    #[mysql(rename = "kinds_name")]
    name: String,
    #[mysql(rename = "kinds_json")]
    json: serde_json::Value,
}

#[derive(Debug, brz_mysql::FromMysqlRow)]
struct WorkspaceRow {
    #[mysql(rename = "kinds_id")]
    _id: i64,
}

/// Rejection categories the namespace CONNECT turns into CONNECT_ERROR text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthError {
    /// The source raised `ConnectionRefusedError(<message>)`.
    Refused(&'static str),
    /// The source's `SQLAlchemyError` branch refused with an unavailable
    /// message.
    StorageUnavailable,
}

impl AuthError {
    /// The CONNECT_ERROR message the client receives.
    #[must_use]
    pub fn message(&self) -> &'static str {
        match self {
            Self::Refused(message) => message,
            Self::StorageUnavailable => "Authentication service unavailable",
        }
    }
}

/// `get_token_expiry` (`app/services/chat/access/auth.py`): the JWT `exp`
/// claim in Unix seconds, decoded without verifying the signature.
///
/// The source stores this at `/chat` connect and `_check_token_expiry`
/// compares it with `datetime.now().timestamp()`; an undecodable token has no
/// expiry, which the source treats as expired.
#[must_use]
pub fn token_expiry(token: &str) -> Option<i64> {
    use base64::Engine as _;
    let payload = token.split('.').nth(1)?;
    let trimmed = payload.trim_end_matches('=');
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(trimmed)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(payload))
        .ok()?;
    let claims: serde_json::Value = serde_json::from_slice(&decoded).ok()?;
    claims.get("exp").and_then(|value| {
        value
            .as_i64()
            .or_else(|| value.as_f64().map(|seconds| seconds as i64))
    })
}

/// Verifies one `auth.token` value.
///
/// # Errors
///
/// Returns the source's rejection category for invalid, expired, revoked or
/// unverifiable credentials.
pub async fn verify(state: &AppState, token: &str) -> Result<Identity, AuthError> {
    if token.starts_with(RUNNER_TOKEN_PREFIX) {
        return verify_runner(state, token).await;
    }
    if token.starts_with(API_KEY_PREFIX) {
        return verify_api_key(state, token).await;
    }
    verify_jwt(state, token).await
}

async fn verify_api_key(state: &AppState, token: &str) -> Result<Identity, AuthError> {
    let hash = hex_sha256(token);
    let key: Option<ApiKeyRow> = state
        .mysql
        .fetch_optional(API_KEY_BY_HASH_QUERY, (hash, "personal"))
        .await
        .map_err(|error| {
            tracing::error!(%error, "Socket.IO API key read failed");
            AuthError::StorageUnavailable
        })?;
    let Some(key) = key.filter(|key| key.expires_at >= chrono::Utc::now().naive_utc()) else {
        return Err(AuthError::Refused("Invalid or expired API key"));
    };
    let unknown = AuthError::Refused("Invalid or expired API key");
    let Some(user) = active_user(&state.mysql, USER_BY_ID_QUERY, key.user_id).await else {
        return Err(unknown);
    };
    let _ = key.id;
    Ok(Identity {
        user_id: i64::from(user.id),
        user_name: user.user_name,
        auth_type: "api_key",
        email: user.email,
    })
}

pub(super) async fn verify_jwt(state: &AppState, token: &str) -> Result<Identity, AuthError> {
    let user_name = crate::auth::verify_token(&state.auth, token)
        .map_err(|_| AuthError::Refused("Invalid or expired token"))?;
    let Some(user) = active_user_by_name(state, &user_name).await else {
        return Err(AuthError::Refused("Invalid or expired token"));
    };
    Ok(Identity {
        user_id: i64::from(user.id),
        user_name: user.user_name,
        auth_type: "jwt",
        email: user.email,
    })
}

async fn verify_runner(state: &AppState, token: &str) -> Result<Identity, AuthError> {
    let refused = AuthError::Refused("Invalid or revoked runner credential");
    let Some((record_id, secret)) = token
        .strip_prefix(RUNNER_TOKEN_PREFIX)
        .and_then(|rest| rest.split_once('.'))
    else {
        return Err(refused);
    };
    if !record_id.bytes().all(|byte| byte.is_ascii_digit()) || secret.is_empty() {
        return Err(refused);
    }
    let Ok(record_id) = record_id.parse::<i64>() else {
        return Err(refused);
    };
    let device: Option<RunnerDeviceRow> = state
        .mysql
        .fetch_optional(RUNNER_DEVICE_QUERY, (record_id,))
        .await
        .map_err(|error| {
            // `on_connect` only rejects a runner with the revocation message;
            // a storage failure ends in the same refusal.
            tracing::error!(%error, "Socket.IO runner credential read failed");
            refused.clone()
        })?;
    let Some(device) = device else {
        return Err(refused);
    };
    let spec = device.json.get("spec").cloned().unwrap_or_default();
    let Some(expected) = spec.get("runnerCredentialHash").and_then(|v| v.as_str()) else {
        return Err(refused);
    };
    let Some(owner) = spec
        .get("workspaceOwnerId")
        .and_then(|value| value.as_str().and_then(|text| text.parse::<i64>().ok()))
    else {
        return Err(refused);
    };
    let workspace: Option<WorkspaceRow> = state
        .mysql
        .fetch_optional(WORKSPACE_QUERY, (owner,))
        .await
        .map_err(|error| {
            tracing::error!(%error, "Socket.IO runner workspace read failed");
            refused.clone()
        })?;
    if workspace.is_none() || hex_sha256(secret) != expected {
        return Err(refused);
    }
    Ok(Identity {
        user_id: device.user_id,
        user_name: device.name,
        auth_type: "workspace_runner",
        email: None,
    })
}

async fn active_user<M>(mysql: &M, query: &str, id: i64) -> Option<UserRow>
where
    M: Mysql,
{
    let user: Option<UserRow> = mysql.fetch_optional(query, (id,)).await.ok()?;
    match user {
        Some(user) if user.is_active != 0 => Some(user),
        _ => None,
    }
}

async fn active_user_by_name(state: &AppState, user_name: &str) -> Option<UserRow> {
    let user: Option<UserRow> = state
        .mysql
        .fetch_optional(USER_BY_NAME_QUERY, (user_name,))
        .await
        .ok()?;
    match user {
        Some(user) if user.is_active != 0 => Some(user),
        _ => None,
    }
}

fn hex_sha256(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    let mut out = String::with_capacity(64);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_key_digest_matches_sha256_hex() {
        assert_eq!(
            hex_sha256("wg-example"),
            "3c5c446c36686388ef6b466a51b30386c5fdecf6a3413cf484dbda46346d38be"
        );
        assert_eq!(hex_sha256("").len(), 64);
    }

    #[test]
    fn rejection_messages_match_the_source() {
        assert_eq!(
            AuthError::Refused("Invalid or expired API key").message(),
            "Invalid or expired API key"
        );
        assert_eq!(
            AuthError::StorageUnavailable.message(),
            "Authentication service unavailable"
        );
    }
}
