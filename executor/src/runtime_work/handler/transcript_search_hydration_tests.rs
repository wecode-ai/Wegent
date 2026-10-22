// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

fn cached_link(messages: Vec<Value>) -> RuntimeTaskLink {
    RuntimeTaskLink {
        runtime_handle: json!({"messages": messages}),
        ..RuntimeTaskLink::default()
    }
}

fn assistant(id: &str, turn_id: &str, content: &str) -> Value {
    json!({
        "id": id, "turnId": turn_id, "role": "assistant",
        "content": content, "status": "done",
    })
}

fn tool_messages(turn_id: &str, prefix: &str) -> Vec<Value> {
    (0..5)
        .map(|index| {
            let mut message = assistant(&format!("{prefix}-{index}"), turn_id, "");
            message["blocks"] = json!([{
                "id": format!("{prefix}-block-{index}"), "type": "tool", "content": "output",
            }]);
            message
        })
        .collect()
}

fn hydrate_cursor(link: &RuntimeTaskLink, cursor: &str, limit: usize, after: bool) -> Value {
    cached_search_match_response(link, cursor, Some(limit), false, after)
        .unwrap()
        .unwrap()
}

fn hydrate_match(link: &RuntimeTaskLink, query: &str, item_id: &str, occurrence: u64) -> Value {
    let result = search_cached_transcript(&cached_search_messages(link), query, 250);
    let matched = result["matches"]
        .as_array()
        .unwrap()
        .iter()
        .find(|matched| matched["itemId"] == item_id && matched["occurrence"] == occurrence)
        .expect("the complete turn contains this visible match");
    hydrate_cursor(link, matched["cursor"].as_str().unwrap(), 5, false)
}

fn assert_complete_page_turns(link: &RuntimeTaskLink, page: &Value) {
    let messages = cached_search_messages(link);
    let turns = transcript_canonical_turns(&messages, TranscriptTurnItemSource::CachedMessages);
    for actual in page["turns"].as_array().unwrap() {
        let expected = turns
            .iter()
            .find(|turn| turn["id"] == actual["id"])
            .unwrap();
        assert_eq!(
            actual, expected,
            "every returned canonical turn must be complete"
        );
    }
}

fn assert_complete_search_turn(link: &RuntimeTaskLink, page: &Value, query: &str, turn_id: &str) {
    assert_complete_page_turns(link, page);
    assert!(page["turns"]
        .as_array()
        .unwrap()
        .iter()
        .any(|turn| turn["id"] == turn_id));
    let messages = cached_search_messages(link);
    assert_eq!(
        search_cached_transcript(page["messages"].as_array().unwrap(), query, 250),
        search_cached_transcript(&messages, query, 250),
        "hydration must preserve visible item IDs, occurrences, and text-block deduplication",
    );
}

fn message_ids(page: &Value) -> Vec<&str> {
    page["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|message| message["id"].as_str().unwrap())
        .collect()
}

fn long_terminal_turn(turn_id: &str, first: &str, last: &str, status: &str) -> Vec<Value> {
    let mut messages = vec![assistant(&format!("{turn_id}-first"), turn_id, first)];
    messages.extend(tool_messages(turn_id, &format!("{turn_id}-tool")));
    let mut terminal = assistant(&format!("{turn_id}-last"), turn_id, last);
    terminal["status"] = json!(status);
    terminal["error"] = json!(last);
    messages.push(terminal);
    messages
}

#[test]
fn cached_async_reply_search_hydrates_distant_question_source_and_raw_answer() {
    let mut card = assistant("question", "question-turn", "");
    card["blocks"] = json!([{"id":"question-block", "type":"tool", "renderPayload":{
        "kind":"request_user_input", "delivery":"async", "questions":[{"question":"needle needle?"}],
    }}]);
    let mut messages = vec![assistant("before", "before", "Other"), card];
    messages.extend((0..8).map(|index| {
        assistant(
            &format!("context-{index}"),
            &format!("context-turn-{index}"),
            "Other",
        )
    }));
    messages.push(json!({"id":"reply", "clientUserMessageId":"client-reply", "turnId":"reply-turn", "role":"user", "content":"**needle**"}));
    messages.push(
        json!({"id":"ordinary", "turnId":"ordinary-turn", "role":"user", "content":"**plain**"}),
    );
    let link = cached_link(messages);
    let response = search_cached_transcript(&cached_search_messages(&link), "needle", 250);
    assert_eq!(response["totalMatches"], 3);
    for (index, matched) in response["matches"].as_array().unwrap().iter().enumerate() {
        assert_eq!(matched["itemId"], "client-reply");
        assert_eq!(matched["messageId"], "client-reply");
        assert_eq!(matched["occurrence"], index);
        assert_eq!(matched["replyQuestions"], json!(["needle needle?"]));
        let page = hydrate_cursor(&link, matched["cursor"].as_str().unwrap(), 2, false);
        assert!(message_ids(&page).contains(&"question"));
        assert!(message_ids(&page).contains(&"reply"));
        assert_eq!(
            search_cached_transcript(page["messages"].as_array().unwrap(), "needle", 250),
            response
        );
        assert_complete_page_turns(&link, &page);
    }
    assert_eq!(
        search_cached_transcript(&cached_search_messages(&link), "**needle**", 250)["totalMatches"],
        1
    );
    assert_eq!(
        search_cached_transcript(&cached_search_messages(&link), "**plain**", 250)["totalMatches"],
        0
    );
}

#[test]
fn cached_search_hydrates_complete_long_cancelled_and_failed_turns() {
    for (status, content, query, occurrence) in [
        ("cancelled", "interrupted", "interrupted", 0),
        ("failed", "API error: needle needle", "needle", 1),
    ] {
        let mut messages = vec![assistant("first", "turn", "Useful output")];
        messages.extend(tool_messages("turn", "tool"));
        let mut last = assistant("last", "turn", content);
        last["status"] = json!(status);
        last["runtimeStatus"] = json!(status);
        last["error"] = json!(content);
        last["stoppedNotice"] = json!("The turn ended");
        messages.push(last);
        let link = cached_link(messages);

        let page = hydrate_match(&link, query, "last", occurrence);

        assert_eq!(page["messages"].as_array().unwrap().len(), 7);
        assert_eq!(page["turns"][0]["items"].as_array().unwrap().len(), 7);
        assert_eq!(page["turns"][0]["runtimeStatus"], status);
        assert_eq!(page["turns"][0]["error"], content);
        assert_eq!(page["hasMoreBefore"], false);
        assert_eq!(page["hasMoreAfter"], false);
        assert_complete_search_turn(&link, &page, query, "turn");
    }
}

#[test]
fn cached_search_hydrates_distant_guidance_and_terminal_status_in_both_directions() {
    for terminal_status in ["done", "failed"] {
        let mut first = assistant("early", "turn", "API error: early needle");
        first["status"] = json!("failed");
        first["error"] = json!("API error: early needle");
        let mut messages = vec![first];
        messages.extend(
            tool_messages("turn", "before-guidance")
                .into_iter()
                .map(|mut message| {
                    message["status"] = json!("failed");
                    message["error"] = json!("API error: early needle");
                    message
                }),
        );
        messages.push(json!({
            "id": "guidance", "clientUserMessageId": "client-guidance", "turnId": "turn",
            "role": "user", "runtimeGuidance": true, "content": "Continue needle", "status": "done",
        }));
        messages.extend(tool_messages("turn", "after-guidance"));
        let mut last = assistant("last", "turn", "Useful final needle");
        last["status"] = json!(terminal_status);
        last["error"] = json!("API error: terminal");
        messages.push(last);
        let link = cached_link(messages);

        for item_id in ["early", "client-guidance", "last"] {
            let page = hydrate_match(&link, "needle", item_id, 0);

            assert_eq!(page["messages"].as_array().unwrap().len(), 13);
            assert_complete_search_turn(&link, &page, "needle", "turn");
            let items = page["turns"][0]["items"].as_array().unwrap();
            assert!(items.iter().any(|item| {
                item["id"] == "client-guidance"
                    && item["type"] == "user_message"
                    && item["message"]["runtimeGuidance"] == true
            }));
        }
    }
}

#[test]
fn cached_search_hydrates_full_done_text_before_deduplicating_narrative_blocks() {
    for block_content in ["needle needle", "needle needle\n\nOther output"] {
        let mut first = assistant("first", "turn", "needle needle");
        first["blocks"] = json!([{
            "id": "narrative", "type": "text", "content": block_content,
        }]);
        let mut messages = vec![first];
        messages.extend(tool_messages("turn", "tool"));
        messages.push(assistant("last", "turn", "Other output"));
        let link = cached_link(messages);

        let page = hydrate_match(&link, "needle", "first", 1);

        assert_eq!(page["messages"].as_array().unwrap().len(), 7);
        assert_complete_search_turn(&link, &page, "needle", "turn");
        if block_content == "needle needle" {
            let block_page = hydrate_match(&link, "needle", "narrative", 1);
            assert_complete_search_turn(&link, &block_page, "needle", "turn");
        }
    }
}

#[test]
fn cached_search_complete_turn_uses_canonical_aliases_and_pages_outside_interleaved_messages() {
    let mut messages = (0..3)
        .map(|index| {
            assistant(
                &format!("before-{index}"),
                &format!("before-turn-{index}"),
                "Other",
            )
        })
        .collect::<Vec<_>>();
    messages.push(assistant("first", "turn", "needle"));
    messages.push(assistant("interleaved", "another-turn", "Other"));
    for (index, key) in ["turn_id", "subtaskId", "subtask_id"].iter().enumerate() {
        let mut message = assistant(&format!("middle-{index}"), "", "needle");
        message[*key] = json!("turn");
        messages.push(message);
    }
    messages.push(assistant("last", "turn", "Other output"));
    messages.extend((0..3).map(|index| {
        assistant(
            &format!("after-{index}"),
            &format!("after-turn-{index}"),
            "Other",
        )
    }));
    let link = cached_link(messages);
    let result = search_cached_transcript(&cached_search_messages(&link), "needle", 250);
    assert_eq!(result["totalMatches"], 4);
    assert!(result["matches"]
        .as_array()
        .unwrap()
        .iter()
        .all(|matched| matched["turnId"] == "turn"));
    let page = hydrate_cursor(
        &link,
        result["matches"][0]["cursor"].as_str().unwrap(),
        3,
        false,
    );

    assert_eq!(
        message_ids(&page),
        [
            "before-2",
            "first",
            "interleaved",
            "middle-0",
            "middle-1",
            "middle-2",
            "last"
        ],
    );
    assert_complete_search_turn(&link, &page, "needle", "turn");
    let before = hydrate_cursor(&link, page["beforeCursor"].as_str().unwrap(), 2, false);
    assert_eq!(message_ids(&before), ["before-0", "before-1"]);
    assert_eq!(before["hasMoreBefore"], false);
    let after = hydrate_cursor(&link, page["afterCursor"].as_str().unwrap(), 2, true);
    assert_eq!(message_ids(&after), ["after-0", "after-1"]);
    assert_eq!(after["hasMoreAfter"], true);
    let last = hydrate_cursor(&link, after["afterCursor"].as_str().unwrap(), 2, true);
    assert_eq!(message_ids(&last), ["after-2"]);
    assert_eq!(last["hasMoreAfter"], false);
}

#[test]
fn cached_search_initial_context_keeps_adjacent_long_turn_and_distinct_equal_text_ids() {
    let mut messages = vec![assistant("anchor", "anchor-turn", "needle")];
    messages.extend(long_terminal_turn(
        "adjacent",
        "interrupted",
        "interrupted",
        "cancelled",
    ));
    messages.push(assistant("outside", "outside-turn", "Other"));
    let link = cached_link(messages);

    let page = hydrate_match(&link, "needle", "anchor", 0);

    assert_eq!(page["messages"].as_array().unwrap().len(), 8);
    assert_eq!(page["hasMoreBefore"], false);
    assert_eq!(page["hasMoreAfter"], true);
    assert_complete_search_turn(&link, &page, "interrupted", "adjacent");
    let result = search_cached_transcript(page["messages"].as_array().unwrap(), "interrupted", 250);
    assert_eq!(result["totalMatches"], 2);
    assert_eq!(result["matches"][0]["itemId"], "adjacent-first");
    assert_eq!(result["matches"][1]["itemId"], "adjacent-last");
    let after = hydrate_cursor(&link, page["afterCursor"].as_str().unwrap(), 1, true);
    assert_eq!(message_ids(&after), ["outside"]);
    assert_complete_page_turns(&link, &after);
}

#[test]
fn cached_search_complete_turn_window_closes_chained_interleaving_in_both_directions() {
    let link = cached_link(vec![
        assistant("before", "before-turn", "Other"),
        assistant("b-first", "b", "Other"),
        assistant("c-first", "c", "Other"),
        assistant("anchor", "a", "needle"),
        assistant("b-last", "b", "Other"),
        assistant("d-first", "d", "Other"),
        assistant("a-last", "a", "Other"),
        assistant("c-last", "c", "Other"),
        assistant("d-last", "d", "Other"),
        assistant("after", "after-turn", "Other"),
    ]);

    for id in ["anchor", "c-last"] {
        let cursor = format!("{CACHED_SEARCH_CURSOR_PREFIX}{}", json!(id));
        let page = hydrate_cursor(&link, &cursor, 1, false);

        assert_eq!(
            message_ids(&page),
            ["b-first", "c-first", "anchor", "b-last", "d-first", "a-last", "c-last", "d-last"]
        );
        assert_complete_search_turn(&link, &page, "needle", "a");
        let before = hydrate_cursor(&link, page["beforeCursor"].as_str().unwrap(), 1, false);
        let after = hydrate_cursor(&link, page["afterCursor"].as_str().unwrap(), 1, true);
        assert_eq!(message_ids(&before), ["before"]);
        assert_eq!(message_ids(&after), ["after"]);
        assert_eq!(before["hasMoreBefore"], false);
        assert_eq!(after["hasMoreAfter"], false);
    }
}

#[test]
fn cached_search_continuation_pages_preserve_complete_terminal_turn_projections() {
    let mut messages = long_terminal_turn("before", "interrupted", "interrupted", "cancelled");
    messages.push(assistant("anchor", "anchor-turn", "needle"));
    messages.extend(long_terminal_turn(
        "after",
        "Useful output",
        "API error: final",
        "failed",
    ));
    let link = cached_link(messages);
    let initial = hydrate_cursor(&link, "wework-cached-search:\"anchor\"", 1, false);
    assert_eq!(message_ids(&initial), ["anchor"]);
    assert_complete_page_turns(&link, &initial);

    let before = hydrate_cursor(&link, initial["beforeCursor"].as_str().unwrap(), 1, false);
    let after = hydrate_cursor(&link, initial["afterCursor"].as_str().unwrap(), 1, true);

    assert_eq!(before["messages"].as_array().unwrap().len(), 7);
    assert_eq!(after["messages"].as_array().unwrap().len(), 7);
    assert_eq!(before["hasMoreBefore"], false);
    assert_eq!(after["hasMoreAfter"], false);
    assert_complete_search_turn(&link, &before, "interrupted", "before");
    assert_complete_search_turn(&link, &after, "final", "after");
    let forward = hydrate_cursor(&link, before["afterCursor"].as_str().unwrap(), 1, true);
    let backward = hydrate_cursor(&link, after["beforeCursor"].as_str().unwrap(), 1, false);
    assert_eq!(message_ids(&forward), ["anchor"]);
    assert_eq!(message_ids(&backward), ["anchor"]);
}
