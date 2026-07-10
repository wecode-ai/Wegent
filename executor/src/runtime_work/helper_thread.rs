// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use serde_json::json;

pub(crate) fn codex_thread_list_params(archived: bool, cursor: Option<&str>) -> Value {
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

pub(crate) fn thread_has_readable_rollout_path(thread: &Value) -> bool {
    string_field(thread, "path")
        .map(|path| Path::new(&path).is_file())
        .unwrap_or(false)
}

pub(crate) fn payload_runtime_is_codex(payload: &Value) -> bool {
    string_field(payload, "runtime")
        .map(|runtime| is_codex_runtime(&runtime))
        .unwrap_or(true)
}

pub(crate) fn is_cached_codex_link_hidden(
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

pub(crate) fn is_codex_runtime(runtime: &str) -> bool {
    runtime.eq_ignore_ascii_case("codex")
}

pub(crate) fn append_unique_links(
    links: &mut Vec<RuntimeTaskLink>,
    new_links: Vec<RuntimeTaskLink>,
) {
    let mut keys = links.iter().map(link_key).collect::<HashSet<_>>();
    for link in new_links {
        if keys.insert(link_key(&link)) {
            links.push(link);
        }
    }
}

pub(crate) fn link_key(link: &RuntimeTaskLink) -> String {
    link.thread_id
        .clone()
        .unwrap_or_else(|| link.local_task_id.clone())
}

pub(crate) fn text_match(text: &str, query: &str) -> Option<(usize, usize)> {
    let normalized_query = query.trim().to_ascii_lowercase();
    if normalized_query.is_empty() {
        return None;
    }
    let normalized_text = text.to_ascii_lowercase();
    normalized_text
        .find(&normalized_query)
        .map(|start| (start, start + normalized_query.len()))
}

pub(crate) fn first_message_search_result(
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

pub(crate) struct SearchSnippet {
    text: String,
    match_start: usize,
    match_end: usize,
}

pub(crate) fn bounded_search_snippet(
    text: &str,
    match_start: usize,
    match_end: usize,
) -> SearchSnippet {
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

pub(crate) fn byte_index_for_char(text: &str, char_index: usize) -> usize {
    text.char_indices()
        .nth(char_index)
        .map(|(byte_index, _)| byte_index)
        .unwrap_or(text.len())
}
