// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Streaming-state repository mirroring the task-level streaming status reads
//! in `Wegent/backend/app/services/chat/storage/session.py`.
//!
//! `get_task_streaming_status` reads the orjson-encoded status object from
//! Redis key `chat:task_streaming:{task_id}`; on a hit with a parseable
//! `subtask_id` it also reads the accumulated content length from
//! `chat:streaming:{subtask_id}` (raw string content stored via APPEND).
//! Errors are logged and mapped to `None`, matching the source's broad
//! exception handling.
use anyhow::Result;

use brz_redis::{Redis, RedisKey2};

/// Streaming status fields written by `set_task_streaming_status`, after the
/// source's timestamp normalization.
#[derive(Debug, Clone, serde::Deserialize)]
pub(crate) struct TaskStreamingStatus {
    #[serde(default)]
    pub subtask_id: Option<SubtaskId>,
    #[serde(default, rename = "last_activity_at")]
    pub last_activity_at: Option<String>,
}

/// `subtask_id` as stored by the source: either a JSON number or its string
/// form (`int(raw_subtask_id)` in the source coerces both).
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(untagged)]
pub(crate) enum SubtaskId {
    Number(i64),
    Text(String),
}

impl SubtaskId {
    /// Mirror of the source's `int(raw) if raw is not None else None`
    /// coercion: numbers pass through, strings are trimmed then parsed,
    /// other shapes have no integer value.
    fn as_i64(&self) -> Option<i64> {
        match self {
            Self::Number(value) => Some(*value),
            Self::Text(text) => text.trim().parse::<i64>().ok(),
        }
    }
}

/// Normalized active-stream checkpoint used by the runtime-check response.
#[derive(Debug, Clone)]
pub(crate) struct ActiveStream {
    pub subtask_id: i64,
    pub cursor: usize,
    pub last_activity_at: Option<String>,
}

/// Render a normalized UTC ISO-8601 timestamp exactly like pydantic's
/// datetime JSON serialization: the stored value comes from
/// `_normalize_streaming_timestamp`, whose `astimezone(utc).isoformat()`
/// output only ever carries `+00:00` (pydantic renders that as `Z`) with
/// either zero or exactly six microsecond digits.
pub(crate) fn format_pydantic_utc_timestamp(value: &str) -> String {
    if let Some(stem) = value.strip_suffix("+00:00") {
        format!("{stem}Z")
    } else {
        value.to_string()
    }
}

/// Mirror of `session_manager.get_task_streaming_status` plus the
/// `get_streaming_content` cursor read performed by the endpoint. Redis
/// failures degrade to `None`, exactly like the source's `except Exception`.
pub(crate) async fn get_active_stream<R>(redis: &R, task_id: i64) -> Result<Option<ActiveStream>>
where
    R: Redis,
{
    let status_key = RedisKey2("chat:task_streaming:", task_id);
    let payload: Option<Vec<u8>> = match redis.get(status_key).await {
        Ok(payload) => payload,
        Err(error) => {
            tracing::error!(%error, task_id, "error getting task streaming status");
            return Ok(None);
        }
    };
    let Some(payload) = payload else {
        return Ok(None);
    };
    let status: TaskStreamingStatus = match serde_json::from_slice(&payload) {
        Ok(status) => status,
        Err(error) => {
            tracing::error!(%error, task_id, "task streaming status payload is not JSON");
            return Ok(None);
        }
    };
    // `int(raw_subtask_id)` in the source; non-numeric values skip the
    // active stream entirely.
    let Some(subtask_id) = status.subtask_id.as_ref().and_then(SubtaskId::as_i64) else {
        return Ok(None);
    };
    let content_key = RedisKey2("chat:streaming:", subtask_id);
    let content: Option<Vec<u8>> = match redis.get(content_key).await {
        Ok(content) => content,
        Err(error) => {
            tracing::error!(%error, subtask_id, "error getting streaming content");
            return Ok(None);
        }
    };
    // `len(cached_content or "")` in the source: the payload is decoded to a
    // str first, so Python counts Unicode characters, not bytes. Mirror that
    // by counting chars of the UTF-8-decoded content.
    let cursor = content
        .as_deref()
        .map(String::from_utf8_lossy)
        .map(|content| content.chars().count())
        .unwrap_or(0);
    Ok(Some(ActiveStream {
        subtask_id,
        cursor,
        // The endpoint feeds the stored string through
        // `datetime.fromisoformat` into pydantic, which re-serializes a UTC
        // offset as `Z`; the recorded expected body shows that rendering.
        last_activity_at: status
            .last_activity_at
            .as_deref()
            .map(format_pydantic_utc_timestamp),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subtask_id_coerces_numbers_and_numeric_strings() {
        assert_eq!(SubtaskId::Number(42).as_i64(), Some(42));
        assert_eq!(SubtaskId::Text("42".to_string()).as_i64(), Some(42));
        assert_eq!(SubtaskId::Text(" 42 ".to_string()).as_i64(), Some(42));
        // Non-numeric strings and floats have no integer value.
        assert_eq!(SubtaskId::Text("abc".to_string()).as_i64(), None);
    }

    #[test]
    fn subtask_id_untagged_decode_matches_stored_shapes() {
        let status: TaskStreamingStatus = serde_json::from_str(r#"{"subtask_id": 42}"#).unwrap();
        assert!(matches!(status.subtask_id, Some(SubtaskId::Number(42))));
        let status: TaskStreamingStatus = serde_json::from_str(r#"{"subtask_id": "42"}"#).unwrap();
        assert!(matches!(status.subtask_id, Some(SubtaskId::Text(_))));
        // Missing and null both decode to None.
        let status: TaskStreamingStatus = serde_json::from_str(r#"{}"#).unwrap();
        assert!(status.subtask_id.is_none());
        let status: TaskStreamingStatus = serde_json::from_str(r#"{"subtask_id": null}"#).unwrap();
        assert!(status.subtask_id.is_none());
    }

    #[test]
    fn cursor_counts_unicode_characters_like_python_len() {
        // The failing case's recorded streaming content is 4096 UTF-8 bytes of
        // CJK-heavy text that decodes to 2512 characters. Python's
        // `len(cached_content)` counts decoded characters; the target mirrors
        // that with `chars().count()` after decoding. A byte cut can split a
        // multi-byte character only when the source itself stored invalid
        // UTF-8 (it never does: it APPENDs str values), so a valid payload
        // decodes exactly. 792 CJK characters (3 bytes each) plus 1720 ASCII
        // characters reproduce the recorded byte/character split exactly.
        let cjk = "示例中文内容，用于测试。";
        let mut cjk_count = 792;
        let mut decoded = String::new();
        while cjk_count >= cjk.chars().count() {
            decoded.push_str(cjk);
            cjk_count -= cjk.chars().count();
        }
        for character in cjk.chars().take(cjk_count) {
            decoded.push(character);
        }
        decoded.push_str(&"x".repeat(1720));
        assert_eq!(decoded.len(), 4096);
        assert_eq!(decoded.chars().count(), 2512);
    }

    #[test]
    fn last_activity_at_renders_utc_offset_as_z_like_pydantic() {
        // The stored status from the failing case:
        // `_normalize_streaming_timestamp` returns `astimezone(utc).isoformat()`.
        assert_eq!(
            format_pydantic_utc_timestamp("2026-09-07T06:18:13.884704+00:00"),
            "2026-09-07T06:18:13.884704Z"
        );
        // Second-precision values keep the same shape.
        assert_eq!(
            format_pydantic_utc_timestamp("2026-09-07T06:18:13+00:00"),
            "2026-09-07T06:18:13Z"
        );
        // Values that are not `+00:00`-suffixed are passed through unchanged
        // (legacy or unexpected payloads; the source's fromisoformat would
        // still round-trip them, but such values were never observed stored).
        assert_eq!(
            format_pydantic_utc_timestamp("2026-09-07T06:18:13.884704"),
            "2026-09-07T06:18:13.884704"
        );
    }
}
