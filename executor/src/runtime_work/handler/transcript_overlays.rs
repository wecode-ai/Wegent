// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

// Codex owns historical text/order; Executor owns live commands, answers and approval evidence.
pub(super) fn runtime_transcript_overlay_turns(
    link: &RuntimeTaskLink,
    native_turns: &[Value],
) -> Vec<Value> {
    let mut messages = runtime_transcript_overlay_messages(link, native_turns);
    remove_superseded_transcript_turns(&mut messages, &link.runtime_handle);
    transcript_canonical_turns(&messages, TranscriptTurnItemSource::CachedMessages)
}

fn runtime_transcript_overlay_messages(
    link: &RuntimeTaskLink,
    native_turns: &[Value],
) -> Vec<Value> {
    let page_turns = native_turns
        .iter()
        .filter_map(|turn| turn["id"].as_str())
        .collect::<std::collections::HashSet<_>>();
    let native_items = native_turns
        .iter()
        .flat_map(|turn| {
            turn["items"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(move |item| Some(((turn["id"].as_str()?, item["id"].as_str()?), item)))
        })
        .collect::<std::collections::HashMap<_, _>>();
    completed_transcript_messages(link)
        .into_iter()
        .filter_map(|mut message| {
            let source = message["runtimeItems"].as_array()?;
            let turn_id = message["turnId"].as_str().unwrap_or_default();
            let is_page_overlay = |item: &Value| {
                page_turns.contains(turn_id)
                    && (is_runtime_user_interaction(item, turn_id)
                        || (item["type"] == "block"
                            && item["block"]["tool_name"] == "auto_approval_review"))
            };
            if message["role"] != "assistant"
                || !source
                    .iter()
                    .any(|item| is_running_runtime_command(item) || is_page_overlay(item))
            {
                return None;
            }
            let items = source
                .iter()
                .filter_map(|item| {
                    let native = item["id"]
                        .as_str()
                        .and_then(|id| native_items.get(&(turn_id, id)))
                        .copied();
                    if is_page_overlay(item)
                        || (is_running_runtime_command(item)
                            && !native.is_some_and(|native| {
                                matches!(
                                    native.pointer("/block/status").and_then(Value::as_str),
                                    Some("done" | "error")
                                )
                            }))
                    {
                        let mut runtime = item.clone();
                        if let Some(position) = native.and_then(|item| item.get("position")) {
                            runtime["position"] = position.clone();
                        }
                        Some(runtime)
                    } else {
                        // Use current native values only. These identities witness the command's
                        // observed neighbors without replaying historical cached text into a page.
                        native.cloned()
                    }
                })
                .collect::<Vec<_>>();
            message["runtimeItems"] = json!(items);
            Some(message)
        })
        .collect()
}

fn is_running_runtime_command(item: &Value) -> bool {
    item["type"] == "block"
        && item
            .pointer("/block/render_payload/kind")
            .and_then(Value::as_str)
            == Some("command_execution")
        && item
            .pointer("/block/render_payload/status")
            .and_then(Value::as_str)
            == Some("inProgress")
        && !matches!(
            item.pointer("/block/status").and_then(Value::as_str),
            Some("done" | "error")
        )
}

fn is_runtime_user_interaction(item: &Value, turn_id: &str) -> bool {
    let payload = &item["block"]["render_payload"];
    item["type"] == "block"
        && payload["kind"] == "request_user_input"
        && payload.get("interactionStatus").is_some()
        && payload["interactionScope"] == turn_id
}
