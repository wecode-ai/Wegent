// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde_json::{Map, Value};

use super::response::RuntimeTaskLink;

pub(crate) fn cached_messages(link: &RuntimeTaskLink) -> Vec<Value> {
    link.runtime_handle
        .get("messages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|message| message.is_object())
        .cloned()
        .collect()
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

pub(crate) fn append_runtime_handle_message(runtime_handle: &mut Value, message: Value) {
    runtime_handle_messages_mut(runtime_handle).push(message);
}

pub(crate) fn clear_runtime_handle_messages(runtime_handle: &mut Value) {
    if let Some(object) = runtime_handle.as_object_mut() {
        object.remove("messages");
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
    let Some(client_message_id) = presentation
        .get("clientMessageId")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
    else {
        return;
    };
    let presentations = runtime_handle_user_message_presentations_mut(runtime_handle);
    if let Some(existing) = presentations.iter_mut().find(|existing| {
        existing.get("clientMessageId").and_then(Value::as_str) == Some(client_message_id.as_str())
    }) {
        *existing = presentation;
    } else {
        presentations.push(presentation);
    }
}

fn runtime_handle_messages_mut(runtime_handle: &mut Value) -> &mut Vec<Value> {
    runtime_handle_array_mut(runtime_handle, "messages")
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
