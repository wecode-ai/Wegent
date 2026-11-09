// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Legacy threads expose no item-list API. Page their canonical rollout projection.
use super::*;
use crate::local::app_ipc::AppIpcError;
use crate::runtime_work::transcript_work::{self, Cancellation};

const PAGE_CURSOR_PREFIX: &str = "wework-codex-legacy-page:";
const PAGE_BYTES: usize = 2 * 1024 * 1024;

pub(in crate::runtime_work) fn is_legacy_page_cursor(cursor: &str) -> bool {
    cursor.starts_with(PAGE_CURSOR_PREFIX)
}

pub(in crate::runtime_work) async fn load_legacy_transcript_page(
    mut thread: Value,
    cursor: Option<&str>,
    direction: CodexTranscriptDirection,
    turn_limit: usize,
) -> Result<CodexTranscriptPage, AppIpcError> {
    let cursor = cursor
        .map(|cursor| {
            let encoded = cursor
                .strip_prefix(PAGE_CURSOR_PREFIX)
                .ok_or_else(|| failed("Invalid legacy transcript page cursor"))?;
            serde_json::from_str::<LegacySearchCursor>(encoded).map_err(failed)
        })
        .transpose()?;
    let path = string_field(&thread, "path")
        .ok_or_else(|| failed("Legacy Codex history has no rollout path"))?;
    transcript_work::run(move |cancellation| {
        let file = File::open(path).map_err(failed)?;
        let mut page = read_page(
            BufReader::new(file),
            cursor.as_ref(),
            direction,
            turn_limit,
            cancellation,
        )?;
        if let Some(usage) = page.thread.get_mut("tokenUsage") {
            thread["tokenUsage"] = usage.take();
        }
        thread["turns"] = page.thread["turns"].take();
        thread["timeline"] = json!(true);
        thread["rolloutContextIndexed"] = json!(true);
        page.thread = thread;
        Ok(page)
    })
    .await
}

fn read_page(
    reader: impl BufRead,
    cursor: Option<&LegacySearchCursor>,
    direction: CodexTranscriptDirection,
    turn_limit: usize,
    cancellation: &Cancellation,
) -> Result<CodexTranscriptPage, AppIpcError> {
    let mut reducer = LegacyProjection::new();
    let mut window = ContextWindow::new(Some(direction), turn_limit, None, None);
    if cursor.is_none() {
        window.capture_native = true;
    }
    let mut bytes = 0;
    let mut context_usage = None;
    let result = scan(reader, 0, |record, offset| {
        cancellation.check().map_err(|error| error.message)?;
        if let Some(usage) = crate::runtime_work::codex_rollout::record_context_usage(&record) {
            context_usage = Some(usage);
        }
        reducer.capture_native = window.capture_native;
        let reduced = reducer.handle(&record, offset);
        if let Some(retained) = reduced.rollback_from {
            // An initial forward page uses an internal budget anchor, not a
            // caller-owned cursor that a rollback can invalidate.
            if cursor.is_none() && window.anchor_turn.is_some_and(|index| index >= retained) {
                window.anchor_turn = None;
            }
            window.rollback(retained, cursor.map_or(0, |cursor| cursor.byte_offset))?;
            if cursor.is_none() && window.anchor_turn.is_none() {
                window.capture_native = true;
            }
            bytes = window_bytes(&window)?;
        }
        if let Some(item) = reduced.item {
            select_item(&reducer, &mut window, item, cursor, &mut bytes)?;
        }
        // Read completion and rollback metadata beyond the bounded body window.
        Ok(true)
    });
    cancellation.check()?;
    result.map_err(failed)?;
    if let Some(cursor) = cursor {
        let valid = window
            .anchor_turn
            .and_then(|index| reducer.turns.get(index));
        if !valid.is_some_and(|turn| {
            turn.id == cursor.turn_id && turn.item_ids.contains_key(&cursor.item_id)
        }) {
            return Err(failed("Legacy transcript page is no longer available"));
        }
    } else if direction == CodexTranscriptDirection::Descending {
        window.retain_recent_turns();
    }
    let mut page = context_page(&reducer, window).map_err(failed)?;
    if let Some(usage) = context_usage {
        page.thread["tokenUsage"] = usage;
    }
    for value in [&mut page.before_cursor, &mut page.after_cursor]
        .into_iter()
        .flatten()
    {
        *value = value.replacen(CONTEXT_CURSOR_PREFIX, PAGE_CURSOR_PREFIX, 1);
    }
    mark_partial_turns(&mut page.thread, direction);
    Ok(page)
}

fn select_item(
    reducer: &LegacyProjection,
    window: &mut ContextWindow,
    item: ProjectedText,
    cursor: Option<&LegacySearchCursor>,
    bytes: &mut usize,
) -> Result<(), String> {
    let turn = &reducer.turns[item.turn_index];
    let selected = cursor.is_some_and(|cursor| {
        item.byte_offset == cursor.byte_offset
            && item.id == cursor.item_id
            && turn.id == cursor.turn_id
    });
    let mut native = item.native;
    if native.is_object() {
        native["position"] = json!(item.byte_offset);
    }
    let item = ContextItem {
        turn_index: item.turn_index,
        cursor: LegacySearchCursor {
            turn_id: turn.id.clone(),
            item_id: item.id,
            byte_offset: item.byte_offset,
            reply_source_turn_id: None,
        },
        native,
    };
    if selected {
        window.select_anchor(item);
        *bytes = window_bytes(window)?;
    } else if window.capture_native {
        let size = item_bytes(&item)?;
        if cursor.is_none() && window.direction == Some(CodexTranscriptDirection::Ascending) {
            window.anchor_turn.get_or_insert(item.turn_index);
        }
        if window.anchor_turn.is_some() && !window.items.is_empty() && *bytes + size > PAGE_BYTES {
            window.capture_native = false;
            return Ok(());
        }
        let offset = item.cursor.byte_offset;
        let previous_count = window.items.len();
        let evicted_bytes = if previous_count >= CONTEXT_PAGE_SIZE {
            window
                .items
                .front()
                .map(item_bytes)
                .transpose()?
                .unwrap_or(0)
        } else {
            0
        };
        window.capture(item, cursor.map_or(0, |cursor| cursor.byte_offset));
        if window
            .items
            .back()
            .is_some_and(|item| item.cursor.byte_offset == offset)
        {
            *bytes += size;
            if window.items.len() == previous_count {
                *bytes -= evicted_bytes;
            }
        }
        while window.items.len() > 1 && *bytes > PAGE_BYTES {
            *bytes -= item_bytes(&window.items.pop_front().unwrap())?;
        }
    }
    Ok(())
}

fn window_bytes(window: &ContextWindow) -> Result<usize, String> {
    window
        .items
        .iter()
        .try_fold(0, |bytes, item| item_bytes(item).map(|size| bytes + size))
}

fn item_bytes(item: &ContextItem) -> Result<usize, String> {
    serde_json::to_vec(&item.native)
        .map(|value| value.len())
        .map_err(|error| error.to_string())
}

fn mark_partial_turns(thread: &mut Value, direction: CodexTranscriptDirection) {
    for turn in thread["turns"].as_array_mut().into_iter().flatten() {
        let items = turn["items"].as_array().unwrap();
        let owns_user = items.iter().any(|item| item_type(item) == "usermessage");
        let position = items.first().map(|item| item["position"].clone());
        turn["ownsUserPresentation"] = json!(owns_user);
        turn["position"] = position.unwrap_or(Value::Null);
        turn["timelineCompleted"] = json!(turn["status"] != "inProgress");
        turn["itemsView"] = json!("summary");
        if direction == CodexTranscriptDirection::Descending {
            turn["itemMerge"] = json!("prepend");
        }
    }
}

fn failed(error: impl std::fmt::Display) -> AppIpcError {
    AppIpcError::new(
        "codex_error",
        format!("Cannot page legacy Codex history: {error}"),
    )
}

#[cfg(test)]
#[path = "page/tests.rs"]
mod tests;
