// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use serde_json::json;

pub(crate) fn runtime_handle_json(link: &RuntimeTaskLink) -> Value {
    let mut object = link
        .runtime_handle
        .as_object()
        .cloned()
        .unwrap_or_else(Map::new);
    object.insert(
        "threadId".to_owned(),
        link.thread_id
            .as_ref()
            .map(|thread_id| Value::String(thread_id.clone()))
            .unwrap_or(Value::Null),
    );
    Value::Object(object)
}

pub(crate) fn set_runtime_handle_model_selection(runtime_handle: &mut Value, payload: &Value) {
    let Some(model_name) =
        string_field(payload, "modelId").or_else(|| string_field(payload, "model_id"))
    else {
        return;
    };
    let mut selection = Map::new();
    selection.insert("modelName".to_owned(), Value::String(model_name));
    selection.insert(
        "modelType".to_owned(),
        string_field(payload, "modelType")
            .or_else(|| string_field(payload, "model_type"))
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    selection.insert(
        "options".to_owned(),
        payload
            .get("modelOptions")
            .or_else(|| payload.get("model_options"))
            .filter(|value| value.is_object())
            .cloned()
            .unwrap_or_else(|| json!({})),
    );

    let mut object = runtime_handle.as_object().cloned().unwrap_or_default();
    object.insert("modelSelection".to_owned(), Value::Object(selection));
    *runtime_handle = Value::Object(object);
}

pub(crate) fn runtime_session_id_from_link(link: &RuntimeTaskLink) -> Option<String> {
    link.thread_id
        .clone()
        .or_else(|| runtime_session_id_from_handle(&link.runtime_handle))
}

pub(crate) fn codex_thread_id_from_link(link: &RuntimeTaskLink) -> Option<String> {
    runtime_session_id_from_link(link).filter(|thread_id| is_codex_thread_id(thread_id))
}

pub(crate) fn is_codex_thread_id(thread_id: &str) -> bool {
    let thread_id = thread_id.strip_prefix("urn:uuid:").unwrap_or(thread_id);
    thread_id.len() == 36
        && thread_id
            .chars()
            .enumerate()
            .all(|(index, character)| match index {
                8 | 13 | 18 | 23 => character == '-',
                _ => character.is_ascii_hexdigit(),
            })
}

pub(crate) fn runtime_thread_path_from_link(link: &RuntimeTaskLink) -> Option<String> {
    string_field(&link.runtime_handle, "threadPath")
        .or_else(|| string_field(&link.runtime_handle, "thread_path"))
        .or_else(|| string_field(&link.runtime_handle, "path"))
        .filter(|path| !path.trim().is_empty())
}

pub(crate) fn archived_link_from_payload_item(
    item: &Value,
    local_task_id: String,
    thread_id: Option<String>,
) -> RuntimeTaskLink {
    let workspace_path = workspace_path(item).unwrap_or_default();
    let title = string_field(item, "title").unwrap_or_else(|| local_task_id.clone());
    let mut link = RuntimeTaskLink::new_pending(local_task_id.clone(), workspace_path, title);
    link.thread_id = thread_id;
    if let Some(runtime_handle) = item
        .get("runtimeHandle")
        .or_else(|| item.get("runtime_handle"))
        .cloned()
    {
        link.runtime_handle = runtime_handle;
    }
    link.status = "archived".to_owned();
    link.running = false;
    link
}

pub(crate) fn runtime_session_id_from_payload(payload: &Value) -> Option<String> {
    let address = payload.get("address");
    string_field(payload, "threadId")
        .or_else(|| string_field(payload, "thread_id"))
        .or_else(|| address.and_then(|address| string_field(address, "threadId")))
        .or_else(|| address.and_then(|address| string_field(address, "thread_id")))
        .or_else(|| {
            payload
                .get("runtimeHandle")
                .or_else(|| payload.get("runtime_handle"))
                .and_then(runtime_session_id_from_handle)
        })
        .or_else(|| {
            address.and_then(|address| {
                address
                    .get("runtimeHandle")
                    .or_else(|| address.get("runtime_handle"))
                    .and_then(runtime_session_id_from_handle)
            })
        })
        .or_else(|| string_field(payload, "providerSessionId"))
        .or_else(|| string_field(payload, "provider_session_id"))
        .or_else(|| address.and_then(|address| string_field(address, "providerSessionId")))
        .or_else(|| address.and_then(|address| string_field(address, "provider_session_id")))
}

pub(crate) fn initial_thread_goal_from_payload(payload: &Value) -> Option<Value> {
    payload
        .get("initialGoal")
        .or_else(|| payload.get("initial_goal"))
        .filter(|goal| goal.is_object())
        .cloned()
}

pub(crate) fn side_source_thread(payload: &Value) -> Option<SideSourceThread> {
    let source = payload
        .get("sideSource")
        .or_else(|| payload.get("side_source"))?;
    let handle = source
        .get("runtimeHandle")
        .or_else(|| source.get("runtime_handle"));
    let thread_id = string_field(source, "threadId")
        .or_else(|| string_field(source, "thread_id"))
        .or_else(|| handle.and_then(runtime_session_id_from_handle))
        .filter(|thread_id| !thread_id.trim().is_empty())?;
    let thread_path = string_field(source, "threadPath")
        .or_else(|| string_field(source, "thread_path"))
        .or_else(|| string_field(source, "path"))
        .or_else(|| {
            handle.and_then(|handle| {
                string_field(handle, "threadPath")
                    .or_else(|| string_field(handle, "thread_path"))
                    .or_else(|| string_field(handle, "path"))
            })
        })
        .filter(|path| !path.trim().is_empty());
    Some(SideSourceThread {
        thread_id,
        thread_path,
    })
}

pub(crate) fn runtime_session_id_from_handle(handle: &Value) -> Option<String> {
    string_field(handle, "sessionId")
        .or_else(|| string_field(handle, "session_id"))
        .or_else(|| string_field(handle, "threadId"))
        .or_else(|| string_field(handle, "thread_id"))
        .or_else(|| string_field(handle, "conversationId"))
        .or_else(|| string_field(handle, "conversation_id"))
}

pub(crate) fn runtime_has_provider_transcript_reader(runtime: &str) -> bool {
    runtime.trim().eq_ignore_ascii_case("codex")
}

pub(crate) fn source_parent_json(
    source: &super::super::super::fork_transfer::SourceTaskIdentity,
) -> Value {
    let mut parent = Map::new();
    if let Some(device_id) = &source.device_id {
        parent.insert("deviceId".to_owned(), Value::String(device_id.clone()));
    }
    if let Some(workspace_path) = &source.workspace_path {
        parent.insert(
            "workspacePath".to_owned(),
            Value::String(workspace_path.clone()),
        );
    }
    parent.insert(
        "taskId".to_owned(),
        Value::String(source.local_task_id.clone()),
    );
    if let Some(thread_id) = &source.thread_id {
        parent.insert("threadId".to_owned(), Value::String(thread_id.clone()));
    }
    if let Some(runtime) = &source.runtime {
        parent.insert("runtime".to_owned(), Value::String(runtime.clone()));
    }
    Value::Object(parent)
}

pub(crate) fn fork_error_response(code: &str, error: String) -> Value {
    json!({
        "success": false,
        "error": error,
        "code": code,
    })
}
