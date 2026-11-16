use super::*;

pub(super) fn request_tool_diagnostic_fields(body: &[u8]) -> Vec<(&'static str, String)> {
    let Ok(request) = serde_json::from_slice::<Value>(body) else {
        return vec![("tool_payload_parse_ok", "false".to_owned())];
    };
    let tools = request
        .get("tools")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let mut namespace_names = HashSet::new();
    let mut relevant_tool_names = HashSet::new();
    let mut tool_search_present = false;
    for tool in tools {
        collect_tool_diagnostics(
            tool,
            &mut namespace_names,
            &mut relevant_tool_names,
            &mut tool_search_present,
        );
    }
    let mut namespace_names = namespace_names.into_iter().collect::<Vec<_>>();
    namespace_names.sort();
    let mut relevant_tool_names = relevant_tool_names.into_iter().collect::<Vec<_>>();
    relevant_tool_names.sort();
    let tool_search = tools.iter().find(|tool| {
        let tool_type = tool.get("type").and_then(Value::as_str);
        let name = tool
            .get("name")
            .and_then(Value::as_str)
            .or_else(|| tool.pointer("/function/name").and_then(Value::as_str));
        tool_type == Some("tool_search")
            || matches!(name, Some("tool_search"))
            || name == Some(chat::BRIDGED_TOOL_SEARCH_NAME)
    });
    let tool_search_wire_name = tool_search
        .and_then(|tool| {
            tool.get("name")
                .and_then(Value::as_str)
                .or_else(|| tool.pointer("/function/name").and_then(Value::as_str))
        })
        .unwrap_or(if tool_search_present { "native" } else { "" });
    let tool_search_description_present = tool_search.is_some_and(|tool| {
        tool.get("description")
            .or_else(|| tool.pointer("/function/description"))
            .and_then(Value::as_str)
            .is_some_and(|description| !description.trim().is_empty())
    });
    let mut tool_search_parameter_names = tool_search
        .and_then(|tool| {
            tool.get("parameters")
                .or_else(|| tool.pointer("/function/parameters"))
        })
        .and_then(|parameters| parameters.get("properties"))
        .and_then(Value::as_object)
        .map(|properties| properties.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    tool_search_parameter_names.sort();
    vec![
        ("tool_payload_parse_ok", "true".to_owned()),
        ("tool_count", tools.len().to_string()),
        ("namespace_names", namespace_names.join(",")),
        ("wework_tool_names", relevant_tool_names.join(",")),
        ("tool_search_present", tool_search_present.to_string()),
        ("tool_search_wire_name", tool_search_wire_name.to_owned()),
        (
            "tool_search_description_present",
            tool_search_description_present.to_string(),
        ),
        (
            "tool_search_parameter_names",
            tool_search_parameter_names.join(","),
        ),
    ]
}

pub(super) fn collect_tool_diagnostics(
    tool: &Value,
    namespace_names: &mut HashSet<String>,
    relevant_tool_names: &mut HashSet<String>,
    tool_search_present: &mut bool,
) {
    let tool_type = tool.get("type").and_then(Value::as_str).unwrap_or_default();
    let name = tool
        .get("name")
        .and_then(Value::as_str)
        .or_else(|| tool.pointer("/function/name").and_then(Value::as_str));
    if tool_type == "namespace" {
        if let Some(name) = name {
            namespace_names.insert(name.to_owned());
        }
        for nested in tool
            .get("tools")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            collect_tool_diagnostics(
                nested,
                namespace_names,
                relevant_tool_names,
                tool_search_present,
            );
        }
    }
    if tool_type == "tool_search"
        || name == Some("tool_search")
        || name == Some(chat::BRIDGED_TOOL_SEARCH_NAME)
    {
        *tool_search_present = true;
    }
    if let Some(name) = name.filter(|name| is_wework_space_tool_name(name)) {
        relevant_tool_names.insert(name.to_owned());
    }
}

pub(super) fn is_wework_space_tool_name(name: &str) -> bool {
    name.contains("wework_space")
        || matches!(
            name,
            "get_board_item" | "get_assignment_candidates" | "assign_board_item"
        )
}

pub(super) fn requested_model(body: &[u8]) -> Option<String> {
    serde_json::from_slice::<Value>(body)
        .ok()?
        .get("model")?
        .as_str()
        .map(str::to_owned)
}

pub(super) fn authorize_task_thread(
    registered: &mut RegisteredUpstream,
    body: &[u8],
) -> Result<(), HttpError> {
    if registered.thread_ids.is_empty() {
        return Ok(());
    }
    let identity = request_thread_identity(body).ok_or_else(|| HttpError {
        status: StatusCode::CONFLICT,
        detail: "Codex Responses request is missing task thread metadata".to_owned(),
    })?;
    if registered.thread_ids.contains(&identity.thread_id) {
        return Ok(());
    }
    if identity
        .parent_thread_id
        .as_ref()
        .is_some_and(|parent| registered.thread_ids.contains(parent))
    {
        registered.thread_ids.insert(identity.thread_id);
        return Ok(());
    }
    Err(HttpError {
        status: StatusCode::CONFLICT,
        detail: "Codex Responses request thread does not belong to the task route".to_owned(),
    })
}

pub(super) fn request_thread_identity(body: &[u8]) -> Option<RequestThreadIdentity> {
    let request = serde_json::from_slice::<Value>(body).ok()?;
    let metadata = request.get("client_metadata")?.as_object()?;
    let thread_id = metadata.get("thread_id")?.as_str()?.to_owned();
    let parent_thread_id = metadata
        .get("parent_thread_id")
        .or_else(|| metadata.get("x-codex-parent-thread-id"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| {
            metadata
                .get("x-codex-turn-metadata")
                .and_then(Value::as_str)
                .and_then(|value| serde_json::from_str::<Value>(value).ok())
                .and_then(|value| {
                    value
                        .get("parent_thread_id")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
        });
    Some(RequestThreadIdentity {
        thread_id,
        parent_thread_id,
    })
}

pub(super) fn stale_requested_model(
    upstream: &LocalModelProxyUpstream,
    body: &[u8],
) -> Option<(String, String)> {
    let expected_model = upstream.routing_model_id.as_deref()?;
    let requested_model = requested_model(body)?;
    if requested_model == expected_model {
        return None;
    }
    Some((requested_model, expected_model.to_owned()))
}

pub(super) fn log_stale_requested_model(upstream: &LocalModelProxyUpstream, body: &[u8]) {
    let Some((requested_model, selected_model)) = stale_requested_model(upstream, body) else {
        return;
    };
    log_executor_event(
        "local model proxy ignored stale codex model",
        &[
            ("requested_model", requested_model),
            ("selected_model", selected_model),
        ],
    );
}

pub(super) fn begin_model_request(
    registered: &RegisteredUpstream,
    body: &[u8],
) -> ModelRequestRouting {
    let current_model = registered
        .upstream
        .routing_model_id
        .as_deref()
        .or(registered.upstream.model_id.as_deref())
        .map(str::to_owned);
    let Some(current_model) = current_model else {
        return ModelRequestRouting::default();
    };
    if registered.pending_model_switch_cleanup {
        return ModelRequestRouting {
            model_switched: true,
            model_to_commit: Some(current_model),
            clear_pending_model_switch: true,
        };
    }
    match registered.last_routed_model.as_deref() {
        None => ModelRequestRouting {
            model_switched: false,
            model_to_commit: Some(current_model),
            clear_pending_model_switch: false,
        },
        Some(previous_model) if previous_model == current_model => ModelRequestRouting::default(),
        Some(_) if request_contains_model_switch_marker(body) => ModelRequestRouting {
            model_switched: true,
            model_to_commit: Some(current_model),
            clear_pending_model_switch: false,
        },
        Some(_) => ModelRequestRouting::default(),
    }
}

pub(super) fn commit_model_request(token: &str, routing: &ModelRequestRouting) {
    let Some(model_to_commit) = routing.model_to_commit.as_deref() else {
        return;
    };
    let mut registry = registry()
        .lock()
        .expect("local model proxy registry should not be poisoned");
    let Some(registered) = registry.routes.get_mut(token) else {
        return;
    };
    let current_model = registered
        .upstream
        .routing_model_id
        .as_deref()
        .or(registered.upstream.model_id.as_deref());
    if current_model == Some(model_to_commit) {
        registered.last_routed_model = Some(model_to_commit.to_owned());
        if routing.clear_pending_model_switch {
            registered.pending_model_switch_cleanup = false;
        }
    }
}

pub(super) fn prepare_model_switch_request(
    upstream: &LocalModelProxyUpstream,
    body: Vec<u8>,
    model_switched: bool,
) -> Result<Vec<u8>, HttpError> {
    if !model_switched {
        return Ok(body);
    }
    let mut request = serde_json::from_slice::<Value>(&body).map_err(|error| HttpError {
        status: StatusCode::BAD_REQUEST,
        detail: format!("Invalid Codex Responses request: {error}"),
    })?;
    let Some(object) = request.as_object_mut() else {
        return Ok(body);
    };
    let removed_previous_response_id = object.remove("previous_response_id").is_some();
    let removed_items = object
        .get_mut("input")
        .and_then(Value::as_array_mut)
        .map(|items| {
            let before = items.len();
            items.retain(|item| !has_encrypted_model_state(item));
            before.saturating_sub(items.len())
        })
        .unwrap_or_default();
    if removed_items == 0 && !removed_previous_response_id {
        return Ok(body);
    }
    log_executor_event(
        "local model proxy removed encrypted history for model switch",
        &[
            (
                "requested_model",
                requested_model(&body).unwrap_or_default(),
            ),
            (
                "upstream_model",
                upstream.model_id.clone().unwrap_or_default(),
            ),
            ("removed_items", removed_items.to_string()),
            (
                "removed_previous_response_id",
                removed_previous_response_id.to_string(),
            ),
        ],
    );
    serde_json::to_vec(&request).map_err(|error| HttpError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        detail: format!("Failed to encode model switch request: {error}"),
    })
}

pub(super) fn request_contains_model_switch_marker(body: &[u8]) -> bool {
    serde_json::from_slice::<Value>(body)
        .ok()
        .is_some_and(|request| contains_model_switch_marker(&request))
}

pub(super) fn contains_model_switch_marker(request: &Value) -> bool {
    request
        .get("input")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| item.get("content").and_then(Value::as_array))
        .flatten()
        .filter_map(|content| content.get("text").and_then(Value::as_str))
        .any(|text| text.contains("<model_switch>"))
}

pub(super) fn has_encrypted_model_state(item: &Value) -> bool {
    let item_type = item.get("type").and_then(Value::as_str);
    let direct = item
        .get("encrypted_content")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty());
    let nested = item
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(|part| {
            part.get("encrypted_content")
                .and_then(Value::as_str)
                .is_some_and(|value| !value.is_empty())
        });
    matches!(
        item_type,
        Some(
            "reasoning"
                | "compaction"
                | "compaction_summary"
                | "context_compaction"
                | "agent_message"
        )
    ) && (direct || nested)
}

pub(super) fn rewrite_request_model(body: &[u8], model_id: &str) -> Result<Vec<u8>, HttpError> {
    let mut request: Value = serde_json::from_slice(body).map_err(|error| HttpError {
        status: StatusCode::BAD_REQUEST,
        detail: format!("Invalid local model proxy request: {error}"),
    })?;
    let object = request.as_object_mut().ok_or_else(|| HttpError {
        status: StatusCode::BAD_REQUEST,
        detail: "Local model proxy request body must be an object".to_owned(),
    })?;
    object.insert("model".to_owned(), Value::String(model_id.to_owned()));
    serde_json::to_vec(&request).map_err(|error| HttpError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        detail: format!("Failed to encode local model proxy request: {error}"),
    })
}
