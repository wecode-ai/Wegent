// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::agents::CodexAppServerClient;

use super::codex_transcript_page::{CodexTranscriptError, CodexTranscriptPage};
use super::util::string_field;

const TURN_CURSOR_PREFIX: &str = "wework-codex-turn:";

pub(super) fn turn_cursor(turn_id: &str) -> String {
    format!("{TURN_CURSOR_PREFIX}{turn_id}")
}

pub(super) fn next_open_timeline_turn_id(thread: &Value, previous_turn_id: &str) -> Option<String> {
    if thread["timeline"] != true {
        return None;
    }
    let turns = thread["turns"].as_array()?;
    let previous = turns.iter().find(|turn| turn["id"] == previous_turn_id)?;
    let latest = turns.last()?;
    if latest["timelineCompleted"] == true
        || latest["ownsUserPresentation"] != true
        || latest["position"].as_u64()? <= previous["position"].as_u64()?
    {
        return None;
    }
    string_field(latest, "id")
}

pub(super) const CURSOR_PREFIX: &str = "wework-codex-timeline:";

#[derive(Deserialize, Serialize)]
struct TimelineCursor {
    cursor: Option<String>,
    #[serde(default, skip_serializing_if = "is_zero")]
    entry_offset: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    snapshot_id: Option<String>,
    // A page can cut through a turn, before its completion boundary.
    turns: Vec<Value>,
}

fn is_zero(value: &usize) -> bool {
    *value == 0
}

pub(super) async fn load_timeline_page(
    client: &CodexAppServerClient,
    mut thread: Value,
    thread_id: &str,
    cursor: Option<&str>,
    limit: usize,
    full_content: bool,
    bounded_items: bool,
) -> Result<CodexTranscriptPage, CodexTranscriptError> {
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
    let mut next_cursor = previous.as_ref().and_then(|cursor| cursor.cursor.clone());
    let mut entry_offset = previous.as_ref().map_or(0, |cursor| cursor.entry_offset);
    let mut page_snapshot = previous
        .as_ref()
        .and_then(|cursor| cursor.snapshot_id.clone());
    let directory = super::transcript_transport::native_page_directory(thread_id);
    let mut seen_cursors = HashSet::new();
    let mut entries = Vec::new();
    let mut page_bytes = 0;
    let budget = limit.clamp(1, 5) * 100;
    loop {
        if !seen_cursors.insert((next_cursor.clone(), entry_offset)) {
            return Err("thread/timeline/list returned a repeated cursor".into());
        }
        let page = if let Some(snapshot) = page_snapshot.clone() {
            let directory = directory.clone();
            super::transcript_work::run(move |cancellation| {
                super::transcript_transport::read_native_page(&directory, &snapshot, cancellation)
            })
            .await?
        } else {
            client
                .request(
                    "thread/timeline/list",
                    json!({
                        "threadId": thread_id, "cursor": next_cursor, "limit": 100,
                    }),
                )
                .await?
        };
        let provider_cursor = next_cursor.clone();
        let (mut page, read_bytes, has_remainder, consumed, retained) =
            if !bounded_items || full_content || target.is_some() {
                (page, 0, false, 0, None)
            } else {
                let already_has_entries = !entries.is_empty();
                let directory = directory.clone();
                let page_snapshot = page_snapshot.clone();
                super::transcript_work::run(move |cancellation| {
                    bounded_timeline_page(
                        page,
                        entry_offset,
                        page_bytes,
                        already_has_entries,
                        cancellation,
                        Some((&directory, page_snapshot.as_deref())),
                    )
                })
                .await?
            };
        page_snapshot = retained;
        page_bytes += read_bytes;
        let page_entries = page["data"].as_array().ok_or("timeline page has no data")?;
        let target_found = target.is_some_and(|target| {
            page_entries.iter().any(|entry| {
                timeline_entry_turn_id(entry).as_deref() == Some(target)
                    && (entry["type"] == "turnStarted" || entry["item"]["type"] == "userMessage")
            })
        });
        // Carry completion metadata when a native page cuts through an older turn.
        turns.extend(
            timeline_metadata(&page, turns.clone())?
                .into_iter()
                .map(|mut turn| {
                    turn["items"] = json!([]);
                    turn
                }),
        );
        if full_content || target.is_none() || target_found {
            let page_entries = std::mem::take(page["data"].as_array_mut().unwrap());
            entries.splice(0..0, page_entries);
        }
        if has_remainder {
            next_cursor = provider_cursor;
            entry_offset += consumed;
        } else {
            next_cursor = string_field(&page, "nextCursor");
            entry_offset = 0;
        }
        if next_cursor.is_none() && entry_offset == 0
            || (!full_content && (has_remainder || page_bytes >= 2 * 1024 * 1024))
            || (!full_content && (target_found || (target.is_none() && entries.len() >= budget)))
        {
            if target.is_some() && !target_found && entries.is_empty() {
                return Err("Requested turn is no longer present in native history".into());
            }
            break;
        }
    }
    let projected = super::transcript_work::run(move |cancellation| {
        cancellation.check()?;
        let page = Value::Object(serde_json::Map::from_iter([(
            "data".to_owned(),
            Value::Array(entries),
        )]));
        timeline_turns_checked(&page, turns, Some(cancellation))
            .map_err(|error| crate::local::app_ipc::AppIpcError::new("codex_error", error))
    })
    .await?;
    let before_cursor = if !full_content && (next_cursor.is_some() || entry_offset > 0) {
        let turns = projected
            .iter()
            .take(1)
            .cloned()
            .map(|mut turn| {
                turn["items"] = json!([]);
                turn
            })
            .collect();
        Some(
            serde_json::to_string(&TimelineCursor {
                cursor: next_cursor,
                entry_offset,
                snapshot_id: page_snapshot,
                turns,
            })
            .map(|encoded| format!("{CURSOR_PREFIX}{encoded}"))
            .map_err(|error| error.to_string())?,
        )
    } else {
        None
    };
    thread["turns"] = Value::Array(projected);
    thread["timeline"] = json!(true);
    Ok(CodexTranscriptPage {
        thread,
        before_cursor,
        after_cursor: None,
    })
}

fn timeline_metadata(page: &Value, metadata: Vec<Value>) -> Result<Vec<Value>, String> {
    let entries = page["data"]
        .as_array()
        .ok_or("Timeline page has no data")?
        .iter()
        .map(|entry| {
            if entry["type"] != "item" {
                return entry.clone();
            }
            json!({"type":"item","position":entry["position"],"turnId":entry["turnId"],
            "item":{"id":entry["item"]["id"],"type":entry["item"]["type"]}})
        })
        .collect();
    timeline_turns(
        &Value::Object(serde_json::Map::from_iter([(
            "data".to_owned(),
            Value::Array(entries),
        )])),
        metadata,
    )
}

fn bounded_timeline_page(
    mut page: Value,
    offset: usize,
    previous_bytes: usize,
    previous_items: bool,
    cancellation: &super::transcript_work::Cancellation,
    snapshot: Option<(&std::path::Path, Option<&str>)>,
) -> Result<(Value, usize, bool, usize, Option<String>), crate::local::app_ipc::AppIpcError> {
    use crate::local::app_ipc::AppIpcError;
    let entries = page["data"]
        .as_array()
        .ok_or_else(|| AppIpcError::new("codex_error", "Timeline page has no data"))?;
    if offset > entries.len() || entries.len() > 100 {
        return Err(AppIpcError::new(
            "codex_error",
            "Timeline provider page exceeded its item budget or changed beneath its cursor",
        ));
    }
    let mut selected = Vec::new();
    let mut bytes = 0;
    for entry in entries.iter().rev().skip(offset) {
        cancellation.check()?;
        let size = serde_json::to_vec(entry)
            .map_err(|error| AppIpcError::new("codex_error", error.to_string()))?
            .len();
        if (previous_items || !selected.is_empty())
            && previous_bytes + bytes + size > 2 * 1024 * 1024
        {
            break;
        }
        bytes += size;
        selected.push(entry.clone());
    }
    let consumed = selected.len();
    let remainder = offset + consumed < entries.len();
    let retained = if remainder {
        match snapshot {
            Some((_, Some(id))) => Some(id.to_owned()),
            Some((directory, None)) => Some(super::transcript_transport::store_native_page(
                directory,
                &page,
                cancellation,
            )?),
            None => None,
        }
    } else {
        None
    };
    selected.reverse();
    page["data"] = Value::Array(selected);
    Ok((page, bytes, remainder, consumed, retained))
}

fn timeline_entry_turn_id(entry: &Value) -> Option<String> {
    match entry["type"].as_str() {
        Some("item" | "turnStarted" | "turnCompleted") => string_field(entry, "turnId"),
        _ => None,
    }
}

fn timeline_turns(page: &Value, metadata: Vec<Value>) -> Result<Vec<Value>, String> {
    timeline_turns_checked(page, metadata, None)
}

fn timeline_turns_checked(
    page: &Value,
    metadata: Vec<Value>,
    cancellation: Option<&super::transcript_work::Cancellation>,
) -> Result<Vec<Value>, String> {
    let mut metadata_by_id = HashMap::<String, Value>::new();
    for turn in metadata {
        let Some(id) = string_field(&turn, "id") else {
            continue;
        };
        // Fresh turn-list metadata must not replace a completion boundary
        // carried from a newer timeline page.
        if metadata_by_id.get(&id).is_some_and(|previous| {
            previous["timelineCompleted"] == true && turn["timelineCompleted"] != true
        }) {
            continue;
        }
        metadata_by_id.insert(id, turn);
    }
    let entries = page["data"].as_array().ok_or("timeline page has no data")?;
    let mut turns: Vec<Value> = Vec::new();
    let mut indexes = HashMap::new();
    let mut previous_position = None;
    for entry in entries {
        if let Some(cancellation) = cancellation {
            cancellation.check().map_err(|error| error.message)?;
        }
        let position = entry["position"]
            .as_u64()
            .ok_or("timeline entry has no position")?;
        if previous_position.is_some_and(|previous| previous > position) {
            return Err("timeline page is not in canonical order".to_owned());
        }
        previous_position = Some(position);
        let Some(turn_id) = timeline_entry_turn_id(entry) else {
            continue;
        };
        let index = *indexes.entry(turn_id.clone()).or_insert_with(|| {
            let mut turn = metadata_by_id
                .get(&turn_id)
                .cloned()
                .unwrap_or_else(|| json!({"id": turn_id, "status": "inProgress"}));
            turn["items"] = json!([]);
            turn["itemsView"] = json!("summary");
            turn["itemsPositioned"] = json!(true);
            turn["ownsUserPresentation"] = json!(false);
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
                if item["type"] == "userMessage" {
                    turn["ownsUserPresentation"] = json!(true);
                }
                turn["items"].as_array_mut().unwrap().push(item);
            }
            Some("turnStarted") | Some("turnCompleted") => {
                if entry["type"] == "turnCompleted" {
                    turn["timelineCompleted"] = json!(true);
                }
                if entry["type"] == "turnStarted" {
                    turn["ownsUserPresentation"] = json!(true);
                }
                // Native JSON-RPC responses use camelCase for lifecycle boundaries.
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
    fn byte_bounded_native_pages_resume_inside_one_provider_page() {
        let body = "正文🙂".repeat(140_000);
        let source = json!({"data":[
            {"position":1,"type":"item","turnId":"turn-1","item":{"id":"one","type":"agentMessage","text":body}},
            {"position":2,"type":"item","turnId":"turn-1","item":{"id":"two","type":"agentMessage","text":body}},
            {"position":3,"type":"item","turnId":"turn-1","item":{"id":"three","type":"agentMessage","text":body}},
        ],"nextCursor":"older-page"});
        let cancellation = super::super::transcript_work::Cancellation::new();
        let (first, _, remaining, count, _) =
            bounded_timeline_page(source.clone(), 0, 0, false, &cancellation, None).unwrap();
        assert!(remaining);
        assert_eq!(count, 1);
        assert_eq!(first["data"][0]["item"]["id"], "three");
        let (second, _, remaining, count, _) =
            bounded_timeline_page(source.clone(), 1, 0, false, &cancellation, None).unwrap();
        assert!(remaining);
        assert_eq!(count, 1);
        assert_eq!(second["data"][0]["item"]["id"], "two");
        let (last, _, remaining, count, _) =
            bounded_timeline_page(source, 2, 0, false, &cancellation, None).unwrap();
        assert!(!remaining);
        assert_eq!(count, 1);
        assert_eq!(last["data"][0]["item"]["text"], body);
        assert_eq!(last["nextCursor"], "older-page");
        let cursor = TimelineCursor {
            cursor: None,
            entry_offset: 1,
            snapshot_id: None,
            turns: vec![],
        };
        let restored: TimelineCursor =
            serde_json::from_str(&serde_json::to_string(&cursor).unwrap()).unwrap();
        assert_eq!(restored.entry_offset, 1);
        assert!(restored.cursor.is_none());
    }

    #[test]
    fn an_append_cannot_shift_a_retained_native_timeline_page() {
        let directory = tempfile::tempdir().unwrap();
        let body = "正文🙂".repeat(140_000);
        let source = json!({"data":[
            {"position":1,"type":"item","turnId":"turn","item":{"id":"one","type":"agentMessage","text":body}},
            {"position":2,"type":"item","turnId":"turn","item":{"id":"two","type":"agentMessage","text":body}},
            {"position":3,"type":"item","turnId":"turn","item":{"id":"three","type":"agentMessage","text":body}},
        ],"nextCursor":"older"});
        let cancellation = super::super::transcript_work::Cancellation::new();
        let (first, _, _, _, snapshot) = bounded_timeline_page(
            source.clone(),
            0,
            0,
            false,
            &cancellation,
            Some((directory.path(), None)),
        )
        .unwrap();
        assert_eq!(first["data"][0]["item"]["id"], "three");
        let snapshot = snapshot.unwrap();
        let mut appended_provider = source.clone();
        appended_provider["data"].as_array_mut().unwrap().push(json!({"position":4,"type":"item","turnId":"turn","item":{"id":"appended","type":"agentMessage","text":"new"}}));
        assert_ne!(appended_provider, source);
        let retained = super::super::transcript_transport::read_native_page(
            directory.path(),
            &snapshot,
            &cancellation,
        )
        .unwrap();
        assert_eq!(retained, source);
        let (second, _, _, _, _) = bounded_timeline_page(
            retained,
            1,
            0,
            false,
            &cancellation,
            Some((directory.path(), Some(&snapshot))),
        )
        .unwrap();
        assert_eq!(second["data"][0]["item"]["id"], "two");
        assert_eq!(second["data"][0]["item"]["text"], body);
    }

    #[test]
    fn a_turn_started_after_metadata_was_read_remains_running() {
        let turns = timeline_turns(&json!({"data":[
            {"type":"turnStarted","position":10,"turnId":"new","startedAt":123},
            {"type":"item","position":11,"turnId":"new","item":{"id":"stream","type":"agentMessage","text":"Still running"}}
        ]}), vec![]).unwrap();
        assert_eq!(turns[0]["status"], "inProgress");
        assert_eq!(turns[0]["startedAt"], 123);
    }

    #[test]
    fn an_abandoned_historical_turn_keeps_its_inferred_interruption() {
        let turns = timeline_turns(
            &json!({"data":[
                {"type":"turnStarted","position":10,"turnId":"recovered","startedAt":123}
            ]}),
            vec![json!({
                "id":"recovered", "status":"interrupted", "items":[],
                "completedAt":null, "durationMs":null, "error":null
            })],
        )
        .unwrap();
        assert_eq!(turns[0]["status"], "interrupted");
        assert_eq!(turns[0]["startedAt"], 123);
        assert_eq!(turns[0]["completedAt"], Value::Null);
        assert_ne!(turns[0]["timelineCompleted"], true);
        assert_eq!(
            super::super::transcript::turn_assistant_status(&turns[0]),
            "cancelled"
        );
        let projection = super::super::transcript::project_transcript(
            &json!({"id":"thread","timeline":true,"turns":turns}),
            "test-device",
            false,
        );
        assert_eq!(projection.turns[0]["status"], "cancelled");
        assert_eq!(projection.turns[0]["items"], json!([]));
    }

    #[test]
    fn an_older_opening_boundary_preserves_native_terminal_outcomes_from_later_pages() {
        for status in ["completed", "interrupted", "failed"] {
            let later = timeline_turns(
                &json!({"data":[
                    {"type":"turnCompleted","position":20,"turnId":"old",
                     "status":status,"completedAt":124,"durationMs":1000}
                ]}),
                vec![],
            )
            .unwrap();
            let mut metadata = later;
            // A new page reads turn-list metadata after the carried timeline boundary.
            metadata.push(json!({"id":"old","status":status}));
            let earlier = timeline_turns(
                &json!({"data":[
                    {"type":"turnStarted","position":10,"turnId":"old","startedAt":123}
                ]}),
                metadata,
            )
            .unwrap();
            assert_eq!(earlier[0]["status"], status);
            assert_eq!(earlier[0]["timelineCompleted"], true);
            assert_eq!(earlier[0]["completedAt"], 124);
            assert_eq!(earlier[0]["durationMs"], 1000);
        }
    }

    #[test]
    fn native_terminal_boundaries_determine_old_turn_search_visibility() {
        use crate::runtime_work::transcript_search_text::{
            codex_turn_search_regions, AsyncReplySearchProjection,
        };

        for (status, narrative, content, error, expected_status, expected_text) in [
            (
                "interrupted",
                Some("interrupted"),
                "aborted",
                None,
                "cancelled",
                vec!["interrupted"],
            ),
            (
                "failed",
                None,
                "API error: needle",
                Some("API error: needle"),
                "failed",
                vec![],
            ),
            (
                "interrupted",
                None,
                "Useful partial needle",
                None,
                "cancelled",
                vec!["Useful partial needle"],
            ),
            ("completed", None, "aborted", None, "done", vec!["aborted"]),
        ] {
            let mut entries =
                vec![json!({"type":"turnStarted","position":1,"turnId":"old","startedAt":123})];
            if let Some(text) = narrative {
                entries.push(json!({"type":"item","position":2,"turnId":"old","item":{
                    "id":"narrative","type":"agentMessage","phase":"commentary","text":text
                }}));
            }
            entries.push(json!({"type":"item","position":3,"turnId":"old","item":{
                "id":"answer","type":"agentMessage","phase":"final_answer","text":content
            }}));
            entries.push(json!({"type":"turnCompleted","position":4,"turnId":"old",
                "status":status,"startedAt":123,"completedAt":124,"durationMs":1000,
                "error":error.map(|message| json!({"message":message}))
            }));
            // The recent turn metadata page does not contain this older turn.
            let turns = timeline_turns(
                &json!({"data":entries}),
                vec![json!({"id":"recent","status":"completed"})],
            )
            .unwrap();
            let turn = &turns[0];
            assert_eq!(turn["timelineCompleted"], true);
            assert_eq!(turn["startedAt"], 123);
            assert_eq!(turn["completedAt"], 124);
            assert_eq!(turn["durationMs"], 1000);
            assert_eq!(
                super::super::transcript::turn_assistant_status(turn),
                expected_status
            );
            let regions = codex_turn_search_regions(
                turn,
                &HashMap::new(),
                None,
                &mut AsyncReplySearchProjection::default(),
            );
            assert_eq!(
                regions
                    .iter()
                    .map(|region| region.text.as_str())
                    .collect::<Vec<_>>(),
                expected_text,
                "{status}"
            );
            assert_eq!(turn["error"]["message"].as_str(), error);
        }
    }

    #[test]
    fn opening_boundary_ownership_does_not_leak_into_another_page() {
        let metadata = timeline_turns(
            &json!({"data":[
                {"type":"turnStarted","position":1,"turnId":"turn"}
            ]}),
            vec![],
        )
        .unwrap();
        assert_eq!(metadata[0]["ownsUserPresentation"], true);
        let partial = timeline_turns(
            &json!({"data":[
                {"type":"item","position":10,"turnId":"turn","item":{"id":"answer"}}
            ]}),
            metadata,
        )
        .unwrap();
        assert_eq!(partial[0]["ownsUserPresentation"], false);
    }

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
        assert_eq!(turns[0]["timelineCompleted"], true);
        let earlier = timeline_turns(
            &json!({"data":[
                {"type":"turnStarted","position":1,"turnId":"turn"},
                {"type":"item","position":2,"turnId":"turn","item":{"id":"earlier"}}
            ]}),
            turns,
        )
        .unwrap();
        assert_eq!(earlier[0]["timelineCompleted"], true);
        assert_eq!(earlier[0]["status"], "completed");
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
