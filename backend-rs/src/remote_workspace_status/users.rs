// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! User lookups for `get_current_user` (`app.core.security.get_current_user`)
//! and `get_task_detail` (`userReader.get_by_id`).
//!
//! Source `get_current_user` queries the `users` table directly with
//! SQLAlchemy's full labeled column list
//! (`SELECT users.<col> AS users_<col>, ... FROM users WHERE users.user_name =
//! ? LIMIT 1`); the public implementation performs no Redis lookup for the
//! name query.
use brz_mysql::{FromMysqlRow, Json, Mysql};
use chrono::NaiveDateTime;

use super::app_state::AppState;
use super::redis_cache::CACHE_TTL_SECONDS;
use crate::json_compat::{OpaqueJson, python_json_string, python_json_value};

pub struct UserStore;

/// A `users` row selected with the source SQLAlchemy projection: every mapped
/// column, labeled `users_<column>`. Only `id`, `user_name`, and `is_active`
/// are consumed by the response; the remaining columns are decoded because the
/// deployment's cached reader writes the whole row back to Redis. Decoding
/// them keeps the statement matching the recorded source query byte-for-byte
/// (modulo the bound parameter).
#[derive(Debug, FromMysqlRow)]
pub struct UserRow {
    pub users_id: i32,
    pub users_user_name: String,
    #[mysql(rename = "users_password_hash")]
    pub users_password_hash: String,
    pub users_email: Option<String>,
    pub users_git_info: Json<Option<OpaqueJson>>,
    pub users_is_active: i8,
    pub users_role: String,
    pub users_auth_source: String,
    pub users_preferences: String,
    pub users_created_at: NaiveDateTime,
    pub users_updated_at: NaiveDateTime,
}

/// `get_current_user`'s `db.query(User).filter(User.user_name ==
/// username).first()` statement, rendered exactly as SQLAlchemy labels it.
#[allow(
    dead_code,
    reason = "route authentication now runs through AppAuthenticator"
)]
const USER_BY_NAME_QUERY: &str = "SELECT users.id AS users_id, users.user_name AS users_user_name, \
     users.password_hash AS users_password_hash, users.email AS users_email, \
     users.git_info AS users_git_info, users.is_active AS users_is_active, \
     users.`role` AS users_role, users.auth_source AS users_auth_source, \
     users.preferences AS users_preferences, users.created_at AS users_created_at, \
     users.updated_at AS users_updated_at \
     FROM users \
     WHERE users.user_name = ? \
     LIMIT 1";

#[allow(
    dead_code,
    reason = "route authentication now runs through AppAuthenticator"
)]
pub async fn get_by_name(
    state: &AppState<impl Mysql, impl brz_redis::Redis>,
    user_name: &str,
) -> anyhow::Result<Option<UserRow>> {
    let row: Option<UserRow> =
        Mysql::fetch_optional(&state.mysql, USER_BY_NAME_QUERY, (user_name,)).await?;
    Ok(row)
}

/// Serialize one `users` row exactly like Python
/// `json.dumps(model_to_dict(user))` (`CachedUserReader._set_data`):
/// `model_to_dict` walks the `users` table columns in declaration order and
/// renders every datetime with `datetime.isoformat()`, then `json.dumps` uses
/// its default separators (`", "` / `": "`) and `ensure_ascii=True` escaping.
fn python_user_model_json(row: &UserRow) -> String {
    let mut out = String::with_capacity(512);
    out.push('{');
    let mut first = true;
    let mut push = |out: &mut String, key: &str, value: &str| {
        if !first {
            out.push_str(", ");
        }
        first = false;
        out.push_str(&python_json_string(key));
        out.push_str(": ");
        out.push_str(value);
    };
    push(&mut out, "id", &row.users_id.to_string());
    push(
        &mut out,
        "user_name",
        &python_json_string(&row.users_user_name),
    );
    push(
        &mut out,
        "password_hash",
        &python_json_string(&row.users_password_hash),
    );
    push(
        &mut out,
        "email",
        &row.users_email
            .as_deref()
            .map(python_json_string)
            .unwrap_or_else(|| "null".to_owned()),
    );
    push(
        &mut out,
        "git_info",
        &row.users_git_info
            .0
            .as_ref()
            .map(|git_info| python_json_value(&git_info.to_value()))
            .unwrap_or_else(|| "null".to_owned()),
    );
    push(
        &mut out,
        "is_active",
        if row.users_is_active != 0 {
            "true"
        } else {
            "false"
        },
    );
    push(&mut out, "role", &python_json_string(&row.users_role));
    push(
        &mut out,
        "auth_source",
        &python_json_string(&row.users_auth_source),
    );
    push(
        &mut out,
        "preferences",
        &python_json_string(&row.users_preferences),
    );
    push(
        &mut out,
        "created_at",
        &format!("\"{}\"", row.users_created_at.format("%Y-%m-%dT%H:%M:%S")),
    );
    push(
        &mut out,
        "updated_at",
        &format!("\"{}\"", row.users_updated_at.format("%Y-%m-%dT%H:%M:%S")),
    );
    out.push('}');
    out
}

/// `userReader.get_by_id` as the status task-detail chain performs it: a
/// supplied user-cache client serves the read from the `user:v2:data:{user_id}`
/// document (the deployment's cached reader) and writes the row back after the
/// SQL fallback (`_set_data`), which is what makes the following lookup a
/// cache hit; without a client the read stays on the public direct SQL path.
pub(crate) async fn cached_user_get_by_id(
    state: &AppState<impl Mysql, impl brz_redis::Redis>,
    user_id: i64,
) -> anyhow::Result<()> {
    let user_cache_key = format!("user:v2:data:{user_id}");
    let cached: Option<brz_redis::RedisBytes> = match state.cache.user_cache() {
        Some(redis) => redis
            .get(user_cache_key.as_str())
            .await
            .map_err(|error| {
                tracing::warn!(%error, key = %user_cache_key, "[user_cache] redis data read failed");
                error
            })
            .ok()
            .flatten(),
        None => None,
    };
    if cached.is_some() {
        return Ok(());
    }
    let row: Option<UserRow> = Mysql::fetch_optional(
        &state.mysql,
        "SELECT users.id AS users_id, users.user_name AS users_user_name, \
         users.password_hash AS users_password_hash, users.email AS users_email, \
         users.git_info AS users_git_info, users.is_active AS users_is_active, \
         users.`role` AS users_role, users.auth_source AS users_auth_source, \
         users.preferences AS users_preferences, users.created_at AS users_created_at, \
         users.updated_at AS users_updated_at \
         FROM users \
         WHERE users.id = ? \
         LIMIT 1",
        (user_id,),
    )
    .await?;
    // `_set_data`: `SETEX user:v2:data:{id} 300 <model json>`, best effort
    // like the source's `except` clause.
    if let (Some(redis), Some(row)) = (state.cache.user_cache(), row.as_ref())
        && let Err(error) = redis
            .set_ex(
                user_cache_key.as_str(),
                CACHE_TTL_SECONDS,
                python_user_model_json(row),
            )
            .await
    {
        tracing::warn!(%error, key = %user_cache_key, "[user_cache] redis data write failed");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user_row(git_info: Option<OpaqueJson>) -> UserRow {
        UserRow {
            users_id: 4242,
            users_user_name: "example_user".to_owned(),
            users_password_hash: "$2b$12$synthetic".to_owned(),
            users_email: Some("example_user@example.invalid".to_owned()),
            users_git_info: Json(git_info),
            users_is_active: 1,
            users_role: "user".to_owned(),
            users_auth_source: "unknown".to_owned(),
            users_preferences: r#"{"company_profile": {"name": "测试", "employee_id": "1"}}"#
                .to_owned(),
            users_created_at: chrono::NaiveDateTime::parse_from_str(
                "2025-12-09 15:58:34",
                "%Y-%m-%d %H:%M:%S",
            )
            .expect("timestamp"),
            users_updated_at: chrono::NaiveDateTime::parse_from_str(
                "2026-07-02 18:34:19",
                "%Y-%m-%d %H:%M:%S",
            )
            .expect("timestamp"),
        }
    }

    /// `json.dumps(model_to_dict(user))` column order, default separators,
    /// `ensure_ascii` escaping, and `datetime.isoformat()` timestamps. A
    /// reordered or reformatted document would leave the recorded `SETEX`
    /// unconsumed, which blocks the following `user:v2:data` read.
    #[test]
    fn cache_payload_matches_python_model_to_dict_serialization() {
        assert_eq!(
            python_user_model_json(&user_row(None)),
            r#"{"id": 4242, "user_name": "example_user", "password_hash": "$2b$12$synthetic", "email": "example_user@example.invalid", "git_info": null, "is_active": true, "role": "user", "auth_source": "unknown", "preferences": "{\"company_profile\": {\"name\": \"\u6d4b\u8bd5\", \"employee_id\": \"1\"}}", "created_at": "2025-12-09T15:58:34", "updated_at": "2026-07-02T18:34:19"}"#
        );
    }

    #[test]
    fn cache_payload_renders_a_stored_git_info_document() {
        #[derive(serde::Serialize)]
        struct GitInfoEntry {
            #[serde(rename = "type")]
            account_type: String,
            git_login: String,
        }
        let git_info = OpaqueJson::from_serializable(vec![GitInfoEntry {
            account_type: "gerrit".to_owned(),
            git_login: "example_user".to_owned(),
        }]);
        assert_eq!(
            python_user_model_json(&user_row(Some(git_info))),
            r#"{"id": 4242, "user_name": "example_user", "password_hash": "$2b$12$synthetic", "email": "example_user@example.invalid", "git_info": [{"type": "gerrit", "git_login": "example_user"}], "is_active": true, "role": "user", "auth_source": "unknown", "preferences": "{\"company_profile\": {\"name\": \"\u6d4b\u8bd5\", \"employee_id\": \"1\"}}", "created_at": "2025-12-09T15:58:34", "updated_at": "2026-07-02T18:34:19"}"#
        );
    }

    #[test]
    fn cache_payload_keeps_a_missing_email_as_null() {
        let mut row = user_row(None);
        row.users_email = None;
        row.users_is_active = 0;
        let payload = python_user_model_json(&row);
        assert!(payload.contains(r#""email": null"#));
        assert!(payload.contains(r#""is_active": false"#));
    }
}
