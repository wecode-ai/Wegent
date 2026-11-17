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
    let active_turn_id = crate::runtime_work::lifecycle::native_execution_state(link)
        .and_then(|state| state.turn_id);
    completed_transcript_messages(link)
        .into_iter()
        .filter_map(|mut message| {
            let source = message["runtimeItems"].as_array()?;
            let turn_id = message["turnId"].as_str().unwrap_or_default();
            let native_turn = native_turns.iter().find(|turn| turn["id"] == turn_id);
            let command_is_current =
                page_turns.contains(turn_id) || active_turn_id.as_deref() == Some(turn_id);
            let is_page_overlay = |item: &Value| {
                page_turns.contains(turn_id)
                    && (is_runtime_user_interaction(item, turn_id)
                        || (item["type"] == "block"
                            && item["block"]["tool_name"] == "auto_approval_review"))
            };
            if message["role"] != "assistant"
                || !source.iter().any(|item| {
                    (command_is_current && is_running_runtime_command(item))
                        || is_page_overlay(item)
                })
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
                        || (command_is_current
                            && is_running_runtime_command(item)
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
            // Runtime overlays own execution artifacts, never native turn outcomes.
            if let Some(native) = native_turn.filter(|turn| turn["status"].is_string()) {
                for key in [
                    "status",
                    "runtimeStatus",
                    "error",
                    "errorType",
                    "stoppedNotice",
                    "startedAt",
                    "completedAt",
                    "durationMs",
                ] {
                    if let Some(value) = native.get(key) {
                        message[key] = value.clone();
                    } else {
                        message.as_object_mut()?.remove(key);
                    }
                }
            }
            Some(message)
        })
        .collect()
}

pub(super) fn is_running_runtime_command(item: &Value) -> bool {
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

pub(super) fn is_runtime_user_interaction(item: &Value, turn_id: &str) -> bool {
    let payload = &item["block"]["render_payload"];
    item["type"] == "block"
        && payload["kind"] == "request_user_input"
        && payload.get("interactionStatus").is_some()
        && payload["interactionScope"] == turn_id
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cached_commands_cannot_resurrect_off_page_failures_or_native_outcomes() {
        let command = json!({"id":"command","type":"block","block":{
            "id":"command","type":"tool","tool_name":"bash","status":"pending",
            "render_payload":{"kind":"command_execution","status":"inProgress"}
        }});
        let interaction = json!({"id":"question","type":"block","block":{
            "id":"question","type":"tool","tool_name":"request_user_input","status":"done",
            "render_payload":{"kind":"request_user_input","interactionScope":"old",
                "interactionStatus":"answered"}
        }});
        let link = RuntimeTaskLink {
            thread_id: Some("thread".into()),
            runtime_handle: json!({"completedTranscriptThreadId":"thread","completedTranscriptMessages":[{
                "id":"cached","turnId":"old","role":"assistant","content":"",
                "status":"failed","error":"stale quota","errorType":"quota_exceeded",
                "runtimeItems":[command, interaction]
            }]}),
            ..Default::default()
        };
        assert!(runtime_transcript_overlay_turns(&link, &[]).is_empty());
        assert!(
            runtime_transcript_overlay_turns(&link, &[json!({"id":"new","items":[]})]).is_empty()
        );
        let turns = runtime_transcript_overlay_turns(
            &link,
            &[json!({
                "id":"old","status":"completed","items":[{"id":"command","type":"block","block":{"id":"command","type":"tool","status":"done"}}]
            })],
        );
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0]["status"], "completed");
        assert!(turns[0]["error"].is_null());
        assert!(turns[0]["errorType"].is_null());
        assert_eq!(turns[0]["items"].as_array().unwrap().len(), 2);
        assert_eq!(turns[0]["items"][0]["id"], "command");
        assert_eq!(turns[0]["items"][0]["block"]["status"], "done");
        assert_eq!(turns[0]["items"][1]["id"], "question");
    }
}
