// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::time::{sleep, Duration};

use crate::agents::CodexAppServerClient;

use super::util::string_field;

const CODEX_ITEM_PAGE_SIZE: usize = 100;
const CODEX_NAVIGATION_CURSOR_PREFIX: &str = "wework-codex-navigation:";
const CODEX_NAVIGATION_MAX_PAGES: usize = 10;
const CODEX_TRANSCRIPT_STARTUP_RETRY_ATTEMPTS: usize = 50;
const CODEX_TRANSCRIPT_STARTUP_RETRY_DELAY: Duration = Duration::from_millis(100);

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
}

#[derive(Clone)]
pub(crate) struct CodexTranscriptNavigationTurn {
    pub turn_id: String,
    pub cursor: Option<String>,
}

#[derive(Clone)]
pub(crate) struct CodexTranscriptNavigation {
    pub turns: Vec<CodexTranscriptNavigationTurn>,
    pub complete: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexNavigationCursor {
    page_backwards_cursor: String,
    descending_offset: usize,
}

pub(crate) async fn load_codex_transcript(
    client: &CodexAppServerClient,
    request: CodexTranscriptRequest<'_>,
) -> Result<CodexTranscriptPage, String> {
    let metadata_response = read_codex_thread_metadata(client, request.thread_id).await?;
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
    if thread_uses_paginated_history(&thread) {
        if request.direction != CodexTranscriptDirection::Descending {
            return Err("Native timeline history only supports backwards pagination".to_owned());
        }
        return super::codex_timeline::load_timeline_page(
            client,
            thread,
            request.thread_id,
            request.cursor,
            request.limit,
            request.full_content,
        )
        .await;
    }
    let navigation_cursor = request
        .cursor
        .map(parse_navigation_cursor)
        .transpose()?
        .flatten();
    let resolved_navigation_cursor = if let Some(cursor) = navigation_cursor.as_ref() {
        if request.direction != CodexTranscriptDirection::Descending {
            return Err("Codex navigation cursors only support descending pagination".to_owned());
        }
        Some(resolve_navigation_cursor(client, request.thread_id, cursor).await?)
    } else {
        None
    };
    let request_cursor = resolved_navigation_cursor.as_deref().or(request.cursor);
    let mut cursor = request_cursor.map(ToOwned::to_owned);
    let mut turns = Vec::new();
    let mut backwards_cursor = None;
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
            false,
        )
        .await?;
        if backwards_cursor.is_none() {
            backwards_cursor = string_field(&page, "backwardsCursor");
        }
        let page_turns = page
            .get("data")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        turns.extend(page_turns);

        let next_cursor = string_field(&page, "nextCursor");
        if !request.full_content || next_cursor.is_none() {
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
            return Ok(CodexTranscriptPage {
                thread,
                before_cursor,
                after_cursor,
            });
        }
        let next_cursor = next_cursor.expect("checked above");
        if !seen_cursors.insert(next_cursor.clone()) {
            return Err("thread/turns/list returned a repeated cursor".to_owned());
        }
        cursor = Some(next_cursor);
    }
}

pub(crate) async fn read_codex_thread_metadata(
    client: &CodexAppServerClient,
    thread_id: &str,
) -> Result<Value, String> {
    for attempt in 0..CODEX_TRANSCRIPT_STARTUP_RETRY_ATTEMPTS {
        match client
            .request(
                "thread/read",
                json!({"threadId": thread_id, "includeTurns": false}),
            )
            .await
        {
            Ok(response) => {
                if attempt > 0 {
                    eprintln!(
                        "Codex rollout metadata recovered after transcript startup retry: \
                         thread_id={thread_id} attempts={attempt}"
                    );
                }
                return Ok(response);
            }
            Err(error)
                if codex_thread_metadata_is_pending(&error)
                    && attempt + 1 < CODEX_TRANSCRIPT_STARTUP_RETRY_ATTEMPTS =>
            {
                eprintln!(
                    "Codex rollout metadata is not ready; retrying transcript startup: \
                     thread_id={thread_id} attempt={}",
                    attempt + 1
                );
                sleep(CODEX_TRANSCRIPT_STARTUP_RETRY_DELAY).await;
            }
            Err(error) => return Err(error),
        }
    }
    unreachable!("Codex thread metadata retry loop always returns")
}

fn codex_thread_metadata_is_pending(error: &str) -> bool {
    let normalized = error.to_ascii_lowercase();
    normalized.contains("failed to read session metadata")
        && normalized.contains("rollout")
        && normalized.contains("is empty")
}

pub(crate) async fn load_codex_transcript_navigation(
    client: &CodexAppServerClient,
    thread: &Value,
    thread_id: &str,
    prefer_rollout_history: bool,
) -> Result<CodexTranscriptNavigation, String> {
    if prefer_rollout_history {
        if let Some(path) = string_field(thread, "path") {
            if let Some(turns) = read_rollout_turns(path).await? {
                let mut navigation_turns = Vec::with_capacity(turns.len());
                for (index, turn) in turns.into_iter().enumerate() {
                    let turn_id = string_field(&turn, "id").ok_or_else(|| {
                        "canonical Codex rollout returned a turn without id".to_owned()
                    })?;
                    navigation_turns.push(CodexTranscriptNavigationTurn {
                        turn_id,
                        cursor: Some(rollout_cursor(index + 1)),
                    });
                }
                return Ok(CodexTranscriptNavigation {
                    turns: navigation_turns,
                    complete: true,
                });
            }
        }
    }

    let mut cursor = None;
    let mut turns = Vec::new();
    let mut seen_cursors = HashSet::new();
    for _ in 0..CODEX_NAVIGATION_MAX_PAGES {
        let page = request_codex_turn_page(
            client,
            json!({
                "threadId": thread_id,
                "cursor": cursor,
                "limit": CODEX_ITEM_PAGE_SIZE,
                "sortDirection": "desc",
                "itemsView": "notLoaded",
            }),
        )
        .await?;
        let page_backwards_cursor = string_field(&page, "backwardsCursor");
        let page_turns = page
            .get("data")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for (descending_offset, turn) in page_turns.into_iter().enumerate() {
            let turn_id = string_field(&turn, "id").ok_or_else(|| {
                "thread/turns/list returned a navigation turn without id".to_owned()
            })?;
            turns.push(CodexTranscriptNavigationTurn {
                turn_id: turn_id.clone(),
                cursor: if thread_uses_paginated_history(thread) {
                    Some(super::codex_timeline::turn_cursor(&turn_id))
                } else {
                    page_backwards_cursor
                        .as_ref()
                        .map(|page_cursor| navigation_cursor(page_cursor, descending_offset))
                },
            });
        }
        let Some(next_cursor) = string_field(&page, "nextCursor") else {
            turns.reverse();
            return Ok(CodexTranscriptNavigation {
                turns,
                complete: true,
            });
        };
        if !seen_cursors.insert(next_cursor.clone()) {
            return Err("thread/turns/list returned a repeated navigation cursor".to_owned());
        }
        cursor = Some(next_cursor);
    }
    Ok(CodexTranscriptNavigation {
        turns: Vec::new(),
        complete: false,
    })
}

fn navigation_cursor(page_backwards_cursor: &str, descending_offset: usize) -> String {
    serde_json::to_string(&CodexNavigationCursor {
        page_backwards_cursor: page_backwards_cursor.to_owned(),
        descending_offset,
    })
    .map(|encoded| format!("{CODEX_NAVIGATION_CURSOR_PREFIX}{encoded}"))
    .expect("Codex navigation cursor should always serialize")
}

fn parse_navigation_cursor(cursor: &str) -> Result<Option<CodexNavigationCursor>, String> {
    let Some(encoded) = cursor.strip_prefix(CODEX_NAVIGATION_CURSOR_PREFIX) else {
        return Ok(None);
    };
    serde_json::from_str(encoded)
        .map(Some)
        .map_err(|error| format!("invalid Codex navigation cursor: {error}"))
}

async fn resolve_navigation_cursor(
    client: &CodexAppServerClient,
    thread_id: &str,
    cursor: &CodexNavigationCursor,
) -> Result<String, String> {
    if cursor.descending_offset == 0 {
        return Ok(cursor.page_backwards_cursor.clone());
    }
    let page = request_codex_turn_page(
        client,
        json!({
            "threadId": thread_id,
            "cursor": cursor.page_backwards_cursor,
            "limit": cursor.descending_offset,
            "sortDirection": "desc",
            "itemsView": "notLoaded",
        }),
    )
    .await?;
    string_field(&page, "nextCursor")
        .ok_or_else(|| "Codex navigation cursor did not resolve to the requested turn".to_owned())
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
    let Some(mut turns) = read_rollout_turns(path).await? else {
        return Ok(None);
    };
    if request.full_content {
        let mut thread = metadata.clone();
        thread["turns"] = Value::Array(turns);
        return Ok(Some(CodexTranscriptPage {
            thread,
            before_cursor: None,
            after_cursor: None,
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
    }))
}

async fn read_rollout_turns(path: String) -> Result<Option<Vec<Value>>, String> {
    tokio::task::spawn_blocking(move || {
        let file = match std::fs::File::open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(format!(
                    "failed to read canonical Codex rollout {path}: {error}"
                ))
            }
        };
        rollout_turns_reader(BufReader::new(file)).map(Some)
    })
    .await
    .map_err(|error| format!("Codex rollout reader failed: {error}"))?
}

#[cfg(test)]
fn rollout_turns(text: &str) -> Result<Vec<Value>, String> {
    rollout_turns_reader(std::io::Cursor::new(text))
}

fn rollout_turns_reader(mut reader: impl BufRead) -> Result<Vec<Value>, String> {
    let mut turns = Vec::<Value>::new();
    let mut turn_indexes = HashMap::<String, usize>::new();
    let mut line = String::new();
    loop {
        line.clear();
        if reader
            .read_line(&mut line)
            .map_err(|error| format!("failed to read Codex rollout: {error}"))?
            == 0
        {
            break;
        }
        if line.trim().is_empty() {
            continue;
        }
        let mut value: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(error)
                if !line.ends_with('\n')
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
        let Some(payload) = value.get_mut("payload") else {
            continue;
        };
        let event_type = string_field(payload, "type").unwrap_or_default();
        let Some(turn_id) =
            string_field(payload, "turn_id").or_else(|| string_field(payload, "turnId"))
        else {
            continue;
        };
        let turn_index = *turn_indexes.entry(turn_id.clone()).or_insert_with(|| {
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
                if let Some(item) = payload.get_mut("item").map(Value::take) {
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
    request_codex_turn_page(
        client,
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

async fn request_codex_turn_page(
    client: &CodexAppServerClient,
    params: Value,
) -> Result<Value, String> {
    for attempt in 0..CODEX_TRANSCRIPT_STARTUP_RETRY_ATTEMPTS {
        match client.request("thread/turns/list", params.clone()).await {
            Ok(response) => return Ok(response),
            Err(error)
                if codex_turn_history_is_pending(&error)
                    && attempt + 1 < CODEX_TRANSCRIPT_STARTUP_RETRY_ATTEMPTS =>
            {
                sleep(CODEX_TRANSCRIPT_STARTUP_RETRY_DELAY).await;
            }
            Err(error) => return Err(error),
        }
    }
    unreachable!("Codex turn history retry loop always returns")
}

fn codex_turn_history_is_pending(error: &str) -> bool {
    error
        .to_ascii_lowercase()
        .contains("list_turns is not supported yet")
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

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        codex_thread_metadata_is_pending, codex_turn_history_is_pending, rollout_turns,
        thread_uses_paginated_history, turn_items_view,
    };

    #[test]
    fn retries_only_transient_codex_transcript_startup_errors() {
        assert!(codex_thread_metadata_is_pending(
            "failed to read thread: thread-store internal error: failed to read session metadata \
             /tmp/rollout.jsonl: rollout at /tmp/rollout.jsonl is empty"
        ));
        assert!(!codex_thread_metadata_is_pending(
            "failed to read thread: thread not found"
        ));
        assert!(!codex_thread_metadata_is_pending(
            "failed to read session metadata /tmp/rollout.jsonl: permission denied"
        ));
        assert!(codex_turn_history_is_pending(
            "list_turns is not supported yet"
        ));
        assert!(!codex_turn_history_is_pending(
            "thread/turns/list returned a repeated cursor"
        ));
    }

    #[tokio::test]
    async fn full_rollout_export_includes_more_than_five_hundred_turns() {
        use super::*;
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("history.jsonl");
        let lines = (0..503)
            .map(|index| {
                json!({
            "type":"event_msg", "payload": {
                "type":"item_completed", "turn_id":format!("turn-{index}"),
                "item":{"id":format!("item-{index}"), "type":"agentMessage", "text":"complete"}
            }
        }).to_string()
            })
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(&path, lines).unwrap();
        let metadata = json!({"path":path.to_string_lossy()});
        let mut request = CodexTranscriptRequest {
            thread_id: "thread",
            cursor: None,
            limit: 5,
            direction: CodexTranscriptDirection::Descending,
            full_content: true,
            prefer_rollout_history: true,
        };
        let full = load_rollout_transcript_page(&metadata, &request)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(full.thread["turns"].as_array().unwrap().len(), 503);
        assert_eq!(full.thread["turns"][0]["id"], "turn-0");
        request.full_content = false;
        let tail = load_rollout_transcript_page(&metadata, &request)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(tail.thread["turns"].as_array().unwrap().len(), 5);
        assert_eq!(tail.thread["turns"][0]["id"], "turn-498");
        assert_eq!(tail.before_cursor.as_deref(), Some("wework-rollout:498"));
        request.cursor = tail.before_cursor.as_deref();
        let older = load_rollout_transcript_page(&metadata, &request)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(older.thread["turns"][4]["id"], "turn-497");
    }

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
