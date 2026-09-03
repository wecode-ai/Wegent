// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde_json::{Map, Value};

use super::response::RuntimeTaskLink;

pub(crate) fn cached_messages(link: &RuntimeTaskLink) -> Vec<Value> {
    runtime_handle_messages(&link.runtime_handle, "messages")
}

pub(crate) fn completed_transcript_messages(link: &RuntimeTaskLink) -> Vec<Value> {
    let Some(thread_id) = link.thread_id.as_deref() else {
        return Vec::new();
    };
    if link
        .runtime_handle
        .get("completedTranscriptThreadId")
        .and_then(Value::as_str)
        != Some(thread_id)
    {
        return Vec::new();
    }
    runtime_handle_messages(&link.runtime_handle, "completedTranscriptMessages")
}

pub(crate) fn transcript_snapshot_messages(link: &RuntimeTaskLink) -> Vec<Value> {
    let Some(thread_id) = link.thread_id.as_deref() else {
        return Vec::new();
    };
    if link
        .runtime_handle
        .get("transcriptSnapshotThreadId")
        .and_then(Value::as_str)
        != Some(thread_id)
    {
        return Vec::new();
    }
    runtime_handle_messages(&link.runtime_handle, "transcriptSnapshotMessages")
}

pub(crate) fn set_runtime_handle_messages(runtime_handle: &mut Value, messages: Vec<Value>) {
    if !runtime_handle.is_object() {
        *runtime_handle = Value::Object(Map::new());
    }
    let object = runtime_handle
        .as_object_mut()
        .expect("runtime handle object was just inserted");
    object.insert("messages".to_owned(), Value::Array(messages));
}

pub(crate) fn set_transcript_snapshot_messages(
    runtime_handle: &mut Value,
    thread_id: &str,
    messages: Vec<Value>,
) {
    if thread_id.trim().is_empty() {
        return;
    }
    if !runtime_handle.is_object() {
        *runtime_handle = Value::Object(Map::new());
    }
    let object = runtime_handle
        .as_object_mut()
        .expect("runtime handle object was just inserted");
    object.insert(
        "transcriptSnapshotThreadId".to_owned(),
        Value::String(thread_id.to_owned()),
    );
    object.insert(
        "transcriptSnapshotMessages".to_owned(),
        Value::Array(messages),
    );
}

pub(crate) fn append_runtime_handle_message(runtime_handle: &mut Value, message: Value) {
    runtime_handle_messages_mut(runtime_handle).push(message);
}

pub(crate) fn append_completed_transcript_messages(
    runtime_handle: &mut Value,
    thread_id: &str,
    messages: Vec<Value>,
) {
    if thread_id.trim().is_empty() {
        return;
    }
    if !runtime_handle.is_object() {
        *runtime_handle = Value::Object(Map::new());
    }
    {
        let object = runtime_handle
            .as_object_mut()
            .expect("runtime handle object was just inserted");
        if object
            .get("completedTranscriptThreadId")
            .and_then(Value::as_str)
            != Some(thread_id)
        {
            object.insert(
                "completedTranscriptMessages".to_owned(),
                Value::Array(Vec::new()),
            );
        }
        object.insert(
            "completedTranscriptThreadId".to_owned(),
            Value::String(thread_id.to_owned()),
        );
    }
    let completed_messages =
        runtime_handle_array_mut(runtime_handle, "completedTranscriptMessages");
    for message in messages {
        let message_id = message.get("id").and_then(Value::as_str);
        if let Some(existing) = completed_messages.iter_mut().find(|existing| {
            message_id.is_some() && existing.get("id").and_then(Value::as_str) == message_id
        }) {
            *existing = message;
        } else {
            completed_messages.push(message);
        }
    }
}

pub(crate) fn clear_runtime_handle_messages(runtime_handle: &mut Value) {
    if let Some(object) = runtime_handle.as_object_mut() {
        object.remove("messages");
    }
}

pub(crate) fn clear_completed_transcript_messages(runtime_handle: &mut Value) {
    if let Some(object) = runtime_handle.as_object_mut() {
        object.remove("completedTranscriptMessages");
        object.remove("completedTranscriptThreadId");
    }
}

pub(crate) fn clear_transcript_snapshot_messages(runtime_handle: &mut Value) {
    if let Some(object) = runtime_handle.as_object_mut() {
        object.remove("transcriptSnapshotMessages");
        object.remove("transcriptSnapshotThreadId");
    }
}

pub(crate) fn append_unique_transcript_messages(
    target: &mut Vec<Value>,
    messages: impl IntoIterator<Item = Value>,
) {
    for mut message in messages {
        let message_id = message.get("id").and_then(Value::as_str);
        if let Some(existing) = target.iter_mut().find(|existing| {
            message_id.is_some() && existing.get("id").and_then(Value::as_str) == message_id
        }) {
            if same_user_client_message_id(existing, &message) {
                preserve_local_user_message_metadata(&mut message, existing);
            }
            *existing = message;
        } else if let Some(existing) = target
            .iter_mut()
            .find(|existing| same_user_client_message_id(existing, &message))
        {
            preserve_local_user_message_metadata(&mut message, existing);
            *existing = message;
        } else {
            target.push(message);
        }
    }
}

fn same_user_client_message_id(left: &Value, right: &Value) -> bool {
    let is_user = |message: &Value| {
        message
            .get("role")
            .and_then(Value::as_str)
            .is_some_and(|role| role.eq_ignore_ascii_case("user"))
    };
    if !is_user(left) || !is_user(right) {
        return false;
    }

    user_client_message_id(left)
        .zip(user_client_message_id(right))
        .is_some_and(|(left, right)| left == right)
}

fn user_client_message_id(message: &Value) -> Option<&str> {
    message
        .get("clientUserMessageId")
        .or_else(|| message.get("client_user_message_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn preserve_local_user_message_metadata(target: &mut Value, source: &Value) {
    let Some(target) = target.as_object_mut() else {
        return;
    };
    let Some(source) = source.as_object() else {
        return;
    };
    for key in [
        "source",
        "runtimeGoalRequest",
        "runtime_goal_request",
        "attachments",
    ] {
        if target.get(key).map(Value::is_null).unwrap_or(true) {
            if let Some(value) = source.get(key) {
                target.insert(key.to_owned(), value.clone());
            }
        }
    }
}

pub(crate) fn user_message_presentations(link: &RuntimeTaskLink) -> Vec<Value> {
    link.runtime_handle
        .get("userMessagePresentations")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|presentation| presentation.is_object())
        .cloned()
        .collect()
}

pub(crate) fn append_runtime_handle_user_message_presentation(
    runtime_handle: &mut Value,
    presentation: Value,
) {
    let Some(client_user_message_id) = presentation
        .get("clientUserMessageId")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
    else {
        return;
    };
    let presentations = runtime_handle_user_message_presentations_mut(runtime_handle);
    if let Some(existing) = presentations.iter_mut().find(|existing| {
        existing.get("clientUserMessageId").and_then(Value::as_str)
            == Some(client_user_message_id.as_str())
    }) {
        *existing = presentation;
    } else {
        presentations.push(presentation);
    }
}

pub(crate) fn bind_runtime_handle_user_message_presentation_to_turn(
    runtime_handle: &mut Value,
    client_user_message_id: &str,
    turn_id: &str,
) {
    let client_user_message_id = client_user_message_id.trim();
    let turn_id = turn_id.trim();
    if client_user_message_id.is_empty() || turn_id.is_empty() {
        return;
    }
    let Some(presentations) = runtime_handle
        .get_mut("userMessagePresentations")
        .and_then(Value::as_array_mut)
    else {
        return;
    };
    let Some(presentation) = presentations
        .iter_mut()
        .find(|presentation| {
            presentation
                .get("clientUserMessageId")
                .or_else(|| presentation.get("client_user_message_id"))
                .and_then(Value::as_str)
                == Some(client_user_message_id)
        })
        .and_then(Value::as_object_mut)
    else {
        return;
    };
    presentation.insert("turnId".to_owned(), Value::String(turn_id.to_owned()));
}

fn runtime_handle_messages_mut(runtime_handle: &mut Value) -> &mut Vec<Value> {
    runtime_handle_array_mut(runtime_handle, "messages")
}

fn runtime_handle_messages(runtime_handle: &Value, key: &str) -> Vec<Value> {
    runtime_handle
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|message| message.is_object())
        .cloned()
        .collect()
}

fn runtime_handle_user_message_presentations_mut(runtime_handle: &mut Value) -> &mut Vec<Value> {
    runtime_handle_array_mut(runtime_handle, "userMessagePresentations")
}

fn runtime_handle_array_mut<'a>(runtime_handle: &'a mut Value, key: &str) -> &'a mut Vec<Value> {
    if !runtime_handle.is_object() {
        *runtime_handle = Value::Object(Map::new());
    }
    let object = runtime_handle
        .as_object_mut()
        .expect("runtime handle object was just inserted");
    if !object.get(key).is_some_and(Value::is_array) {
        object.insert(key.to_owned(), Value::Array(Vec::new()));
    }
    object
        .get_mut(key)
        .and_then(Value::as_array_mut)
        .expect("runtime handle array was just inserted")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn completed_transcript_cache_is_scoped_to_provider_thread() {
        let mut link = RuntimeTaskLink {
            thread_id: Some("thread-1".to_owned()),
            ..RuntimeTaskLink::default()
        };
        append_completed_transcript_messages(
            &mut link.runtime_handle,
            "thread-1",
            vec![json!({"id": "message-1", "role": "assistant"})],
        );

        assert_eq!(completed_transcript_messages(&link).len(), 1);

        link.thread_id = Some("thread-2".to_owned());
        assert!(completed_transcript_messages(&link).is_empty());

        append_completed_transcript_messages(
            &mut link.runtime_handle,
            "thread-2",
            vec![json!({"id": "message-2", "role": "assistant"})],
        );

        let messages = completed_transcript_messages(&link);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["id"], "message-2");
    }

    #[test]
    fn transcript_snapshot_is_scoped_to_provider_thread() {
        let mut link = RuntimeTaskLink {
            thread_id: Some("thread-1".to_owned()),
            ..RuntimeTaskLink::default()
        };
        set_transcript_snapshot_messages(
            &mut link.runtime_handle,
            "thread-1",
            vec![json!({"id": "message-1", "role": "assistant"})],
        );

        assert_eq!(transcript_snapshot_messages(&link).len(), 1);

        link.thread_id = Some("thread-2".to_owned());
        assert!(transcript_snapshot_messages(&link).is_empty());
    }

    #[test]
    fn appending_transcript_messages_replaces_matching_ids() {
        let mut messages = vec![
            json!({"id": "message-1", "content": "old"}),
            json!({"id": "message-2", "content": "keep"}),
        ];

        append_unique_transcript_messages(
            &mut messages,
            vec![
                json!({"id": "message-1", "content": "new"}),
                json!({"id": "message-3", "content": "append"}),
            ],
        );

        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0]["content"], "new");
        assert_eq!(messages[1]["content"], "keep");
        assert_eq!(messages[2]["content"], "append");
    }

    #[test]
    fn appending_transcript_messages_replaces_user_aliases_by_client_id() {
        let mut messages = vec![json!({
            "id": "cached-user",
            "clientUserMessageId": "client-user-1",
            "role": "user",
            "content": "Visible prompt",
            "attachments": [{"id": "attachment-1"}],
        })];

        append_unique_transcript_messages(
            &mut messages,
            vec![json!({
                "id": "provider-user",
                "clientUserMessageId": "client-user-1",
                "role": "user",
                "content": "Provider prompt",
                "turnId": "turn-1",
            })],
        );

        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["id"], "provider-user");
        assert_eq!(messages[0]["content"], "Provider prompt");
        assert_eq!(messages[0]["turnId"], "turn-1");
        assert_eq!(messages[0]["attachments"][0]["id"], "attachment-1");
    }

    #[test]
    fn appending_transcript_messages_preserves_metadata_for_same_user_id() {
        let mut messages = vec![json!({
            "id": "user-1",
            "clientUserMessageId": "client-user-1",
            "role": "user",
            "content": "Visible prompt",
            "attachments": [{"id": "attachment-1"}],
        })];

        append_unique_transcript_messages(
            &mut messages,
            vec![json!({
                "id": "user-1",
                "clientUserMessageId": "client-user-1",
                "role": "user",
                "content": "Provider prompt",
                "turnId": "turn-1",
            })],
        );

        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["content"], "Provider prompt");
        assert_eq!(messages[0]["turnId"], "turn-1");
        assert_eq!(messages[0]["attachments"][0]["id"], "attachment-1");
    }
}
