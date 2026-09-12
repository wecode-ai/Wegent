// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::collections::HashSet;
use std::path::Path;

use futures_util::{stream, TryStreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::agents::CodexAppServerClient;

use super::util::string_field;

const CODEX_ITEM_PAGE_SIZE: usize = 100;
const CODEX_ITEM_LOAD_CONCURRENCY: usize = 5;
const CODEX_INITIAL_ITEM_BUDGET_PAGES: usize = 5;
const CODEX_FULL_TRANSCRIPT_MAX_TURNS: usize = 500;
const CODEX_INCREMENTAL_CURSOR_PREFIX: &str = "wework-codex-items:";

#[derive(Clone, Copy, Eq, PartialEq)]
pub(crate) enum CodexTranscriptDirection {
    Ascending,
    Descending,
}

impl CodexTranscriptDirection {
    fn as_str(self) -> &'static str {
        match self {
            Self::Ascending => "asc",
            Self::Descending => "desc",
        }
    }
}

pub(crate) struct CodexTranscriptRequest<'a> {
    pub thread_id: &'a str,
    pub cursor: Option<&'a str>,
    pub limit: usize,
    pub direction: CodexTranscriptDirection,
    pub full_content: bool,
    pub prefer_rollout_history: bool,
}

pub(crate) struct CodexTranscriptPage {
    pub thread: Value,
    pub before_cursor: Option<String>,
    pub after_cursor: Option<String>,
    pub prepend_item_turn_ids: HashSet<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexIncrementalCursor {
    turn_cursor: Option<String>,
    pending_turns: Vec<CodexTurnItemCursor>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexTurnItemCursor {
    turn: Value,
    cursor: Option<String>,
    started: bool,
}

pub(crate) async fn load_codex_transcript(
    client: &CodexAppServerClient,
    request: CodexTranscriptRequest<'_>,
) -> Result<CodexTranscriptPage, String> {
    let metadata_response = client
        .request(
            "thread/read",
            json!({"threadId": request.thread_id, "includeTurns": false}),
        )
        .await?;
    let mut thread = metadata_response
        .get("thread")
        .cloned()
        .ok_or_else(|| "thread/read returned a response without thread".to_owned())?;
    if !thread.is_object() {
        return Err("thread/read returned a non-object thread".to_owned());
    }
    if request.prefer_rollout_history {
        if let Some(page) = load_rollout_transcript_page(&thread, &request).await? {
            return Ok(page);
        }
    }
    let paginated_history = thread_uses_paginated_history(&thread);
    let incremental_cursor = if paginated_history
        && !request.full_content
        && request.direction == CodexTranscriptDirection::Descending
    {
        request
            .cursor
            .map(parse_incremental_cursor)
            .transpose()?
            .flatten()
    } else {
        None
    };
    if let Some(cursor) = incremental_cursor
        .as_ref()
        .filter(|cursor| !cursor.pending_turns.is_empty())
    {
        return load_incremental_item_page(client, thread, request.thread_id, cursor).await;
    }
    let mut cursor = incremental_cursor
        .as_ref()
        .and_then(|cursor| cursor.turn_cursor.clone())
        .or_else(|| request.cursor.map(ToOwned::to_owned));
    let mut turns = Vec::new();
    let mut backwards_cursor = None;
    let mut pending_turns = Vec::new();
    let mut seen_cursors = HashSet::new();
    if let Some(cursor) = cursor.as_ref() {
        seen_cursors.insert(cursor.clone());
    }

    loop {
        let page = load_turn_page(
            client,
            request.thread_id,
            cursor.as_deref(),
            request.limit,
            request.direction,
            paginated_history,
        )
        .await?;
        if backwards_cursor.is_none() {
            backwards_cursor = string_field(&page, "backwardsCursor");
        }
        let mut page_turns = page
            .get("data")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if paginated_history && request.full_content {
            page_turns = load_full_turn_items(client, request.thread_id, page_turns).await?;
        } else if paginated_history {
            let hydrated =
                load_initial_turn_items(client, request.thread_id, page_turns, request.limit)
                    .await?;
            page_turns = hydrated.turns;
            pending_turns.extend(hydrated.pending_turns);
        }
        turns.extend(page_turns);

        let next_cursor = string_field(&page, "nextCursor");
        let reached_full_content_limit =
            request.full_content && turns.len() >= CODEX_FULL_TRANSCRIPT_MAX_TURNS;
        if !request.full_content || next_cursor.is_none() || reached_full_content_limit {
            if reached_full_content_limit && next_cursor.is_some() {
                turns.truncate(CODEX_FULL_TRANSCRIPT_MAX_TURNS);
                eprintln!(
                    "Codex transcript {thread_id} truncated at {max_turns} turns",
                    thread_id = request.thread_id,
                    max_turns = CODEX_FULL_TRANSCRIPT_MAX_TURNS,
                );
            }
            if request.direction == CodexTranscriptDirection::Descending {
                turns.reverse();
            }
            thread["turns"] = Value::Array(turns);
            let (before_cursor, after_cursor) =
                if request.direction == CodexTranscriptDirection::Descending {
                    (next_cursor, backwards_cursor)
                } else {
                    (backwards_cursor, next_cursor)
                };
            let before_cursor = if request.full_content {
                before_cursor
            } else {
                incremental_before_cursor(before_cursor, pending_turns)?
            };
            return Ok(CodexTranscriptPage {
                thread,
                before_cursor,
                after_cursor,
                prepend_item_turn_ids: HashSet::new(),
            });
        }
        let next_cursor = next_cursor.expect("checked above");
        if !seen_cursors.insert(next_cursor.clone()) {
            return Err("thread/turns/list returned a repeated cursor".to_owned());
        }
        cursor = Some(next_cursor);
    }
}

const ROLLOUT_CURSOR_PREFIX: &str = "wework-rollout:";

async fn load_rollout_transcript_page(
    metadata: &Value,
    request: &CodexTranscriptRequest<'_>,
) -> Result<Option<CodexTranscriptPage>, String> {
    if request
        .cursor
        .is_some_and(|cursor| !cursor.starts_with(ROLLOUT_CURSOR_PREFIX))
    {
        return Ok(None);
    }
    let Some(path) = string_field(metadata, "path") else {
        return Ok(None);
    };
    let text = match tokio::fs::read_to_string(Path::new(&path)).await {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "failed to read canonical Codex rollout {}: {error}",
                Path::new(&path).display()
            ));
        }
    };
    let mut turns = rollout_turns(&text)?;
    if request.full_content {
        if turns.len() > CODEX_FULL_TRANSCRIPT_MAX_TURNS {
            turns.drain(..turns.len() - CODEX_FULL_TRANSCRIPT_MAX_TURNS);
        }
        let mut thread = metadata.clone();
        thread["turns"] = Value::Array(turns);
        return Ok(Some(CodexTranscriptPage {
            thread,
            before_cursor: None,
            after_cursor: None,
            prepend_item_turn_ids: HashSet::new(),
        }));
    }

    let turn_count = turns.len();
    let cursor = request
        .cursor
        .map(parse_rollout_cursor)
        .transpose()?
        .unwrap_or(match request.direction {
            CodexTranscriptDirection::Ascending => 0,
            CodexTranscriptDirection::Descending => turn_count,
        })
        .min(turn_count);
    let (start, end) = match request.direction {
        CodexTranscriptDirection::Ascending => {
            (cursor, cursor.saturating_add(request.limit).min(turn_count))
        }
        CodexTranscriptDirection::Descending => (cursor.saturating_sub(request.limit), cursor),
    };
    let page_turns = turns.drain(start..end).collect();
    let before_cursor = (start > 0).then(|| rollout_cursor(start));
    let after_cursor = (end < turn_count).then(|| rollout_cursor(end));
    let mut thread = metadata.clone();
    thread["turns"] = Value::Array(page_turns);
    Ok(Some(CodexTranscriptPage {
        thread,
        before_cursor,
        after_cursor,
        prepend_item_turn_ids: HashSet::new(),
    }))
}

fn rollout_turns(text: &str) -> Result<Vec<Value>, String> {
    let mut turns = Vec::<Value>::new();
    let lines = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect::<Vec<_>>();
    for (index, line) in lines.iter().enumerate() {
        let value: Value = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(error)
                if index + 1 == lines.len()
                    && !text.ends_with('\n')
                    && error.classify() == serde_json::error::Category::Eof =>
            {
                break;
            }
            Err(error) => {
                return Err(format!("canonical Codex rollout is invalid JSONL: {error}"));
            }
        };
        if string_field(&value, "type").as_deref() != Some("event_msg") {
            continue;
        }
        let Some(payload) = value.get("payload") else {
            continue;
        };
        let event_type = string_field(payload, "type").unwrap_or_default();
        let Some(turn_id) =
            string_field(payload, "turn_id").or_else(|| string_field(payload, "turnId"))
        else {
            continue;
        };
        let turn_index = turns
            .iter()
            .position(|turn| string_field(turn, "id").as_deref() == Some(turn_id.as_str()))
            .unwrap_or_else(|| {
                turns.push(json!({
                    "id": turn_id,
                    "items": [],
                    "itemsView": "full",
                    "status": "inProgress",
                }));
                turns.len() - 1
            });
        let turn = &mut turns[turn_index];
        match event_type.as_str() {
            "task_started" | "turn_started" => {
                if let Some(started_at) = payload.get("started_at").and_then(Value::as_i64) {
                    turn["startedAt"] = json!(started_at.saturating_mul(1_000));
                }
            }
            "item_completed" => {
                if let Some(item) = payload.get("item").cloned() {
                    turn["items"]
                        .as_array_mut()
                        .expect("rollout turn items must be an array")
                        .push(item);
                }
            }
            "task_complete" | "turn_complete" => {
                turn["status"] = Value::String("completed".to_owned());
                if let Some(completed_at) = payload.get("completed_at").and_then(Value::as_i64) {
                    turn["completedAt"] = json!(completed_at.saturating_mul(1_000));
                }
                if let Some(duration_ms) = payload.get("duration_ms").and_then(Value::as_i64) {
                    turn["durationMs"] = json!(duration_ms);
                }
            }
            "turn_aborted" => {
                turn["status"] = Value::String("interrupted".to_owned());
            }
            _ => {}
        }
    }
    turns.retain(|turn| {
        turn.get("items")
            .and_then(Value::as_array)
            .is_some_and(|items| !items.is_empty())
    });
    Ok(turns)
}

fn parse_rollout_cursor(cursor: &str) -> Result<usize, String> {
    cursor
        .strip_prefix(ROLLOUT_CURSOR_PREFIX)
        .and_then(|value| value.parse::<usize>().ok())
        .ok_or_else(|| "invalid canonical rollout cursor".to_owned())
}

fn rollout_cursor(index: usize) -> String {
    format!("{ROLLOUT_CURSOR_PREFIX}{index}")
}

async fn load_turn_page(
    client: &CodexAppServerClient,
    thread_id: &str,
    cursor: Option<&str>,
    limit: usize,
    direction: CodexTranscriptDirection,
    paginated_history: bool,
) -> Result<Value, String> {
    client
        .request(
            "thread/turns/list",
            json!({
                "threadId": thread_id,
                "cursor": cursor,
                "limit": limit,
                "sortDirection": direction.as_str(),
                "itemsView": turn_items_view(paginated_history),
            }),
        )
        .await
}

fn thread_uses_paginated_history(thread: &Value) -> bool {
    string_field(thread, "historyMode").as_deref() == Some("paginated")
}

fn turn_items_view(paginated_history: bool) -> &'static str {
    if paginated_history {
        "notLoaded"
    } else {
        "full"
    }
}

struct InitialTurnItems {
    turns: Vec<Value>,
    pending_turns: Vec<CodexTurnItemCursor>,
}

async fn load_initial_turn_items(
    client: &CodexAppServerClient,
    thread_id: &str,
    turns: Vec<Value>,
    turn_limit: usize,
) -> Result<InitialTurnItems, String> {
    let mut remaining_items = turn_limit
        .min(CODEX_INITIAL_ITEM_BUDGET_PAGES)
        .saturating_mul(CODEX_ITEM_PAGE_SIZE);
    let mut page_turns = Vec::with_capacity(turns.len());
    let mut pending_turns = Vec::new();
    for turn in turns {
        let metadata = turn_metadata(&turn);
        let turn_id = string_field(&turn, "id")
            .ok_or_else(|| "thread/turns/list returned a turn without id".to_owned())?;
        let mut items = Vec::new();
        let mut cursor: Option<String> = None;
        let mut started = false;
        let mut seen_cursors = HashSet::new();
        let mut seen_item_ids = HashSet::new();
        while (!started || cursor.is_some()) && remaining_items > 0 {
            if let Some(cursor) = cursor.as_ref() {
                if !seen_cursors.insert(cursor.clone()) {
                    return Err(format!(
                        "thread/items/list returned a repeated cursor for turn {turn_id}"
                    ));
                }
            }
            started = true;
            let page = load_turn_item_page(
                client,
                thread_id,
                &turn_id,
                cursor.as_deref(),
                remaining_items.min(CODEX_ITEM_PAGE_SIZE),
            )
            .await?;
            let page_items = turn_items_from_page(&page, &turn_id)?
                .into_iter()
                .filter(|item| {
                    string_field(item, "id")
                        .map(|item_id| seen_item_ids.insert(item_id))
                        .unwrap_or(true)
                })
                .collect::<Vec<_>>();
            remaining_items = remaining_items.saturating_sub(page_items.len());
            items.splice(0..0, page_items);
            let next_cursor = string_field(&page, "nextCursor");
            if next_cursor.is_some() && next_cursor == cursor {
                return Err(format!(
                    "thread/items/list returned an unchanged cursor for turn {turn_id}"
                ));
            }
            cursor = next_cursor;
        }

        let mut turn = turn;
        turn["items"] = Value::Array(items);
        turn["itemsView"] = Value::String(
            if started && cursor.is_none() {
                "full"
            } else {
                "summary"
            }
            .to_owned(),
        );
        let pending = (!started || cursor.is_some()).then_some(CodexTurnItemCursor {
            turn: metadata,
            cursor,
            started,
        });
        page_turns.push(turn);
        if let Some(pending) = pending {
            pending_turns.push(pending);
        }
    }
    Ok(InitialTurnItems {
        turns: page_turns,
        pending_turns,
    })
}

async fn load_incremental_item_page(
    client: &CodexAppServerClient,
    mut thread: Value,
    thread_id: &str,
    cursor: &CodexIncrementalCursor,
) -> Result<CodexTranscriptPage, String> {
    let mut pending_turns = cursor.pending_turns.clone();
    let mut pending = pending_turns.remove(0);
    let turn_id = string_field(&pending.turn, "id")
        .ok_or_else(|| "Codex item cursor contains a turn without id".to_owned())?;
    let page = load_turn_item_page(
        client,
        thread_id,
        &turn_id,
        pending.cursor.as_deref(),
        CODEX_ITEM_PAGE_SIZE,
    )
    .await?;
    let next_cursor = string_field(&page, "nextCursor");
    if pending.started && next_cursor == pending.cursor {
        return Err(format!(
            "thread/items/list returned an unchanged cursor for turn {turn_id}"
        ));
    }
    let items = turn_items_from_page(&page, &turn_id)?;
    let mut turn = pending.turn.clone();
    turn["items"] = Value::Array(items);
    turn["itemsView"] = Value::String(
        if next_cursor.is_some() {
            "summary"
        } else {
            "full"
        }
        .to_owned(),
    );
    if let Some(next_cursor) = next_cursor {
        pending.cursor = Some(next_cursor);
        pending.started = true;
        pending_turns.insert(0, pending);
    }
    thread["turns"] = Value::Array(vec![turn]);
    let before_cursor = incremental_before_cursor(cursor.turn_cursor.clone(), pending_turns)?;
    Ok(CodexTranscriptPage {
        thread,
        before_cursor,
        after_cursor: None,
        prepend_item_turn_ids: HashSet::from([turn_id]),
    })
}

fn turn_metadata(turn: &Value) -> Value {
    let mut metadata = turn.clone();
    if let Some(object) = metadata.as_object_mut() {
        object.insert("items".to_owned(), Value::Array(Vec::new()));
        object.insert(
            "itemsView".to_owned(),
            Value::String("notLoaded".to_owned()),
        );
    }
    metadata
}

async fn load_turn_item_page(
    client: &CodexAppServerClient,
    thread_id: &str,
    turn_id: &str,
    cursor: Option<&str>,
    limit: usize,
) -> Result<Value, String> {
    client
        .request(
            "thread/items/list",
            json!({
                "threadId": thread_id,
                "turnId": turn_id,
                "cursor": cursor,
                "limit": limit,
                "sortDirection": "desc",
            }),
        )
        .await
}

fn turn_items_from_page(page: &Value, turn_id: &str) -> Result<Vec<Value>, String> {
    let mut items = Vec::new();
    for entry in page
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if string_field(entry, "turnId").as_deref() != Some(turn_id) {
            return Err(format!(
                "thread/items/list returned an item for a different turn than {turn_id}"
            ));
        }
        let item = entry
            .get("item")
            .cloned()
            .ok_or_else(|| "thread/items/list returned an entry without item".to_owned())?;
        items.push(item);
    }
    items.reverse();
    Ok(items)
}

fn incremental_before_cursor(
    turn_cursor: Option<String>,
    pending_turns: Vec<CodexTurnItemCursor>,
) -> Result<Option<String>, String> {
    if pending_turns.is_empty() {
        return Ok(turn_cursor);
    }
    let state = CodexIncrementalCursor {
        turn_cursor,
        pending_turns,
    };
    serde_json::to_string(&state)
        .map(|encoded| Some(format!("{CODEX_INCREMENTAL_CURSOR_PREFIX}{encoded}")))
        .map_err(|error| format!("failed to encode Codex transcript cursor: {error}"))
}

fn parse_incremental_cursor(cursor: &str) -> Result<Option<CodexIncrementalCursor>, String> {
    let Some(encoded) = cursor.strip_prefix(CODEX_INCREMENTAL_CURSOR_PREFIX) else {
        return Ok(None);
    };
    serde_json::from_str(encoded)
        .map(Some)
        .map_err(|error| format!("invalid Codex transcript item cursor: {error}"))
}

async fn load_full_turn_items(
    client: &CodexAppServerClient,
    thread_id: &str,
    turns: Vec<Value>,
) -> Result<Vec<Value>, String> {
    stream::iter(turns.into_iter().map(|turn| {
        let client = client.clone();
        Ok::<_, String>(async move {
            let turn_id = string_field(&turn, "id")
                .ok_or_else(|| "thread/turns/list returned a turn without id".to_owned())?;
            let items = load_turn_items(&client, thread_id, &turn_id).await?;
            let mut turn = turn;
            turn["items"] = Value::Array(items);
            turn["itemsView"] = Value::String("full".to_owned());
            Ok::<Value, String>(turn)
        })
    }))
    .try_buffered(CODEX_ITEM_LOAD_CONCURRENCY)
    .try_collect()
    .await
}

async fn load_turn_items(
    client: &CodexAppServerClient,
    thread_id: &str,
    turn_id: &str,
) -> Result<Vec<Value>, String> {
    let mut items = Vec::new();
    let mut cursor = None;
    let mut seen_cursors = HashSet::new();

    loop {
        let response = client
            .request(
                "thread/items/list",
                json!({
                    "threadId": thread_id,
                    "turnId": turn_id,
                    "cursor": cursor,
                    "limit": CODEX_ITEM_PAGE_SIZE,
                    "sortDirection": "asc",
                }),
            )
            .await?;
        for entry in response
            .get("data")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if string_field(entry, "turnId").as_deref() != Some(turn_id) {
                return Err(format!(
                    "thread/items/list returned an item for a different turn than {turn_id}"
                ));
            }
            let item = entry
                .get("item")
                .cloned()
                .ok_or_else(|| "thread/items/list returned an entry without item".to_owned())?;
            items.push(item);
        }

        let next_cursor = string_field(&response, "nextCursor");
        let Some(next_cursor) = next_cursor else {
            return Ok(items);
        };
        if !seen_cursors.insert(next_cursor.clone()) {
            return Err(format!(
                "thread/items/list returned a repeated cursor for turn {turn_id}"
            ));
        }
        cursor = Some(next_cursor);
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{rollout_turns, thread_uses_paginated_history, turn_items_view};

    #[test]
    fn detects_paginated_thread_history() {
        assert!(thread_uses_paginated_history(
            &json!({"historyMode": "paginated"})
        ));
    }

    #[test]
    fn treats_legacy_and_missing_history_modes_as_non_paginated() {
        assert!(!thread_uses_paginated_history(
            &json!({"historyMode": "legacy"})
        ));
        assert!(!thread_uses_paginated_history(&json!({})));
    }

    #[test]
    fn requests_unloaded_items_for_paginated_history() {
        assert_eq!(turn_items_view(true), "notLoaded");
        assert_eq!(turn_items_view(false), "full");
    }

    #[test]
    fn rebuilds_paginated_turns_from_canonical_rollout_events() {
        let text = [
            json!({
                "type": "event_msg",
                "payload": {
                    "type": "task_started",
                    "turn_id": "turn-1",
                    "started_at": 10,
                }
            }),
            json!({
                "type": "event_msg",
                "payload": {
                    "type": "item_completed",
                    "turn_id": "turn-1",
                    "item": {"id": "user-1", "type": "UserMessage", "content": []},
                }
            }),
            json!({
                "type": "event_msg",
                "payload": {
                    "type": "item_completed",
                    "turn_id": "turn-1",
                    "item": {"id": "agent-1", "type": "AgentMessage", "content": []},
                }
            }),
            json!({
                "type": "event_msg",
                "payload": {
                    "type": "task_complete",
                    "turn_id": "turn-1",
                    "completed_at": 12,
                    "duration_ms": 2_000,
                }
            }),
        ]
        .into_iter()
        .map(|value| value.to_string())
        .collect::<Vec<_>>()
        .join("\n");

        let turns = rollout_turns(&text).expect("rollout should rebuild");

        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0]["id"], "turn-1");
        assert_eq!(turns[0]["status"], "completed");
        assert_eq!(turns[0]["startedAt"], 10_000);
        assert_eq!(turns[0]["completedAt"], 12_000);
        assert_eq!(turns[0]["durationMs"], 2_000);
        assert_eq!(turns[0]["items"].as_array().map(Vec::len), Some(2));
    }

    #[test]
    fn ignores_only_an_unterminated_partial_final_rollout_record() {
        let complete = json!({
            "type": "event_msg",
            "payload": {
                "type": "item_completed",
                "turn_id": "turn-1",
                "item": {"id": "user-1", "type": "UserMessage"},
            },
        })
        .to_string();
        let turns = rollout_turns(&format!("{complete}\n{{\"type\":\"event_msg\""))
            .expect("partial final writes should not hide completed records");

        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0]["id"], "turn-1");
        assert!(rollout_turns(&format!(
            "{complete}\n{{\"type\":\"event_msg\"\n{complete}\n"
        ))
        .is_err());
        assert!(rollout_turns(&format!("{complete}\nnot-json")).is_err());
    }
}
