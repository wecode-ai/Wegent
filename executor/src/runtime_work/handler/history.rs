// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

use super::*;

const DEFAULT_TURN_PAGE_SIZE: usize = 5;
const MAX_TURN_PAGE_SIZE: usize = 20;
const DEFAULT_ITEM_PAGE_SIZE: usize = 20;
const MAX_ITEM_PAGE_SIZE: usize = 50;
const ITEM_PROVIDER_PAGE_SIZE: usize = 50;
const ITEM_PAGE_MAX_BYTES: usize = 384 * 1024;
const ITEM_CURSOR_PREFIX: &str = "history-items-v1:";

impl RuntimeWorkRpcHandler {
    pub(super) async fn list_history_turns(
        &self,
        mut payload: Value,
    ) -> Result<Value, AppIpcError> {
        let local_task_id = runtime_task_id(&payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "taskId is required"))?;
        let limit = integer_field(&payload, "limit")
            .and_then(|value| usize::try_from(value).ok())
            .filter(|value| *value > 0)
            .unwrap_or(DEFAULT_TURN_PAGE_SIZE)
            .min(MAX_TURN_PAGE_SIZE);
        let before_cursor = string_field(&payload, "beforeCursor")
            .or_else(|| string_field(&payload, "before_cursor"));
        let after_cursor = string_field(&payload, "afterCursor")
            .or_else(|| string_field(&payload, "after_cursor"));
        if before_cursor.is_some() && after_cursor.is_some() {
            return Err(AppIpcError::new(
                "bad_request",
                "Runtime history pagination accepts only one cursor at a time",
            ));
        }
        payload["limit"] = json!(limit);
        payload["includeFullContent"] = Value::Bool(false);

        let local_link = self.local_task_link(&local_task_id);
        let runtime = local_link
            .as_ref()
            .map(|link| link.runtime.clone())
            .or_else(|| string_field(&payload, "runtime"))
            .unwrap_or_else(|| "codex".to_owned());
        let session_id = local_link
            .as_ref()
            .and_then(runtime_session_id_from_link)
            .or_else(|| runtime_session_id_from_payload(&payload));
        if local_link.as_ref().is_some_and(|link| link.ephemeral)
            || !runtime_has_provider_transcript_reader(&runtime)
            || session_id.is_none()
        {
            return self.cached_history_turn_page(payload).await;
        }

        let local_execution_running = self.is_active_local_task(&local_task_id);
        let refresh = bool_field(&payload, "refresh")
            .or_else(|| bool_field(&payload, "forceRefresh"))
            .unwrap_or(false);
        let mut thread_id = session_id.expect("checked above");
        if refresh && !local_execution_running {
            if let Some(link) = local_link.as_ref().filter(|link| !link.ephemeral) {
                thread_id = self
                    .resume_codex_thread_for_action(link, &thread_id)
                    .await
                    .map_err(|error| AppIpcError::new("codex_error", error))?;
            }
        }

        let CodexTranscriptPage {
            thread,
            before_cursor: page_before_cursor,
            after_cursor: page_after_cursor,
        } = load_codex_turn_metadata_page(
            &self.codex_app_server,
            CodexTranscriptRequest {
                thread_id: &thread_id,
                cursor: before_cursor.as_deref().or(after_cursor.as_deref()),
                limit,
                direction: if after_cursor.is_some() {
                    CodexTranscriptDirection::Ascending
                } else {
                    CodexTranscriptDirection::Descending
                },
                full_content: false,
            },
        )
        .await
        .map_err(|error| AppIpcError::new("codex_error", error))?;
        let turns = thread
            .get("turns")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let workspace_path = local_link
            .as_ref()
            .map(|link| link.workspace_path.clone())
            .filter(|path| !path.trim().is_empty())
            .or_else(|| string_field(&thread, "cwd"))
            .or_else(|| string_field(&payload, "workspacePath"))
            .or_else(|| string_field(&payload, "workspace_path"))
            .unwrap_or_default();
        let running = local_execution_running || codex_thread_has_in_progress_turn(&thread);
        Ok(json!({
            "success": true,
            "schemaVersion": 2,
            "taskId": local_task_id,
            "workspacePath": workspace_path,
            "runtime": runtime,
            "running": running,
            "turns": turns,
            "turnNavigation": [],
            "contextUsage": transcript_context_usage(&thread).unwrap_or(Value::Null),
            "rangeStart": Value::Null,
            "rangeEnd": Value::Null,
            "hasMoreBefore": page_before_cursor.is_some(),
            "beforeCursor": page_before_cursor,
            "hasMoreAfter": page_after_cursor.is_some(),
            "afterCursor": page_after_cursor,
        }))
    }

    pub(super) async fn list_history_turn_items(
        &self,
        payload: Value,
    ) -> Result<Value, AppIpcError> {
        let local_task_id = runtime_task_id(&payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "taskId is required"))?;
        let turn_id = string_field(&payload, "turnId")
            .or_else(|| string_field(&payload, "turn_id"))
            .ok_or_else(|| AppIpcError::new("bad_request", "turnId is required"))?;
        let limit = integer_field(&payload, "limit")
            .and_then(|value| usize::try_from(value).ok())
            .filter(|value| *value > 0)
            .unwrap_or(DEFAULT_ITEM_PAGE_SIZE)
            .min(MAX_ITEM_PAGE_SIZE);
        let cursor = string_field(&payload, "cursor")
            .map(|value| decode_item_cursor(&value))
            .transpose()?
            .unwrap_or_default();
        let link = self.local_task_link(&local_task_id);
        let runtime = link
            .as_ref()
            .map(|link| link.runtime.clone())
            .or_else(|| string_field(&payload, "runtime"))
            .unwrap_or_else(|| "codex".to_owned());
        if !runtime_has_provider_transcript_reader(&runtime) {
            let link = link
                .as_ref()
                .ok_or_else(|| AppIpcError::new("not_found", "Runtime task was not found"))?;
            return self.cached_history_turn_items(link, &turn_id, cursor.skip, limit);
        }

        let thread_id = link
            .as_ref()
            .and_then(runtime_session_id_from_link)
            .or_else(|| runtime_session_id_from_payload(&payload))
            .ok_or_else(|| AppIpcError::new("not_found", "Runtime thread was not found"))?;
        let metadata_response = self
            .codex_app_server
            .request(
                "thread/read",
                json!({"threadId": thread_id, "includeTurns": false}),
            )
            .await
            .map_err(|error| AppIpcError::new("codex_error", error))?;
        let thread = metadata_response
            .get("thread")
            .cloned()
            .filter(Value::is_object)
            .ok_or_else(|| {
                AppIpcError::new(
                    "codex_error",
                    "thread/read returned a response without thread",
                )
            })?;
        let history_mode = string_field(&thread, "historyMode").unwrap_or_default();
        if history_mode.eq_ignore_ascii_case("paginated") {
            self.paginated_codex_turn_items(
                &local_task_id,
                &thread_id,
                &turn_id,
                thread,
                cursor,
                limit,
            )
            .await
        } else {
            self.legacy_codex_turn_items(
                &local_task_id,
                &thread_id,
                &turn_id,
                thread,
                cursor.skip,
                limit,
            )
            .await
        }
    }

    async fn cached_history_turn_page(&self, payload: Value) -> Result<Value, AppIpcError> {
        let mut response = self.transcript(payload).await?;
        response["messages"] = Value::Array(Vec::new());
        if let Some(turns) = response.get_mut("turns").and_then(Value::as_array_mut) {
            for turn in turns {
                let item_count = turn
                    .get("items")
                    .and_then(Value::as_array)
                    .map(Vec::len)
                    .unwrap_or_default();
                turn["items"] = Value::Array(Vec::new());
                turn["itemsView"] = Value::String("notLoaded".to_owned());
                turn["itemCount"] = json!(item_count);
            }
        }
        response["schemaVersion"] = json!(2);
        Ok(response)
    }

    fn cached_history_turn_items(
        &self,
        link: &RuntimeTaskLink,
        turn_id: &str,
        skip: usize,
        limit: usize,
    ) -> Result<Value, AppIpcError> {
        let messages = cached_runtime_transcript_messages(link);
        let turns = canonical_cached_transcript_turns(&messages);
        let turn = turns
            .into_iter()
            .find(|turn| string_field(turn, "id").as_deref() == Some(turn_id))
            .ok_or_else(|| AppIpcError::new("not_found", "Runtime turn was not found"))?;
        let items = turn
            .get("items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        Ok(history_item_page_response(
            &link.local_task_id,
            turn_id,
            items,
            skip,
            limit,
            None,
        ))
    }

    async fn paginated_codex_turn_items(
        &self,
        local_task_id: &str,
        thread_id: &str,
        turn_id: &str,
        thread: Value,
        cursor: HistoryItemCursor,
        limit: usize,
    ) -> Result<Value, AppIpcError> {
        let response = self
            .codex_app_server
            .request(
                "thread/items/list",
                json!({
                    "threadId": thread_id,
                    "turnId": turn_id,
                    "cursor": cursor.provider_cursor,
                    "limit": ITEM_PROVIDER_PAGE_SIZE,
                    "sortDirection": "asc",
                }),
            )
            .await
            .map_err(|error| AppIpcError::new("codex_error", error))?;
        let entries = response
            .get("data")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let provider_next_cursor = string_field(&response, "nextCursor");
        let mut items = Vec::new();
        let mut response_bytes: usize = 0;
        let mut consumed_entries = cursor.skip.min(entries.len());

        for entry in entries.iter().skip(cursor.skip) {
            if string_field(entry, "turnId").as_deref() != Some(turn_id) {
                return Err(AppIpcError::new(
                    "codex_error",
                    "thread/items/list returned an item for a different turn",
                ));
            }
            let raw_item = entry.get("item").cloned().ok_or_else(|| {
                AppIpcError::new(
                    "codex_error",
                    "thread/items/list returned an entry without item",
                )
            })?;
            let projected =
                project_codex_history_items(&thread, turn_id, raw_item, &self.device_id);
            let projected_bytes = serde_json::to_vec(&projected)
                .map(|value| value.len())
                .unwrap_or_default();
            if !items.is_empty()
                && (items.len().saturating_add(projected.len()) > limit
                    || response_bytes.saturating_add(projected_bytes) > ITEM_PAGE_MAX_BYTES)
            {
                break;
            }
            consumed_entries += 1;
            response_bytes = response_bytes.saturating_add(projected_bytes);
            append_unique_history_items(&mut items, projected);
            if items.len() >= limit || response_bytes >= ITEM_PAGE_MAX_BYTES {
                break;
            }
        }

        let next_cursor = if consumed_entries < entries.len() {
            Some(encode_item_cursor(HistoryItemCursor {
                provider_cursor: cursor.provider_cursor,
                skip: consumed_entries,
            }))
        } else {
            provider_next_cursor.map(|provider_cursor| {
                encode_item_cursor(HistoryItemCursor {
                    provider_cursor: Some(provider_cursor),
                    skip: 0,
                })
            })
        };
        Ok(json!({
            "success": true,
            "schemaVersion": 2,
            "taskId": local_task_id,
            "turnId": turn_id,
            "items": items,
            "hasMore": next_cursor.is_some(),
            "nextCursor": next_cursor,
        }))
    }

    async fn legacy_codex_turn_items(
        &self,
        local_task_id: &str,
        thread_id: &str,
        turn_id: &str,
        thread: Value,
        skip: usize,
        limit: usize,
    ) -> Result<Value, AppIpcError> {
        let turns_response = self
            .codex_app_server
            .request(
                "thread/turns/list",
                json!({
                    "threadId": thread_id,
                    "cursor": Value::Null,
                    "limit": 100,
                    "sortDirection": "desc",
                    "itemsView": "full",
                }),
            )
            .await
            .map_err(|error| AppIpcError::new("codex_error", error))?;
        let turn = turns_response
            .get("data")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find(|turn| string_field(turn, "id").as_deref() == Some(turn_id))
            .cloned()
            .ok_or_else(|| AppIpcError::new("not_found", "Runtime turn was not found"))?;
        let raw_items = turn
            .get("items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let projected = raw_items
            .into_iter()
            .flat_map(|item| project_codex_history_items(&thread, turn_id, item, &self.device_id))
            .collect::<Vec<_>>();
        Ok(history_item_page_response(
            local_task_id,
            turn_id,
            projected,
            skip,
            limit,
            Some("legacy"),
        ))
    }
}

#[derive(Default)]
struct HistoryItemCursor {
    provider_cursor: Option<String>,
    skip: usize,
}

fn project_codex_history_items(
    thread: &Value,
    turn_id: &str,
    raw_item: Value,
    device_id: &str,
) -> Vec<Value> {
    let raw_item_id = string_field(&raw_item, "id").unwrap_or_else(|| "file-change".to_owned());
    let mut projected_thread = thread.clone();
    projected_thread["turns"] = json!([{
        "id": turn_id,
        "items": [raw_item],
    }]);
    let messages = transcript_messages(&projected_thread, device_id);
    let Some(turn) = canonical_codex_transcript_turns(&messages)
        .into_iter()
        .find(|turn| string_field(turn, "id").as_deref() == Some(turn_id))
    else {
        return Vec::new();
    };
    let mut items = turn
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if let Some(file_changes) = turn.get("fileChanges").cloned() {
        let block_id = format!("file-changes-{raw_item_id}");
        items.push(json!({
            "id": block_id,
            "type": "block",
            "block": {
                "id": block_id,
                "type": "file_changes",
                "file_changes": file_changes,
                "status": "done",
            },
        }));
    }
    items
}

fn append_unique_history_items(target: &mut Vec<Value>, items: Vec<Value>) {
    for item in items {
        let item_id = string_field(&item, "id");
        if let Some(position) = item_id.as_ref().and_then(|item_id| {
            target
                .iter()
                .position(|current| string_field(current, "id").as_ref() == Some(item_id))
        }) {
            target[position] = item;
        } else {
            target.push(item);
        }
    }
}

fn history_item_page_response(
    local_task_id: &str,
    turn_id: &str,
    items: Vec<Value>,
    skip: usize,
    limit: usize,
    provider_marker: Option<&str>,
) -> Value {
    let mut page = Vec::new();
    let mut bytes: usize = 0;
    let mut consumed = skip.min(items.len());
    for item in items.iter().skip(skip) {
        let item_bytes = serde_json::to_vec(item)
            .map(|value| value.len())
            .unwrap_or_default();
        if !page.is_empty()
            && (page.len() >= limit || bytes.saturating_add(item_bytes) > ITEM_PAGE_MAX_BYTES)
        {
            break;
        }
        page.push(item.clone());
        consumed += 1;
        bytes = bytes.saturating_add(item_bytes);
    }
    let next_cursor = (consumed < items.len()).then(|| {
        encode_item_cursor(HistoryItemCursor {
            provider_cursor: provider_marker.map(ToOwned::to_owned),
            skip: consumed,
        })
    });
    json!({
        "success": true,
        "schemaVersion": 2,
        "taskId": local_task_id,
        "turnId": turn_id,
        "items": page,
        "hasMore": next_cursor.is_some(),
        "nextCursor": next_cursor,
    })
}

fn encode_item_cursor(cursor: HistoryItemCursor) -> String {
    let payload = json!({
        "providerCursor": cursor.provider_cursor,
        "skip": cursor.skip,
    });
    let encoded = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap_or_default());
    format!("{ITEM_CURSOR_PREFIX}{encoded}")
}

fn decode_item_cursor(value: &str) -> Result<HistoryItemCursor, AppIpcError> {
    let encoded = value
        .strip_prefix(ITEM_CURSOR_PREFIX)
        .ok_or_else(|| AppIpcError::new("bad_request", "Invalid history item cursor"))?;
    let decoded = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| AppIpcError::new("bad_request", "Invalid history item cursor"))?;
    let payload: Value = serde_json::from_slice(&decoded)
        .map_err(|_| AppIpcError::new("bad_request", "Invalid history item cursor"))?;
    Ok(HistoryItemCursor {
        provider_cursor: string_field(&payload, "providerCursor"),
        skip: payload
            .get("skip")
            .and_then(Value::as_u64)
            .and_then(|value| usize::try_from(value).ok())
            .unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_item_cursor_preserves_provider_cursor_and_page_offset() {
        let encoded = encode_item_cursor(HistoryItemCursor {
            provider_cursor: Some("provider-page-2".to_owned()),
            skip: 7,
        });
        let decoded = decode_item_cursor(&encoded).expect("cursor should decode");

        assert_eq!(decoded.provider_cursor.as_deref(), Some("provider-page-2"));
        assert_eq!(decoded.skip, 7);
    }

    #[test]
    fn cached_history_item_page_returns_an_opaque_next_cursor() {
        let response = history_item_page_response(
            "task-1",
            "turn-1",
            vec![
                json!({"id": "item-1"}),
                json!({"id": "item-2"}),
                json!({"id": "item-3"}),
            ],
            0,
            2,
            None,
        );

        assert_eq!(response["items"].as_array().map(Vec::len), Some(2));
        assert_eq!(response["hasMore"], true);
        assert!(response["nextCursor"]
            .as_str()
            .is_some_and(|value| value.starts_with(ITEM_CURSOR_PREFIX)));
    }

    #[test]
    fn history_item_page_never_drops_one_oversized_item() {
        let response = history_item_page_response(
            "task-1",
            "turn-1",
            vec![
                json!({"id": "large", "content": "x".repeat(ITEM_PAGE_MAX_BYTES + 1)}),
                json!({"id": "next"}),
            ],
            0,
            20,
            None,
        );

        assert_eq!(response["items"].as_array().map(Vec::len), Some(1));
        assert_eq!(response["items"][0]["id"], "large");
        assert_eq!(response["hasMore"], true);
    }

    #[test]
    fn codex_file_change_survives_paginated_history_projection() {
        let items = project_codex_history_items(
            &json!({"cwd": "/tmp/project"}),
            "turn-1",
            json!({
                "id": "change-1",
                "type": "fileChange",
                "status": "completed",
                "changes": [{
                    "path": "/tmp/project/created.txt",
                    "kind": {"type": "add"},
                    "diff": "created\n",
                }],
            }),
            "device-1",
        );

        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["type"], "block");
        assert_eq!(items[0]["block"]["type"], "file_changes");
        assert_eq!(
            items[0]["block"]["file_changes"]["files"][0]["path"],
            "created.txt"
        );
    }
}
