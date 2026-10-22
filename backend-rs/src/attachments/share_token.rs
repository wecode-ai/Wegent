// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Share-token authentication for the attachment download exit
//! (`app/api/endpoints/adapter/attachments.py:_validate_share_token_access`
//! and `app/services/shared_task.py:decode_share_token`).
//!
//! A share token is the URL-encoded AES-256-CBC ciphertext of
//! `"{user_id}#{task_id}"`, produced by `SharedTaskService.generate_share_token`
//! with `settings.SHARE_TOKEN_AES_KEY` / `SHARE_TOKEN_AES_IV`. Decoding
//! restores the ids, then re-reads the owning active `users` row and the active
//! `Task` row before the caller checks the attachment's task/subtask linkage.
//!
//! Every decode, parse, or lookup failure collapses to "no access" (the source
//! returns `False`, which the handler renders as its 404); only a MySQL failure
//! propagates.

use std::borrow::Cow;
use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use brz_mysql::{MysqlResult, MysqlRow};

use super::auth::UserRow;
use super::context_store;
use super::handler::internal_error;
use crate::http_compat::FastApiError;
use crate::state::AppState;

/// `ContextType.ATTACHMENT`.
const CONTEXT_TYPE_ATTACHMENT: &str = "attachment";

/// `settings.SHARE_TOKEN_AES_KEY` pydantic default (32 bytes -> AES-256).
const DEFAULT_SHARE_AES_KEY: &str = "12345678901234567890123456789012";
/// `settings.SHARE_TOKEN_AES_IV` pydantic default (16 bytes).
const DEFAULT_SHARE_AES_IV: &str = "1234567890123456";

/// `db.query(User).filter(User.id == user_id, User.is_active == True).first()`:
/// every mapped column, aliased `users_<column>` like SQLAlchemy's labeled
/// rendering.
const USER_BY_ID_QUERY: &str = "SELECT users.id AS users_id, \
     users.user_name AS users_user_name, \
     users.password_hash AS users_password_hash, users.email AS users_email, \
     users.git_info AS users_git_info, users.is_active AS users_is_active, \
     users.`role` AS users_role, users.auth_source AS users_auth_source, \
     users.preferences AS users_preferences, users.created_at AS users_created_at, \
     users.updated_at AS users_updated_at \
     FROM users \
     WHERE users.id = ? AND users.is_active = true \
     LIMIT 1";

/// The `decode_share_token` result fields `_validate_share_token_access`
/// consumes (`TaskShareInfo.user_id` / `.task_id`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ShareInfo {
    pub user_id: i64,
    pub task_id: i64,
}

/// `_validate_share_token_access`: the same attachment access the source
/// applies for a public shared-task viewer.
///
/// `Ok(true)` grants access; `Ok(false)` is the source's `False` (rendered as
/// the handler's 404); `Err` is a MySQL failure the source leaves unhandled.
pub(super) async fn validate_share_token_access(
    state: &Arc<AppState>,
    attachment_id: i64,
    share_token: &str,
) -> Result<bool, FastApiError> {
    let Some(share_info) = decode_share_token(state, share_token).await? else {
        return Ok(false);
    };

    let context = context_store::get_context_optional(&state.mysql, attachment_id)
        .await
        .map_err(|error| {
            tracing::error!(%error, "share-token context lookup failed");
            internal_error()
        })?;
    let Some(context) = context else {
        return Ok(false);
    };
    if context.context_type != CONTEXT_TYPE_ATTACHMENT {
        return Ok(false);
    }

    // Unlinked attachments authorize on the owner matching the token.
    if context.subtask_id <= 0 {
        return Ok(i64::from(context.user_id) == share_info.user_id);
    }

    // `subtask_store.get_by_id`: the full projection; a returned row then
    // triggers the source's `subqueryload(Subtask.contexts)` batch (an
    // inline-id read against the base `subtask_contexts` table).
    let subtask = context_store::get_subtask_by_id(&*state.task_store, context.subtask_id)
        .await
        .map_err(|error| {
            tracing::error!(%error, "share-token subtask lookup failed");
            internal_error()
        })?;
    let Some(subtask) = subtask else {
        return Ok(false);
    };
    load_subtask_contexts(&state.mysql, context.subtask_id)
        .await
        .map_err(|error| {
            tracing::error!(%error, "share-token subtask context load failed");
            internal_error()
        })?;
    if subtask.task_id != share_info.task_id {
        return Ok(false);
    }

    // `task_store.get_owned_task_by_state`: the active task owned by the token
    // user.
    let owned = state
        .task_store
        .get_active_task_owned(share_info.task_id, share_info.user_id as i32)
        .await
        .map_err(|error| {
            tracing::error!(%error, "share-token task ownership lookup failed");
            internal_error()
        })?;
    Ok(owned.is_some())
}

/// `SharedTaskService.decode_share_token(share_token, db)`: `Ok(None)` for
/// every decode/parse or user/task lookup failure; `Err` only when a lookup
/// itself fails.
async fn decode_share_token(
    state: &Arc<AppState>,
    share_token: &str,
) -> Result<Option<ShareInfo>, FastApiError> {
    let Some(info) = decode_payload(share_token) else {
        return Ok(None);
    };
    // The source runs both lookups unconditionally (`user = ...; task = ...;
    // if not user or not task: return None`), so the reads stay in this order.
    let user: Option<UserRow> = state
        .mysql
        .fetch_optional(USER_BY_ID_QUERY, (info.user_id,))
        .await
        .map_err(|error| {
            tracing::error!(%error, "share-token user lookup failed");
            internal_error()
        })?;
    let task = state
        .task_store
        .get_active_task(info.task_id)
        .await
        .map_err(|error| {
            tracing::error!(%error, "share-token task lookup failed");
            internal_error()
        })?;
    if user.is_none() || task.is_none() {
        return Ok(None);
    }
    Ok(Some(info))
}

/// `SharedTaskService._aes_decrypt` + the `"{user_id}#{task_id}"` parse: the
/// pure decode half of `decode_share_token`.
pub(crate) fn decode_payload(share_token: &str) -> Option<ShareInfo> {
    let (user_id, task_id) = decode_id_pair(share_token)?;
    Some(ShareInfo { user_id, task_id })
}

/// The `"{user_id}#{target_id}"` payload shared by the task and team share
/// tokens (`SharedTaskService.decode_share_token` and
/// `SharedTeamService.decode_share_token`, which use the same
/// `SHARE_TOKEN_AES_*` key material and id format).
pub(crate) fn decode_id_pair(share_token: &str) -> Option<(i64, i64)> {
    decode_ids_with_key_material(
        share_aes_key().as_ref(),
        share_aes_iv().as_ref(),
        share_token,
    )
}

/// The `SHARE_TOKEN_AES_*`-parameterized decode: `unquote` + base64 + AES-CBC
/// + PKCS#7 unpadding, then the id parse.
fn decode_ids_with_key_material(key: &str, iv: &str, share_token: &str) -> Option<(i64, i64)> {
    let decoded = percent_decode(share_token);
    let encrypted = STANDARD.decode(decoded.as_bytes()).ok()?;
    let plaintext =
        super::crypto::decrypt_with_key(key.as_bytes(), iv.as_bytes(), &encrypted).ok()?;
    let text = String::from_utf8(plaintext).ok()?;
    let (user_id, target_id) = text.split_once('#')?;
    Some((user_id.parse().ok()?, target_id.parse().ok()?))
}

/// Source-shaped decode used by the tests below: the id pair rebuilt into the
/// task-share [`ShareInfo`].
#[cfg(test)]
fn decode_with_key_material(key: &str, iv: &str, share_token: &str) -> Option<ShareInfo> {
    let (user_id, task_id) = decode_ids_with_key_material(key, iv, share_token)?;
    Some(ShareInfo { user_id, task_id })
}

/// `subqueryload(Subtask.contexts)`: the contexts of one subtask, the source
/// renders the subtask id as an inline literal inside a comma-separated list
/// (as `ShardedSubtaskStore` does), ordered by `id`.
async fn load_subtask_contexts(
    mysql: &brz_mysql::MysqlService,
    subtask_id: i64,
) -> MysqlResult<()> {
    let sql = format!(
        "SELECT {} \
         FROM subtask_contexts \nWHERE subtask_contexts.subtask_id IN ({subtask_id}) \
         ORDER BY subtask_contexts.id ASC",
        crate::task_store::subtask_context_columns()
    );
    let _: Vec<MysqlRow> = mysql.fetch_all(&sql, ()).await?;
    Ok(())
}

/// `settings.SHARE_TOKEN_AES_KEY` (`env_or_dotenv`, pydantic default).
fn share_aes_key() -> Cow<'static, str> {
    configured("SHARE_TOKEN_AES_KEY", DEFAULT_SHARE_AES_KEY)
}

/// `settings.SHARE_TOKEN_AES_IV` (`env_or_dotenv`, pydantic default).
fn share_aes_iv() -> Cow<'static, str> {
    configured("SHARE_TOKEN_AES_IV", DEFAULT_SHARE_AES_IV)
}

fn configured(name: &str, default: &'static str) -> Cow<'static, str> {
    match crate::config::env_or_dotenv(name) {
        Some(value) => Cow::Owned(value),
        None => Cow::Borrowed(default),
    }
}

/// `urllib.parse.unquote`: `%XX` escapes decoded to their byte, invalid
/// sequences left verbatim.
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%'
            && index + 2 < bytes.len()
            && let (Some(high), Some(low)) =
                (hex_value(bytes[index + 1]), hex_value(bytes[index + 2]))
        {
            out.push((high << 4) | low);
            index += 3;
            continue;
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Ciphertexts produced by `openssl enc -aes-256-cbc -base64` with the
    // source default key/IV and PKCS#7 padding, so a change to the block
    // order, the chaining, the unpadding, or the parse fails here rather than
    // in Replay.
    const TOKEN_7_42: &str = "huK5LFyLSW5tXcSY+0IOJQ==";
    const TOKEN_NO_SEPARATOR: &str = "5E8IcBMaqY3U4flbMOr7oQ==";
    const TOKEN_NON_NUMERIC: &str = "toCRg++g2RQgmvOl7rUKug==";

    #[test]
    fn decodes_the_source_constructed_payload() {
        assert_eq!(
            decode_with_key_material(DEFAULT_SHARE_AES_KEY, DEFAULT_SHARE_AES_IV, TOKEN_7_42),
            Some(ShareInfo {
                user_id: 7,
                task_id: 42,
            })
        );
    }

    #[test]
    fn exposes_the_generic_id_pair_for_team_share_tokens() {
        // `SharedTeamService.decode_share_token` reads the same
        // `"{user_id}#{team_id}"` payload as the task share token.
        assert_eq!(
            decode_ids_with_key_material(DEFAULT_SHARE_AES_KEY, DEFAULT_SHARE_AES_IV, TOKEN_7_42),
            Some((7, 42))
        );
    }

    #[test]
    fn decodes_a_percent_encoded_token() {
        let encoded = TOKEN_7_42.replace('+', "%2B").replace('/', "%2F");
        assert_eq!(
            decode_with_key_material(DEFAULT_SHARE_AES_KEY, DEFAULT_SHARE_AES_IV, &encoded),
            Some(ShareInfo {
                user_id: 7,
                task_id: 42,
            })
        );
    }

    #[test]
    fn rejects_malformed_payloads() {
        let decode = |token: &str| {
            decode_with_key_material(DEFAULT_SHARE_AES_KEY, DEFAULT_SHARE_AES_IV, token)
        };
        // A decodable payload without the `user_id#task_id` shape.
        assert_eq!(decode(TOKEN_NO_SEPARATOR), None);
        // A decodable payload whose ids are not integers.
        assert_eq!(decode(TOKEN_NON_NUMERIC), None);
        // Not valid base64, and not valid ciphertext/padding respectively.
        assert_eq!(decode("not base64!!"), None);
        assert_eq!(decode(&STANDARD.encode(b"short")), None);
    }

    #[test]
    fn percent_decode_matches_python_unquote() {
        assert_eq!(percent_decode("a%2Fb%3D"), "a/b=");
        // Invalid escapes are left verbatim.
        assert_eq!(percent_decode("a%2"), "a%2");
        assert_eq!(percent_decode("a%zz"), "a%zz");
        assert_eq!(percent_decode("plain"), "plain");
    }
}
