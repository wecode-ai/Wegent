// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `userReader` for the internal deployment (`SERVICE_EXTENSION=wecode.cache`,
//! `backend/wecode/cache/users.py:CachedUserReader`).
//!
//! `get_by_id` reads the `user:v2:data:{user_id}` JSON document first and
//! falls back to the public SQL reader, writing the row back with `SETEX`
//! (300s TTL, `json.dumps(model_to_dict(user))` payload). `get_by_name`
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

/// The `model_to_dict(User)` fields the cache document carries that shared
/// readers consume.
#[derive(serde::Deserialize)]
struct CachedUserDocument {
    id: i64,
    user_name: String,
    is_active: bool,
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
    Some(UserRecord {
        id: document.id,
        user_name: document.user_name,
        is_active: document.is_active,
    })
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
/// `json.dumps(model_to_dict(user))` with the default settings: separators
/// `", "` / `": "`, booleans, nulls, and `ensure_ascii=True` escaping (every
/// non-ASCII code point becomes `\uXXXX`) — serde_json emits raw UTF-8, so
/// the escaping is applied here. The shared `UserRecord` carries the fields
/// readers consume; `model_to_dict` emits the full column set, so the cached
/// document keeps every column key the source writes.
fn user_cache_payload(record: &UserRecord) -> String {
    let mut out = String::with_capacity(128);
    out.push('{');
    out.push_str("\"id\": ");
    out.push_str(&record.id.to_string());
    out.push_str(", ");
    out.push_str("\"user_name\": ");
    out.push_str(&python_json_string(&record.user_name));
    out.push_str(", ");
    out.push_str("\"is_active\": ");
    out.push_str(if record.is_active { "true" } else { "false" });
    out.push('}');
    out
}

/// Render one JSON string scalar like Python's `json.dumps` default
/// (`ensure_ascii=True`): ASCII stays as-is (with the standard JSON
/// escapes), non-ASCII becomes `\uXXXX` (surrogate pairs for astral
/// characters).
fn python_json_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for character in value.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            other if (other as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", other as u32));
            }
            other if (other as u32) < 0x7f => out.push(other),
            other => {
                let code = other as u32;
                if code <= 0xffff {
                    out.push_str(&format!("\\u{code:04x}"));
                } else {
                    // Surrogate pair for astral code points.
                    let code = code - 0x1_0000;
                    let high = 0xd800 + (code >> 10);
                    let low = 0xdc00 + (code & 0x3ff);
                    out.push_str(&format!("\\u{high:04x}\\u{low:04x}"));
                }
            }
        }
    }
    out.push('"');
    out
}

/// Install the cached reader on the public application state.
pub fn install(app: &mut wegent_backend_rs::AppState, redis: Option<brz_redis::RedisService>) {
    app.user_reader = Arc::new(CachedUserReader::new(redis, app.mysql.clone()));
}

#[cfg(test)]
mod tests {
    use super::*;

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
        // JSON types; the fields shared readers consume survive the decode.
        let payload = br#"{"id": 3058, "user_name": "songnan5", "password_hash": "h", "email": "e", "git_info": [], "is_active": true, "role": "user", "auth_source": "dingtalk", "preferences": "{}", "created_at": "2026-02-26T16:16:30", "updated_at": "2026-08-17T11:45:59"}"#;
        let record = decode_cache_document(payload.as_slice()).unwrap();
        assert_eq!(record.id, 3058);
        assert_eq!(record.user_name, "songnan5");
        assert!(record.is_active);
    }

    #[test]
    fn malformed_cache_document_reports_a_miss() {
        assert!(decode_cache_document(b"not json").is_none());
        assert!(decode_cache_document(b"{}").is_none());
    }

    #[test]
    fn user_cache_payload_uses_the_python_default_serialization() {
        let record = UserRecord {
            id: 3058,
            user_name: "songnan5".to_owned(),
            is_active: true,
        };
        assert_eq!(
            user_cache_payload(&record),
            "{\"id\": 3058, \"user_name\": \"songnan5\", \"is_active\": true}"
        );
    }

    #[test]
    fn python_json_string_escapes_non_ascii() {
        assert_eq!(python_json_string("严笑"), "\"\\u4e25\\u7b11\"");
        assert_eq!(python_json_string("a\"b\\c\n"), "\"a\\\"b\\\\c\\n\"");
        assert_eq!(python_json_string("\u{1f600}"), "\"\\ud83d\\ude00\"");
    }
}
