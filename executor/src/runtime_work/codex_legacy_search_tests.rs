// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::io::Cursor;

use super::*;

fn event(payload: Value) -> Value {
    json!({"type":"event_msg", "payload":payload})
}

fn rollout(records: Vec<Value>) -> Vec<u8> {
    records
        .into_iter()
        .flat_map(|record| {
            let mut bytes = serde_json::to_vec(&record).unwrap();
            bytes.push(b'\n');
            bytes
        })
        .collect()
}

fn search(bytes: &[u8], query: &str) -> Value {
    search_reader(
        Cursor::new(bytes),
        query,
        250,
        &HashSet::new(),
        &HashMap::new(),
    )
    .unwrap()
}

fn hydrate(bytes: &[u8], matched: &Value) -> Value {
    let cursor = parse_legacy_search_cursor(matched["cursor"].as_str().unwrap())
        .unwrap()
        .unwrap();
    hydrate_reader(Cursor::new(bytes), &cursor).unwrap()
}

fn hydrate_reader(
    reader: impl BufRead + Seek,
    cursor: &LegacySearchCursor,
) -> Result<Value, String> {
    let page = context::hydrate_context_reader(reader, cursor, None, 3)?;
    page.thread["turns"]
        .as_array()
        .and_then(|turns| turns.iter().find(|turn| turn["id"] == cursor.turn_id))
        .cloned()
        .ok_or_else(|| "selected turn is missing".to_owned())
}

/// These item ids were checked against the bundled alpha.5 app-server's
/// thread/read and turns/list using the same synthetic legacy event sequence.
#[test]
fn legacy_projection_matches_native_synthetic_item_ids() {
    let bytes = rollout(vec![
        json!({"type":"session_meta", "payload":{}}),
        event(json!({"type":"task_started", "turn_id":"turn-1"})),
        json!({"type":"response_item", "payload":{"type":"message", "role":"user", "content":[{"type":"input_text", "text":"needle raw duplicate"}]}}),
        event(json!({"type":"user_message", "message":"needle user one", "client_id":"client-1"})),
        event(
            json!({"type":"item_completed", "turn_id":"turn-1", "item":{"type":"UserMessage", "id":"ignored-user", "content":[]}}),
        ),
        event(json!({"type":"agent_reasoning", "text":"reasoning"})),
        event(json!({"type":"agent_reasoning_raw_content", "text":"raw reasoning"})),
        event(json!({"type":"exec_command_end", "call_id":"ignored-command"})),
        event(json!({"type":"entered_review_mode", "turn_id":"turn-1"})),
        event(json!({"type":"exited_review_mode", "turn_id":"turn-1"})),
        event(json!({"type":"context_compacted"})),
        json!({"type":"response_item", "payload":{"type":"message", "role":"assistant", "content":[{"type":"output_text", "text":"needle raw duplicate"}]}}),
        event(
            json!({"type":"agent_message", "message":"needle assistant one", "phase":"final_answer"}),
        ),
        event(json!({"type":"task_complete", "turn_id":"turn-1"})),
        event(json!({"type":"task_started", "turn_id":"turn-2"})),
        event(json!({"type":"user_message", "message":"needle user two"})),
        event(
            json!({"type":"entered_review_mode", "turn_id":"turn-2", "item_id":"explicit-review"}),
        ),
        event(
            json!({"type":"item_completed", "turn_id":"turn-2", "item":{"type":"CommandExecution", "id":"ignored-command"}}),
        ),
        event(json!({"type":"agent_message", "message":"needle assistant two"})),
        event(json!({"type":"task_complete", "turn_id":"turn-2"})),
    ]);
    let response = search(&bytes, "needle");
    let matches = response["matches"].as_array().unwrap();
    assert_eq!(response["totalMatches"], 4);
    assert_eq!(
        matches
            .iter()
            .map(|item| item["itemId"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["item-1", "item-6", "item-7", "item-8"]
    );
    assert_eq!(matches[0]["messageId"], "client-1");
    let turn = hydrate(&bytes, &matches[3]);
    assert_eq!(turn["id"], "turn-2");
    assert_eq!(turn["items"][0]["id"], "item-7");
    assert_eq!(turn["items"][1]["id"], "item-8");
}

#[test]
fn rollback_removes_occurrences_and_resets_counter_from_all_retained_items() {
    let bytes = rollout(vec![
        event(json!({"type":"task_started", "turn_id":"kept"})),
        event(json!({"type":"user_message", "message":"needle kept"})),
        event(
            json!({"type":"item_completed", "turn_id":"kept", "item":{"type":"Plan", "id":"plan-1", "text":" "}}),
        ),
        event(json!({"type":"agent_reasoning", "text":" "})),
        event(json!({"type":"agent_message", "message":"needle kept reply"})),
        event(json!({"type":"task_started", "turn_id":"removed"})),
        event(json!({"type":"user_message", "message":"needle removed"})),
        event(json!({"type":"agent_message", "message":"needle removed reply"})),
        event(json!({"type":"thread_rolled_back", "num_turns":1})),
        event(json!({"type":"task_started", "turn_id":"replacement"})),
        event(json!({"type":"user_message", "message":"needle replacement"})),
        event(json!({"type":"agent_message", "message":"needle replacement reply"})),
    ]);
    let response = search(&bytes, "needle");
    let matches = response["matches"].as_array().unwrap();
    assert_eq!(response["totalMatches"], 4);
    assert_eq!(
        matches
            .iter()
            .map(|item| item["itemId"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["item-1", "item-3", "item-5", "item-6"]
    );
    assert!(matches.iter().all(|matched| matched["turnId"] != "removed"));
    assert_eq!(hydrate(&bytes, &matches[3])["items"][1]["id"], "item-6");
}

#[test]
fn large_turn_search_caps_metadata_and_hydrates_the_complete_anchor() {
    let mut records = vec![event(json!({"type":"task_started", "turn_id":"large"}))];
    records.extend(
        (0..300).map(|index| {
            event(json!({"type":"agent_message", "message":format!("needle {index}")}))
        }),
    );
    let bytes = rollout(records);
    let response = search(&bytes, "needle");
    assert_eq!(response["matches"].as_array().unwrap().len(), 250);
    assert_eq!(response["totalMatches"], 300);
    assert_eq!(response["isCapped"], true);
    let turn = hydrate(&bytes, &response["matches"][150]);
    let items = turn["items"].as_array().unwrap();
    assert_eq!(items.len(), 300);
    assert_eq!(items.first().unwrap()["id"], "item-1");
    assert_eq!(items[150]["id"], "item-151");
    assert_eq!(items.last().unwrap()["id"], "item-300");
    assert!(response["matches"]
        .as_array()
        .unwrap()
        .iter()
        .all(|matched| matched.get("text").is_none()));
}

#[test]
fn search_uses_visible_user_and_assistant_text() {
    let bytes = rollout(vec![
        event(
            json!({"type":"user_message", "message":"<application_context>secret hidden</application_context>\n**visible** user"}),
        ),
        event(
            json!({"type":"agent_message", "message":"[visible](https://secret.example) assistant"}),
        ),
    ]);
    assert_eq!(search(&bytes, "secret")["totalMatches"], 0);
    assert_eq!(search(&bytes, "visible")["totalMatches"], 2);
}

#[test]
fn terminal_status_hides_cancelled_final_placeholder_after_legacy_scan() {
    let bytes = rollout(vec![
        event(json!({"type":"task_started", "turn_id":"cancelled"})),
        event(json!({"type":"user_message", "message":"request"})),
        event(json!({"type":"agent_message", "phase":"commentary", "message":"interrupted"})),
        event(json!({"type":"turn_aborted", "turn_id":"cancelled"})),
    ]);
    assert_eq!(search(&bytes, "interrupted")["totalMatches"], 0);
    assert_eq!(search(&bytes, "request")["totalMatches"], 1);
}

#[test]
fn failed_legacy_turn_preserves_error_and_hides_only_final_error_content() {
    let error = json!({"message":"API error: needle final"});
    let bytes = rollout(vec![
        event(json!({"type":"task_started", "turn_id":"failed"})),
        event(json!({"type":"user_message", "message":"request needle"})),
        event(json!({"type":"agent_message", "message":"API error: needle final"})),
        event(json!({"type":"task_complete", "turn_id":"failed", "error":error})),
    ]);
    let response = search(&bytes, "needle");
    assert_eq!(response["totalMatches"], 1);
    assert_eq!(response["matches"][0]["itemId"], "item-1");
    let turn = hydrate(&bytes, &response["matches"][0]);
    assert_eq!(turn["status"], "failed");
    assert_eq!(turn["error"], error);
}

#[test]
fn interrupted_legacy_turn_keeps_meaningful_partial_output_and_occurrences() {
    let bytes = rollout(vec![
        event(json!({"type":"task_started", "turn_id":"partial"})),
        event(json!({"type":"user_message", "message":"request"})),
        event(
            json!({"type":"agent_message", "phase":"commentary", "message":"partial needle needle"}),
        ),
        event(json!({"type":"turn_aborted", "turn_id":"partial"})),
    ]);
    let response = search(&bytes, "needle");
    assert_eq!(response["totalMatches"], 2);
    assert_eq!(response["matches"][0]["itemId"], "item-2");
    assert_eq!(response["matches"][0]["occurrence"], 0);
    assert_eq!(response["matches"][1]["occurrence"], 1);
    assert_eq!(
        hydrate(&bytes, &response["matches"][0])["status"],
        "interrupted"
    );
}

#[test]
fn failed_legacy_turn_filters_joined_content_and_keeps_earlier_guidance_segment() {
    let bytes = rollout(vec![
        event(json!({"type":"task_started", "turn_id":"guided"})),
        event(json!({"type":"user_message", "message":"request"})),
        event(json!({"type":"agent_message", "message":"API error: needle earlier needle"})),
        event(json!({"type":"user_message", "message":"guidance needle", "client_id":"guidance"})),
        event(json!({"type":"agent_message", "message":"API error: needle final"})),
        event(
            json!({"type":"task_complete", "turn_id":"guided", "error":"API error: needle final"}),
        ),
    ]);
    let response = search(&bytes, "needle");
    assert_eq!(response["totalMatches"], 3);
    let matches = response["matches"].as_array().unwrap();
    assert_eq!(matches[0]["itemId"], "item-2");
    assert_eq!(matches[0]["occurrence"], 0);
    assert_eq!(matches[1]["itemId"], "item-2");
    assert_eq!(matches[1]["occurrence"], 1);
    assert_eq!(matches[2]["itemId"], "item-3");
    assert_eq!(matches[2]["messageId"], "guidance");
}

#[test]
fn failed_legacy_turn_keeps_error_like_item_inside_meaningful_joined_answer() {
    let bytes = rollout(vec![
        event(json!({"type":"task_started", "turn_id":"partial"})),
        event(json!({"type":"agent_message", "message":"Useful partial output"})),
        event(json!({"type":"agent_message", "message":"needle"})),
        event(json!({"type":"task_complete", "turn_id":"partial", "error":"needle"})),
    ]);
    let response = search(&bytes, "needle");
    assert_eq!(response["totalMatches"], 1);
    assert_eq!(response["matches"][0]["itemId"], "item-2");
}

#[test]
fn rollback_reused_turn_id_searches_only_replacement_generation() {
    let bytes = rollout(vec![
        event(json!({"type":"task_started", "turn_id":"same"})),
        event(json!({"type":"agent_message", "message":"removed needle needle"})),
        event(json!({"type":"thread_rolled_back", "num_turns":1})),
        event(json!({"type":"task_started", "turn_id":"same"})),
        event(json!({"type":"agent_message", "message":"replacement needle"})),
        event(json!({"type":"task_complete", "turn_id":"same"})),
    ]);
    let response = search(&bytes, "needle");
    assert_eq!(response["totalMatches"], 1);
    let turn = hydrate(&bytes, &response["matches"][0]);
    assert_eq!(turn["items"][0]["text"], "replacement needle");
}

#[test]
fn search_uses_restored_user_body_instead_of_injected_attachments() {
    let bytes = rollout(vec![
        event(json!({"type":"user_message", "client_id":"hidden-client",
            "message":"shown\n\n# User-provided text attachments\nMIME Type: text/markdown"})),
        event(json!({"type":"user_message", "client_id":"body-client",
            "message":"markdown raw count once"})),
        event(json!({"type":"user_message", "message":"markdown without stored presentation"})),
        event(json!({"type":"agent_message", "message":"markdown assistant"})),
    ]);
    let restored = HashMap::from([
        ("hidden-client".to_owned(), String::new()),
        ("body-client".to_owned(), "markdown **markdown**".to_owned()),
    ]);
    let response = search_reader(
        Cursor::new(bytes),
        "markdown",
        250,
        &HashSet::new(),
        &restored,
    )
    .unwrap();
    let matches = response["matches"].as_array().unwrap();
    assert_eq!(response["totalMatches"], 4);
    assert_eq!(matches[0]["messageId"], "body-client");
    assert_eq!(matches[1]["occurrence"], 1);
    assert_eq!(matches[2]["itemId"], "item-3");
    assert_eq!(matches[3]["itemId"], "item-4");
}

#[test]
fn implicit_turn_ids_count_only_persisted_records_and_respect_compaction() {
    let bytes = rollout(vec![
        json!({"type":"session_meta", "payload":{}}),
        event(json!({"type":"item_started", "item":{"type":"AgentMessage", "id":"ignored"}})),
        json!({"type":"unknown_future_record", "payload":{}}),
        json!({"type":"compacted", "payload":{}}),
        event(json!({"type":"user_message", "message":"needle first"})),
        event(json!({"type":"agent_message", "message":"needle reply"})),
        event(json!({"type":"user_message", "message":"needle second"})),
    ]);
    let response = search(&bytes, "needle");
    assert_eq!(response["matches"][0]["turnId"], "rollout-1");
    assert_eq!(response["matches"][1]["turnId"], "rollout-1");
    assert_eq!(response["matches"][2]["turnId"], "rollout-4");
    assert_eq!(
        hydrate(&bytes, &response["matches"][2])["items"][0]["id"],
        "item-3"
    );
}

#[test]
fn selected_user_context_retains_image_order_and_audio() {
    let bytes = rollout(vec![event(
        json!({"type":"user_message", "message":"needle attachment",
        "images":["https://example.test/image.png"], "file_ids":["file-1"], "image_order":["file", "inline"],
        "local_images":["synthetic-image.png"], "audio":["https://example.test/audio.mp3"], "local_audio":["synthetic-audio.mp3"]}),
    )]);
    let response = search(&bytes, "needle");
    let turn = hydrate(&bytes, &response["matches"][0]);
    let content = turn["items"][0]["content"].as_array().unwrap();
    assert_eq!(content.len(), 6);
    assert_eq!(content[1]["fileId"], "file-1");
    assert_eq!(content[2]["url"], "https://example.test/image.png");
    assert_eq!(content[3]["type"], "localImage");
    assert_eq!(content[5]["type"], "localAudio");
}

#[test]
fn partial_append_is_ignored_and_invalid_cursor_is_rejected() {
    let mut bytes = rollout(vec![event(
        json!({"type":"user_message", "message":"needle"}),
    )]);
    bytes.extend_from_slice(b"{\"type\":");
    let response = search(&bytes, "needle");
    assert_eq!(response["totalMatches"], 1);
    let encoded = response["matches"][0]["cursor"].as_str().unwrap();
    assert!(is_legacy_search_cursor(encoded));
    assert!(!encoded.contains("path"));
    assert!(parse_legacy_search_cursor("other-cursor")
        .unwrap()
        .is_none());
    assert!(parse_legacy_search_cursor(&format!("{CURSOR_PREFIX}{{}}")).is_err());
    let mut cursor = parse_legacy_search_cursor(encoded).unwrap().unwrap();
    cursor.byte_offset += 1;
    assert!(hydrate_reader(Cursor::new(&bytes), &cursor).is_err());
}

#[test]
fn excluded_turns_keep_global_ids_but_do_not_count_matches() {
    let bytes = rollout(vec![
        event(json!({"type":"task_started", "turn_id":"hidden"})),
        event(json!({"type":"user_message", "message":"needle hidden"})),
        event(json!({"type":"task_started", "turn_id":"shown"})),
        event(json!({"type":"agent_message", "message":"needle shown"})),
    ]);
    let excluded = HashSet::from(["hidden".to_owned()]);
    let response = search_reader(
        Cursor::new(bytes),
        "needle",
        250,
        &excluded,
        &HashMap::new(),
    )
    .unwrap();
    assert_eq!(response["totalMatches"], 1);
    assert_eq!(response["matches"][0]["itemId"], "item-2");
}

#[test]
fn late_review_for_finished_turn_does_not_change_selected_active_turn() {
    let bytes = rollout(vec![
        event(json!({"type":"task_started", "turn_id":"older"})),
        event(json!({"type":"user_message", "message":"older user"})),
        event(json!({"type":"task_complete", "turn_id":"older"})),
        event(json!({"type":"task_started", "turn_id":"selected"})),
        event(json!({"type":"user_message", "message":"selected user"})),
        event(json!({"type":"entered_review_mode", "turn_id":"older", "item_id":"late-review"})),
        event(json!({"type":"agent_message", "message":"needle selected reply"})),
    ]);
    let response = search(&bytes, "needle");
    let turn = hydrate(&bytes, &response["matches"][0]);
    assert_eq!(turn["id"], "selected");
    assert_eq!(turn["items"][1]["id"], "item-3");
}

#[test]
fn hydration_preserves_late_completion_and_the_complete_turn() {
    let mut records = vec![event(
        json!({"type":"task_started", "turn_id":"large", "started_at":10}),
    )];
    records.extend(
        (0..200).map(|index| {
            event(json!({"type":"agent_message", "message":format!("needle {index}")}))
        }),
    );
    records.push(event(
        json!({"type":"task_complete", "turn_id":"large", "completed_at":20, "duration_ms":10000}),
    ));
    let bytes = rollout(records);
    let response = search(&bytes, "needle");
    let turn = hydrate(&bytes, &response["matches"][0]);
    assert_eq!(turn["items"].as_array().unwrap().len(), 200);
    assert_eq!(turn["status"], "completed");
    assert_eq!(turn["completedAt"], 20);
    assert_eq!(turn["durationMs"], 10000);
}

#[test]
fn completed_match_preserves_process_dedup_against_the_complete_joined_answer() {
    for append_tail in [false, true] {
        let mut records = vec![
            event(json!({"type":"task_started", "turn_id":"completed"})),
            event(json!({"type":"agent_message", "phase":"final_answer", "message":"needle"})),
            event(json!({"type":"agent_message", "phase":"analysis", "message":"needle"})),
        ];
        records.extend((0..110).map(|index| {
            event(json!({"type":"agent_message", "phase":"analysis",
                "message":format!("padding {index}")}))
        }));
        if append_tail {
            records.push(event(
                json!({"type":"agent_message", "phase":"final_answer", "message":"tail"}),
            ));
        }
        records.push(event(
            json!({"type":"task_complete", "turn_id":"completed"}),
        ));
        let bytes = rollout(records);
        let response = search(&bytes, "needle");
        let matches = response["matches"].as_array().unwrap();
        let expected_ids = if append_tail {
            vec!["item-1", "item-2"]
        } else {
            vec!["item-1"]
        };
        assert_eq!(response["totalMatches"], expected_ids.len());
        assert_eq!(
            matches
                .iter()
                .map(|matched| matched["itemId"].as_str().unwrap())
                .collect::<Vec<_>>(),
            expected_ids
        );
        for matched in matches {
            let turn = hydrate(&bytes, matched);
            assert_eq!(turn["status"], "completed");
            assert_eq!(
                turn["items"].as_array().unwrap().len(),
                112 + usize::from(append_tail)
            );
            let sources = codex_turn_search_sources(&turn, &HashMap::new(), None);
            let visible_hits = sources
                .iter()
                .filter(|(_, text)| text.contains("needle"))
                .map(|(id, _)| id.as_str())
                .collect::<Vec<_>>();
            assert_eq!(visible_hits, expected_ids);
            assert_eq!(matched["occurrence"], 0);
            assert!(sources.iter().any(|(id, text)| {
                id == matched["itemId"].as_str().unwrap() && text == "needle"
            }));
        }
    }
}

#[test]
fn failed_match_restores_complete_joined_answer_and_keeps_neighbor_pagination() {
    use crate::runtime_work::codex_transcript_page::CodexTranscriptDirection;

    let mut records = vec![event(json!({"type":"task_started", "turn_id":"older"}))];
    records.extend(
        (0..75).map(|index| {
            event(json!({"type":"agent_message", "message":format!("older {index}")}))
        }),
    );
    records.extend([
        event(json!({"type":"task_complete", "turn_id":"older"})),
        event(json!({"type":"task_started", "turn_id":"failed"})),
        event(json!({"type":"agent_message", "message":"useful output"})),
    ]);
    records.extend(
        (0..150).map(|index| {
            event(json!({"type":"agent_message", "message":format!("partial {index}")}))
        }),
    );
    records.extend([
        event(json!({"type":"agent_message", "message":"needle"})),
        event(json!({"type":"task_complete", "turn_id":"failed", "error":"needle"})),
        event(json!({"type":"task_started", "turn_id":"newer"})),
    ]);
    records.extend(
        (0..75).map(|index| {
            event(json!({"type":"agent_message", "message":format!("newer {index}")}))
        }),
    );
    records.push(event(json!({"type":"task_complete", "turn_id":"newer"})));
    let bytes = rollout(records);
    let matches = search(&bytes, "needle");
    assert_eq!(matches["totalMatches"], 1);
    let cursor = parse_legacy_search_cursor(matches["matches"][0]["cursor"].as_str().unwrap())
        .unwrap()
        .unwrap();
    let page = context::hydrate_context_reader(Cursor::new(&bytes), &cursor, None, 3).unwrap();
    let turns = page.thread["turns"].as_array().unwrap();
    assert_eq!(turns.len(), 3);
    assert_eq!(turns[0]["items"].as_array().unwrap().len(), 50);
    assert_eq!(turns[2]["items"].as_array().unwrap().len(), 50);
    let failed = &turns[1];
    assert_eq!(failed["items"].as_array().unwrap().len(), 152);
    assert_eq!(failed["items"][0]["text"], "useful output");
    assert_eq!(failed["items"][151]["text"], "needle");
    assert_eq!(failed["error"], "needle");
    let sources = codex_turn_search_sources(failed, &HashMap::new(), None);
    assert!(sources
        .iter()
        .any(|(id, text)| id == &cursor.item_id && text == "needle"));
    for (direction, boundary, expected_turn) in [
        (
            CodexTranscriptDirection::Descending,
            page.before_cursor,
            "older",
        ),
        (
            CodexTranscriptDirection::Ascending,
            page.after_cursor,
            "newer",
        ),
    ] {
        let cursor = parse_legacy_context_cursor(boundary.as_deref().unwrap())
            .unwrap()
            .unwrap();
        let rest =
            context::hydrate_context_reader(Cursor::new(&bytes), &cursor, Some(direction), 5)
                .unwrap();
        assert_eq!(rest.thread["turns"][0]["id"], expected_turn);
        assert_eq!(
            rest.thread["turns"][0]["items"].as_array().unwrap().len(),
            25
        );
        assert!(rest.before_cursor.is_none() || rest.after_cursor.is_none());
    }
}

#[test]
fn failed_match_restores_guidance_boundaries_beyond_the_item_radius() {
    let mut records = vec![
        event(json!({"type":"task_started", "turn_id":"guided"})),
        event(json!({"type":"agent_message", "message":"API error: needle earlier"})),
    ];
    records.extend(
        (0..120).map(|index| {
            event(json!({"type":"agent_message", "message":format!("earlier {index}")}))
        }),
    );
    records.extend([
        event(json!({"type":"user_message", "message":"continue", "client_id":"guidance"})),
        event(json!({"type":"agent_message", "message":"API error: needle final"})),
        event(
            json!({"type":"task_complete", "turn_id":"guided", "error":"API error: needle final"}),
        ),
    ]);
    let bytes = rollout(records);
    let response = search(&bytes, "needle");
    assert_eq!(response["totalMatches"], 1);
    let turn = hydrate(&bytes, &response["matches"][0]);
    assert_eq!(turn["items"].as_array().unwrap().len(), 123);
    assert_eq!(turn["items"][121]["clientId"], "guidance");
    let sources = codex_turn_search_sources(&turn, &HashMap::new(), None);
    assert!(sources
        .iter()
        .any(|(id, text)| id == "item-1" && text.contains("needle")));
    assert!(!sources
        .iter()
        .any(|(_, text)| text == "API error: needle final"));
}

#[test]
fn interrupted_match_restores_the_complete_meaningful_partial_answer() {
    let mut records = vec![event(
        json!({"type":"task_started", "turn_id":"interrupted"}),
    )];
    records.extend((0..140).map(|index| {
        event(json!({"type":"agent_message", "phase":"commentary",
            "message":format!("partial {index}")}))
    }));
    records.extend([
        event(json!({"type":"agent_message", "phase":"commentary", "message":"needle"})),
        event(json!({"type":"turn_aborted", "turn_id":"interrupted"})),
    ]);
    let bytes = rollout(records);
    let matched = search(&bytes, "needle");
    assert_eq!(matched["totalMatches"], 1);
    let turn = hydrate(&bytes, &matched["matches"][0]);
    assert_eq!(turn["status"], "interrupted");
    assert_eq!(turn["items"].as_array().unwrap().len(), 141);
    assert_eq!(turn["items"][0]["text"], "partial 0");
    assert!(codex_turn_search_sources(&turn, &HashMap::new(), None)
        .iter()
        .any(|(_, text)| text == "needle"));
}

#[test]
fn hydration_rejects_match_rolled_back_after_search_even_when_ids_are_reused() {
    let mut bytes = rollout(vec![
        event(json!({"type":"task_started", "turn_id":"removed"})),
        event(json!({"type":"agent_message", "message":"needle old"})),
    ]);
    let response = search(&bytes, "needle");
    bytes.extend(rollout(vec![
        event(json!({"type":"thread_rolled_back", "num_turns":1})),
        event(json!({"type":"task_started", "turn_id":"removed"})),
        event(json!({"type":"agent_message", "message":"needle new"})),
    ]));
    let cursor = parse_legacy_search_cursor(response["matches"][0]["cursor"].as_str().unwrap())
        .unwrap()
        .unwrap();
    assert!(hydrate_reader(Cursor::new(&bytes), &cursor)
        .unwrap_err()
        .contains("no longer available"));
}

#[test]
fn legacy_search_context_includes_adjacent_turns_and_can_browse_both_edges() {
    use crate::runtime_work::codex_transcript_page::CodexTranscriptDirection;

    let mut records = Vec::new();
    for index in 0..6 {
        records.extend([
            event(json!({"type":"task_started", "turn_id": format!("turn-{index}")})),
            event(json!({"type":"user_message", "message": format!("request {index}")})),
            event(json!({"type":"agent_message", "message": format!("reply {index}")})),
            event(json!({"type":"task_complete", "turn_id": format!("turn-{index}")})),
        ]);
    }
    let bytes = rollout(records);
    let matches = search(&bytes, "reply 2");
    let cursor = parse_legacy_search_cursor(matches["matches"][0]["cursor"].as_str().unwrap())
        .unwrap()
        .unwrap();
    let page = context::hydrate_context_reader(Cursor::new(&bytes), &cursor, None, 3).unwrap();
    let turn_ids = |page: &crate::runtime_work::codex_transcript_page::CodexTranscriptPage| {
        page.thread["turns"]
            .as_array()
            .unwrap()
            .iter()
            .map(|turn| turn["id"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>()
    };
    assert_eq!(turn_ids(&page), ["turn-1", "turn-2", "turn-3"]);
    assert!(page.prepend_item_turn_ids.is_empty());

    let before = parse_legacy_context_cursor(page.before_cursor.as_deref().unwrap())
        .unwrap()
        .unwrap();
    let older = context::hydrate_context_reader(
        Cursor::new(&bytes),
        &before,
        Some(CodexTranscriptDirection::Descending),
        5,
    )
    .unwrap();
    assert_eq!(turn_ids(&older), ["turn-0"]);
    assert!(older.before_cursor.is_none());
    assert!(older.prepend_item_turn_ids.contains("turn-0"));

    let after = parse_legacy_context_cursor(page.after_cursor.as_deref().unwrap())
        .unwrap()
        .unwrap();
    let newer = context::hydrate_context_reader(
        Cursor::new(&bytes),
        &after,
        Some(CodexTranscriptDirection::Ascending),
        5,
    )
    .unwrap();
    assert_eq!(turn_ids(&newer), ["turn-4", "turn-5"]);
    assert!(newer.after_cursor.is_none());
    assert!(newer.prepend_item_turn_ids.is_empty());
    assert!(parse_legacy_context_cursor("other-cursor")
        .unwrap()
        .is_none());
    assert!(parse_legacy_context_cursor("wework-codex-legacy-context:{}").is_err());
}

#[test]
fn long_legacy_neighbor_context_pages_are_bounded_and_never_skip_items() {
    use crate::runtime_work::codex_transcript_page::CodexTranscriptDirection;

    let mut records = Vec::new();
    for turn_id in ["older", "selected", "newer"] {
        records.push(event(json!({"type":"task_started", "turn_id":turn_id})));
        let item_count = if turn_id == "selected" { 1 } else { 360 };
        records.extend((0..item_count).map(|index| {
            event(json!({"type":"agent_message", "message":format!("{turn_id} {index}")}))
        }));
        records.push(event(json!({"type":"task_complete", "turn_id":turn_id})));
    }
    let bytes = rollout(records);
    let matched = search(&bytes, "selected 0");
    let cursor = parse_legacy_search_cursor(matched["matches"][0]["cursor"].as_str().unwrap())
        .unwrap()
        .unwrap();
    let initial = context::hydrate_context_reader(Cursor::new(&bytes), &cursor, None, 3).unwrap();
    let items = |page: &crate::runtime_work::codex_transcript_page::CodexTranscriptPage| {
        page.thread["turns"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|turn| turn["items"].as_array().unwrap())
            .map(|item| item["id"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>()
    };
    let mut collected = items(&initial);
    assert_eq!(collected.len(), 101);
    for (direction, mut boundary) in [
        (CodexTranscriptDirection::Descending, initial.before_cursor),
        (CodexTranscriptDirection::Ascending, initial.after_cursor),
    ] {
        while let Some(encoded) = boundary {
            let cursor = parse_legacy_context_cursor(&encoded).unwrap().unwrap();
            let page =
                context::hydrate_context_reader(Cursor::new(&bytes), &cursor, Some(direction), 5)
                    .unwrap();
            let next = items(&page);
            assert!(!next.is_empty());
            assert!(next.len() <= 100);
            collected.extend(next);
            boundary = match direction {
                CodexTranscriptDirection::Ascending => page.after_cursor,
                CodexTranscriptDirection::Descending => {
                    assert!(page.prepend_item_turn_ids.contains("older"));
                    page.before_cursor
                }
            };
        }
    }
    assert_eq!(collected.len(), 721);
    let unique = collected.into_iter().collect::<HashSet<_>>();
    assert_eq!(
        unique,
        (1..=721).map(|index| format!("item-{index}")).collect()
    );
}

#[test]
fn legacy_context_discards_rolled_back_neighbors_and_captures_the_replacement() {
    let bytes = rollout(vec![
        event(json!({"type":"task_started", "turn_id":"selected"})),
        event(json!({"type":"agent_message", "message":"needle selected"})),
        event(json!({"type":"task_started", "turn_id":"removed"})),
        event(json!({"type":"agent_message", "message":"removed reply"})),
        event(json!({"type":"thread_rolled_back", "num_turns":1})),
        event(json!({"type":"task_started", "turn_id":"replacement"})),
        event(json!({"type":"agent_message", "message":"replacement reply"})),
    ]);
    let matched = search(&bytes, "needle");
    let cursor = parse_legacy_search_cursor(matched["matches"][0]["cursor"].as_str().unwrap())
        .unwrap()
        .unwrap();
    let page = context::hydrate_context_reader(Cursor::new(&bytes), &cursor, None, 3).unwrap();
    let turns = page.thread["turns"].as_array().unwrap();
    assert_eq!(turns.len(), 2);
    assert_eq!(turns[0]["id"], "selected");
    assert_eq!(turns[1]["id"], "replacement");
    assert_eq!(turns[1]["items"][0]["text"], "replacement reply");
    assert!(page.after_cursor.is_none());
}
