// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::HashSet,
    path::{Component, Path, PathBuf},
};

use serde_json::{Map, Value};

use super::{ForkTransferError, ForkTransferResult, InheritedSession, ARCHIVE_EXCLUDED_NAMES};

pub(super) fn normalize_inherited_session(value: &Value) -> Option<InheritedSession> {
    let object = value.as_object()?;
    let agent = string_member(object, "agent")?;
    let session_id =
        string_member(object, "sessionId").or_else(|| string_member(object, "session_id"));
    let thread_id =
        string_member(object, "threadId").or_else(|| string_member(object, "thread_id"));
    if session_id.is_none() && thread_id.is_none() {
        return None;
    }
    Some(InheritedSession {
        agent,
        source_task_id: i64_member(object, "sourceTaskId")
            .or_else(|| i64_member(object, "source_task_id")),
        bot_id: object
            .get("botId")
            .or_else(|| object.get("bot_id"))
            .cloned(),
        session_id,
        thread_id,
    })
}

pub(super) fn dedupe_sessions(sessions: Vec<InheritedSession>) -> Vec<InheritedSession> {
    let mut seen = HashSet::new();
    let mut deduped = Vec::new();
    for session in sessions {
        let identity = (
            session.agent.clone(),
            session.session_id.clone().unwrap_or_default(),
            session.thread_id.clone().unwrap_or_default(),
        );
        if seen.insert(identity) {
            deduped.push(session);
        }
    }
    deduped
}

pub(super) fn append_unique_inherited_session(
    execution_request: &mut Map<String, Value>,
    session: Value,
) {
    let sessions = execution_request
        .entry("inherited_sessions".to_owned())
        .or_insert_with(|| Value::Array(Vec::new()));
    if !sessions.is_array() {
        *sessions = Value::Array(Vec::new());
    }
    let sessions = sessions
        .as_array_mut()
        .expect("sessions value was normalized");
    if !sessions
        .iter()
        .any(|existing| sessions_equal(existing, &session))
    {
        sessions.push(session);
    }
}

fn sessions_equal(left: &Value, right: &Value) -> bool {
    let Some(left) = left.as_object() else {
        return false;
    };
    let Some(right) = right.as_object() else {
        return false;
    };
    let left_agent = string_member(left, "agent").unwrap_or_default();
    let right_agent = string_member(right, "agent").unwrap_or_default();
    let left_session =
        string_member(left, "sessionId").or_else(|| string_member(left, "session_id"));
    let right_session =
        string_member(right, "sessionId").or_else(|| string_member(right, "session_id"));
    let left_thread = string_member(left, "threadId").or_else(|| string_member(left, "thread_id"));
    let right_thread =
        string_member(right, "threadId").or_else(|| string_member(right, "thread_id"));
    left_agent == right_agent && left_session == right_session && left_thread == right_thread
}

pub(super) fn bot_matches(raw_bot_id: Option<&Value>, current_bot_id: Option<i64>) -> bool {
    match (raw_bot_id.and_then(value_to_i64), current_bot_id) {
        (Some(left), Some(right)) => left == right,
        (Some(_), None) | (None, _) => true,
    }
}

fn value_to_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|number| i64::try_from(number).ok()))
        .or_else(|| value.as_str()?.trim().parse::<i64>().ok())
}

pub(super) fn string_member(object: &Map<String, Value>, key: &str) -> Option<String> {
    object.get(key).and_then(value_to_string)
}

pub(super) fn optional_string_member(
    object: &Map<String, Value>,
    key: &str,
    field: &'static str,
) -> ForkTransferResult<Option<String>> {
    match object.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value_to_string(value)
            .map(Some)
            .ok_or(ForkTransferError::InvalidField {
                code: "invalid_string_field",
                field,
                expected: "a string",
            }),
    }
}

pub(super) fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .as_object()
        .and_then(|object| string_member(object, key))
}

fn value_to_string(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

pub(super) fn i64_member(object: &Map<String, Value>, key: &str) -> Option<i64> {
    object.get(key).and_then(value_to_i64)
}

pub(super) fn u64_member(object: &Map<String, Value>, key: &str) -> Option<u64> {
    object.get(key).and_then(|value| {
        value
            .as_u64()
            .or_else(|| value.as_i64().and_then(|number| u64::try_from(number).ok()))
            .or_else(|| value.as_str()?.trim().parse::<u64>().ok())
    })
}

pub(super) fn bool_member(object: &Map<String, Value>, key: &str) -> Option<bool> {
    object.get(key).and_then(|value| {
        value.as_bool().or_else(|| {
            let value = value.as_str()?.trim().to_ascii_lowercase();
            match value.as_str() {
                "true" | "1" | "yes" => Some(true),
                "false" | "0" | "no" => Some(false),
                _ => None,
            }
        })
    })
}

pub(super) fn string_list_member(value: Option<&Value>) -> ForkTransferResult<Vec<String>> {
    match value {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(value) => payload_string_list(value, "directUrls"),
    }
}

pub(super) fn payload_string_list(
    value: &Value,
    field: &'static str,
) -> ForkTransferResult<Vec<String>> {
    let Some(items) = value.as_array() else {
        return Err(ForkTransferError::InvalidField {
            code: "invalid_string_list",
            field,
            expected: "a list",
        });
    };
    Ok(dedupe_strings(
        items
            .iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty()),
    ))
}

pub(super) fn object_value(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(object) => object,
        _ => Map::new(),
    }
}

pub(super) fn dedupe_strings<'a>(values: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut deduped = Vec::new();
    for value in values {
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        if seen.insert(value.to_owned()) {
            deduped.push(value.to_owned());
        }
    }
    deduped
}

pub(super) fn format_url_host(host: &str) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_owned()
    }
}

pub(super) fn is_loopback_host(host: &str) -> bool {
    host == "localhost" || host == "::1" || host.starts_with("127.")
}

pub(super) fn is_unsafe_archive_member(name: &str) -> bool {
    let path = Path::new(name);
    path.is_absolute()
        || path
            .components()
            .any(|component| component.as_os_str() == "..")
}

pub(super) fn has_excluded_part(path: &Path) -> bool {
    path.components().any(|component| {
        component
            .as_os_str()
            .to_str()
            .is_some_and(|part| ARCHIVE_EXCLUDED_NAMES.contains(&part))
    })
}

pub(super) fn normalize_path(path: &Path) -> std::io::Result<PathBuf> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    Ok(normalized)
}
