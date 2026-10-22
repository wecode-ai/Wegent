// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `LoopItemResponse` body shared by the local and external loop-item reads.
//!
//! Mirrors `app.schemas.delivery.LoopItemResponse` (`model_config =
//! ConfigDict(from_attributes=True)`): every field is always emitted (FastAPI
//! has no `response_model_exclude_*`), so an unset `Option` serializes as
//! `null` rather than being skipped. Field declaration order matches the
//! source pydantic schema.

use chrono::{DateTime, NaiveDateTime};
use serde::Serialize;
use serde_json::{Map, Value};

/// The `LoopItemResponse` body (`app.schemas.delivery.LoopItemResponse`).
#[derive(Debug, Serialize)]
pub(crate) struct LoopItemResponse {
    pub id: String,
    pub cloud_project_id: String,
    pub sequence_number: i64,
    pub parent_id: Option<String>,
    pub title: String,
    pub description: String,
    pub status: String,
    pub assignee_user_id: Option<i32>,
    pub assignee_group_id: Option<String>,
    pub assignee_group_name: Option<String>,
    pub assignee_name: Option<String>,
    pub assignee_agent_id: Option<String>,
    pub assignee_agent_name: Option<String>,
    pub assignee_team_id: Option<i32>,
    pub assignee_team_name: Option<String>,
    pub ai_state: Option<Value>,
    pub execution_id: Option<i64>,
    pub execution_state: Option<String>,
    pub execution_control_state: Option<String>,
    pub execution_observed_state: Option<String>,
    pub execution_sync_state: Option<String>,
    pub execution_attempt_no: Option<i64>,
    pub execution_last_event_seq: Option<i64>,
    pub can_approve: bool,
    pub assignment_history: Vec<Value>,
    pub status_history: Vec<Value>,
    pub approval: Option<Value>,
    pub queued_at: Option<String>,
    pub execution_note: Option<String>,
    pub execution_error: Option<String>,
    pub automation: Option<Value>,
    pub workflow: Option<Value>,
    pub execution_config: Option<Value>,
    pub priority: String,
    pub due_at: Option<String>,
    pub sort_order: i64,
    pub tags: Vec<String>,
    pub created_by_user_id: i64,
    pub created_by_user_name: Option<String>,
    pub can_view_detail: bool,
    pub security_level: &'static str,
    pub can_edit: bool,
    pub permissions: LoopItemPermissions,
    pub detail_loaded: bool,
    pub content_revision: i64,
    pub activity_read_sequence: i64,
    pub is_unread: bool,
    pub current_delivery_id: Option<String>,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
}

/// `LoopItemPermissions` (`app.schemas.delivery`).
#[derive(Debug, Serialize)]
pub(crate) struct LoopItemPermissions {
    pub edit_content: bool,
    pub comment: bool,
    pub assign: bool,
    pub execute: bool,
}

/// The `LoopItemListResponse` body (`app.schemas.delivery.LoopItemListResponse`).
#[derive(Debug, Serialize)]
pub(crate) struct LoopItemListResponse {
    pub items: Vec<LoopItemResponse>,
}

/// pydantic naive-datetime serialization (`value.isoformat()`): `YYYY-MM-DDTHH:MM:SS`
/// plus fractional seconds when nonzero. Reuses the board-snapshot helper so
/// both reads render datetimes identically.
pub(crate) fn isoformat(value: Option<NaiveDateTime>) -> Option<String> {
    crate::board_snapshot::handler::datetime_string(value)
}

/// `str(value)` for a non-null datetime: same rendering as [`isoformat`].
pub(crate) fn isoformat_required(value: Option<NaiveDateTime>) -> String {
    isoformat(value).unwrap_or_default()
}

/// `_parse_ai_state_datetime`: parse an ISO timestamp, normalizing an aware
/// value to naive UTC.
pub(crate) fn parse_ai_state_datetime(value: &str) -> Option<NaiveDateTime> {
    if let Ok(parsed) = NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S%.f") {
        return Some(parsed);
    }
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|parsed| parsed.naive_utc())
}

/// `normalize_empty_id`: `""` becomes `None` (pydantic `normalize_empty_id`).
pub(crate) fn normalize_empty_id(value: Option<&str>) -> Option<String> {
    value.filter(|text| !text.is_empty()).map(str::to_string)
}

/// `normalize_empty_numeric_assignee_id`: `0` becomes `None`.
pub(crate) fn normalize_zero_id(value: Option<i32>) -> Option<i32> {
    value.filter(|id| *id != 0)
}

/// `normalize_unset_datetime`: the `1970-01-01 00:00:01` sentinel becomes
/// `None` (and NULL stays `None`).
pub(crate) fn normalize_unset_datetime(value: Option<NaiveDateTime>) -> Option<NaiveDateTime> {
    value.filter(|value| !crate::board_snapshot::repository::datetime_is_unset(Some(*value)))
}

/// `normalize_tags` (`app.schemas.tagging`): trim, dedupe, cap.
pub(crate) fn normalize_tags(value: Option<&Value>) -> Vec<String> {
    const MAX_TAGS_PER_ITEM: usize = 20;
    const MAX_TAG_LENGTH: usize = 32;
    let Some(Value::Array(entries)) = value else {
        return Vec::new();
    };
    let mut tags: Vec<String> = Vec::new();
    for raw in entries {
        let text = match raw {
            Value::String(text) => text.clone(),
            Value::Null => continue,
            other => other.to_string(),
        };
        let tag: String = text.trim().chars().take(MAX_TAG_LENGTH).collect();
        if !tag.is_empty() && !tags.contains(&tag) {
            tags.push(tag);
        }
    }
    tags.truncate(MAX_TAGS_PER_ITEM);
    tags
}

/// The `value` as a JSON object, else `None` (`isinstance(value, dict)`).
pub(crate) fn json_object(value: Option<&Value>) -> Option<Map<String, Value>> {
    match value {
        Some(Value::Object(map)) => Some(map.clone()),
        _ => None,
    }
}

/// The `value` as a JSON array of objects, else an empty list.
pub(crate) fn json_array(value: Option<&Value>) -> Vec<Value> {
    match value {
        Some(Value::Array(entries)) => entries
            .iter()
            .filter(|entry| entry.is_object())
            .cloned()
            .collect(),
        _ => Vec::new(),
    }
}

/// `metadata.get(key)` when it is a string.
pub(crate) fn metadata_string(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::to_string)
}

/// A JSON pointer value when it is a string (`json_string(value)`).
pub(crate) fn json_string(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::to_string)
}
