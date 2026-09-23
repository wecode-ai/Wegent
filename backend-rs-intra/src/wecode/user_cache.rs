// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `userReader` for the internal deployment (`SERVICE_EXTENSION=wecode.cache`,
//! `backend/wecode/cache/users.py:CachedUserReader`).
//!
//! `get_by_id` reads the `user:v2:data:{user_id}` JSON document first and
//! falls back to the public SQL reader, writing the row back with `SETEX`
//! (300s TTL, `json.dumps(model_to_dict(user))` — one key per mapped `users`
//! column, in table order). `get_by_name`
//! resolves the `user:v2:idx:name:{user_name}` index first (`__NULL__` is
//! the cached negative that skips MySQL) and then the data key; the MySQL
//! fallback writes the data key and the index, including the negative index
//! when the row is absent. Cache failures are logged and treated as misses
//! exactly like the source's `except` clauses; a `None` Redis client mirrors
//! the source extension's `wrap()` returning `None` (`get_redis_client()`
//! failed), which leaves the public SQL reader installed.
use async_trait::async_trait;
use brz_redis::Redis;
use std::sync::Arc;
use wegent_backend_rs::json_compat::{python_json_string, python_json_value};
use wegent_backend_rs::user_reader::{PublicUserReader, UserByIdReader, UserRecord};

/// Cache TTL from the cached reader (`wecode/cache/base.py: CACHE_TTL = 300`).
const CACHE_TTL_SECONDS: u64 = 300;

/// Null marker from the cached reader (`wecode/cache/base.py: NULL_MARKER`).
const NULL_MARKER: &str = "__NULL__";

/// `user:v2:data:{user_id}` (`CachedUserReader._key_data`).
fn data_key(user_id: i64) -> String {
    format!("user:v2:data:{user_id}")
}

/// `user:v2:idx:name:{user_name}` (`CachedUserReader._key_idx_name`).
fn idx_key(user_name: &str) -> String {
    format!("user:v2:idx:name:{user_name}")
}

/// One `user:v2:data:{user_id}` document (`json.dumps(model_to_dict(user))`):
/// the `users` table columns in table order, which `dict_to_model` maps back
/// onto the user record.
#[derive(serde::Deserialize)]
struct CachedUserDocument {
    id: i64,
    user_name: String,
    password_hash: String,
    email: Option<String>,
    git_info: serde_json::Value,
    is_active: bool,
    role: String,
    auth_source: String,
    preferences: String,
    created_at: chrono::NaiveDateTime,
    updated_at: chrono::NaiveDateTime,
}

impl From<CachedUserDocument> for UserRecord {
    fn from(document: CachedUserDocument) -> Self {
        Self {
            id: document.id,
            user_name: document.user_name,
            password_hash: document.password_hash,
            email: document.email,
            git_info: document.git_info,
            is_active: document.is_active,
            role: document.role,
            auth_source: document.auth_source,
            preferences: document.preferences,
            created_at: document.created_at,
            updated_at: document.updated_at,
        }
    }
}

/// The cached reader: `user:v2:data` / `user:v2:idx:name` read-through with
/// the public SQL fallback and `SETEX` write-backs.
pub struct CachedUserReader {
    redis: Option<brz_redis::RedisService>,
    fallback: PublicUserReader,
}

impl CachedUserReader {
    /// Build the reader. A `None` Redis client mirrors the source extension's
    /// `get_redis_client()` returning `None` (Redis unavailable): every read
    /// falls back to the public SQL reader.
    pub fn new(redis: Option<brz_redis::RedisService>, mysql: brz_mysql::MysqlService) -> Self {
        Self {
            redis,
            fallback: PublicUserReader::new(mysql),
        }
    }
}

/// One Redis read; a missing client, absent key, or Redis error is a miss.
async fn cache_get(
    redis: Option<&brz_redis::RedisService>,
    key: &str,
) -> Option<brz_redis::RedisBytes> {
    let redis = redis?;
    match redis.get(key).await {
        Ok(value) => value,
        Err(error) => {
            tracing::warn!(%error, key, "[user_cache] redis read failed");
            None
        }
    }
}

/// One best-effort `SETEX key 300 value` write (`_set_data`/`_set_idx`):
/// failures are logged and ignored like the source's `except` clauses.
async fn cache_set(redis: Option<&brz_redis::RedisService>, key: &str, value: &str) {
    let Some(redis) = redis else { return };
    if let Err(error) = redis.set_ex(key, CACHE_TTL_SECONDS, value).await {
        tracing::warn!(%error, key, "[user_cache] redis write failed");
    }
}

/// Decode one `user:v2:data` document into the shared user record. The
/// source rebuilds the model through `dict_to_model`, which cannot fail on
/// a well-formed document, so an undecodable value is treated as a miss.
fn decode_cache_document(payload: &[u8]) -> Option<UserRecord> {
    let document: CachedUserDocument = serde_json::from_slice(payload).ok()?;
    Some(document.into())
}

#[async_trait]
impl UserByIdReader for CachedUserReader {
    /// `CachedUserReader.get_by_id`: data cache first, SQL fallback, then the
    /// `_set_data` write-through. A miss without a row is not cached (only
    /// `get_by_name` caches its negative index).
    async fn get_by_id(&self, user_id: i64) -> anyhow::Result<Option<UserRecord>> {
        let key = data_key(user_id);
        if let Some(record) = cache_get(self.redis.as_ref(), &key)
            .await
            .as_deref()
            .and_then(decode_cache_document)
        {
            return Ok(Some(record));
        }
        let record = self.fallback.get_by_id(user_id).await?;
        if let Some(record) = record.as_ref() {
            cache_set(self.redis.as_ref(), &key, &user_cache_payload(record)).await;
        }
        Ok(record)
    }

    /// `CachedUserReader.get_by_name`: name index, then data key, then the
    /// SQL fallback that writes both the data key and the index (the
    /// negative index when the row is absent).
    async fn get_by_name(&self, user_name: &str) -> anyhow::Result<Option<UserRecord>> {
        let idx = idx_key(user_name);
        if let Some(cached_id) = cache_get(self.redis.as_ref(), &idx).await {
            let raw: &[u8] = cached_id.as_ref();
            // `_get_idx`: `__NULL__` is the cached negative result.
            if raw == NULL_MARKER.as_bytes() {
                return Ok(None);
            }
            if let Ok(cached_id) = std::str::from_utf8(raw)
                && let Ok(user_id) = cached_id.trim().parse::<i64>()
            {
                let key = data_key(user_id);
                if let Some(record) = cache_get(self.redis.as_ref(), &key)
                    .await
                    .as_deref()
                    .and_then(decode_cache_document)
                {
                    return Ok(Some(record));
                }
            }
        }
        let record = self.fallback.get_by_name(user_name).await?;
        match record.as_ref() {
            Some(record) => {
                let key = data_key(record.id);
                cache_set(self.redis.as_ref(), &key, &user_cache_payload(record)).await;
                cache_set(self.redis.as_ref(), &idx, &record.id.to_string()).await;
            }
            None => cache_set(self.redis.as_ref(), &idx, NULL_MARKER).await,
        }
        Ok(record)
    }
}

/// Serialize one user record exactly like Python
/// `json.dumps(model_to_dict(user))` with the default settings: the `users`
/// table columns in table order, separators `", "` / `": "`, JSON `null` for
/// an absent value, and `ensure_ascii=True` escaping (every non-ASCII code
/// point becomes `\uXXXX`) — serde_json emits raw UTF-8, so the escaping is
/// applied here. `model_to_dict` emits every column, so the cached document
/// keeps the complete key set; a partial document would not be the value the
/// source writes.
fn user_cache_payload(record: &UserRecord) -> String {
    let mut out = String::with_capacity(512);
    out.push('{');
    out.push_str("\"id\": ");
    out.push_str(&record.id.to_string());
    out.push_str(", \"user_name\": ");
    out.push_str(&python_json_string(&record.user_name));
    out.push_str(", \"password_hash\": ");
    out.push_str(&python_json_string(&record.password_hash));
    out.push_str(", \"email\": ");
    out.push_str(
        &record
            .email
            .as_deref()
            .map_or_else(|| "null".to_owned(), python_json_string),
    );
    out.push_str(", \"git_info\": ");
    out.push_str(&python_json_value(&record.git_info));
    out.push_str(", \"is_active\": ");
    out.push_str(if record.is_active { "true" } else { "false" });
    out.push_str(", \"role\": ");
    out.push_str(&python_json_string(&record.role));
    out.push_str(", \"auth_source\": ");
    out.push_str(&python_json_string(&record.auth_source));
    out.push_str(", \"preferences\": ");
    out.push_str(&python_json_string(&record.preferences));
    out.push_str(", \"created_at\": ");
    out.push_str(&python_json_string(&python_isoformat(record.created_at)));
    out.push_str(", \"updated_at\": ");
    out.push_str(&python_json_string(&python_isoformat(record.updated_at)));
    out.push('}');
    out
}

/// Render one `users.created_at`/`updated_at` value like Python
/// `datetime.isoformat()`: `YYYY-MM-DDTHH:MM:SS` with the microsecond part
/// appended only when it is non-zero.
fn python_isoformat(value: chrono::NaiveDateTime) -> String {
    if value.and_utc().timestamp_subsec_nanos() == 0 {
        value.format("%Y-%m-%dT%H:%M:%S").to_string()
    } else {
        value.format("%Y-%m-%dT%H:%M:%S%.6f").to_string()
    }
}
/// Install the cached reader on the public application state.
pub fn install(app: &mut wegent_backend_rs::AppState, redis: Option<brz_redis::RedisService>) {
    app.user_reader = Arc::new(CachedUserReader::new(redis, app.mysql.clone()));
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn naive_date_time(date: (i32, u32, u32), time: (u32, u32, u32)) -> chrono::NaiveDateTime {
        NaiveDate::from_ymd_opt(date.0, date.1, date.2)
            .unwrap()
            .and_hms_opt(time.0, time.1, time.2)
            .unwrap()
    }

    fn naive_date_time_with_micros(
        date: (i32, u32, u32),
        time: (u32, u32, u32),
        micros: u32,
    ) -> chrono::NaiveDateTime {
        NaiveDate::from_ymd_opt(date.0, date.1, date.2)
            .unwrap()
            .and_hms_micro_opt(time.0, time.1, time.2, micros)
            .unwrap()
    }

    fn user_record() -> UserRecord {
        UserRecord {
            id: 2001,
            user_name: "user1".to_owned(),
            password_hash: "test-hash".to_owned(),
            email: Some("user1@example.invalid".to_owned()),
            git_info: serde_json::Value::Null,
            is_active: true,
            role: "user".to_owned(),
            auth_source: "oidc".to_owned(),
            preferences: "{\"company_profile\": {\"name\": \"严笑\", \"employee_id\": \"232693\"}}"
                .to_owned(),
            created_at: naive_date_time((2026, 2, 12), (17, 28, 39)),
            updated_at: naive_date_time((2026, 6, 29), (14, 34, 59)),
        }
    }

    #[test]
    fn cache_keys_match_the_source_extension() {
        // `CachedUserReader._key_data` / `_key_idx_name` with
        // `CACHE_VERSION = "v2"`.
        assert_eq!(data_key(3058), "user:v2:data:3058");
        assert_eq!(idx_key("songnan5"), "user:v2:idx:name:songnan5");
    }

    #[test]
    fn cache_document_decodes_the_recorded_payload_shape() {
        // `json.dumps(model_to_dict(user))`: Python separators and native
        // JSON types for every mapped column.
        let payload = br#"{"id": 3058, "user_name": "songnan5", "password_hash": "h", "email": "e", "git_info": null, "is_active": true, "role": "user", "auth_source": "dingtalk", "preferences": "{}", "created_at": "2026-02-26T16:16:30", "updated_at": "2026-08-17T11:45:59"}"#;
        let record = decode_cache_document(payload.as_slice()).unwrap();
        assert_eq!(record.id, 3058);
        assert_eq!(record.user_name, "songnan5");
        assert_eq!(record.email.as_deref(), Some("e"));
        assert_eq!(record.git_info, serde_json::Value::Null);
        assert_eq!(record.role, "user");
        assert_eq!(record.auth_source, "dingtalk");
        assert_eq!(record.preferences, "{}");
        assert!(record.is_active);
        assert_eq!(
            record.created_at,
            naive_date_time((2026, 2, 26), (16, 16, 30))
        );
        assert_eq!(
            record.updated_at,
            naive_date_time((2026, 8, 17), (11, 45, 59))
        );
    }

    #[test]
    fn malformed_cache_document_reports_a_miss() {
        assert!(decode_cache_document(b"not json").is_none());
        assert!(decode_cache_document(b"{}").is_none());
    }

    #[test]
    fn user_cache_payload_writes_every_mapped_column() {
        // `json.dumps(model_to_dict(user))` emits the complete column set
        // with `ensure_ascii=True`, `isoformat()` datetimes, and JSON null
        // for an absent value.
        assert_eq!(
            user_cache_payload(&user_record()),
            "{\"id\": 2001, \"user_name\": \"user1\", \"password_hash\": \"test-hash\", \
             \"email\": \"user1@example.invalid\", \"git_info\": null, \"is_active\": true, \
             \"role\": \"user\", \"auth_source\": \"oidc\", \"preferences\": \
             \"{\\\"company_profile\\\": {\\\"name\\\": \\\"\\u4e25\\u7b11\\\", \\\"employee_id\\\": \
             \\\"232693\\\"}}\", \"created_at\": \"2026-02-12T17:28:39\", \"updated_at\": \
             \"2026-06-29T14:34:59\"}"
        );
    }

    #[test]
    fn user_cache_payload_renders_a_stored_git_account_in_stored_order() {
        let mut record = user_record();
        record.email = None;
        // `model_to_dict` reads the decoded JSON column, so the document
        // echoes the stored keys in stored order.
        record.git_info = serde_json::json!([{
            "id": "00000000-0000-0000-0000-000000000001",
            "type": "gitlab",
            "git_id": "1234",
            "auth_type": null,
            "git_email": "gituser1@example.invalid",
            "git_login": "gituser1",
            "git_token": "***",
            "user_name": null,
            "git_domain": "gitlab.example.invalid"
        }]);
        assert_eq!(
            user_cache_payload(&record),
            "{\"id\": 2001, \"user_name\": \"user1\", \"password_hash\": \"test-hash\", \
             \"email\": null, \"git_info\": [{\"id\": \
             \"00000000-0000-0000-0000-000000000001\", \"type\": \"gitlab\", \"git_id\": \
             \"1234\", \"auth_type\": null, \"git_email\": \"gituser1@example.invalid\", \
             \"git_login\": \"gituser1\", \"git_token\": \"***\", \"user_name\": null, \
             \"git_domain\": \"gitlab.example.invalid\"}], \"is_active\": true, \"role\": \
             \"user\", \"auth_source\": \"oidc\", \"preferences\": \
             \"{\\\"company_profile\\\": {\\\"name\\\": \\\"\\u4e25\\u7b11\\\", \\\"employee_id\\\": \
             \\\"232693\\\"}}\", \"created_at\": \"2026-02-12T17:28:39\", \"updated_at\": \
             \"2026-06-29T14:34:59\"}"
        );
    }

    #[test]
    fn cache_document_round_trips_through_the_payload() {
        // The reader writes the document and decodes it back on a hit.
        let record = user_record();
        let decoded = decode_cache_document(user_cache_payload(&record).as_bytes()).unwrap();
        assert_eq!(decoded.id, record.id);
        assert_eq!(decoded.user_name, record.user_name);
        assert_eq!(decoded.is_active, record.is_active);
        assert_eq!(decoded.created_at, record.created_at);
        assert_eq!(decoded.preferences, record.preferences);
    }

    #[test]
    fn python_isoformat_omits_zero_microseconds() {
        // `datetime.isoformat()` appends the microsecond part only when it
        // is non-zero.
        assert_eq!(
            python_isoformat(naive_date_time((2026, 2, 12), (17, 28, 39))),
            "2026-02-12T17:28:39"
        );
        assert_eq!(
            python_isoformat(naive_date_time_with_micros(
                (2026, 2, 12),
                (17, 28, 39),
                39000
            )),
            "2026-02-12T17:28:39.039000"
        );
    }

    #[test]
    fn python_json_value_renders_python_defaults() {
        assert_eq!(python_json_value(&serde_json::Value::Null), "null");
        assert_eq!(
            python_json_value(&serde_json::json!({"a": [1, true, "严"]})),
            "{\"a\": [1, true, \"\\u4e25\"]}"
        );
    }
}
