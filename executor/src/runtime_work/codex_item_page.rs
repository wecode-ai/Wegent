// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Legacy turns can contain thousands of items. A turn is not a work budget.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::agents::CodexAppServerClient;
use crate::local::app_ipc::AppIpcError;

use super::codex_transcript_page::{
    CodexTranscriptDirection, CodexTranscriptError, CodexTranscriptPage,
};
use super::util::{item_type, string_field};

const PREFIX: &str = "wework-codex-items:";
const ITEM_LIMIT: usize = 100;
const PAGE_BYTES: usize = 2 * 1024 * 1024;

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Cursor {
    ascending: bool,
    turn_cursor: Option<String>,
    turn: Option<Value>,
    item_cursor: Option<String>,
    item_offset: usize,
    #[serde(default)]
    snapshot_id: Option<String>,
}

pub(super) fn is_cursor(cursor: &str) -> bool {
    cursor.starts_with(PREFIX)
}

pub(super) async fn load(
    client: &CodexAppServerClient,
    mut thread: Value,
    thread_id: &str,
    cursor: Option<&str>,
    direction: CodexTranscriptDirection,
) -> Result<CodexTranscriptPage, CodexTranscriptError> {
    let ascending = direction == CodexTranscriptDirection::Ascending;
    let mut state = match cursor.and_then(|cursor| cursor.strip_prefix(PREFIX)) {
        Some(encoded) => {
            if encoded.len() > 64 * 1024 {
                return Err("Codex item cursor exceeds the metadata limit".into());
            }
            let state: Cursor = serde_json::from_str(encoded)
                .map_err(|error| format!("Invalid Codex item cursor: {error}"))?;
            if state.ascending != ascending {
                return Err("Codex item cursor has the wrong direction".into());
            }
            state
        }
        None => Cursor {
            ascending,
            turn_cursor: cursor.map(ToOwned::to_owned),
            ..Cursor::default()
        },
    };
    let sort_direction = if ascending { "asc" } else { "desc" };
    if state.turn.is_none() {
        let page = client
            .request(
                "thread/turns/list",
                json!({
                    "threadId":thread_id, "cursor":state.turn_cursor, "limit":1,
                    "sortDirection":sort_direction, "itemsView":"notLoaded",
                }),
            )
            .await?;
        let turns = page["data"]
            .as_array()
            .ok_or("Codex turn page is missing data")?;
        if turns.len() > 1 {
            return Err("Codex turn metadata exceeded the requested page size".into());
        }
        let next = string_field(&page, "nextCursor");
        if next.is_some() && next == state.turn_cursor {
            return Err("Codex item history returned an unchanged turn cursor".into());
        }
        state.turn_cursor = next;
        state.turn = turns.first().cloned();
    }
    let Some(mut turn) = state.turn.take() else {
        thread["turns"] = json!([]);
        return Ok(CodexTranscriptPage {
            thread,
            before_cursor: None,
            after_cursor: None,
        });
    };
    turn.as_object_mut()
        .ok_or("Codex turn metadata is not an object")?
        .remove("items");
    let turn_id = string_field(&turn, "id").ok_or("Codex turn metadata has no id")?;
    let directory = super::transcript_transport::native_page_directory(thread_id);
    let page = if let Some(snapshot) = state.snapshot_id.clone() {
        let directory = directory.clone();
        super::transcript_work::run(move |cancellation| {
            super::transcript_transport::read_native_page(&directory, &snapshot, cancellation)
        })
        .await?
    } else {
        client
            .request(
                "thread/items/list",
                json!({
                    "threadId":thread_id, "turnId":turn_id,
                    "cursor":state.item_cursor, "sortDirection":sort_direction, "limit":ITEM_LIMIT,
                }),
            )
            .await?
    };
    let previous_snapshot = state.snapshot_id.clone();
    let offset = state.item_offset;
    let (items, consumed, total, next, snapshot) =
        super::transcript_work::run(move |cancellation| {
            let entries = page["data"].as_array().ok_or_else(|| {
                AppIpcError::new("codex_error", "Codex item page is missing data")
            })?;
            if entries.len() > ITEM_LIMIT {
                return Err(AppIpcError::new(
                    "codex_error",
                    "Codex item page exceeded its requested item budget",
                ));
            }
            let (items, consumed) = select_items(entries, &turn_id, offset, cancellation)?;
            let snapshot = if offset + consumed < entries.len() {
                Some(match previous_snapshot {
                    Some(snapshot) => snapshot,
                    None => super::transcript_transport::store_native_page(
                        &directory,
                        &page,
                        cancellation,
                    )?,
                })
            } else {
                None
            };
            Ok((
                items,
                consumed,
                entries.len(),
                string_field(&page, "nextCursor"),
                snapshot,
            ))
        })
        .await?;
    state.snapshot_id = snapshot;
    let read_start = state.item_offset;
    if read_start + consumed < total {
        state.item_offset += consumed;
        state.turn = Some(turn.clone());
    } else if next.is_some() {
        if next == state.item_cursor {
            return Err("Codex item history returned an unchanged item cursor".into());
        }
        state.item_cursor = next;
        state.item_offset = 0;
        state.turn = Some(turn.clone());
    } else {
        state.item_cursor = None;
        state.item_offset = 0;
    }
    let mut items = items;
    if !ascending {
        items.reverse();
    }
    turn["ownsUserPresentation"] = json!(items.iter().any(|item| item_type(item) == "usermessage"));
    turn["timelineCompleted"] = json!(turn["status"] == "completed");
    turn["items"] = Value::Array(items);
    turn["itemsView"] = json!("summary");
    if !ascending && cursor.is_some() {
        turn["itemMerge"] = json!("prepend");
    }
    thread["turns"] = Value::Array(vec![turn]);
    // Partial turns use the canonical item reducer and never merge a full cached turn.
    thread["timeline"] = json!(true);
    let next = if state.turn.is_some() || state.turn_cursor.is_some() {
        Some(format!(
            "{PREFIX}{}",
            serde_json::to_string(&state).map_err(|error| error.to_string())?
        ))
    } else {
        None
    };
    let (before_cursor, after_cursor) = if ascending {
        (None, next)
    } else {
        (next, None)
    };
    Ok(CodexTranscriptPage {
        thread,
        before_cursor,
        after_cursor,
    })
}

fn select_items(
    entries: &[Value],
    turn_id: &str,
    offset: usize,
    cancellation: &super::transcript_work::Cancellation,
) -> Result<(Vec<Value>, usize), AppIpcError> {
    if offset > entries.len() {
        return Err(AppIpcError::new(
            "codex_error",
            "Codex item cursor no longer belongs to this page",
        ));
    }
    let mut items = Vec::new();
    let mut bytes = 0;
    for entry in &entries[offset..] {
        cancellation.check()?;
        if entry["turnId"] != turn_id {
            return Err(AppIpcError::new(
                "codex_error",
                "Codex item page contains another turn",
            ));
        }
        let item = entry
            .get("item")
            .ok_or_else(|| AppIpcError::new("codex_error", "Codex item page is missing item"))?;
        let size = serde_json::to_vec(item)
            .map_err(|error| AppIpcError::new("codex_error", error.to_string()))?
            .len();
        if !items.is_empty() && bytes + size > PAGE_BYTES {
            break;
        }
        // A single native item is indivisible; retain it losslessly through chunk transport.
        bytes += size;
        items.push(item.clone());
    }
    let consumed = items.len();
    Ok((items, consumed))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_provider_page_continues_at_its_byte_boundary_without_losing_full_bodies() {
        let body = "正文🙂".repeat(140_000);
        let entries = (0..3)
            .map(|index| {
                json!({"turnId":"turn-1","item":{
                    "id":format!("item-{index}"),"type":"agentMessage","text":body,
                }})
            })
            .collect::<Vec<_>>();
        let cancellation = super::super::transcript_work::Cancellation::new();
        let mut offset = 0;
        let mut restored = Vec::new();
        while offset < entries.len() {
            let (items, consumed) =
                select_items(&entries, "turn-1", offset, &cancellation).unwrap();
            assert_eq!(consumed, 1);
            assert_eq!(items[0]["text"], body);
            restored.extend(items);
            offset += consumed;
        }
        assert_eq!(
            restored
                .iter()
                .map(|item| item["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["item-0", "item-1", "item-2"]
        );
        assert!(select_items(&entries, "other-turn", 0, &cancellation).is_err());
        assert!(select_items(&entries, "turn-1", 4, &cancellation).is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn legacy_native_history_requests_metadata_and_bounded_item_pages() {
        use std::{fs, os::unix::fs::PermissionsExt};
        let _environment = crate::agents::CodexLaunchEnvironment::new();
        let _capabilities = crate::services::capability_activation::begin_execution().await;
        let directory = tempfile::tempdir().unwrap();
        let binary = directory.path().join("history-fixture");
        let log = directory.path().join("requests.jsonl");
        for start in [0, 100, 200] {
            let data = (start..(start + 100).min(251))
                .map(|index| {
                    json!({
                        "turnId":"long-turn", "item":{"id":format!("item-{}",250-index),
                            "type":"agentMessage","text":format!("完整正文🙂-{}",250-index)}
                    })
                })
                .collect::<Vec<_>>();
            let next = (start + 100 < 251).then(|| format!("offset-{}", start + 100));
            fs::write(
                directory.path().join(format!("{start}.json")),
                json!({"data":data,"nextCursor":next}).to_string(),
            )
            .unwrap();
        }
        let script = r#"#!/bin/sh
while IFS= read -r line; do
  printf '%s\n' "$line" >> '__LOG__'
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*) result='{}' ;;
    *'"method":"initialized"'*) continue ;;
    *'"method":"thread/read"'*) result='{"thread":{"id":"thread-1","historyMode":"legacy"}}' ;;
    *'"method":"thread/turns/list"'*) result='{"data":[{"id":"long-turn","status":"completed","itemsView":"notLoaded","items":[]}],"nextCursor":null}' ;;
    *'"method":"thread/items/list"'*)
      offset=$(printf '%s' "$line" | sed -n 's/.*"cursor":"offset-\([0-9][0-9]*\)".*/\1/p')
      if [ -z "$offset" ]; then offset=0; fi
      result=$(cat '__ROOT__/'"$offset"'.json') ;;
    *) result='{}' ;;
  esac
  printf '{"id":%s,"result":%s}\n' "$id" "$result"
done
"#;
        fs::write(
            &binary,
            script
                .replace("__LOG__", &log.to_string_lossy())
                .replace("__ROOT__", &directory.path().to_string_lossy()),
        )
        .unwrap();
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
        let request = serde_json::from_value(json!({
            "user_name":"synthetic","team_namespace":"default","team_name":"history",
            "team_id":12,"bot":[{"id":31,"shell_type":"Codex"}]
        }))
        .unwrap();
        let client = CodexAppServerClient::new(binary.to_string_lossy())
            .for_request(&request)
            .unwrap();
        let mut cursor = None;
        let mut seen = std::collections::HashSet::new();
        let mut pages = 0;
        loop {
            let page = super::super::codex_transcript_page::load_codex_transcript(
                &client,
                super::super::codex_transcript_page::CodexTranscriptRequest {
                    thread_id: "thread-1",
                    cursor: cursor.as_deref(),
                    limit: 50,
                    direction: CodexTranscriptDirection::Descending,
                    full_content: false,
                    bounded_items: true,
                    prefer_rollout_history: false,
                },
            )
            .await
            .unwrap();
            let items = page.thread["turns"][0]["items"].as_array().unwrap();
            assert!(items.len() <= ITEM_LIMIT);
            for item in items {
                let id = item["id"].as_str().unwrap();
                assert!(seen.insert(id.to_owned()));
                assert_eq!(
                    item["text"],
                    format!("完整正文🙂-{}", id.strip_prefix("item-").unwrap())
                );
            }
            pages += 1;
            cursor = page.before_cursor;
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(pages, 3);
        assert_eq!(seen.len(), 251);
        let calls = fs::read_to_string(&log)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        let turn_calls = calls
            .iter()
            .filter(|call| call["method"] == "thread/turns/list")
            .collect::<Vec<_>>();
        assert_eq!(turn_calls.len(), 1);
        assert_eq!(turn_calls[0]["params"]["itemsView"], "notLoaded");
        assert_eq!(turn_calls[0]["params"]["limit"], 1);
        assert!(calls
            .iter()
            .filter(|call| call["method"] == "thread/items/list")
            .all(|call| call["params"]["limit"] == ITEM_LIMIT));
        let body = "正文🙂".repeat(140_000);
        let mut large = (0..3)
            .rev()
            .map(|index| {
                json!({"turnId":"long-turn","item":{
                    "id":format!("large-{index}"),"type":"agentMessage","text":body,
                }})
            })
            .collect::<Vec<_>>();
        fs::write(
            directory.path().join("0.json"),
            json!({"data":large,"nextCursor":null}).to_string(),
        )
        .unwrap();
        let first = load(
            &client,
            json!({"id":"thread-1"}),
            "thread-1",
            None,
            CodexTranscriptDirection::Descending,
        )
        .await
        .unwrap();
        assert_eq!(first.thread["turns"][0]["items"][0]["id"], "large-2");
        // The latest provider page shifts after an append. Continue the immutable original.
        large.insert(0,json!({"turnId":"long-turn","item":{"id":"appended","type":"agentMessage","text":"new"}}));
        fs::write(
            directory.path().join("0.json"),
            json!({"data":large,"nextCursor":null}).to_string(),
        )
        .unwrap();
        let second = load(
            &client,
            json!({"id":"thread-1"}),
            "thread-1",
            first.before_cursor.as_deref(),
            CodexTranscriptDirection::Descending,
        )
        .await
        .unwrap();
        assert_eq!(second.thread["turns"][0]["items"][0]["id"], "large-1");
        let last = load(
            &client,
            json!({"id":"thread-1"}),
            "thread-1",
            second.before_cursor.as_deref(),
            CodexTranscriptDirection::Descending,
        )
        .await
        .unwrap();
        assert_eq!(last.thread["turns"][0]["items"][0]["id"], "large-0");
        assert_eq!(last.thread["turns"][0]["items"][0]["text"], body);
        assert!(last.before_cursor.is_none());
        let after_calls = fs::read_to_string(&log)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            after_calls
                .iter()
                .filter(|call| call["method"] == "thread/items/list")
                .count(),
            4
        );
        client.restart().await;
    }
}
