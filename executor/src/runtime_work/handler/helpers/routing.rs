fn normalize_inactive_running_codex_task(link: &mut RuntimeTaskLink) -> bool {
    if !is_inactive_running_codex_task(link) {
        return false;
    }
    link.status = "active".to_owned();
    link.running = false;
    link.updated_at = now_ms();
    true
}
fn is_inactive_running_codex_task(link: &RuntimeTaskLink) -> bool {
    if !link.running || !is_codex_runtime(&link.runtime) {
        return false;
    }
    let status = link.status.replace(['_', '-'], "").to_ascii_lowercase();
    matches!(
        status.as_str(),
        "running" | "inprogress" | "busy" | "pending"
    )
}

fn task_fields(task_id: &str, subtask_id: &str) -> Vec<(&'static str, String)> {
    vec![
        ("task_id", task_id.to_owned()),
        ("subtask_id", subtask_id.to_owned()),
    ]
}

fn request_user_input_response(payload: &Value) -> Option<Value> {
    payload
        .get("requestUserInputResponse")
        .or_else(|| payload.get("request_user_input_response"))
        .filter(|value| value.is_object())
        .cloned()
}

fn empty_request_user_input_response() -> Value {
    json!({ "answers": {} })
}

struct RuntimeTranscriptLog<'a> {
    started_at: Instant,
    local_task_id: &'a str,
    thread_id: &'a str,
    source: &'a str,
    refresh: bool,
    running_hint: bool,
    limit: Option<usize>,
    before_cursor: Option<&'a str>,
    after_cursor: Option<&'a str>,
    message_count: usize,
    running: bool,
}

struct RuntimeProjectFilterLog<'a> {
    action: &'a str,
    reason: &'a str,
    workspace_kind: &'a str,
    group_path: Option<&'a str>,
    matched_by: Option<&'a str>,
    project_workspace_path: Option<&'a str>,
    project_name: Option<&'a str>,
    thread_hint: Option<&'a str>,
    project_count: usize,
}

fn log_runtime_project_filter_item(link: &RuntimeTaskLink, details: RuntimeProjectFilterLog<'_>) {
    log_executor_event(
        "runtime work project filter item",
        &[
            ("action", details.action.to_owned()),
            ("reason", details.reason.to_owned()),
            ("local_task_id", link.local_task_id.clone()),
            (
                "thread_id",
                link.thread_id.as_deref().unwrap_or("none").to_owned(),
            ),
            ("title", link.title.clone()),
            ("runtime", link.runtime.clone()),
            ("status", link.status.clone()),
            ("workspace_path", link.workspace_path.clone()),
            ("workspace_kind", details.workspace_kind.to_owned()),
            ("group_path", optional_str(details.group_path)),
            ("matched_by", optional_str(details.matched_by)),
            (
                "project_workspace_path",
                optional_str(details.project_workspace_path),
            ),
            ("project_name", optional_str(details.project_name)),
            ("thread_hint", optional_str(details.thread_hint)),
            ("project_count", details.project_count.to_string()),
        ],
    );
}

fn log_runtime_archive_link(event: &str, link: &RuntimeTaskLink, archived_query: bool) {
    log_executor_event(
        event,
        &[
            ("archived_query", archived_query.to_string()),
            ("local_task_id", link.local_task_id.clone()),
            (
                "thread_id",
                link.thread_id.as_deref().unwrap_or("none").to_owned(),
            ),
            ("workspace_path", link.workspace_path.clone()),
            ("runtime", link.runtime.clone()),
            ("status", link.status.clone()),
            ("running", link.running.to_string()),
            (
                "session_id",
                runtime_session_id_from_link(link).unwrap_or_else(|| "none".to_owned()),
            ),
        ],
    );
}

fn log_runtime_transcript_finished(details: RuntimeTranscriptLog<'_>) {
    log_executor_event(
        "runtime work transcript finished",
        &[
            ("elapsed_ms", elapsed_ms(details.started_at)),
            ("local_task_id", details.local_task_id.to_owned()),
            ("thread_id", details.thread_id.to_owned()),
            ("source", details.source.to_owned()),
            ("refresh", details.refresh.to_string()),
            ("running_hint", details.running_hint.to_string()),
            ("running", details.running.to_string()),
            ("limit", optional_usize(details.limit)),
            ("before_cursor", details.before_cursor.is_some().to_string()),
            ("after_cursor", details.after_cursor.is_some().to_string()),
            ("messages", details.message_count.to_string()),
        ],
    );
}

fn elapsed_ms(started_at: Instant) -> String {
    started_at.elapsed().as_millis().to_string()
}

fn optional_usize(value: Option<usize>) -> String {
    value
        .map(|value| value.to_string())
        .unwrap_or_else(|| "none".to_owned())
}

fn optional_str(value: Option<&str>) -> String {
    value
        .map(str::to_owned)
        .unwrap_or_else(|| "none".to_owned())
}

fn codex_project_workspaces(project_index: &CodexGlobalProjectIndex) -> Vec<RuntimeWorkspaceLink> {
    let now = now_ms();
    project_index
        .projects()
        .iter()
        .flat_map(|project| {
            let roots = if project.roots.is_empty() {
                vec![project.workspace_path.clone()]
            } else {
                project.roots.clone()
            };
            roots.into_iter().map(|root| RuntimeWorkspaceLink {
                workspace_path: root,
                title: project.name.clone(),
                runtime: "codex".to_owned(),
                created_at: now,
                updated_at: now,
                workspace_source: project.kind.clone(),
                remote_host_id: project.remote_host_id.clone(),
                project_key: project.key.clone(),
                project_kind: project.kind.clone(),
                project_source: project.source.clone(),
                project_roots: project.roots.clone(),
                project_pinned: project.pinned,
                project_pinned_order: project.pinned_order,
                project_active: project.active,
                project_appearance: project.appearance.clone(),
            })
        })
        .collect()
}

fn codex_started_thread_id(message: &Value) -> Option<String> {
    let notification = codex_notification(message);
    if notification.method != "thread/started" {
        return None;
    }
    notification
        .params
        .get("thread")
        .and_then(|thread| string_field(thread, "id"))
        .or_else(|| string_field(notification.params, "threadId"))
        .or_else(|| string_field(notification.params, "thread_id"))
}

fn pending_thread_event_route_id(local_task_id: &str) -> String {
    format!("{PENDING_THREAD_EVENT_ROUTE_PREFIX}{local_task_id}")
}

fn is_pending_thread_event_route_id(route_id: &str) -> bool {
    route_id.starts_with(PENDING_THREAD_EVENT_ROUTE_PREFIX)
}

fn codex_notification_thread_id(message: &Value) -> Option<String> {
    let notification = codex_notification(message);
    codex_stream_thread_id(notification.params).or_else(|| codex_stream_thread_id(message))
}

fn codex_stream_thread_id(value: &Value) -> Option<String> {
    string_field(value, "threadId")
        .or_else(|| string_field(value, "thread_id"))
        .or_else(|| {
            value.get("item").and_then(|item| {
                string_field(item, "threadId").or_else(|| string_field(item, "thread_id"))
            })
        })
        .or_else(|| {
            value.get("payload").and_then(|payload| {
                string_field(payload, "threadId").or_else(|| string_field(payload, "thread_id"))
            })
        })
        .or_else(|| {
            value.get("thread").and_then(|thread| {
                string_field(thread, "id")
                    .or_else(|| string_field(thread, "threadId"))
                    .or_else(|| string_field(thread, "thread_id"))
            })
        })
}

fn debug_unrouted_codex_notification(message: &Value, reason: &str) {
    let notification = codex_notification(message);
    let raw = serde_json::to_string(message)
        .unwrap_or_else(|error| format!("<failed to serialize raw message: {error}>"));
    log_executor_event(
        "runtime work codex notification unrouted",
        &[
            ("reason", reason.to_owned()),
            ("method", notification.method),
            ("raw_len", raw.len().to_string()),
            ("raw", raw),
        ],
    );
}

fn runtime_event_request_from_link(link: &RuntimeTaskLink) -> ExecutionRequest {
    ExecutionRequest {
        task_id: link.local_task_id.clone(),
        subtask_id: format!("{}-context-compact", link.local_task_id),
        project_workspace_path: Some(link.workspace_path.clone()),
        prompt: Value::String(link.title.clone()),
        ..ExecutionRequest::default()
    }
}

fn runtime_project_workspace_path(
    payload: &Value,
    project_index: &CodexGlobalProjectIndex,
) -> Option<String> {
    workspace_path(payload)
        .map(|path| {
            project_index
                .project_for_key(&path)
                .map(|project| project.workspace_path.clone())
                .unwrap_or_else(|| workspace_group_path(&path))
        })
        .or_else(|| {
            let key = string_field(payload, "runtimeProjectKey")
                .or_else(|| string_field(payload, "runtime_project_key"))?;
            let normalized_key = key.strip_prefix("local:").unwrap_or(&key);
            project_index
                .project_for_key(normalized_key)
                .map(|project| project.workspace_path.clone())
                .or_else(|| Some(super::util::normalize_workspace_path(normalized_key)))
        })
}

fn codex_thread_list_params(archived: bool, cursor: Option<&str>) -> Value {
    let mut params = json!({
        "limit": CODEX_THREAD_LIST_PAGE_SIZE,
        "sortKey": "updated_at",
        "sortDirection": "desc",
        "sourceKinds": CODEX_THREAD_SOURCE_KINDS,
        "archived": archived,
        "useStateDbOnly": true,
    });
    if let Some(cursor) = cursor {
        params["cursor"] = Value::String(cursor.to_owned());
    }
    params
}

fn payload_runtime_is_codex(payload: &Value) -> bool {
    string_field(payload, "runtime")
        .map(|runtime| is_codex_runtime(&runtime))
        .unwrap_or(true)
}

fn is_cached_codex_link_hidden(
    link: &RuntimeTaskLink,
    discovered_thread_ids: &HashSet<String>,
) -> bool {
    is_codex_runtime(&link.runtime)
        && !link.running
        && link
            .thread_id
            .as_ref()
            .is_some_and(|thread_id| discovered_thread_ids.contains(thread_id))
        && link.status != "archived"
}

fn is_codex_runtime(runtime: &str) -> bool {
    runtime.eq_ignore_ascii_case("codex")
}

fn append_unique_links(links: &mut Vec<RuntimeTaskLink>, new_links: Vec<RuntimeTaskLink>) {
    let mut keys = links.iter().map(link_key).collect::<HashSet<_>>();
    for link in new_links {
        if keys.insert(link_key(&link)) {
            links.push(link);
        }
    }
}

fn link_key(link: &RuntimeTaskLink) -> String {
    link.thread_id
        .clone()
        .unwrap_or_else(|| link.local_task_id.clone())
}

fn text_match(text: &str, query: &str) -> Option<(usize, usize)> {
    let normalized_query = query.trim().to_ascii_lowercase();
    if normalized_query.is_empty() {
        return None;
    }
    let normalized_text = text.to_ascii_lowercase();
    normalized_text
        .find(&normalized_query)
        .map(|start| (start, start + normalized_query.len()))
}

fn first_message_search_result(
    link: &RuntimeTaskLink,
    device_id: &str,
    messages: Vec<Value>,
    query: &str,
) -> Option<Value> {
    for message in messages {
        let content = string_field(&message, "content").unwrap_or_default();
        let Some((match_start, match_end)) = text_match(&content, query) else {
            continue;
        };
        let snippet = bounded_search_snippet(&content, match_start, match_end);
        return Some(search_result_item(
            link,
            device_id,
            SearchResultMatch {
                snippet: snippet.text,
                match_start: snippet.match_start,
                match_end: snippet.match_end,
                message_id: string_field(&message, "id").unwrap_or_default(),
                message_role: string_field(&message, "role")
                    .unwrap_or_else(|| "message".to_owned()),
                message_created_at: message.get("createdAt").cloned().unwrap_or(Value::Null),
            },
        ));
    }
    None
}

struct SearchSnippet {
    text: String,
    match_start: usize,
    match_end: usize,
}

fn bounded_search_snippet(text: &str, match_start: usize, match_end: usize) -> SearchSnippet {
    let total_chars = text.chars().count();
    if total_chars <= SEARCH_SNIPPET_MAX_CHARS {
        return SearchSnippet {
            text: text.to_owned(),
            match_start,
            match_end,
        };
    }

    let match_start_char = text[..match_start].chars().count();
    let match_end_char = text[..match_end].chars().count();
    let match_chars = match_end_char.saturating_sub(match_start_char);
    let context_budget = SEARCH_SNIPPET_MAX_CHARS.saturating_sub(match_chars);
    let before_budget = context_budget.min(SEARCH_SNIPPET_CONTEXT_CHARS);
    let after_budget = context_budget.saturating_sub(before_budget);
    let before_chars = before_budget.min(match_start_char);
    let mut after_chars = after_budget.min(total_chars.saturating_sub(match_end_char));

    let unused_before_budget = before_budget.saturating_sub(before_chars);
    if unused_before_budget > 0 {
        after_chars =
            (after_chars + unused_before_budget).min(total_chars.saturating_sub(match_end_char));
    }

    let snippet_start_char = match_start_char.saturating_sub(before_chars);
    let snippet_end_char = (match_end_char + after_chars).min(total_chars);
    let snippet_start_byte = byte_index_for_char(text, snippet_start_char);
    let snippet_end_byte = byte_index_for_char(text, snippet_end_char);

    SearchSnippet {
        text: text[snippet_start_byte..snippet_end_byte].to_owned(),
        match_start: match_start.saturating_sub(snippet_start_byte),
        match_end: match_end.saturating_sub(snippet_start_byte),
    }
}

fn byte_index_for_char(text: &str, char_index: usize) -> usize {
    text.char_indices()
        .nth(char_index)
        .map(|(byte_index, _)| byte_index)
        .unwrap_or(text.len())
}
