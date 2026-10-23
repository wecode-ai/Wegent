// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::agents::CodexAppServerClient;

use super::codex_transcript_page::CodexTranscriptPage;
use super::util::string_field;

const TURN_CURSOR_PREFIX: &str = "wework-codex-turn:";

pub(super) fn turn_cursor(turn_id: &str) -> String {
    format!("{TURN_CURSOR_PREFIX}{turn_id}")
}

pub(super) const CURSOR_PREFIX: &str = "wework-codex-timeline:";

#[derive(Deserialize, Serialize)]
struct TimelineCursor {
    cursor: String,
    // A page can cut through a turn, before its completion boundary.
    turns: Vec<Value>,
}

pub(super) async fn load_timeline_page(
    client: &CodexAppServerClient,
    mut thread: Value,
    thread_id: &str,
    cursor: Option<&str>,
    limit: usize,
    full_content: bool,
) -> Result<CodexTranscriptPage, String> {
    let target = cursor.and_then(|cursor| cursor.strip_prefix(TURN_CURSOR_PREFIX));
    let previous: Option<TimelineCursor> = cursor
        .filter(|_| target.is_none())
        .map(|cursor| {
            let encoded = cursor
                .strip_prefix(CURSOR_PREFIX)
                .ok_or("invalid timeline cursor")?;
            serde_json::from_str(encoded).map_err(|_| "invalid timeline cursor")
        })
        .transpose()
        .map_err(str::to_owned)?;
    let metadata = super::codex_transcript_page::request_codex_turn_page(
        client,
        json!({
            "threadId": thread_id, "limit": 100,
            "sortDirection": "desc", "itemsView": "notLoaded",
        }),
    )
    .await?;
    let mut turns = previous
        .as_ref()
        .map(|cursor| cursor.turns.clone())
        .unwrap_or_default();
    turns.extend(metadata["data"].as_array().into_iter().flatten().cloned());
    let mut next_cursor = previous.as_ref().map(|cursor| cursor.cursor.clone());
    let mut seen_cursors = HashSet::new();
    let mut entries = Vec::new();
    let budget = limit.clamp(1, 5) * 100;
    loop {
        if let Some(cursor) = &next_cursor {
            if !seen_cursors.insert(cursor.clone()) {
                return Err("thread/timeline/list returned a repeated cursor".to_owned());
            }
        }
        let page = client
            .request(
                "thread/timeline/list",
                json!({
                    "threadId": thread_id, "cursor": next_cursor, "limit": 100,
                }),
            )
            .await?;
        let page_entries = page["data"]
            .as_array()
            .ok_or("timeline page has no data")?
            .clone();
        let target_found = target.is_some_and(|target| {
            page_entries.iter().any(|entry| {
                entry["turnId"].as_str() == Some(target)
                    && (entry["type"] == "turnStarted" || entry["item"]["type"] == "userMessage")
            })
        });
        // Carry completion metadata when a native page cuts through an older turn.
        turns.extend(
            timeline_turns(&page, turns.clone())?
                .into_iter()
                .map(|mut turn| {
                    turn["items"] = json!([]);
                    turn
                }),
        );
        if full_content || target.is_none() || target_found {
            entries.splice(0..0, page_entries);
        }
        next_cursor = string_field(&page, "nextCursor");
        if next_cursor.is_none()
            || (!full_content && (target_found || (target.is_none() && entries.len() >= budget)))
        {
            if target.is_some() && !target_found && entries.is_empty() {
                return Err("Requested turn is no longer present in native history".to_owned());
            }
            break;
        }
    }
    let projected = timeline_turns(&json!({"data": entries}), turns)?;
    let before_cursor = if full_content { None } else { next_cursor }
        .map(|cursor| {
            let turns = projected
                .iter()
                .take(1)
                .cloned()
                .map(|mut turn| {
                    turn["items"] = json!([]);
                    turn
                })
                .collect();
            serde_json::to_string(&TimelineCursor { cursor, turns })
                .map(|encoded| format!("{CURSOR_PREFIX}{encoded}"))
                .map_err(|error| error.to_string())
        })
        .transpose()?;
    thread["turns"] = Value::Array(projected);
    thread["timeline"] = json!(true);
    Ok(CodexTranscriptPage {
        thread,
        before_cursor,
        after_cursor: None,
    })
}

fn timeline_turns(page: &Value, metadata: Vec<Value>) -> Result<Vec<Value>, String> {
    let metadata: HashMap<_, _> = metadata
        .into_iter()
        .filter_map(|turn| Some((string_field(&turn, "id")?, turn)))
        .collect();
    let entries = page["data"].as_array().ok_or("timeline page has no data")?;
    let mut turns: Vec<Value> = Vec::new();
    let mut indexes = HashMap::new();
    let mut previous_position = None;
    for entry in entries {
        let position = entry["position"]
            .as_u64()
            .ok_or("timeline entry has no position")?;
        if previous_position.is_some_and(|previous| previous > position) {
            return Err("timeline page is not in canonical order".to_owned());
        }
        previous_position = Some(position);
        let Some(turn_id) = string_field(entry, "turnId") else {
            continue;
        };
        let index = *indexes.entry(turn_id.clone()).or_insert_with(|| {
            let mut turn = metadata
                .get(&turn_id)
                .cloned()
                .unwrap_or_else(|| json!({"id": turn_id, "status": "completed"}));
            turn["items"] = json!([]);
            turn["itemsView"] = json!("summary");
            turn["itemsPositioned"] = json!(true);
            turn["position"] = json!(position);
            turns.push(turn);
            turns.len() - 1
        });
        let turn = &mut turns[index];
        match entry["type"].as_str() {
            Some("item") => {
                let mut item = entry["item"].clone();
                if string_field(&item, "id").is_none() {
                    return Err("timeline item has no identity".to_owned());
                }
                item["position"] = json!(position);
                turn["items"].as_array_mut().unwrap().push(item);
            }
            Some("turnStarted") | Some("turnCompleted") => {
                for field in ["startedAt", "completedAt", "durationMs", "status", "error"] {
                    if let Some(value) = entry.get(field).filter(|value| !value.is_null()) {
                        turn[field] = value.clone();
                    }
                }
            }
            _ => {}
        }
    }
    Ok(turns)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_pages_keep_native_positions_and_completion_metadata() {
        let page = json!({"data": [
            {"type":"item", "position":3313, "turnId":"turn", "item":{"id":"old"}},
            {"type":"item", "position":4945, "turnId":"turn", "item":{"id":"new"}},
            {"type":"turnCompleted", "position":5000, "turnId":"turn", "status":"completed", "completedAt":123}
        ]});
        let turns = timeline_turns(&page, vec![]).unwrap();
        assert_eq!(turns[0]["items"][0]["position"], 3313);
        assert_eq!(turns[0]["items"][1]["position"], 4945);
        assert_eq!(turns[0]["completedAt"], 123);
        assert_eq!(turns[0]["itemsView"], "summary");
    }

    #[test]
    fn rejects_unordered_or_unidentified_history() {
        for entries in [
            json!([{"type":"item", "position":2,"turnId":"turn","item":{"id":"b"}}, {"type":"item", "position":1,"turnId":"turn","item":{"id":"a"}}]),
            json!([{"type":"item", "position":1,"turnId":"turn","item":{}}]),
        ] {
            assert!(timeline_turns(&json!({"data":entries}), vec![]).is_err());
        }
    }
}
