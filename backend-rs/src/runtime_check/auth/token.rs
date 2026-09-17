// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! JWT authentication mirroring `Wegent/backend/app/core/security.py`.
//!
//! `get_current_user` verifies a Bearer token with the active key, then each
//! configured legacy key (`app/core/jwt_compat.py`), rejects payloads that are
//! not interactive user sessions (`app/core/session_token.py`), and loads the
//! user by name from MySQL (`app/services/readers/users.py`).
use anyhow::Result;
use brz_mysql::Mysql;
use jsonwebtoken::{Algorithm, DecodingKey, Validation, errors::ErrorKind};

use super::model::AuthUser;
use crate::auth::SessionClaims;
use crate::runtime_check::state::AppState;

/// Load the authenticated user from the Authorization header, mirroring
/// `security.get_current_user`. `Err(status, detail)` maps to the source's
/// 401 `Could not validate credentials` response.
pub(crate) async fn get_current_user(
    state: &AppState<impl Mysql, impl brz_redis::Redis>,
    authorization: Option<&str>,
) -> Result<AuthUser, (u16, &'static str)> {
    const INVALID: (u16, &str) = (401, "Could not validate credentials");
    const NOT_ACTIVE: (u16, &str) = (401, "User not activated");
    let token = extract_bearer_token(authorization).ok_or(INVALID)?;
    let username = verify_token(state, token).ok_or(INVALID)?;
    let user = state
        .users
        .get_user_by_name(&state.mysql, &username)
        .await
        .map_err(|error| {
            tracing::error!(%error, username = %username, "failed to load authenticated user");
            (500, "Internal server error")
        })?
        .ok_or(INVALID)?;
    // The source rejects inactive users with `User not activated` after the
    // row load (`security.get_current_user`).
    if !user.is_active {
        return Err(NOT_ACTIVE);
    }
    Ok(user)
}

/// Mirror of `security.extract_authorization_token`: a case-insensitive
/// Bearer credential or a plain token.
fn extract_bearer_token(authorization: Option<&str>) -> Option<&str> {
    let authorization = authorization?.trim();
    if authorization.is_empty() {
        return None;
    }
    let (scheme, token) = authorization.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("bearer") || token.is_empty() {
        return None;
    }
    Some(token)
}

/// Mirror of `security.verify_token` + `decode_jose_jwt`: try the active key,
/// then each unique legacy decode-only key, keeping the last JWT error.
pub(crate) fn verify_token(
    state: &AppState<impl Mysql, impl brz_redis::Redis>,
    token: &str,
) -> Option<String> {
    let algorithm = match state.config.jwt_algorithm.as_str() {
        "HS256" => Algorithm::HS256,
        _ => {
            tracing::error!(algorithm = %state.config.jwt_algorithm, "unsupported JWT algorithm");
            return None;
        }
    };
    let mut last_error: Option<ErrorKind> = None;
    for (index, key) in state.config.jwt_decode_keys().iter().enumerate() {
        let mut validation = Validation::new(algorithm);
        validation.validate_exp = true;
        // python-jose uses 0 seconds leeway by default.
        validation.leeway = 0;
        validation.required_spec_claims.clear();
        match jsonwebtoken::decode::<SessionClaims>(
            token,
            &DecodingKey::from_secret(key.as_bytes()),
            &validation,
        ) {
            Ok(data) => {
                if index > 0 {
                    tracing::info!(index, "JWT verified with legacy secret key");
                }
                return session_username(&data.claims);
            }
            Err(error) => {
                // An unauthenticated signature is a failed key; any other
                // error (malformed token, bad base64) fails every key the
                // same way and ends the search.
                let kind = error.kind();
                last_error = Some(kind.clone());
                if !matches!(kind, ErrorKind::InvalidSignature) {
                    break;
                }
            }
        }
    }
    if let Some(ErrorKind::ExpiredSignature) = last_error {
        tracing::debug!("rejected expired JWT");
    }
    None
}

/// Mirror of `session_token.is_user_session_payload` plus `sub` extraction.
fn session_username(claims: &SessionClaims) -> Option<String> {
    claims.username()
}
