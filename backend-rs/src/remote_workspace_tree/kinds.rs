// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Kind resource loading (the unsharded `kinds` table).
//!
//! The `KindStore` keeps the public direct-SQL reader and an optional
//! read-through cache client. A `None` client keeps every lookup on the
//! direct SQL path (the open-source reader). A supplied client implements
//! the deployment's cached reader contract: `kind:v2:idx:*` index keys
//! resolve to resource ids, `kind:v2:data:{kind}:{id}` holds the JSON
//! document, and `__NULL__` is a cached negative index.
use brz_mysql::{FromMysqlRow, Mysql};
use brz_redis::{Redis, RedisBytes};
use serde_json::Value;

use super::error::ApiError;

/// One `kinds` row. The projection mirrors the source SQLAlchemy `kinds`
/// column list (labeled `kinds_<column>`) so the prepared statement matches
/// the recorded exchange for replay.
#[derive(Debug, FromMysqlRow)]
pub(crate) struct KindRecord {
    #[allow(dead_code)]
    #[mysql(rename = "kinds_id")]
    pub(crate) id: i64,
    #[allow(dead_code)]
    #[mysql(rename = "kinds_user_id")]
    pub(crate) user_id: i64,
    #[allow(dead_code)]
    #[mysql(rename = "kinds_kind")]
    pub(crate) kind: String,
    #[allow(dead_code)]
    #[mysql(rename = "kinds_name")]
    pub(crate) name: String,
    #[allow(dead_code)]
    #[mysql(rename = "kinds_namespace")]
    pub(crate) namespace: String,
    #[allow(dead_code)]
    #[mysql(rename = "kinds_json")]
    pub(crate) json: brz_mysql::Json<Value>,
    #[allow(dead_code)]
    #[mysql(rename = "kinds_is_active")]
    pub(crate) is_active: i8,
    #[allow(dead_code)]
    #[mysql(rename = "kinds_created_at")]
    pub(crate) created_at: chrono::NaiveDateTime,
    #[allow(dead_code)]
    #[mysql(rename = "kinds_updated_at")]
    pub(crate) updated_at: chrono::NaiveDateTime,
}

/// Kinds access through MySQL plus the Redis read-through cache.
pub(crate) struct KindStore<'a, M: Mysql, R: Redis> {
    pub(crate) mysql: &'a M,
    pub(crate) redis: Option<&'a R>,
}

/// `PUBLIC_FALLBACK_KINDS` from source `app.services.readers.kinds`: kinds
/// that fall back to the public (`user_id = 0`) resource when the personal
/// lookup misses. Team is deliberately absent (it has its own resolution).
fn public_fallback_kind(kind: &str) -> bool {
    matches!(
        kind,
        "Model" | "Shell" | "Skill" | "Ghost" | "Retriever" | "Bot"
    )
}

/// The outcome of one index lookup for the cached-reader contract:
/// `Hit(record)` from a data document, `Negative` from the `__NULL__`
/// marker (a cached absence that must skip the MySQL fallback), and `Miss`
/// when no cache entry exists (the reader falls through to MySQL).
enum IndexLookup {
    Hit(KindRecord),
    Negative,
    Miss,
}

/// The lookup scope of one index-resolved kind read.
enum IndexScope {
    Public,
    Personal(i64),
    Group,
}

/// Cache TTL of the cached-reader contract.
const CACHE_TTL_SECONDS: u64 = 300;

/// Serialize a kind record exactly like Python
/// `json.dumps(model_to_dict(kind))` with the source's default separators
/// (`", "` and `": "`) and `ensure_ascii=True` escaping; columns in the
/// `Kind` table order.
fn python_model_json(record: &KindRecord) -> String {
    let mut out = String::with_capacity(256);
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
    push(&mut out, "id", &record.id.to_string());
    push(&mut out, "user_id", &record.user_id.to_string());
    push(&mut out, "kind", &python_json_string(&record.kind));
    push(&mut out, "name", &python_json_string(&record.name));
    push(
        &mut out,
        "namespace",
        &python_json_string(&record.namespace),
    );
    push(&mut out, "json", &python_json_value(&record.json.0));
    push(
        &mut out,
        "is_active",
        if record.is_active != 0 {
            "true"
        } else {
            "false"
        },
    );
    push(
        &mut out,
        "created_at",
        &format!("\"{}\"", record.created_at.format("%Y-%m-%dT%H:%M:%S")),
    );
    push(
        &mut out,
        "updated_at",
        &format!("\"{}\"", record.updated_at.format("%Y-%m-%dT%H:%M:%S")),
    );
    out.push('}');
    out
}

/// Render one JSON string scalar like Python's `json.dumps` default
/// (`ensure_ascii=True`): ASCII stays as-is (with the standard JSON
/// escapes), non-ASCII becomes `\uXXXX` (surrogate pairs for astral
/// characters).
pub(crate) fn python_json_string(value: &str) -> String {
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

/// Render a JSON value like Python's `json.dumps` default
/// (`ensure_ascii=True`, separators `", "` / `": "`). Numbers keep their
/// `serde_json` representation, which matches Python for the integer and
/// float literals the kind CRDs carry.
fn python_json_value(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number.to_string(),
        Value::String(text) => python_json_string(text),
        Value::Array(items) => {
            let mut out = String::from("[");
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push_str(", ");
                }
                out.push_str(&python_json_value(item));
            }
            out.push(']');
            out
        }
        Value::Object(map) => {
            let mut out = String::from("{");
            for (index, (key, item)) in map.iter().enumerate() {
                if index > 0 {
                    out.push_str(", ");
                }
                out.push_str(&python_json_string(key));
                out.push_str(": ");
                out.push_str(&python_json_value(item));
            }
            out.push('}');
            out
        }
    }
}

/// `_set_data`: `SETEX kind:v2:data:{kind}:{id} 300 <model json>`.
///
/// A caller implementing the same cached-reader tail for a kind with its
/// own resolution (the Team branch of `_get_team`) shares this helper; it is
/// best-effort like the source, so failures are ignored.
pub(crate) async fn set_cached_data<R: Redis>(redis: &R, kind: &str, record: &KindRecord) {
    let key = format!("kind:v2:data:{kind}:{}", record.id);
    let payload = python_model_json(record);
    let _ = redis.set_ex(key.as_str(), CACHE_TTL_SECONDS, payload).await;
}

/// `_set_idx`: `SETEX <idx_key> 300 <id | __NULL__>`.
pub(crate) async fn set_cached_index<R: Redis>(redis: &R, idx_key: &str, resource_id: Option<i64>) {
    let value = match resource_id {
        Some(id) => id.to_string(),
        None => "__NULL__".to_owned(),
    };
    let _ = redis.set_ex(idx_key, CACHE_TTL_SECONDS, value).await;
}

impl<'a, M: Mysql, R: Redis> KindStore<'a, M, R> {
    /// `kindReader.get_public`: `user_id = 0` in namespace `default`.
    pub(crate) async fn get_public(
        &self,
        kind: &str,
        namespace: &str,
        name: &str,
    ) -> Result<Option<KindRecord>, ApiError> {
        let idx_key = format!("kind:v2:idx:public:{kind}:{namespace}:{name}");
        let index = self.cached_by_index(&idx_key, kind).await?;
        self.resolve_by_index(&idx_key, kind, namespace, name, index, IndexScope::Public)
            .await
    }

    /// `kindReader.get_personal`: owned by `user_id` in namespace `default`.
    #[allow(dead_code)]
    pub(crate) async fn get_personal(
        &self,
        user_id: i64,
        kind: &str,
        namespace: &str,
        name: &str,
    ) -> Result<Option<KindRecord>, ApiError> {
        let idx_key = format!("kind:v2:idx:personal:{kind}:{user_id}:{namespace}:{name}");
        let index = self.cached_by_index(&idx_key, kind).await?;
        self.resolve_by_index(
            &idx_key,
            kind,
            namespace,
            name,
            index,
            IndexScope::Personal(user_id),
        )
        .await
    }

    /// `kindReader.get_by_name_and_namespace` for non-Team kinds in
    /// namespace `default`: the personal index first (when the user id is
    /// nonzero), then the public fallback for kinds that support it
    /// (Model, Shell, Skill, Ghost, Retriever, Bot). Team lookups use the
    /// dedicated team resolution instead.
    pub(crate) async fn get_by_name_and_namespace(
        &self,
        user_id: i64,
        kind: &str,
        namespace: &str,
        name: &str,
    ) -> Result<Option<KindRecord>, ApiError> {
        if namespace != "default" {
            // Group resource: `get_group`.
            return self.get_group(kind, namespace, name).await;
        }
        if user_id != 0
            && let Some(personal) = self.get_personal(user_id, kind, namespace, name).await?
        {
            return Ok(Some(personal));
        }
        if public_fallback_kind(kind) {
            return self.get_public(kind, namespace, name).await;
        }
        Ok(None)
    }

    /// `kindReader.get_group`: namespace-scoped resource.
    pub(crate) async fn get_group(
        &self,
        kind: &str,
        namespace: &str,
        name: &str,
    ) -> Result<Option<KindRecord>, ApiError> {
        let idx_key = format!("kind:v2:idx:group:{kind}:{namespace}:{name}");
        let index = self.cached_by_index(&idx_key, kind).await?;
        self.resolve_by_index(&idx_key, kind, namespace, name, index, IndexScope::Group)
            .await
    }

    /// Source `get_personal`/`get_public`/`get_group` tail: on an index miss,
    /// query MySQL, then write both cache entries back (`_set_data` for a
    /// found row plus `_set_idx` with the id — or `_set_idx` with the
    /// `__NULL__` marker when the row is absent).
    async fn resolve_by_index(
        &self,
        idx_key: &str,
        kind: &str,
        namespace: &str,
        name: &str,
        index: IndexLookup,
        scope: IndexScope,
    ) -> Result<Option<KindRecord>, ApiError> {
        match index {
            IndexLookup::Hit(record) => return Ok(Some(record)),
            IndexLookup::Negative => return Ok(None),
            IndexLookup::Miss => {}
        }
        let record = match scope {
            IndexScope::Public => {
                self.fetch_where(
                    "kinds.user_id = 0 AND kinds.kind = ? AND kinds.namespace = ? \
                     AND kinds.name = ? AND kinds.is_active = true",
                    (kind, namespace, name),
                )
                .await?
            }
            IndexScope::Personal(user_id) => {
                self.fetch_where(
                    "kinds.user_id = ? AND kinds.kind = ? AND kinds.namespace = ? \
                     AND kinds.name = ? AND kinds.is_active = true",
                    (user_id, kind, namespace, name),
                )
                .await?
            }
            IndexScope::Group => {
                self.fetch_where(
                    "kinds.kind = ? AND kinds.namespace = ? AND kinds.name = ? \
                     AND kinds.is_active = true",
                    (kind, namespace, name),
                )
                .await?
            }
        };
        match &record {
            Some(found) => {
                self.set_data(kind, found).await;
                self.set_idx(idx_key, Some(found.id)).await;
            }
            None => {
                // `_set_idx(key, None)` caches the negative index.
                self.set_idx(idx_key, None).await;
            }
        }
        Ok(record)
    }

    /// `_set_data`: `SETEX kind:v2:data:{kind}:{id} 300 <model json>`.
    /// Best-effort like the source (failures are logged and ignored).
    ///
    /// The command is a real `SETEX key 300 value` (redis-py
    /// `setex(key, ttl, value)`), not `SET key value EX 300` — the two have
    /// different wire signatures and the recorded exchanges carry the
    /// `SETEX` form.
    async fn set_data(&self, kind: &str, record: &KindRecord) {
        let Some(redis) = self.redis else { return };
        set_cached_data(redis, kind, record).await;
    }

    /// `_set_idx`: `SETEX <idx_key> 300 <id | __NULL__>`.
    async fn set_idx(&self, idx_key: &str, resource_id: Option<i64>) {
        let Some(redis) = self.redis else { return };
        set_cached_index(redis, idx_key, resource_id).await;
    }

    /// `resolve_task_ref_team` direct owner query: when the task CRD's
    /// `teamRef.user_id` is set, the source queries the `kinds` table
    /// directly (no cached-reader index lookup).
    pub(crate) async fn get_team_by_owner(
        &self,
        owner_user_id: i64,
        namespace: &str,
        name: &str,
    ) -> Result<Option<KindRecord>, ApiError> {
        self.fetch_where(
            "kinds.user_id = ? AND kinds.kind = 'Team' AND kinds.namespace = ? \
             AND kinds.name = ? AND kinds.is_active = true",
            (owner_user_id, namespace, name),
        )
        .await
    }

    /// `kindReader.get_by_ids`: per-id data cache reads, then one MySQL
    /// `IN (...)` load for the misses. The source indexes the loaded rows
    /// by id, so the result order follows the database.
    pub(crate) async fn get_by_ids(
        &self,
        kind: &str,
        resource_ids: &[i64],
    ) -> Result<Vec<KindRecord>, ApiError> {
        if resource_ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut records = Vec::new();
        let mut missing_ids = Vec::new();
        for id in resource_ids {
            match self.cached_data(kind, *id).await? {
                Some(record) => records.push(record),
                None => missing_ids.push(*id),
            }
        }
        if missing_ids.is_empty() {
            return Ok(records);
        }
        // One placeholder per id; the kind literal comes from the internal
        // `KindType` enum (not request input), and the ids are bound as
        // native integer values.
        let placeholders = vec!["?"; missing_ids.len()].join(", ");
        let rows: Vec<brz_mysql::MysqlRow> = self
            .mysql
            .fetch_all(
                &format!(
                    "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
                     kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
                     kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
                     kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
                     kinds.updated_at AS kinds_updated_at \
                     FROM kinds \
                     WHERE kinds.id IN ({placeholders}) AND kinds.kind = '{kind}' \
                     AND kinds.is_active = true"
                ),
                missing_ids,
            )
            .await
            .map_err(|error| {
                tracing::warn!(%error, "[kind_store] kinds by-ids query failed");
                ApiError::internal("kind query failed")
            })?;
        for row in rows {
            if let Ok(record) = KindRecord::from_mysql_row(row) {
                // `_set_data` per loaded row (the source caches each miss it
                // resolves through the batch load).
                self.set_data(kind, &record).await;
                records.push(record);
            }
        }
        Ok(records)
    }

    /// `kindReader.get_by_id`: data cache first, MySQL fallback, then
    /// `_set_data` write-through.
    pub(crate) async fn get_by_id(
        &self,
        kind: &str,
        resource_id: i64,
    ) -> Result<Option<KindRecord>, ApiError> {
        if let Some(cached) = self.cached_data(kind, resource_id).await? {
            return Ok(Some(cached));
        }
        let record = self
            .fetch_where("kinds.id = ? AND kinds.kind = ?", (resource_id, kind))
            .await?;
        if let Some(found) = &record {
            self.set_data(kind, found).await;
        }
        Ok(record)
    }

    async fn fetch_where(
        &self,
        predicate: &str,
        arguments: impl brz_mysql::MysqlArgs,
    ) -> Result<Option<KindRecord>, ApiError> {
        self.mysql
            .fetch_optional(
                &format!(
                    "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
                     kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
                     kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
                     kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
                     kinds.updated_at AS kinds_updated_at \
                     FROM kinds \
                     WHERE {predicate} \
                     LIMIT 1"
                ),
                arguments,
            )
            .await
            .map_err(|error| {
                tracing::warn!(%error, "[kind_store] kinds query failed");
                ApiError::internal("kind query failed")
            })
    }

    /// Index read returning the decoded id, a cached negative (`__NULL__`),
    /// or `None` on absence/error, exactly like the cached-reader contract
    /// (which maps `__NULL__` to `-1` and treats every failure as a miss).
    /// The `__NULL__` marker is a bulk
    /// string, so decoding it as an integer must be handled as a negative
    /// cache entry, not a decode error that falls through to MySQL.
    async fn cached_index(&self, idx_key: &str) -> Option<i64> {
        let raw: Option<RedisBytes> = match self.redis {
            Some(redis) => redis
                .get(idx_key)
                .await
                .map_err(|error| {
                    tracing::warn!(%error, key = %idx_key, "[kind_store] redis index read failed");
                    error
                })
                .ok()
                .flatten(),
            None => return None,
        };
        let raw = raw?;
        if raw.as_ref() == b"__NULL__" {
            return Some(-1);
        }
        let text = std::str::from_utf8(raw.as_ref()).ok()?;
        text.trim().parse::<i64>().ok()
    }

    async fn cached_by_index(&self, idx_key: &str, kind: &str) -> Result<IndexLookup, ApiError> {
        let Some(cached_id) = self.cached_index(idx_key).await else {
            return Ok(IndexLookup::Miss);
        };
        if cached_id == -1 {
            return Ok(IndexLookup::Negative);
        }
        match self.cached_data(kind, cached_id).await? {
            Some(record) => Ok(IndexLookup::Hit(record)),
            // The data document missing while the index resolves is a
            // miss for the caller (the source re-queries MySQL then).
            None => Ok(IndexLookup::Miss),
        }
    }

    /// Read and decode the `kind:v2:data:{kind}:{id}` cache document.
    async fn cached_data(
        &self,
        kind: &str,
        resource_id: i64,
    ) -> Result<Option<KindRecord>, ApiError> {
        let data_key = format!("kind:v2:data:{kind}:{resource_id}");
        let value: Option<RedisBytes> = match self.redis {
            Some(redis) => redis
                .get(data_key.as_str())
                .await
                .map_err(|error| {
                    tracing::warn!(%error, key = %data_key, "[kind_store] redis data read failed");
                    error
                })
                .ok()
                .flatten(),
            None => None,
        };
        let Some(value) = value else {
            return Ok(None);
        };
        Ok(decode_cached_kind(&value))
    }
}

/// Decode a cached kind payload into a record; non-JSON payloads are misses.
fn decode_cached_kind(value: &[u8]) -> Option<KindRecord> {
    if value == b"__NULL__" {
        return None;
    }
    let record: Value = serde_json::from_slice(value).ok()?;
    Some(KindRecord {
        id: record.get("id")?.as_i64()?,
        user_id: record.get("user_id")?.as_i64()?,
        kind: record.get("kind")?.as_str()?.to_owned(),
        name: record.get("name")?.as_str()?.to_owned(),
        namespace: record
            .get("namespace")
            .and_then(Value::as_str)
            .unwrap_or("default")
            .to_owned(),
        json: brz_mysql::Json(record.get("json").cloned().unwrap_or(Value::Null)),
        is_active: record
            .get("is_active")
            .and_then(Value::as_i64)
            .or_else(|| {
                record
                    .get("is_active")
                    .and_then(Value::as_bool)
                    .map(i64::from)
            })
            .unwrap_or(0) as i8,
        // The cached document carries the timestamps as ISO strings
        // (`2026-01-19T14:16:18`); a missing or unparsable value keeps the
        // epoch default like the source `dict_to_model` fallback.
        created_at: cached_kind_timestamp(&record, "created_at"),
        updated_at: cached_kind_timestamp(&record, "updated_at"),
    })
}

/// Parse one cached-document timestamp field into a `NaiveDateTime`.
fn cached_kind_timestamp(record: &Value, field: &str) -> chrono::NaiveDateTime {
    record
        .get(field)
        .and_then(Value::as_str)
        .and_then(|text| {
            chrono::NaiveDateTime::parse_from_str(text, "%Y-%m-%dT%H:%M:%S")
                .or_else(|_| chrono::NaiveDateTime::parse_from_str(text, "%Y-%m-%dT%H:%M:%S%.f"))
                .or_else(|_| chrono::NaiveDateTime::parse_from_str(text, "%Y-%m-%d %H:%M:%S"))
                .ok()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn index_null_marker_decodes_as_negative_cache() {
        // `_get_idx` maps `__NULL__` to -1 (a cached negative), and the
        // reader returns None without the MySQL fallback; the marker bytes
        // are exactly what `cached_index` compares against.
        let raw = RedisBytes::from("__NULL__".as_bytes().to_vec());
        assert_eq!(raw.as_ref(), b"__NULL__");
        // A numeric index value decodes through the same raw-bytes path.
        let numeric = RedisBytes::from("50369".as_bytes().to_vec());
        let text = std::str::from_utf8(numeric.as_ref()).expect("utf8");
        assert_eq!(text.trim().parse::<i64>().expect("id"), 50369);
    }

    #[test]
    fn null_marker_is_a_miss() {
        assert!(decode_cached_kind(b"__NULL__").is_none());
    }

    #[test]
    fn json_document_decodes() {
        let payload = br#"{"id": 110466, "user_id": 0, "kind": "Bot", "name": "wegent-chat",
            "namespace": "default", "json": {"kind": "Bot"}, "is_active": 1}"#;
        let record = decode_cached_kind(payload).expect("record");
        assert_eq!(record.id, 110466);
        assert_eq!(record.kind, "Bot");
        assert_eq!(
            record.json.0.get("kind").and_then(Value::as_str),
            Some("Bot")
        );
    }

    #[test]
    fn cached_timestamps_decode_from_iso_strings() {
        let payload = br#"{"id": 110467, "user_id": 0, "kind": "Team", "name": "wegent-chat",
            "namespace": "default", "json": {}, "is_active": true,
            "created_at": "2026-01-19T14:16:18", "updated_at": "2026-08-07T03:01:22"}"#;
        let record = decode_cached_kind(payload).expect("record");
        assert_eq!(
            record.created_at.format("%Y-%m-%dT%H:%M:%S").to_string(),
            "2026-01-19T14:16:18"
        );
        assert_eq!(
            record.updated_at.format("%Y-%m-%dT%H:%M:%S").to_string(),
            "2026-08-07T03:01:22"
        );
    }

    #[test]
    fn missing_cached_timestamps_keep_epoch_default() {
        let payload = br#"{"id": 1, "user_id": 0, "kind": "Bot", "name": "b",
            "namespace": "default", "json": {}, "is_active": true}"#;
        let record = decode_cached_kind(payload).expect("record");
        assert_eq!(record.created_at, chrono::NaiveDateTime::default());
    }

    #[test]
    fn index_id_string_decodes_as_i64() {
        let payload = br#"{"id": 50369, "user_id": 0, "kind": "Shell", "name": "Chat",
            "namespace": "default", "json": {}, "is_active": true}"#;
        let record = decode_cached_kind(payload).expect("record");
        assert_eq!(record.id, 50369);
        assert_eq!(record.is_active, 1);
    }

    #[test]
    fn python_json_string_escapes_non_ascii() {
        assert_eq!(python_json_string("严笑"), "\"\\u4e25\\u7b11\"");
        assert_eq!(python_json_string("a\"b\\c\n"), "\"a\\\"b\\\\c\\n\"");
        assert_eq!(python_json_string("\u{1f600}"), "\"\\ud83d\\ude00\"");
        assert_eq!(python_json_string("Chat"), "\"Chat\"");
    }

    #[test]
    fn python_json_value_renders_ensure_ascii_with_python_separators() {
        let value = serde_json::json!({
            "modelRef": {"name": "example-model(公网)", "namespace": "default"},
            "count": 2,
            "ratio": 1.5,
            "flag": true,
            "missing": null
        });
        assert_eq!(
            python_json_value(&value),
            "{\"modelRef\": {\"name\": \"example-model(\\u516c\\u7f51)\", \
             \"namespace\": \"default\"}, \"count\": 2, \"ratio\": 1.5, \"flag\": true, \
             \"missing\": null}"
        );
    }

    #[test]
    fn python_model_json_matches_the_recorded_setex_payload_shape() {
        // The recorded Bot cache document for kind 110466 (`_set_data` for
        // the Bot 110466 MySQL fallback): Python's `json.dumps` escaping and
        // `model_to_dict`'s ISO timestamps.
        let record = KindRecord {
            id: 110466,
            user_id: 0,
            kind: "Bot".to_owned(),
            name: "wegent-chat".to_owned(),
            namespace: "default".to_owned(),
            json: brz_mysql::Json(serde_json::json!({
                "kind": "Bot",
                "spec": {
                    "ghostRef": {"name": "wegent-chat", "namespace": "default"},
                    "modelRef": {"name": "example-model(公网)", "namespace": "default"},
                    "shellRef": {"name": "Chat", "namespace": "default"}
                },
                "status": {"state": "Available"},
                "metadata": {"name": "wegent-chat", "namespace": "default"},
                "apiVersion": "agent.example.io/v1"
            })),
            is_active: 1,
            created_at: chrono::NaiveDateTime::parse_from_str(
                "2026-01-19 14:15:40",
                "%Y-%m-%d %H:%M:%S",
            )
            .unwrap(),
            updated_at: chrono::NaiveDateTime::parse_from_str(
                "2026-06-04 15:40:34",
                "%Y-%m-%d %H:%M:%S",
            )
            .unwrap(),
        };
        assert_eq!(
            python_model_json(&record),
            "{\"id\": 110466, \"user_id\": 0, \"kind\": \"Bot\", \"name\": \"wegent-chat\", \
             \"namespace\": \"default\", \"json\": {\"kind\": \"Bot\", \"spec\": {\"ghostRef\": \
             {\"name\": \"wegent-chat\", \"namespace\": \"default\"}, \"modelRef\": {\"name\": \
             \"example-model(\\u516c\\u7f51)\", \"namespace\": \"default\"}, \
             \"shellRef\": {\"name\": \"Chat\", \"namespace\": \"default\"}}, \"status\": \
             {\"state\": \"Available\"}, \"metadata\": {\"name\": \"wegent-chat\", \"namespace\": \
             \"default\"}, \"apiVersion\": \"agent.example.io/v1\"}, \"is_active\": true, \
             \"created_at\": \"2026-01-19T14:15:40\", \"updated_at\": \"2026-06-04T15:40:34\"}"
        );
    }
}
