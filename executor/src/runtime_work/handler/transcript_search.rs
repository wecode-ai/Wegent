// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::runtime_work::transcript_search_projection::search_ranges;
use crate::runtime_work::transcript_search_text::{
    canonical_turn_search_regions, AsyncReplySearchProjection,
};

const MAX_TRANSCRIPT_SEARCH_MATCHES: usize = 250;
const CACHED_SEARCH_CURSOR_PREFIX: &str = "wework-cached-search:";
const CACHED_CONTEXT_CURSOR_PREFIX: &str = "wework-cached-search-context:";

impl RuntimeWorkRpcHandler {
    pub(super) async fn search_transcript(&self, payload: Value) -> Result<Value, AppIpcError> {
        let task_id = runtime_task_id(&payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "taskId is required"))?;
        let query = string_field(&payload, "query").unwrap_or_default();
        let limit = integer_field(&payload, "limit")
            .and_then(|value| usize::try_from(value).ok())
            .filter(|value| *value > 0)
            .unwrap_or(MAX_TRANSCRIPT_SEARCH_MATCHES)
            .min(MAX_TRANSCRIPT_SEARCH_MATCHES);
        if query.trim().is_empty() {
            return Ok(transcript_search_response(Vec::new(), 0, false));
        }
        let link = self.local_task_link(&task_id);
        let linked_session_id = link.as_ref().and_then(runtime_session_id_from_link);
        let requested_session_id = runtime_session_id_from_payload(&payload);
        let direct_thread_override = requested_session_id
            .as_deref()
            .zip(linked_session_id.as_deref())
            .is_some_and(|(requested, linked)| requested != linked);
        let session_id = requested_session_id.or(linked_session_id);
        let cached_only = link.as_ref().is_some_and(|link| {
            link.ephemeral
                || !runtime_has_provider_transcript_reader(&link.runtime)
                || session_id.is_none()
                || (!direct_thread_override && provider_transcript_is_unmaterialized(link))
        });
        if cached_only {
            let link = link.as_ref().expect("cached search requires a local task");
            let messages = cached_search_messages(link);
            return Ok(search_cached_transcript(&messages, &query, limit));
        }
        let Some(thread_id) = session_id else {
            return Ok(transcript_search_response(Vec::new(), 0, false));
        };
        let client = link
            .as_ref()
            .map(|link| {
                self.codex_app_server
                    .for_request(&runtime_event_request_from_link(link))
            })
            .unwrap_or_else(|| Ok(self.codex_app_server.clone()))
            .map_err(|error| AppIpcError::new("codex_error", error))?;
        let excluded_turn_ids = link
            .as_ref()
            .filter(|_| !direct_thread_override)
            .map(|link| superseded_transcript_turn_ids(&link.runtime_handle))
            .unwrap_or_default();
        let user_content_by_client_id = link
            .as_ref()
            .filter(|_| !direct_thread_override)
            .map(search_user_content_by_client_id)
            .unwrap_or_default();
        crate::runtime_work::codex_transcript_search::search_codex_transcript(
            &client,
            &thread_id,
            &query,
            limit,
            &excluded_turn_ids,
            &user_content_by_client_id,
        )
        .await
        .map_err(|error| AppIpcError::new("transcript_search_failed", error))
    }
}

fn search_user_content_by_client_id(link: &RuntimeTaskLink) -> HashMap<String, String> {
    user_message_presentations(link)
        .iter()
        .filter_map(|presentation| {
            let id = string_field(presentation, "clientUserMessageId")
                .or_else(|| string_field(presentation, "client_user_message_id"))?;
            let content = string_field(presentation, "content").unwrap_or_default();
            user_presentation_restores_content(
                &content,
                !normalized_attachments(presentation.get("attachments")).is_empty(),
            )
            .then_some((id, content))
        })
        .collect()
}

fn cached_search_messages(link: &RuntimeTaskLink) -> Vec<Value> {
    let mut messages = cached_messages(link);
    append_unique_transcript_messages(&mut messages, completed_transcript_messages(link));
    normalize_overload_recovery_messages(&mut messages, &link.runtime_handle);
    remove_superseded_transcript_turns(&mut messages, &link.runtime_handle);
    let mut presentations = user_message_presentations(link);
    for presentation in &mut presentations {
        presentation["ensureVisible"] = json!(false);
    }
    attach_user_message_presentations_for_page(&mut messages, presentations, &[], &[], true, true);
    messages
}

pub(super) fn cached_search_match_response(
    link: &RuntimeTaskLink,
    cursor: &str,
    limit: Option<usize>,
    running: bool,
    after: bool,
) -> Result<Option<Value>, AppIpcError> {
    let continuation = cursor.strip_prefix(CACHED_CONTEXT_CURSOR_PREFIX);
    let Some(value) = continuation.or_else(|| cursor.strip_prefix(CACHED_SEARCH_CURSOR_PREFIX))
    else {
        return Ok(None);
    };
    let id: String = serde_json::from_str(value).map_err(|error| {
        AppIpcError::new(
            "bad_request",
            format!("Invalid cached search cursor: {error}"),
        )
    })?;
    let all_messages = cached_search_messages(link);
    let index = all_messages
        .iter()
        .position(|message| string_field(message, "id").as_deref() == Some(&id))
        .ok_or_else(|| {
            AppIpcError::new(
                "transcript_search_failed",
                "Search message is no longer available",
            )
        })?;
    let limit = limit.unwrap_or(100).clamp(1, 200);
    let (start, end) = if continuation.is_some() {
        if after {
            let start = index + 1;
            (start, start.saturating_add(limit).min(all_messages.len()))
        } else {
            (index.saturating_sub(limit), index)
        }
    } else {
        let start = index.saturating_sub(limit / 2);
        (start, start.saturating_add(limit).min(all_messages.len()))
    };
    let start = if continuation.is_none() {
        cached_reply_source_index(&all_messages, index)
            .unwrap_or(start)
            .min(start)
    } else {
        start
    };
    let (start, end) = cached_search_complete_turn_window(&all_messages, start, end);
    let messages = all_messages[start..end].to_vec();
    let boundary_cursor = |message: Option<&Value>| {
        message.and_then(|message| {
            string_field(message, "id")
                .map(|id| format!("{CACHED_CONTEXT_CURSOR_PREFIX}{}", json!(id)))
        })
    };
    let before_cursor = (start > 0)
        .then(|| boundary_cursor(messages.first()))
        .flatten();
    let after_cursor = (end < all_messages.len())
        .then(|| boundary_cursor(messages.last()))
        .flatten();
    let turn_navigation = transcript_turn_navigation(&messages);
    Ok(Some(transcript_response(TranscriptResponseInput {
        local_task_id: link.local_task_id.clone(),
        workspace_path: link.workspace_path.clone(),
        runtime: link.runtime.clone(),
        messages,
        canonical_turns: None,
        context_usage: None,
        running,
        pagination: TranscriptPagination::Opaque {
            before_cursor,
            after_cursor,
        },
        full_content: true,
        conversation_context_only: false,
        turn_item_source: TranscriptTurnItemSource::CachedMessages,
        turn_navigation,
    })))
}

fn cached_reply_source_index(messages: &[Value], reply_index: usize) -> Option<usize> {
    let (projection, _) = cached_async_reply_search_projection(messages);
    let source = projection.reply_source(messages[reply_index]["id"].as_str()?)?;
    source.parse().ok()
}

fn cached_async_reply_search_projection(
    messages: &[Value],
) -> (AsyncReplySearchProjection, HashMap<String, String>) {
    let mut turns = transcript_canonical_turns(messages, TranscriptTurnItemSource::CachedMessages)
        .into_iter()
        .filter_map(|turn| Some((string_field(&turn, "id")?, turn)))
        .collect::<HashMap<_, _>>();
    let mut item_sources = HashMap::new();
    for (index, message) in messages.iter().enumerate() {
        if message["role"] != "assistant" {
            continue;
        }
        if let Some(id) = string_field(message, "id") {
            item_sources.insert(id, index);
        }
        for block in message["blocks"].as_array().into_iter().flatten() {
            if let Some(id) = string_field(block, "id") {
                item_sources.insert(id, index);
            }
        }
    }
    let mut projection = AsyncReplySearchProjection::default();
    let mut user_texts = HashMap::new();
    for message in messages {
        if let Some(turn_id) = transcript_message_turn_id(message) {
            if let Some(turn) = turns.remove(&turn_id) {
                cached_turn_reply_projection(
                    &turn,
                    &item_sources,
                    &mut projection,
                    &mut user_texts,
                );
            }
        } else if message["role"] == "user" {
            if let (Some(id), Some(text)) = (
                string_field(message, "id"),
                projection.message_text(message, ""),
            ) {
                user_texts.insert(id, text);
            }
        }
    }
    (projection, user_texts)
}

// The renderer associates replies after merging each canonical assistant segment.
fn cached_turn_reply_projection(
    turn: &Value,
    item_sources: &HashMap<String, usize>,
    projection: &mut AsyncReplySearchProjection,
    user_texts: &mut HashMap<String, String>,
) {
    let Some(items) = turn["items"].as_array() else {
        return;
    };
    for segment in items.split_inclusive(|item| item["type"] == "user_message") {
        let source = segment
            .iter()
            .filter_map(|item| item_sources.get(item["id"].as_str()?))
            .min();
        if let Some(source) = source {
            let blocks = segment
                .iter()
                .filter(|item| item["type"] == "block")
                .map(|item| item["block"].clone())
                .collect::<Vec<_>>();
            projection.message_text(
                &json!({"role":"assistant", "blocks":blocks}),
                &source.to_string(),
            );
        }
        if let Some(message) = segment
            .last()
            .filter(|item| item["type"] == "user_message")
            .map(|item| &item["message"])
        {
            if let (Some(id), Some(text)) = (
                string_field(message, "id"),
                projection.message_text(message, ""),
            ) {
                user_texts.insert(id, text);
            }
        }
    }
}

fn cached_search_complete_turn_window(
    messages: &[Value],
    mut start: usize,
    mut end: usize,
) -> (usize, usize) {
    let mut turn_ranges = HashMap::<String, (usize, usize)>::new();
    for (index, message) in messages.iter().enumerate() {
        if let Some(turn_id) = transcript_message_turn_id(message) {
            turn_ranges.entry(turn_id).or_insert((index, index + 1)).1 = index + 1;
        }
    }
    // Every returned turn needs its full projection, including adjacent context turns.
    // Enqueue only newly covered intervals so interleaved turns scan each message once.
    let mut pending = vec![(start, end)];
    while let Some((scan_start, scan_end)) = pending.pop() {
        for message in &messages[scan_start..scan_end] {
            let Some(turn_id) = transcript_message_turn_id(message) else {
                continue;
            };
            let &(turn_start, turn_end) = turn_ranges
                .get(&turn_id)
                .expect("all canonical turns have indexed boundaries");
            if turn_start < start {
                pending.push((turn_start, start));
                start = turn_start;
            }
            if turn_end > end {
                pending.push((end, turn_end));
                end = turn_end;
            }
        }
    }
    (start, end)
}

fn transcript_search_response(matches: Vec<Value>, total: usize, capped: bool) -> Value {
    json!({
        "success": true,
        "matches": matches,
        "totalMatches": total,
        "isCapped": capped,
    })
}

fn search_cached_transcript(messages: &[Value], query: &str, limit: usize) -> Value {
    if query.trim().is_empty() {
        return transcript_search_response(Vec::new(), 0, false);
    }
    let (projection, mut user_texts) = cached_async_reply_search_projection(messages);
    let mut normalized = messages.to_vec();
    let mut source_by_item = HashMap::new();
    for (index, message) in normalized.iter_mut().enumerate() {
        let Some(id) = string_field(message, "id") else {
            continue;
        };
        if transcript_message_turn_id(message).is_none() {
            message["turnId"] = json!(format!("cached-search-message-{index}"));
            message.as_object_mut().unwrap().remove("runtimeStatus");
        }
        source_by_item.insert(id.clone(), index);
        if let Some(alias) = string_field(message, "clientUserMessageId")
            .or_else(|| string_field(message, "client_user_message_id"))
        {
            source_by_item.insert(alias.clone(), index);
            if let Some(text) = user_texts.get(&id).cloned() {
                user_texts.insert(alias, text);
            }
        }
        for item in message["runtimeItems"]
            .as_array()
            .into_iter()
            .flatten()
            .chain(message["blocks"].as_array().into_iter().flatten())
        {
            if let Some(item_id) = string_field(item, "id") {
                source_by_item.insert(item_id, index);
            }
        }
    }
    let mut matches = Vec::new();
    let mut total = 0;
    for turn in transcript_canonical_turns(&normalized, TranscriptTurnItemSource::CachedMessages) {
        for region in canonical_turn_search_regions(&turn, &user_texts) {
            let Some(&source_index) = source_by_item.get(&region.id) else {
                continue;
            };
            let message = &messages[source_index];
            let Some(message_id) = string_field(message, "id") else {
                continue;
            };
            let ranges = search_ranges(&region.text, query);
            total += ranges.len();
            for (occurrence, range) in ranges
                .into_iter()
                .take(limit.saturating_sub(matches.len()))
                .enumerate()
            {
                let mut item = json!({
                    "itemId": region.id, "regionId": region.id, "range":range,
                    "occurrence": occurrence,
                    "cursor": format!("{CACHED_SEARCH_CURSOR_PREFIX}{}", json!(message_id)),
                });
                if let Some(turn_id) = transcript_message_turn_id(message) {
                    item["turnId"] = json!(turn_id);
                }
                if message["role"] == "user" {
                    item["messageId"] = json!(region.id);
                    if let Some(questions) = projection.reply_questions(&message_id) {
                        item["replyQuestions"] = json!(questions);
                    }
                }
                matches.push(item);
            }
        }
    }
    let capped = total > matches.len();
    transcript_search_response(matches, total, capped)
}

#[cfg(test)]
#[path = "transcript_search_hydration_tests.rs"]
mod hydration_tests;

#[cfg(test)]
mod tests {
    #[test]
    fn cached_search_obeys_shared_projection_contract() {
        use crate::runtime_work::transcript_search_projection::contract_tests::*;
        for case in cases() {
            let messages = cached_messages(&case);
            let (_, user_texts) = cached_async_reply_search_projection(&messages);
            let regions =
                transcript_canonical_turns(&messages, TranscriptTurnItemSource::CachedMessages)
                    .iter()
                    .flat_map(|turn| canonical_turn_search_regions(turn, &user_texts))
                    .collect::<Vec<_>>();
            assert_regions(&case, &regions);
            for query in case["queries"].as_array().unwrap() {
                let response =
                    search_cached_transcript(&messages, query["query"].as_str().unwrap(), 250);
                assert_matches(&case, query, &response["matches"]);
                assert_eq!(
                    response["totalMatches"],
                    query["matches"].as_array().unwrap().len()
                );
                for matched in response["matches"].as_array().unwrap() {
                    let cursor: String = serde_json::from_str(
                        matched["cursor"]
                            .as_str()
                            .unwrap()
                            .strip_prefix(CACHED_SEARCH_CURSOR_PREFIX)
                            .unwrap(),
                    )
                    .unwrap();
                    assert!(messages.iter().any(|message| message["id"] == cursor));
                }
            }
        }
    }

    use super::*;

    #[test]
    fn search_user_content_matches_transcript_presentation_restoration() {
        let link = RuntimeTaskLink {
            runtime_handle: json!({"userMessagePresentations":[
                {"clientUserMessageId":"attachment-user", "content":"visible request",
                 "attachments":[{"filename":"notes.md"}]},
                {"clientUserMessageId":"empty-user", "content":"",
                 "attachments":[{"filename":"notes.md"}]},
                {"clientUserMessageId":"ordinary-user", "content":"original request"},
            ]}),
            ..RuntimeTaskLink::default()
        };
        let content_by_id = search_user_content_by_client_id(&link);
        assert_eq!(content_by_id.len(), 2);
        for (id, expected) in &content_by_id {
            let mut messages = vec![json!({
                "id":"provider-user", "role":"user", "clientUserMessageId":id,
                "content":"injected attachment preview",
            })];
            attach_user_message_presentations(&mut messages, user_message_presentations(&link));
            assert_eq!(messages[0]["content"].as_str(), Some(expected.as_str()));
        }
    }

    #[test]
    fn cached_search_uses_the_restored_body_for_matching_and_hydration() {
        let link = RuntimeTaskLink {
            runtime_handle: json!({
                "messages":[{
                    "id":"provider-user", "role":"user", "clientUserMessageId":"client-user",
                    "content":"needle\n# User-provided text attachments\nMIME Type: text/markdown",
                }],
                "userMessagePresentations":[{
                    "clientUserMessageId":"client-user", "content":"needle needle",
                    "attachments":[{"filename":"notes.md"}],
                }],
            }),
            ..RuntimeTaskLink::default()
        };
        let messages = cached_search_messages(&link);
        assert_eq!(
            search_cached_transcript(&messages, "markdown", 250)["totalMatches"],
            0
        );
        let result = search_cached_transcript(&messages, "needle", 250);
        assert_eq!(result["totalMatches"], 2);
        let response = cached_search_match_response(
            &link,
            result["matches"][1]["cursor"].as_str().unwrap(),
            Some(5),
            false,
            false,
        )
        .unwrap()
        .unwrap();
        assert_eq!(response["messages"][0]["content"], "needle needle");
    }

    #[test]
    fn cached_search_is_bounded_and_does_not_publish_stored_content() {
        let messages = (0..300)
            .map(|index| {
                json!({
                    "id": format!("assistant-{index}"), "turnId": format!("turn-{index}"),
                    "role": "assistant", "content": "visible needle",
                    "blocks": [{"id":"tool", "type":"tool", "content":"needle"}],
                })
            })
            .collect::<Vec<_>>();
        let result = search_cached_transcript(&messages, "NEEDLE", 250);
        assert_eq!(result["matches"].as_array().unwrap().len(), 250);
        assert_eq!(result["totalMatches"], 300);
        assert_eq!(result["isCapped"], true);
        assert_eq!(result["matches"][0]["itemId"], "assistant-0");
        assert_eq!(
            result["matches"][0]["cursor"],
            "wework-cached-search:\"assistant-0\""
        );
        assert!(result["matches"][0].get("content").is_none());
    }

    #[test]
    fn cached_search_ignores_hidden_context_and_keeps_user_presentation_identity() {
        let messages = vec![json!({
            "id":"provider-user", "clientUserMessageId":"client-user", "turnId":"turn-1",
            "role":"user", "content":"<application_context>needle</application_context>Visible",
        })];
        let hidden = search_cached_transcript(&messages, "needle", 250);
        assert_eq!(hidden["totalMatches"], 0);
        let visible = search_cached_transcript(&messages, "Visible", 250);
        assert_eq!(visible["matches"][0]["messageId"], "client-user");
        assert_eq!(visible["matches"][0]["itemId"], "client-user");
    }

    #[test]
    fn cached_search_uses_rendered_markdown_and_ignores_whitespace_queries() {
        let messages = vec![json!({
            "id":"assistant", "role":"assistant",
            "content":"[needle](https://hidden.example/needle) ![needle](image.png)\u{e200}cite\u{e202}needle\u{e201}",
        })];
        assert_eq!(
            search_cached_transcript(&messages, "needle", 250)["totalMatches"],
            1
        );
        assert_eq!(
            search_cached_transcript(&messages, "  ", 250)["totalMatches"],
            0
        );
    }

    #[test]
    fn cached_search_ignores_hidden_failed_final_content() {
        for content in [
            "needle",
            "API error: needle",
            "Task failed: needle",
            "ERROR: needle",
            r#"{"error": "needle"}"#,
            r#"{"error_type": "needle"}"#,
            r#"{"error_code": "needle"}"#,
            "status: failed needle",
            "type: FAILED needle",
            "::archive-thread{}\nAPI error: needle",
        ] {
            let message = json!({
                "id":"failed", "turnId":"failed-turn", "role":"assistant",
                "status":"FAILED", "content":content, "error":"needle",
            });
            assert_eq!(
                search_cached_transcript(&[message], "needle", 250)["totalMatches"],
                0,
                "hidden failed content was indexed: {content}",
            );
        }
    }

    #[test]
    fn cached_search_uses_canonical_status_precedence_only_for_turns() {
        for (status, runtime_status, expected) in [
            ("failed", json!("done"), 1),
            ("done", json!("FAILED"), 0),
            ("failed", Value::Null, 0),
            ("failed", json!(""), 1),
        ] {
            let mut message = json!({
                "id":"assistant", "turnId":"turn", "role":"assistant",
                "status":status, "runtimeStatus":runtime_status,
                "content":"API error: needle", "error":"needle",
            });
            assert_eq!(
                search_cached_transcript(&[message.clone()], "needle", 250)["totalMatches"],
                expected,
                "canonical turn status={status}, runtimeStatus={runtime_status}",
            );
            message.as_object_mut().unwrap().remove("turnId");
            assert_eq!(
                search_cached_transcript(&[message], "needle", 250)["totalMatches"],
                if status == "failed" { 0 } else { 1 },
                "unkeyed runtime message must use status={status}",
            );
        }
    }

    #[test]
    fn cached_search_applies_failed_visibility_to_joined_turn_content() {
        let mut messages = vec![
            json!({
                "id":"partial", "turnId":"turn", "role":"assistant",
                "status":"done", "content":"Useful partial response",
            }),
            json!({
                "id":"final", "turnId":"turn", "role":"assistant",
                "status":"failed", "content":"API error: needle", "error":"needle",
            }),
        ];
        let result = search_cached_transcript(&messages, "needle", 250);
        assert_eq!(result["totalMatches"], 1);
        assert_eq!(result["matches"][0]["itemId"], "partial");
        assert_eq!(
            result["matches"][0]["cursor"],
            format!("{CACHED_SEARCH_CURSOR_PREFIX}\"partial\"")
        );

        messages[0]["content"] = json!("::archive-thread{}\nAPI error: first needle");
        messages[1]["content"] = json!("Useful partial needle response");
        assert_eq!(
            search_cached_transcript(&messages, "needle", 250)["totalMatches"],
            0
        );
        messages[1]["blocks"] = json!([
            {"id":"commentary", "type":"text", "content":"Visible commentary needle"},
        ]);
        let result = search_cached_transcript(&messages, "needle", 250);
        assert_eq!(result["totalMatches"], 1);
        assert_eq!(result["matches"][0]["itemId"], "commentary");
    }

    #[test]
    fn cached_search_keeps_early_assistant_segment_before_guidance_visible() {
        let messages = vec![
            json!({
                "id":"early", "turnId":"turn", "role":"assistant",
                "status":"failed", "content":"API error: early needle", "error":"needle",
            }),
            json!({
                "id":"guidance", "turnId":"turn", "role":"user",
                "status":"done", "runtimeGuidance":true, "content":"Please continue",
            }),
            json!({
                "id":"final", "turnId":"turn", "role":"assistant",
                "status":"failed", "content":"API error: final needle", "error":"needle",
            }),
        ];
        let result = search_cached_transcript(&messages, "needle", 250);
        assert_eq!(result["totalMatches"], 1);
        assert_eq!(result["matches"][0]["itemId"], "early");
        assert_eq!(
            result["matches"][0]["cursor"],
            format!("{CACHED_SEARCH_CURSOR_PREFIX}\"early\"")
        );
    }

    #[test]
    fn cached_search_deduplicates_text_blocks_against_joined_segment_content() {
        let messages = vec![
            json!({
                "id":"first", "turnId":"turn", "role":"assistant",
                "status":"done", "content":"First needle",
            }),
            json!({
                "id":"last", "turnId":"turn", "role":"assistant",
                "status":"done", "content":"Last needle",
                "blocks":[{"id":"duplicate", "type":"text", "content":"First needle\n\nLast needle"}],
            }),
        ];
        let result = search_cached_transcript(&messages, "needle", 250);
        assert_eq!(result["totalMatches"], 2);
        assert_eq!(result["matches"][0]["itemId"], "first");
        assert_eq!(result["matches"][1]["itemId"], "first");
        assert_eq!(result["matches"][1]["occurrence"], 1);
    }

    #[test]
    fn cached_search_keeps_visible_prose_and_blocks_in_failed_messages() {
        let mut message = json!({
            "id":"failed", "turnId":"failed-turn", "role":"assistant",
            "status":"failed", "content":"API error: needle", "error":" ",
            "blocks":[{"id":"commentary", "type":"text", "content":"API error: needle"}],
        });
        let result = search_cached_transcript(&[message.clone()], "needle", 250);
        assert_eq!(result["totalMatches"], 1);
        assert_eq!(result["matches"][0]["itemId"], "commentary");

        message["content"] = json!("Useful partial needle response");
        message["blocks"] = json!([]);
        assert_eq!(
            search_cached_transcript(&[message.clone()], "needle", 250)["totalMatches"],
            1
        );
        for error in [Value::Null, json!("")] {
            message["content"] = json!("API error: needle");
            message["error"] = error;
            assert_eq!(
                search_cached_transcript(&[message.clone()], "needle", 250)["totalMatches"],
                1
            );
        }
    }

    #[test]
    fn cached_search_ignores_only_cancelled_placeholder_content() {
        for content in ["interrupted", " Cancelled ", "CANCELED", "aborted"] {
            let mut message = json!({
                "id":"cancelled", "turnId":"cancelled-turn", "role":"assistant",
                "status":"cancelled", "content":content,
            });
            let query = content.trim();
            assert_eq!(
                search_cached_transcript(&[message.clone()], query, 250)["totalMatches"],
                0
            );
            message["status"] = json!("done");
            assert_eq!(
                search_cached_transcript(&[message.clone()], query, 250)["totalMatches"],
                1
            );
            message["status"] = json!("cancelled");
            message["content"] = json!(format!("The operation was {query}"));
            assert_eq!(
                search_cached_transcript(&[message], query, 250)["totalMatches"],
                1
            );
        }
    }

    #[test]
    fn cached_search_hydrates_a_bounded_stable_window_for_ephemeral_codex() {
        let mut link = RuntimeTaskLink {
            local_task_id: "cached-task".to_owned(),
            thread_id: Some("thread-1".to_owned()),
            runtime: "codex".to_owned(),
            ephemeral: true,
            runtime_handle: json!({
                "messages": (0..300).map(|index| json!({
                    "id":format!("message-{index}"), "turnId":format!("turn-{index}"),
                    "role":"assistant", "content":"other prose",
                })).collect::<Vec<_>>(),
                "completedTranscriptThreadId":"thread-1",
                "completedTranscriptMessages":[{
                    "id":"completed", "turnId":"completed-turn", "role":"assistant",
                    "content":"needle", "blocks":[{"id":"duplicate","type":"text","content":" needle "}],
                }],
                "userMessagePresentations":[{
                    "clientUserMessageId":"unrelated-prompt", "content":"unrelated", "ensureVisible":true,
                }],
            }),
            ..RuntimeTaskLink::default()
        };
        let result = search_cached_transcript(&cached_search_messages(&link), "needle", 250);
        assert_eq!(result["totalMatches"], 1);
        let cursor = result["matches"][0]["cursor"].as_str().unwrap();
        link.runtime_handle["messages"]
            .as_array_mut()
            .unwrap()
            .insert(
                0,
                json!({
                    "id":"new-first", "turnId":"new-turn", "role":"user", "content":"new prompt",
                }),
            );
        let response = cached_search_match_response(&link, cursor, Some(3), false, false)
            .unwrap()
            .unwrap();
        let messages = response["messages"].as_array().unwrap();
        assert!(messages.len() <= 3);
        assert!(messages.iter().any(|message| message["id"] == "completed"));
        assert!(!messages
            .iter()
            .any(|message| message["id"] == "unrelated-prompt"));
        assert_eq!(response["fullContent"], true);
        assert_eq!(response["hasMoreBefore"], true);
        assert_eq!(response["hasMoreAfter"], false);
        assert!(response["turns"].as_array().unwrap().iter().any(|turn| {
            turn["items"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item["id"] == "completed")
        }));
    }

    #[test]
    fn cached_search_context_pages_continue_without_repeating_the_anchor() {
        let link = RuntimeTaskLink {
            runtime_handle: json!({"messages": (0..9).map(|index| json!({
                "id":format!("message-{index}"), "role":"assistant",
                "turnId":format!("turn-{index}"), "content":"needle",
            })).collect::<Vec<_>>()}),
            ..RuntimeTaskLink::default()
        };
        let initial = cached_search_match_response(
            &link,
            "wework-cached-search:\"message-4\"",
            Some(3),
            false,
            false,
        )
        .unwrap()
        .unwrap();
        let ids = |page: &Value| {
            page["messages"]
                .as_array()
                .unwrap()
                .iter()
                .map(|message| message["id"].as_str().unwrap().to_owned())
                .collect::<Vec<_>>()
        };
        assert_eq!(ids(&initial), ["message-3", "message-4", "message-5"]);
        for (field, after, expected) in [
            (
                "beforeCursor",
                false,
                ["message-0", "message-1", "message-2"],
            ),
            ("afterCursor", true, ["message-6", "message-7", "message-8"]),
        ] {
            let page = cached_search_match_response(
                &link,
                initial[field].as_str().unwrap(),
                Some(3),
                false,
                after,
            )
            .unwrap()
            .unwrap();
            assert_eq!(ids(&page), expected);
            assert_eq!(
                page[if after {
                    "hasMoreAfter"
                } else {
                    "hasMoreBefore"
                }],
                false
            );
        }
    }
}
