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

fn runtime_handle_messages_mut(runtime_handle: &mut Value) -> &mut Vec<Value> {
    if !runtime_handle.is_object() {
        *runtime_handle = Value::Object(Map::new());
    }
    let object = runtime_handle
        .as_object_mut()
        .expect("runtime handle object was just inserted");
    if !object.get("messages").is_some_and(Value::is_array) {
        object.insert("messages".to_owned(), Value::Array(Vec::new()));
    }
    object
        .get_mut("messages")
        .and_then(Value::as_array_mut)
        .expect("messages array was just inserted")
}
