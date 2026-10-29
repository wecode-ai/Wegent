// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The `api_keys` half of `get_auth_context` and the `users` read that follows
//! it (`app/core/security.py`).
//!
//! `POST /api/v1/responses` splits this chain: the extractor stops at
//! [`AuthenticatedKey`] and the create path owns the `users` read and the
//! post-commit `api_keys` reload, because the recorded transaction issues them.

use sha2::{Digest, Sha256};

use super::{AuthError, auth_id, cached_user_by_id, cached_user_by_name};
use crate::request_sql::{RequestSql, RouteKey};
use crate::user_reader::{UserByIdReader, UserRecord};

/// `KEY_TYPE_PERSONAL` (`app.models.api_key`).
const KEY_TYPE_PERSONAL: &str = "personal";

/// `KEY_TYPE_SERVICE` (`app.models.api_key`).
const KEY_TYPE_SERVICE: &str = "service";

/// `api_keys` row selected by hash (`db.query(APIKey).filter(key_hash, is_active)`).
///
/// The full SQLAlchemy-labeled projection with the hash and `is_active`
/// filters inlined as literals, matching the recorded text `COM_QUERY`
/// exactly (the source session renders ORM queries as text with inlined
/// scalars); the row decodes through `MysqlRow` because the aliases embed
/// the `api_keys_` prefix.
#[derive(Debug)]
struct ApiKeyRow {
    id: i32,
    user_id: i32,
    key_type: String,
    /// `DATETIME` decoded as the driver's datetime type; compared against
    /// the current naive-UTC timestamp like the source.
    expires_at: chrono::NaiveDateTime,
}

impl ApiKeyRow {
    /// Decode one row of the labeled `api_keys` projection.
    fn from_row(row: &brz_mysql::MysqlRow) -> brz_mysql::MysqlResult<Self> {
        Ok(Self {
            id: row.get_required("api_keys_id")?,
            user_id: row.get_required("api_keys_user_id")?,
            key_type: row.get_required("api_keys_key_type")?,
            expires_at: row.get_required("api_keys_expires_at")?,
        })
    }
}

/// `api_keys` columns as rendered by `db.query(APIKey)` (SQLAlchemy's
/// labeled full-entity projection).
const API_KEY_COLUMNS: &str = "api_keys.id AS api_keys_id, \
     api_keys.user_id AS api_keys_user_id, api_keys.key_hash AS api_keys_key_hash, \
     api_keys.key_prefix AS api_keys_key_prefix, api_keys.name AS api_keys_name, \
     api_keys.key_type AS api_keys_key_type, \
     api_keys.description AS api_keys_description, \
     api_keys.expires_at AS api_keys_expires_at, \
     api_keys.last_used_at AS api_keys_last_used_at, \
     api_keys.is_active AS api_keys_is_active, \
     api_keys.created_at AS api_keys_created_at, \
     api_keys.updated_at AS api_keys_updated_at";

/// `api_keys` row re-selected by primary key after the `last_used_at` commit
/// (SQLAlchemy expires the ORM object on commit; the next attribute read
/// reloads it). Only `name` is read by the source; the row is decoded by
/// name for the same labeled projection.
#[derive(Debug)]
pub(crate) struct ApiKeyReloadRow {
    pub(crate) name: String,
    #[allow(dead_code)]
    pub(crate) key_type: String,
}

/// The post-commit `api_keys` refresh on a caller-owned request transaction:
/// `SELECT {API_KEY_COLUMNS} … WHERE api_keys.id = {id}` with the literal id,
/// the same COM_QUERY shape the extractor issues (`auth.rs`'s reload).
pub(crate) async fn reload_api_key_on(
    sql: &mut dyn crate::request_sql::RequestSql,
    api_key_id: i64,
) -> brz_mysql::MysqlResult<Option<ApiKeyReloadRow>> {
    let row = sql
        .fetch_optional_row(
            crate::request_sql::RouteKey::None,
            &format!("SELECT {API_KEY_COLUMNS} \nFROM api_keys \nWHERE api_keys.id = {api_key_id}"),
            Vec::new(),
        )
        .await?;
    row.as_ref().map(ApiKeyReloadRow::from_row).transpose()
}

impl ApiKeyReloadRow {
    pub(crate) fn from_row(row: &brz_mysql::MysqlRow) -> brz_mysql::MysqlResult<Self> {
        Ok(Self {
            name: row.get_required("api_keys_name")?,
            key_type: row.get_required("api_keys_key_type")?,
        })
    }
}

/// The `users` columns as `db.refresh(user)` renders them: SQLAlchemy's
/// unlabeled full-entity projection read by primary key.
const USER_RELOAD_COLUMNS: &str = "users.id, users.user_name, users.password_hash, users.email, \
     users.git_info, users.is_active, users.`role`, users.auth_source, users.preferences, \
     users.created_at, users.updated_at";

/// `db.refresh(current_user)`: SQLAlchemy expires the ORM object on the write
/// commit (`cancel_response`'s `db.commit()`), so the later
/// `current_user.id` read inside `get_task_by_id` re-selects the authenticated
/// user's row by primary key. The row itself is not consumed (only the id is
/// read, and the target already holds it), so the call exists to keep the
/// source's observable read.
pub(crate) async fn reload_current_user(
    mysql: &brz_mysql::MysqlService,
    user_id: i32,
) -> Result<(), brz_mysql::MysqlError> {
    let _: Option<brz_mysql::MysqlRow> = mysql
        .fetch_optional(
            &format!("SELECT {USER_RELOAD_COLUMNS} \nFROM users \nWHERE users.id = ?"),
            (user_id,),
        )
        .await?;
    Ok(())
}

/// `api_key#username` format split (`get_auth_context`).
pub(super) fn split_key_with_username(api_key: &str) -> (String, Option<String>) {
    match api_key.split_once('#') {
        Some((key, username)) if !username.is_empty() => {
            (key.to_string(), Some(username.to_string()))
        }
        Some((key, _)) => (key.to_string(), None),
        None => (api_key.to_string(), None),
    }
}

/// Lowercase hex SHA-256 of `value`.
pub(super) fn hex_sha256(value: &[u8]) -> String {
    let digest = Sha256::digest(value);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// The naive-UTC `expires_at` boundary (`api_key_record.expires_at <
/// datetime.utcnow()`), second precision.
fn api_key_expired(expires_at: chrono::NaiveDateTime) -> bool {
    expires_at < chrono::Utc::now().naive_utc()
}

/// The API-key half of `get_current_user_flexible`, resolved up to - but not
/// including - the `users` row (`app/core/security.py:get_auth_context`).
///
/// `lookup` names the read that still has to happen. `POST /api/v1/responses`
/// defers it into its own request transaction (the recorded transaction reads
/// `api_keys` then `users` before any write); every other route resolves it
/// immediately in [`get_current_user_flexible`].
pub(crate) struct AuthenticatedKey {
    pub api_key_id: i64,
    pub api_key_name: Option<String>,
    pub lookup: UserLookup,
}

/// The `users` read an authenticated API key still needs.
pub(crate) enum UserLookup {
    /// Personal key: the key owner's id (`cached_user_by_id`).
    ById(i64),
    /// Service key: the target username (`cached_user_by_name`).
    ByName(String),
}

/// The `api_keys` half of `get_auth_context`: hash select, expiration check,
/// `last_used_at` update and the (optionally deferred) post-commit reload.
/// Every rejection here fires before the request transaction opens.
pub(crate) async fn authenticate_api_key(
    mysql: &brz_mysql::MysqlService,
    api_key: &str,
    wegent_username: Option<String>,
    defer_post_commit_refresh: bool,
) -> Result<AuthenticatedKey, AuthError> {
    // `api_key#username` format.
    let (actual_api_key, username_from_key) = split_key_with_username(api_key);

    // Select the key by SHA-256 hash (full labeled projection, scalar
    // filters inlined as literals like the recorded `COM_QUERY`).
    let key_hash = hex_sha256(actual_api_key.as_bytes());
    let row: Option<brz_mysql::MysqlRow> = mysql
        .fetch_optional(
            &format!(
                "SELECT {API_KEY_COLUMNS} \nFROM api_keys \n\
                 WHERE api_keys.key_hash = '{key_hash}' \
                 AND api_keys.is_active = true \n LIMIT 1"
            ),
            (),
        )
        .await
        .map_err(AuthError::dependency)?;
    let Some(record) = row
        .as_ref()
        .map(ApiKeyRow::from_row)
        .transpose()
        .map_err(AuthError::dependency)?
    else {
        return Err(AuthError::InvalidApiKey);
    };

    // Expiration check (naive UTC comparison).
    if api_key_expired(record.expires_at) {
        return Err(AuthError::ApiKeyExpired);
    }

    // `last_used_at` bookkeeping write (UPDATE + COMMIT). The source renders
    // `datetime.utcnow()` (microsecond precision, naive UTC) as an inlined
    // literal, so the recorded UPDATE carries the recording-time timestamp
    // while a faithful replay emits a replay-time value that can never match
    // byte-for-byte. brz-mysql routes every statement through sqlx's
    // prepared path, so this literal-only write is emitted as
    // COM_STMT_EXECUTE (no bound parameters), never the recorded COM_QUERY
    // text command; the SDK exposes no raw text-protocol escape hatch. The
    // replay engine's `mysql sql_values` time rules (repair
    // 3e89636ba0b5e9f5, planned through the coordinator's `mysql-time`
    // dependency rule) cover exactly this form: a tokenized UPDATE template
    // whose `last_used_at` slot is validated against replay_now, matching
    // across the COM_QUERY/COM_STMT_EXECUTE protocol difference. Until that
    // rule is applied the write stays unmatched; its failure is swallowed so
    // the request proceeds while the response — which never reads
    // `last_used_at` — still matches.
    let now = chrono::Utc::now()
        .naive_utc()
        .format("%Y-%m-%d %H:%M:%S%.6f")
        .to_string();
    if let Err(error) = mysql
        .execute(
            &format!(
                "UPDATE api_keys SET last_used_at='{now}', updated_at=now() \
                 WHERE api_keys.id = {}",
                record.id
            ),
            (),
        )
        .await
    {
        tracing::warn!(%error, "[auth] last_used_at update failed; continuing");
    }
    // The source's helper session ends this write with `db.commit()`.
    // `brz-mysql`'s `ai-strict` rejects a pooled `COMMIT` because the service
    // manages autocommit itself, and the pooled `UPDATE` above is already
    // durable; no manual commit is issued.
    // SQLAlchemy expires the ORM object on commit; the endpoint's later
    // `api_key_record.name` read reloads the row by primary key (full
    // labeled projection, literal id).
    let reload: Option<brz_mysql::MysqlRow> = if defer_post_commit_refresh {
        None
    } else {
        mysql
            .fetch_optional(
                &format!(
                    "SELECT {API_KEY_COLUMNS} \nFROM api_keys \n\
                 WHERE api_keys.id = {}",
                    record.id
                ),
                (),
            )
            .await
            .map_err(AuthError::dependency)?
    };
    let reload = reload
        .as_ref()
        .map(ApiKeyReloadRow::from_row)
        .transpose()
        .map_err(AuthError::dependency)?;

    // `AuthContext.api_key_name` is `api_key_record.name`; `create_response`
    // writes it into the Task CRD's `metadata.labels.api_key_name`.
    let api_key_name = reload.map(|row| row.name);

    if record.key_type == KEY_TYPE_PERSONAL {
        return Ok(AuthenticatedKey {
            api_key_id: i64::from(record.id),
            api_key_name,
            lookup: UserLookup::ById(i64::from(record.user_id)),
        });
    }

    if record.key_type == KEY_TYPE_SERVICE {
        let target_username = username_from_key.or(wegent_username);
        let Some(target_username) = target_username else {
            return Err(AuthError::UsernameRequired);
        };
        // Username format validation (`^[a-zA-Z0-9_-]+$`).
        if target_username.is_empty()
            || !target_username
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return Err(AuthError::InvalidUsernameFormat);
        }
        return Ok(AuthenticatedKey {
            api_key_id: i64::from(record.id),
            api_key_name,
            lookup: UserLookup::ByName(target_username),
        });
    }

    Err(AuthError::InvalidAuthenticationCredentials)
}

/// The auth fields every resolved `users` row yields.
fn user_fields(user: &UserRecord) -> (i32, String, serde_json::Value, String) {
    (
        auth_id(user),
        user.user_name.clone(),
        user.git_info.clone(),
        user.preferences.clone(),
    )
}

/// The outcome shared by the personal-key read and the service key's follow-up
/// read: a miss or an inactive row is `UserNotFoundOrInactive`.
fn require_active_user(
    user: Option<UserRecord>,
) -> Result<(i32, String, serde_json::Value, String), AuthError> {
    match user {
        Some(user) if user.is_active => Ok(user_fields(&user)),
        _ => Err(AuthError::UserNotFoundOrInactive),
    }
}

/// The by-name lookup outcome: an inactive user is `UserInactive`.
fn by_name_user_fields(
    user: Option<UserRecord>,
    target_username: &str,
) -> Result<(i32, String, serde_json::Value, String), AuthError> {
    match user {
        Some(user) if !user.is_active => Err(AuthError::UserInactive(target_username.to_string())),
        Some(user) => Ok(user_fields(&user)),
        None => Err(AuthError::UserNotFoundOrInactive),
    }
}

/// `cached_user_by_id` + the personal-key outcome: a miss or an inactive owner
/// is `UserNotFoundOrInactive`.
pub(super) async fn resolve_personal_user(
    user_reader: &dyn UserByIdReader,
    user_id: i64,
) -> Result<(i32, String, serde_json::Value, String), AuthError> {
    require_active_user(cached_user_by_id(user_reader, user_id).await?)
}

/// `cached_user_by_name` + the service-key outcomes: an inactive user is
/// `UserInactive`, and an unknown one repeats the source's follow-up read
/// (the source auto-creates the user; the replay has no write and re-selects).
pub(super) async fn resolve_service_user(
    user_reader: &dyn UserByIdReader,
    mysql: &brz_mysql::MysqlService,
    target_username: &str,
) -> Result<(i32, String, serde_json::Value, String), AuthError> {
    if let Some(user) = cached_user_by_name(user_reader, target_username).await? {
        return by_name_user_fields(Some(user), target_username);
    }
    let created: Option<brz_mysql::MysqlRow> = mysql
        .fetch_optional(&user_by_name_literal(target_username), ())
        .await
        .map_err(AuthError::dependency)?;
    let created = created
        .as_ref()
        .map(UserRecord::from_mysql_row)
        .transpose()
        .map_err(AuthError::dependency)?;
    require_active_user(created)
}

/// The `users` row an authenticated API key still needs, read on the caller's
/// request transaction.
///
/// `POST /api/v1/responses` records this read inside the session transaction
/// (`get_auth_context` calls `userReader` with the request's session), so the
/// extractor must not resolve it on a pooled connection first. The read still
/// goes through the deployment's reader, including its cache: only the SQL the
/// reader issues on a cache miss moves onto `sql`.
pub(crate) async fn resolve_authenticated_key_on(
    user_reader: &dyn UserByIdReader,
    sql: &mut dyn RequestSql,
    key: AuthenticatedKey,
) -> Result<super::CurrentUser, AuthError> {
    let (id, user_name, git_info, preferences) = match &key.lookup {
        UserLookup::ById(user_id) => personal_user_on(user_reader, sql, *user_id).await?,
        UserLookup::ByName(user_name) => service_user_on(user_reader, sql, user_name).await?,
    };
    Ok(super::CurrentUser {
        id,
        user_name,
        api_key_name: key.api_key_name,
        api_key_id: Some(key.api_key_id),
        git_info,
        preferences,
    })
}

async fn personal_user_on(
    user_reader: &dyn UserByIdReader,
    sql: &mut dyn RequestSql,
    user_id: i64,
) -> Result<(i32, String, serde_json::Value, String), AuthError> {
    let user = user_reader
        .get_by_id_on(sql, user_id)
        .await
        .map_err(super::reader_failure)?;
    require_active_user(user)
}

async fn service_user_on(
    user_reader: &dyn UserByIdReader,
    sql: &mut dyn RequestSql,
    target_username: &str,
) -> Result<(i32, String, serde_json::Value, String), AuthError> {
    let found = user_reader
        .get_by_name_on(sql, target_username)
        .await
        .map_err(super::reader_failure)?;
    if found.is_some() {
        return by_name_user_fields(found, target_username);
    }
    let created = sql
        .fetch_optional_row(
            RouteKey::None,
            &user_by_name_literal(target_username),
            Vec::new(),
        )
        .await
        .map_err(AuthError::dependency)?;
    let created = created
        .as_ref()
        .map(UserRecord::from_mysql_row)
        .transpose()
        .map_err(AuthError::dependency)?;
    require_active_user(created)
}

/// The source's follow-up read when the by-name lookup misses: the same
/// labeled projection with the name inlined as a literal.
fn user_by_name_literal(username: &str) -> String {
    format!(
        "SELECT users.id AS users_id, users.user_name AS users_user_name, \
         users.password_hash AS users_password_hash, users.email AS users_email, \
         users.git_info AS users_git_info, users.is_active AS users_is_active, \
         users.`role` AS users_role, users.auth_source AS users_auth_source, \
         users.preferences AS users_preferences, users.created_at AS users_created_at, \
         users.updated_at AS users_updated_at \nFROM users \n\
         WHERE users.user_name = '{}' \n LIMIT 1",
        username.replace('\'', "\\'")
    )
}
