// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `userReader.get_by_id` for the task-scoped readers that consume the
//! deployment's user reader.
//!
//! The remote-workspace tree response discards the loaded user, so only the
//! read topology and the cache side effects are observable there; the task
//! detail response renders the same document. A deployment whose
//! `SERVICE_EXTENSION` replaces `userReader` with the read-through cache
//! (`CachedUserReader`) serves the lookup from the `user:v2:data:{user_id}`
//! document and falls back to the public SQL reader, writing the row back
//! with `SETEX` (300s TTL, `json.dumps(model_to_dict(user))` payload).
//! Without a cache client the lookup stays on the public direct SQL path.
use brz_mysql::{FromMysqlRow, Mysql};
use brz_redis::Redis;
use chrono::Timelike;
use serde_json::Value;

use super::error::ApiError;
use crate::json_compat::{python_json_string, python_json_value};

/// Cache TTL of the deployment's cached-reader contract.
const CACHE_TTL_SECONDS: u64 = 300;

/// `CachedUserReader._key_data`: the `user:v2:data` document key.
fn data_key(user_id: i64) -> String {
    format!("user:v2:data:{user_id}")
}

/// One `users` row selected with the source `UserReader.get_by_id`
/// projection: every mapped column, labeled `users_<column>`.
#[derive(Debug, FromMysqlRow)]
struct UserCacheRow {
    #[mysql(rename = "users_id")]
    id: i64,
    #[mysql(rename = "users_user_name")]
    user_name: String,
    #[mysql(rename = "users_password_hash")]
    password_hash: String,
    #[mysql(rename = "users_email")]
    email: Option<String>,
    /// `GitInfo` is an optional JSON column: a stored NULL renders as
    /// `"git_info": null` in the cache document (the recorded
    /// `user:v2:data:5647` payload).
    #[mysql(rename = "users_git_info")]
    git_info: Option<brz_mysql::Json<Value>>,
    #[mysql(rename = "users_is_active")]
    is_active: i8,
    #[mysql(rename = "users_role")]
    role: String,
    #[mysql(rename = "users_auth_source")]
    auth_source: String,
    #[mysql(rename = "users_preferences")]
    preferences: Option<String>,
    #[mysql(rename = "users_created_at")]
    created_at: chrono::NaiveDateTime,
    #[mysql(rename = "users_updated_at")]
    updated_at: chrono::NaiveDateTime,
}

/// The source `db.query(User).filter(User.id == user_id).first()` statement:
/// every mapped column, aliased `users_<column>` like SQLAlchemy's labeled
/// query rendering.
const USER_BY_ID_QUERY: &str = "SELECT users.id AS users_id, users.user_name AS users_user_name, \
     users.password_hash AS users_password_hash, users.email AS users_email, \
     users.git_info AS users_git_info, users.is_active AS users_is_active, \
     users.`role` AS users_role, users.auth_source AS users_auth_source, \
     users.preferences AS users_preferences, users.created_at AS users_created_at, \
     users.updated_at AS users_updated_at \
     FROM users \
     WHERE users.id = ? \
     LIMIT 1";

/// `userReader.get_by_id` as the task-detail chain performs it: the
/// `user:v2:data` document when the cache client is present and holds the
/// key, otherwise the direct SQL lookup and the `SETEX` write-back.
pub(crate) async fn get_by_id<M, R>(
    mysql: &M,
    redis: Option<&R>,
    user_id: i64,
) -> Result<(), ApiError>
where
    M: Mysql,
    R: Redis,
{
    load_document(mysql, redis, user_id).await.map(|_| ())
}

/// The same `userReader.get_by_id` read, returning the `user:v2:data`
/// document that now backs the key: the cached text on a hit, otherwise the
/// row's `json.dumps(model_to_dict(user))` payload written back with `SETEX`.
/// `None` when no user row exists.
///
/// Callers that need the user projection render it from this document, so the
/// cache read, the SQL fallback, and the write-back stay in one place.
pub(crate) async fn load_document<M, R>(
    mysql: &M,
    redis: Option<&R>,
    user_id: i64,
) -> Result<Option<String>, ApiError>
where
    M: Mysql,
    R: Redis,
{
    let key = data_key(user_id);
    if let Some(redis) = redis {
        let cached: brz_redis::RedisResult<Option<brz_redis::RedisBytes>> =
            redis.get(key.as_str()).await;
        match cached {
            Ok(Some(bytes)) => {
                let text = String::from_utf8_lossy(bytes.as_ref()).into_owned();
                // `_get_data` decodes with `json.loads`: a payload that is not
                // JSON is a miss that falls through to the SQL reader.
                if serde_json::from_str::<serde::de::IgnoredAny>(text.as_str()).is_ok() {
                    return Ok(Some(text));
                }
            }
            Ok(None) => {}
            // The source extension's `except` clauses treat a cache failure
            // as a miss that falls through to the SQL reader.
            Err(error) => {
                tracing::warn!(%error, key = %key, "[user_cache] redis data read failed");
            }
        }
    }
    // The `users` table is unsharded: the public reader binds no routing key.
    let row: Option<UserCacheRow> = mysql
        .fetch_optional(USER_BY_ID_QUERY, (user_id,))
        .await
        .map_err(super::error::database_query_failed)?;
    let Some(row) = row else {
        return Ok(None);
    };
    let payload = python_model_json(&row);
    if let Some(redis) = redis {
        // `_set_data`: best-effort like the source's `except` clause.
        if let Err(error) = redis
            .set_ex(key.as_str(), CACHE_TTL_SECONDS, payload.as_str())
            .await
        {
            tracing::warn!(%error, key = %key, "[user_cache] redis write failed");
        }
    }
    Ok(Some(payload))
}

/// Serialize one user row exactly like Python
/// `json.dumps(model_to_dict(user))` with the default separators (`", "` and
/// `": "`) and `ensure_ascii=True` escaping; column order is the `User` table
/// order the source's cached reader writes.
fn python_model_json(row: &UserCacheRow) -> String {
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
    push(&mut out, "id", &row.id.to_string());
    push(&mut out, "user_name", &python_json_string(&row.user_name));
    push(
        &mut out,
        "password_hash",
        &python_json_string(&row.password_hash),
    );
    push(
        &mut out,
        "email",
        &match row.email.as_deref() {
            Some(email) => python_json_string(email),
            None => "null".to_owned(),
        },
    );
    push(
        &mut out,
        "git_info",
        &match row.git_info.as_ref() {
            Some(git_info) => python_json_value(&git_info.0),
            None => "null".to_owned(),
        },
    );
    push(
        &mut out,
        "is_active",
        if row.is_active != 0 { "true" } else { "false" },
    );
    push(&mut out, "role", &python_json_string(&row.role));
    push(
        &mut out,
        "auth_source",
        &python_json_string(&row.auth_source),
    );
    push(
        &mut out,
        "preferences",
        &match row.preferences.as_deref() {
            Some(preferences) => python_json_string(preferences),
            None => "null".to_owned(),
        },
    );
    push(&mut out, "created_at", &python_timestamp(row.created_at));
    push(&mut out, "updated_at", &python_timestamp(row.updated_at));
    out.push('}');
    out
}

/// Render one column timestamp like Python's `datetime.isoformat()`, which
/// omits the fractional part when the microsecond field is zero.
fn python_timestamp(value: chrono::NaiveDateTime) -> String {
    let micros = value.nanosecond() / 1_000;
    if micros == 0 {
        format!("\"{}\"", value.format("%Y-%m-%dT%H:%M:%S"))
    } else {
        format!("\"{}.{:06}\"", value.format("%Y-%m-%dT%H:%M:%S"), micros)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A synthetic row covering every column kind the cache document renders:
    /// a numeric id, strings (one non-ASCII), a nullable column, a JSON
    /// column, a boolean, and two timestamps.
    fn row() -> UserCacheRow {
        UserCacheRow {
            id: 4_242,
            user_name: "sample_user".to_owned(),
            password_hash: "stored-hash".to_owned(),
            email: Some("sample.user@example.com".to_owned()),
            git_info: Some(brz_mysql::Json(Value::Array(Vec::new()))),
            is_active: 1,
            role: "user".to_owned(),
            auth_source: "oidc".to_owned(),
            preferences: Some(
                r#"{"company_profile": {"name": "张三", "employee_id": "10001"}}"#.to_owned(),
            ),
            created_at: chrono::NaiveDate::from_ymd_opt(2026, 8, 13)
                .unwrap()
                .and_hms_opt(17, 0, 1)
                .unwrap(),
            updated_at: chrono::NaiveDate::from_ymd_opt(2026, 8, 17)
                .unwrap()
                .and_hms_opt(16, 58, 52)
                .unwrap(),
        }
    }

    #[test]
    fn cache_key_matches_the_source_extension() {
        // `CachedUserReader._key_data` with `CACHE_VERSION = "v2"`.
        assert_eq!(data_key(4_242), "user:v2:data:4242");
    }

    /// `json.dumps(model_to_dict(user))`: Python's `", "` and `": "`
    /// separators, the full column set in table order, the JSON column
    /// rendered as native JSON, `ensure_ascii=True` escaping, and ISO
    /// timestamps.
    #[test]
    fn model_json_renders_the_python_document_shape() {
        let rendered = python_model_json(&row());
        assert!(rendered.starts_with("{\"id\": 4242, \"user_name\": \"sample_user\", "));
        assert!(rendered.contains("\"email\": \"sample.user@example.com\", \"git_info\": []"));
        assert!(
            rendered.contains("\"is_active\": true, \"role\": \"user\", \"auth_source\": \"oidc\"")
        );
        // The stored `preferences` document keeps its own JSON text, with the
        // non-ASCII name escaped by `ensure_ascii=True`.
        assert!(rendered.contains("\\\"name\\\": \\\"\\u5f20\\u4e09\\\""));
        assert!(rendered.ends_with(
            "\"created_at\": \"2026-08-13T17:00:01\", \"updated_at\": \"2026-08-17T16:58:52\"}"
        ));
    }

    #[test]
    fn absent_email_serializes_as_null() {
        let mut row = row();
        row.email = None;
        assert!(python_model_json(&row).contains("\"email\": null"));
    }

    /// `users.git_info` and `users.preferences` are nullable columns: a
    /// stored NULL renders as JSON `null` (the recorded
    /// `user:v2:data:5647` write-back carries `"git_info": null`), and the
    /// row must still decode — a required `Json`/`String` projection fails
    /// the whole read instead.
    #[test]
    fn absent_json_columns_serialize_as_null() {
        let mut row = row();
        row.git_info = None;
        row.preferences = None;
        let rendered = python_model_json(&row);
        assert!(
            rendered.contains("\"git_info\": null, \"is_active\": true"),
            "{rendered}"
        );
        assert!(
            rendered.contains("\"preferences\": null, \"created_at\""),
            "{rendered}"
        );
    }

    #[test]
    fn timestamps_keep_microseconds_like_python_isoformat() {
        let mut row = row();
        row.created_at = chrono::NaiveDate::from_ymd_opt(2026, 8, 13)
            .unwrap()
            .and_hms_micro_opt(17, 0, 1, 250_000)
            .unwrap();
        assert!(python_model_json(&row).contains("\"created_at\": \"2026-08-13T17:00:01.250000\""));
    }
}
