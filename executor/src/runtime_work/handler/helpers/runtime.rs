fn runtime_session_id_from_link(link: &RuntimeTaskLink) -> Option<String> {
    link.thread_id
        .clone()
        .or_else(|| runtime_session_id_from_handle(&link.runtime_handle))
}
fn codex_thread_id_from_link(link: &RuntimeTaskLink) -> Option<String> {
    runtime_session_id_from_link(link).filter(|thread_id| is_codex_thread_id(thread_id))
}

fn is_codex_thread_id(thread_id: &str) -> bool {
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

fn runtime_thread_path_from_link(link: &RuntimeTaskLink) -> Option<String> {
    string_field(&link.runtime_handle, "threadPath")
        .or_else(|| string_field(&link.runtime_handle, "thread_path"))
        .or_else(|| string_field(&link.runtime_handle, "path"))
        .filter(|path| !path.trim().is_empty())
}

fn archived_link_from_payload_item(
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
    link.continuable = false;
    link
}

fn runtime_session_id_from_payload(payload: &Value) -> Option<String> {
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

fn initial_thread_goal_from_payload(payload: &Value) -> Option<Value> {
    payload
        .get("initialGoal")
        .or_else(|| payload.get("initial_goal"))
        .filter(|goal| goal.is_object())
        .cloned()
}

fn side_source_thread(payload: &Value) -> Option<SideSourceThread> {
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

fn runtime_session_id_from_handle(handle: &Value) -> Option<String> {
    string_field(handle, "sessionId")
        .or_else(|| string_field(handle, "session_id"))
        .or_else(|| string_field(handle, "threadId"))
        .or_else(|| string_field(handle, "thread_id"))
        .or_else(|| string_field(handle, "conversationId"))
        .or_else(|| string_field(handle, "conversation_id"))
}

fn runtime_has_provider_transcript_reader(runtime: &str) -> bool {
    runtime.trim().eq_ignore_ascii_case("codex")
}

fn source_parent_json(source: &super::fork_transfer::SourceTaskIdentity) -> Value {
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

fn fork_error_response(code: &str, error: String) -> Value {
    json!({
        "success": false,
        "error": error,
        "code": code,
    })
}
