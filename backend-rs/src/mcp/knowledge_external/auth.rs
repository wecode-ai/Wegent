// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! External knowledge MCP authentication
//! (`app/mcp_server/server.py`: `_default_external_auth_handler`,
//! `set_external_knowledge_auth_handler`, `_resolve_external_knowledge_user`).
//!
//! The mounted external-knowledge app authenticates every non-public path with
//! a user identity: the deployment may replace the handler
//! (`set_external_knowledge_auth_handler`, used by an internal deployment to
//! resolve the gateway employee header), and the default handler resolves a
//! personal API key to its active owner. A handler that returns `None` makes
//! the middleware answer `401 {"error": "Authentication required",
//! "code": "unauthorized"}`.

use async_trait::async_trait;
use brz_mysql::{FromMysqlRow, Mysql, MysqlResult};
use sha2::{Digest, Sha256};

use crate::state::AppState;

/// `API_KEY_PREFIX` (`app.core.auth_utils`).
const API_KEY_PREFIX: &str = "wg-";
/// `KEY_TYPE_PERSONAL`.
const KEY_TYPE_PERSONAL: &str = "personal";

/// The authenticated external MCP user. `document_download_exempt` is not set
/// here: the middleware fills it from a non-empty `X-User-Name` header, and the
/// short-lived document token carries it to the file endpoint.
pub struct ExternalKnowledgeUser {
    pub id: i64,
    pub user_name: String,
}

/// `ExternalKnowledgeAuthHandler`: resolve the caller from the optional
/// gateway employee header and the optional bearer credential.
#[async_trait]
pub trait ExternalKnowledgeAuth: Send + Sync {
    async fn resolve(
        &self,
        state: &AppState,
        employee_id: Option<&str>,
        token: Option<&str>,
    ) -> Option<ExternalKnowledgeUser>;
}

/// `_default_external_auth_handler`: a personal API key resolves to its
/// active owner without a `last_used_at` write.
pub struct PersonalApiKeyAuth;

#[async_trait]
impl ExternalKnowledgeAuth for PersonalApiKeyAuth {
    async fn resolve(
        &self,
        state: &AppState,
        _employee_id: Option<&str>,
        token: Option<&str>,
    ) -> Option<ExternalKnowledgeUser> {
        verify_api_key(&state.mysql, token?).await.ok().flatten()
    }
}

/// `verify_api_key(db, token, update_last_used_at=False)`:
/// `find_valid_api_key` (personal, active, unexpired) then its owner.
async fn verify_api_key<M>(mysql: &M, api_key: &str) -> MysqlResult<Option<ExternalKnowledgeUser>>
where
    M: Mysql,
{
    if !api_key.starts_with(API_KEY_PREFIX) {
        return Ok(None);
    }
    let key_hash = format!("{:x}", Sha256::digest(api_key.as_bytes()));
    let record: Option<ApiKeyRow> = mysql
        .fetch_optional(
            "SELECT user_id, expires_at, key_type FROM api_keys \
             WHERE key_hash = ? AND is_active = 1 LIMIT 1",
            (key_hash.as_str(),),
        )
        .await?;
    let Some(record) = record else {
        return Ok(None);
    };
    if record.key_type != KEY_TYPE_PERSONAL || record.is_expired() {
        return Ok(None);
    }
    let user: Option<OwnerRow> = mysql
        .fetch_optional(
            "SELECT users.id AS users_id, users.user_name AS users_user_name \
             FROM users WHERE users.id = ? LIMIT 1",
            (record.user_id,),
        )
        .await?;
    Ok(user
        .filter(|user| user.users_is_active != 0)
        .map(|user| ExternalKnowledgeUser {
            id: user.users_id,
            user_name: user.users_user_name,
        }))
}

/// The `api_keys` columns `find_valid_api_key` reads.
#[derive(Debug, FromMysqlRow)]
struct ApiKeyRow {
    user_id: i64,
    /// `DATETIME` kept as text; the source compares a naive UTC value.
    expires_at: String,
    key_type: String,
}

impl ApiKeyRow {
    /// `api_key_record.expires_at < datetime.utcnow()`.
    fn is_expired(&self) -> bool {
        let now = chrono::Utc::now().naive_utc().format("%Y-%m-%d %H:%M:%S");
        self.expires_at.trim() < now.to_string().as_str()
    }
}

/// The key owner's identity and activity flag.
#[derive(Debug, FromMysqlRow)]
struct OwnerRow {
    users_id: i64,
    users_user_name: String,
    users_is_active: i8,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_wg_prefixed_credentials_are_api_keys() {
        for key in ["wg-abcdef", "wg-"] {
            assert!(key.starts_with(API_KEY_PREFIX), "{key}");
        }
        for key in ["eyJhbGciOi", ""] {
            assert!(!key.starts_with(API_KEY_PREFIX), "{key}");
        }
    }

    #[test]
    fn expiry_compares_the_naive_utc_text() {
        let expired = ApiKeyRow {
            user_id: 1,
            expires_at: "2000-01-01 00:00:00".to_string(),
            key_type: KEY_TYPE_PERSONAL.to_string(),
        };
        assert!(expired.is_expired());
        let valid = ApiKeyRow {
            user_id: 1,
            expires_at: "2999-01-01 00:00:00".to_string(),
            key_type: KEY_TYPE_PERSONAL.to_string(),
        };
        assert!(!valid.is_expired());
    }
}
