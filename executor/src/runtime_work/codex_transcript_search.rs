// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::agents::CodexAppServerClient;

use super::{
    codex_transcript_page::{
        read_codex_thread_metadata, CodexTranscriptDirection, CodexTranscriptPage,
    },
    transcript_search_text::codex_turn_search_sources,
    util::{item_type, string_field},
};

const SEARCH_CURSOR_PREFIX: &str = "wework-codex-search:";
const CONTEXT_CURSOR_PREFIX: &str = "wework-codex-search-context:";
const SEARCH_PAGE_SIZE: usize = 100;
const SEARCH_ITEM_RADIUS: usize = 50;
const CONTEXT_ITEM_PAGE_SIZE: usize = 100;

pub(super) fn is_search_cursor(cursor: &str) -> bool {
    cursor.starts_with(SEARCH_CURSOR_PREFIX)
        || cursor.starts_with(CONTEXT_CURSOR_PREFIX)
        || cursor.starts_with("wework-codex-legacy-context:")
        || super::codex_legacy_search::is_legacy_search_cursor(cursor)
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum ContextDirection {
    Asc,
    Desc,
}

impl ContextDirection {
    fn as_str(self) -> &'static str {
        match self {
            Self::Asc => "asc",
            Self::Desc => "desc",
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingContextTurn {
    turn: Value,
    item_cursor: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CodexSearchContextCursor {
    direction: ContextDirection,
    turn_cursor: Option<String>,
    pending_turns: Vec<PendingContextTurn>,
}

pub(super) fn parse_context_cursor(
    cursor: &str,
) -> Result<Option<CodexSearchContextCursor>, String> {
    cursor
        .strip_prefix(CONTEXT_CURSOR_PREFIX)
        .map(|encoded| {
            serde_json::from_str(encoded)
                .map_err(|error| format!("Invalid Codex search context cursor: {error}"))
        })
        .transpose()
}

fn context_cursor(
    direction: ContextDirection,
    turn_cursor: Option<String>,
    pending_turns: Vec<PendingContextTurn>,
) -> Result<Option<String>, String> {
    if turn_cursor.is_none() && pending_turns.is_empty() {
        return Ok(None);
    }
    serde_json::to_string(&CodexSearchContextCursor {
        direction,
        turn_cursor,
        pending_turns,
    })
    .map(|encoded| Some(format!("{CONTEXT_CURSOR_PREFIX}{encoded}")))
    .map_err(|error| format!("Cannot encode Codex search context cursor: {error}"))
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CodexSearchCursor {
    turn_id: String,
    item_id: String,
    turn_cursor: String,
    #[serde(default)]
    turn_offset: usize,
}

pub(super) fn parse_search_cursor(cursor: &str) -> Result<Option<CodexSearchCursor>, String> {
    cursor
        .strip_prefix(SEARCH_CURSOR_PREFIX)
        .map(|value| {
            serde_json::from_str(value)
                .map_err(|error| format!("invalid Codex transcript search cursor: {error}"))
        })
        .transpose()
}

fn search_cursor(cursor: &CodexSearchCursor) -> Result<String, String> {
    serde_json::to_string(cursor)
        .map(|value| format!("{SEARCH_CURSOR_PREFIX}{value}"))
        .map_err(|error| format!("failed to encode Codex transcript search cursor: {error}"))
}

pub(super) async fn search_codex_transcript(
    client: &CodexAppServerClient,
    thread_id: &str,
    query: &str,
    limit: usize,
    excluded_turn_ids: &HashSet<String>,
    user_content_by_client_id: &HashMap<String, String>,
) -> Result<Value, String> {
    if limit == 0 {
        return Ok(search_result(Vec::new(), true));
    }
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(json!({"success": true, "matches": [], "totalMatches": 0, "isCapped": false}));
    }
    let metadata = read_codex_thread_metadata(client, thread_id).await?;
    let thread = metadata
        .get("thread")
        .filter(|thread| thread.is_object())
        .ok_or_else(|| "thread/read returned invalid thread metadata".to_owned())?;
    if !super::codex_transcript_page::thread_uses_paginated_history(thread) {
        let path = string_field(thread, "path")
            .ok_or_else(|| "Legacy Codex thread metadata is missing rollout path".to_owned())?;
        return super::codex_legacy_search::search_legacy_transcript(
            path,
            query.to_owned(),
            limit,
            excluded_turn_ids.clone(),
            user_content_by_client_id.clone(),
        )
        .await;
    }
    search_paginated_codex_transcript(
        client,
        thread_id,
        query,
        limit,
        excluded_turn_ids,
        user_content_by_client_id,
    )
    .await
}

async fn search_paginated_codex_transcript(
    client: &CodexAppServerClient,
    thread_id: &str,
    query: &str,
    limit: usize,
    excluded_turn_ids: &HashSet<String>,
    user_content_by_client_id: &HashMap<String, String>,
) -> Result<Value, String> {
    let needle = query.trim().to_lowercase();
    let mut matches = Vec::new();
    let mut cursor = None;
    let mut seen_cursors = HashSet::new();
    loop {
        let page = context_turn_page(
            client,
            thread_id,
            cursor.as_deref(),
            SEARCH_PAGE_SIZE,
            ContextDirection::Asc,
        )
        .await?;
        let turns = page
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| "thread/turns/list returned a response without data".to_owned())?;
        let anchor = string_field(&page, "backwardsCursor");
        for (turn_offset, turn) in turns.iter().enumerate() {
            let turn_id = string_field(turn, "id")
                .ok_or_else(|| "Codex search turn is missing id".to_owned())?;
            if excluded_turn_ids.contains(&turn_id) {
                continue;
            }
            let anchor = anchor
                .as_ref()
                .ok_or_else(|| "Codex search turn page is missing its anchor".to_owned())?;
            let turn = load_search_turn_items(client, thread_id, turn.clone()).await?;
            let capped = search_turn_items(
                thread_id,
                &turn,
                CodexSearchCursor {
                    turn_id,
                    item_id: String::new(),
                    turn_cursor: anchor.clone(),
                    turn_offset,
                },
                &needle,
                limit,
                user_content_by_client_id,
                &mut matches,
            )?;
            if capped {
                return Ok(search_result(matches, true));
            }
        }
        let Some(next) = string_field(&page, "nextCursor") else {
            return Ok(search_result(matches, false));
        };
        if !seen_cursors.insert(next.clone()) || cursor.as_ref() == Some(&next) {
            return Err("Codex search returned a repeated turn cursor".to_owned());
        }
        cursor = Some(next);
    }
}

fn search_result(matches: Vec<Value>, is_capped: bool) -> Value {
    json!({
        "success": true,
        "totalMatches": matches.len(),
        "isCapped": is_capped,
        "matches": matches,
    })
}

async fn load_search_turn_items(
    client: &CodexAppServerClient,
    thread_id: &str,
    mut turn: Value,
) -> Result<Value, String> {
    let turn_id =
        string_field(&turn, "id").ok_or_else(|| "Codex search turn is missing id".to_owned())?;
    let mut items = Vec::new();
    let mut cursor = None;
    let mut seen_cursors = HashSet::new();
    loop {
        let page = client
            .request(
                "thread/items/list",
                json!({
                    "threadId": thread_id, "turnId": turn_id,
                    "cursor": cursor, "sortDirection": "asc", "limit": SEARCH_PAGE_SIZE,
                }),
            )
            .await?;
        items.extend(response_items(&page, &turn_id)?);
        let Some(next) = string_field(&page, "nextCursor") else {
            turn["items"] = json!(items);
            turn["itemsView"] = json!("full");
            return Ok(turn);
        };
        if !seen_cursors.insert(next.clone()) || cursor.as_ref() == Some(&next) {
            return Err("Codex search returned a repeated item cursor".to_owned());
        }
        cursor = Some(next);
    }
}

fn search_turn_items(
    thread_id: &str,
    turn: &Value,
    mut position: CodexSearchCursor,
    needle: &str,
    limit: usize,
    user_content_by_client_id: &HashMap<String, String>,
    matches: &mut Vec<Value>,
) -> Result<bool, String> {
    let provider_item_ids: HashSet<_> = turn
        .get("items")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| string_field(item, "id"))
        .collect();
    let user_message_ids: HashMap<_, _> = turn
        .get("items")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|item| item_type(item) == "usermessage")
        .filter_map(|item| {
            let id = string_field(item, "id")?;
            let message_id = string_field(item, "clientId")
                .or_else(|| string_field(item, "client_id"))
                .unwrap_or_else(|| id.clone());
            Some((id, message_id))
        })
        .collect();
    for (item_id, text) in
        codex_turn_search_sources(turn, user_content_by_client_id, Some(thread_id))
    {
        let text = text.to_lowercase();
        if !text.contains(needle) {
            continue;
        }
        if !provider_item_ids.contains(&item_id) {
            return Err("Codex search item is missing provider id".to_owned());
        }
        position.item_id = item_id;
        let anchor = search_cursor(&position)?;
        for (occurrence, _) in text.match_indices(needle).enumerate() {
            let mut matched = json!({
                "turnId": position.turn_id, "itemId": position.item_id,
                "occurrence": occurrence, "cursor": anchor,
            });
            if let Some(message_id) = user_message_ids.get(&position.item_id) {
                matched["messageId"] = json!(message_id);
            }
            matches.push(matched);
            if matches.len() >= limit {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

fn response_items(response: &Value, turn_id: &str) -> Result<Vec<Value>, String> {
    Ok(response_item_refs(response, turn_id)?
        .into_iter()
        .cloned()
        .collect())
}

fn response_item_refs<'a>(response: &'a Value, turn_id: &str) -> Result<Vec<&'a Value>, String> {
    response
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| "Codex item response is missing data".to_owned())?
        .iter()
        .map(|entry| {
            if string_field(entry, "turnId").as_deref() != Some(turn_id) {
                return Err("Codex item response contains an item from another turn".to_owned());
            }
            entry
                .get("item")
                .ok_or_else(|| "Codex item response is missing item".to_owned())
        })
        .collect()
}

pub(super) async fn load_search_match(
    client: &CodexAppServerClient,
    mut thread: Value,
    mut cursor: CodexSearchCursor,
) -> Result<CodexTranscriptPage, String> {
    let thread_id = string_field(&thread, "id")
        .ok_or_else(|| "Codex thread metadata is missing id".to_owned())?;
    cursor.turn_cursor = resolve_search_turn_cursor(client, &thread_id, &cursor).await?;
    let (older_turns, newer_turns) = tokio::try_join!(
        context_turn_page(
            client,
            &thread_id,
            Some(&cursor.turn_cursor),
            2,
            ContextDirection::Desc
        ),
        context_turn_page(
            client,
            &thread_id,
            Some(&cursor.turn_cursor),
            2,
            ContextDirection::Asc
        ),
    )?;
    let turn = older_turns
        .get("data")
        .and_then(Value::as_array)
        .and_then(|turns| {
            turns
                .iter()
                .find(|turn| string_field(turn, "id").as_deref() == Some(cursor.turn_id.as_str()))
        })
        .cloned()
        .ok_or_else(|| "Persisted conversation search turn is no longer available".to_owned())?;
    let center = load_match_turn(client, &thread_id, turn, &cursor).await?;
    let (older_context, newer_context) = tokio::try_join!(
        initial_context_side(
            client,
            &thread_id,
            &cursor.turn_id,
            &older_turns,
            ContextDirection::Desc
        ),
        initial_context_side(
            client,
            &thread_id,
            &cursor.turn_id,
            &newer_turns,
            ContextDirection::Asc
        ),
    )?;
    let mut turns = older_context.0;
    turns.push(center);
    turns.extend(newer_context.0);
    thread["turns"] = json!(turns);
    Ok(CodexTranscriptPage {
        thread,
        before_cursor: older_context.1,
        after_cursor: newer_context.1,
        prepend_item_turn_ids: HashSet::new(),
    })
}

async fn load_match_turn(
    client: &CodexAppServerClient,
    thread_id: &str,
    turn: Value,
    cursor: &CodexSearchCursor,
) -> Result<Value, String> {
    // Completed turns also need every fragment: truncation can change which
    // process blocks duplicate the joined final answer and become hidden.
    let center = load_search_turn_items(client, thread_id, turn).await?;
    if !center["items"].as_array().is_some_and(|items| {
        items
            .iter()
            .any(|item| string_field(item, "id").as_deref() == Some(cursor.item_id.as_str()))
    }) {
        return Err("Persisted conversation search item is no longer available".to_owned());
    }
    Ok(center)
}

async fn resolve_search_turn_cursor(
    client: &CodexAppServerClient,
    thread_id: &str,
    cursor: &CodexSearchCursor,
) -> Result<String, String> {
    if cursor.turn_offset == 0 {
        return Ok(cursor.turn_cursor.clone());
    }
    if cursor.turn_offset >= SEARCH_PAGE_SIZE {
        return Err("Invalid Codex search turn offset".to_owned());
    }
    let prefix = context_turn_page(
        client,
        thread_id,
        Some(&cursor.turn_cursor),
        cursor.turn_offset,
        ContextDirection::Asc,
    )
    .await?;
    if prefix.get("data").and_then(Value::as_array).map(Vec::len) != Some(cursor.turn_offset) {
        return Err("Persisted conversation search turn is no longer available".to_owned());
    }
    let after_prefix = string_field(&prefix, "nextCursor")
        .ok_or_else(|| "Persisted conversation search turn is no longer available".to_owned())?;
    let target = context_turn_page(
        client,
        thread_id,
        Some(&after_prefix),
        1,
        ContextDirection::Asc,
    )
    .await?;
    let turns = target.get("data").and_then(Value::as_array);
    if !turns.is_some_and(|turns| {
        turns.len() == 1
            && string_field(&turns[0], "id").as_deref() == Some(cursor.turn_id.as_str())
    }) {
        return Err("Persisted conversation search turn is no longer available".to_owned());
    }
    string_field(&target, "backwardsCursor")
        .ok_or_else(|| "Codex search turn page is missing its anchor".to_owned())
}

async fn context_turn_page(
    client: &CodexAppServerClient,
    thread_id: &str,
    cursor: Option<&str>,
    limit: usize,
    direction: ContextDirection,
) -> Result<Value, String> {
    client
        .request(
            "thread/turns/list",
            json!({
                "threadId":thread_id, "cursor":cursor, "limit":limit,
                "sortDirection":direction.as_str(), "itemsView":"notLoaded",
            }),
        )
        .await
}

async fn initial_context_side(
    client: &CodexAppServerClient,
    thread_id: &str,
    center_id: &str,
    turn_page: &Value,
    direction: ContextDirection,
) -> Result<(Vec<Value>, Option<String>), String> {
    let neighbor = turn_page
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|turn| string_field(turn, "id").as_deref() != Some(center_id))
        .cloned();
    let mut pending = Vec::new();
    let mut turns = Vec::new();
    if let Some(turn) = neighbor {
        let (turn, remaining) = load_context_turn(
            client,
            thread_id,
            PendingContextTurn {
                turn,
                item_cursor: None,
            },
            direction,
            SEARCH_ITEM_RADIUS,
        )
        .await?;
        turns.push(turn);
        pending.extend(remaining);
    }
    Ok((
        turns,
        context_cursor(direction, string_field(turn_page, "nextCursor"), pending)?,
    ))
}

async fn load_context_turn(
    client: &CodexAppServerClient,
    thread_id: &str,
    pending: PendingContextTurn,
    direction: ContextDirection,
    limit: usize,
) -> Result<(Value, Option<PendingContextTurn>), String> {
    let turn_id = string_field(&pending.turn, "id")
        .ok_or_else(|| "Codex search context turn is missing id".to_owned())?;
    let page = client
        .request(
            "thread/items/list",
            json!({
                "threadId":thread_id, "turnId":turn_id, "cursor":pending.item_cursor,
                "sortDirection":direction.as_str(), "limit":limit,
            }),
        )
        .await?;
    let next_cursor = string_field(&page, "nextCursor");
    if next_cursor.is_some() && next_cursor == pending.item_cursor {
        return Err("Codex search context returned an unchanged item cursor".to_owned());
    }
    let mut items = response_items(&page, &turn_id)?;
    if matches!(direction, ContextDirection::Desc) {
        items.reverse();
    }
    let mut turn = pending.turn.clone();
    turn["items"] = json!(items);
    turn["itemsView"] = json!(if pending.item_cursor.is_some() || next_cursor.is_some() {
        "summary"
    } else {
        "full"
    });
    let remaining = next_cursor.map(|item_cursor| PendingContextTurn {
        turn: pending.turn,
        item_cursor: Some(item_cursor),
    });
    Ok((turn, remaining))
}

pub(super) async fn load_context_page(
    client: &CodexAppServerClient,
    mut thread: Value,
    mut cursor: CodexSearchContextCursor,
    direction: CodexTranscriptDirection,
) -> Result<CodexTranscriptPage, String> {
    if !matches!(
        (cursor.direction, direction),
        (ContextDirection::Desc, CodexTranscriptDirection::Descending)
            | (ContextDirection::Asc, CodexTranscriptDirection::Ascending)
    ) {
        return Err("Codex search context cursor has the wrong direction".to_owned());
    }
    let thread_id = string_field(&thread, "id")
        .ok_or_else(|| "Codex thread metadata is missing id".to_owned())?;
    if cursor.pending_turns.is_empty() {
        let page = context_turn_page(
            client,
            &thread_id,
            cursor.turn_cursor.as_deref(),
            1,
            cursor.direction,
        )
        .await?;
        cursor.turn_cursor = string_field(&page, "nextCursor");
        cursor.pending_turns = page
            .get("data")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .cloned()
            .map(|turn| PendingContextTurn {
                turn,
                item_cursor: None,
            })
            .collect();
    }
    let mut turns = Vec::new();
    let mut prepend_item_turn_ids = HashSet::new();
    if !cursor.pending_turns.is_empty() {
        let pending = cursor.pending_turns.remove(0);
        let (turn, remaining) = load_context_turn(
            client,
            &thread_id,
            pending,
            cursor.direction,
            CONTEXT_ITEM_PAGE_SIZE,
        )
        .await?;
        if matches!(cursor.direction, ContextDirection::Desc) {
            prepend_item_turn_ids.extend(string_field(&turn, "id"));
        }
        turns.push(turn);
        if let Some(remaining) = remaining {
            cursor.pending_turns.insert(0, remaining);
        }
    }
    thread["turns"] = json!(turns);
    let next = context_cursor(cursor.direction, cursor.turn_cursor, cursor.pending_turns)?;
    let (before_cursor, after_cursor) = match cursor.direction {
        ContextDirection::Desc => (next, None),
        ContextDirection::Asc => (None, next),
    };
    Ok(CodexTranscriptPage {
        thread,
        before_cursor,
        after_cursor,
        prepend_item_turn_ids,
    })
}

#[cfg(all(test, unix))]
#[path = "codex_transcript_search/native_fixture.rs"]
mod native_fixture;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn visible_search_excludes_context_and_tool_output() {
        let turn = json!({"id":"turn-1", "status":"completed", "items":[
            {"id":"user", "type":"userMessage", "content":[{"type":"text", "text":
                "<application_context>hidden needle</application_context> Visible request"}]},
            {"id":"tool", "type":"commandExecution", "text":"needle"},
            {"id":"assistant", "type":"agentMessage", "text":"visible needle"},
        ]});
        assert_eq!(
            codex_turn_search_sources(&turn, &HashMap::new(), Some("thread-1")),
            [
                ("user".to_owned(), "Visible request".to_owned()),
                ("assistant".to_owned(), "visible needle".to_owned()),
            ],
        );
    }

    #[test]
    fn native_search_excludes_child_threads_and_preserves_root_occurrences() {
        let turn = json!({"id":"turn-1", "status":"completed", "items":[
            {"id":"child", "type":"agentMessage", "threadId":"child-thread", "text":"needle needle"},
            {"id":"root", "type":"agentMessage", "thread_id":"root-thread", "text":"needle needle"},
        ]});
        let mut matches = Vec::new();
        let capped = search_turn_items(
            "root-thread",
            &turn,
            CodexSearchCursor {
                turn_id: "turn-1".into(),
                item_id: String::new(),
                turn_cursor: "opaque-turn".into(),
                turn_offset: 0,
            },
            "needle",
            10,
            &HashMap::new(),
            &mut matches,
        )
        .unwrap();
        assert!(!capped);
        assert_eq!(matches.len(), 2);
        for (occurrence, matched) in matches.iter().enumerate() {
            assert_eq!(matched["itemId"], "root");
            assert_eq!(matched["occurrence"], occurrence);
            let cursor = parse_search_cursor(matched["cursor"].as_str().unwrap())
                .unwrap()
                .unwrap();
            assert_eq!(cursor.item_id, "root");
        }
    }

    #[test]
    fn native_search_rejects_matching_items_without_provider_ids() {
        for item_type in ["agentMessage", "userMessage"] {
            let turn = json!({"id":"turn-1", "status":"completed", "items":[
                {"type":item_type, "text":"needle"},
            ]});
            let mut matches = Vec::new();
            let error = search_turn_items(
                "root-thread",
                &turn,
                CodexSearchCursor {
                    turn_id: "turn-1".into(),
                    item_id: String::new(),
                    turn_cursor: "opaque-turn".into(),
                    turn_offset: 0,
                },
                "needle",
                10,
                &HashMap::new(),
                &mut matches,
            )
            .unwrap_err();
            assert_eq!(error, "Codex search item is missing provider id");
            assert!(matches.is_empty());
        }
    }

    #[test]
    fn search_cursor_preserves_native_turn_and_item_anchors() {
        let cursor = search_cursor(&CodexSearchCursor {
            turn_id: "turn-1".to_owned(),
            item_id: "item-1".to_owned(),
            turn_cursor: "opaque-turn".to_owned(),
            turn_offset: 3,
        })
        .unwrap();
        let parsed = parse_search_cursor(&cursor).unwrap().unwrap();
        assert_eq!(parsed.turn_id, "turn-1");
        assert_eq!(parsed.item_id, "item-1");
        assert_eq!(parsed.turn_cursor, "opaque-turn");
        assert_eq!(parsed.turn_offset, 3);
        let old = parse_search_cursor(
            "wework-codex-search:{\"turnId\":\"turn-1\",\"itemId\":\"item-1\",\"turnCursor\":\"opaque-turn\"}",
        )
        .unwrap()
        .unwrap();
        assert_eq!(old.turn_offset, 0);
        assert!(parse_search_cursor("offset:10").unwrap().is_none());
        assert!(parse_search_cursor("wework-codex-search:invalid").is_err());
    }
}
