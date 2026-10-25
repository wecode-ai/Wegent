// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{fs, os::unix::fs::PermissionsExt};

use super::*;

#[tokio::test]
async fn native_search_hydrates_complete_match_turn_and_pages_neighbor_context() {
    let _environment = crate::agents::CodexLaunchEnvironment::new();
    let directory = tempfile::tempdir().unwrap();
    let binary = directory.path().join("search-fixture");
    let log = directory.path().join("requests.jsonl");
    let script = r#"#!/bin/sh
while IFS= read -r line; do
  printf '%s\n' "$line" >> '__LOG__'
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*) result='{}' ;;
    *'"method":"initialized"'*) continue ;;
    *'"method":"thread/read"'*) result='{"thread":{"id":"thread-1","historyMode":"paginated"}}' ;;
    *'"method":"thread/turns/list"'*)
      case "$line" in
        *'"threadId":"repeat-turns"'*) result='{"data":[],"nextCursor":"repeated-turn-cursor"}' ;;
        *'"cursor":null'*) result='{"data":[{"id":"reverted-turn","status":"completed","items":[]},{"id":"turn-1","status":"completed","items":[]}],"nextCursor":"scan-turns-next","backwardsCursor":"search-page-anchor"}' ;;
        *'"cursor":"scan-turns-next"'*) result='{"data":[{"id":"turn-2","status":"completed","items":[]}],"nextCursor":null,"backwardsCursor":"turn-2-anchor"}' ;;
        *'"cursor":"search-page-anchor"'*) result='{"data":[{"id":"reverted-turn","status":"completed","items":[]}],"nextCursor":"after-reverted","backwardsCursor":"search-page-anchor"}' ;;
        *'"cursor":"after-reverted"'*) result='{"data":[{"id":"turn-1","status":"completed","items":[]}],"nextCursor":"after-center","backwardsCursor":"turn-anchor"}' ;;
        *'"cursor":"before-older"'*) result='{"data":[{"id":"oldest","status":"completed","items":[]}],"nextCursor":null}' ;;
        *'"cursor":"after-newer"'*) result='{"data":[{"id":"newest","status":"completed","items":[]}],"nextCursor":null}' ;;
        *'"sortDirection":"desc"'*) result='{"data":[{"id":"turn-1","status":"completed","items":[],"itemsView":"notLoaded"},{"id":"older","status":"completed","items":[]}],"nextCursor":"before-older"}' ;;
        *) result='{"data":[{"id":"turn-1","status":"completed","items":[],"itemsView":"notLoaded"},{"id":"newer","status":"completed","items":[]}],"nextCursor":"after-newer"}' ;;
      esac ;;
    *'"method":"thread/items/list"'*)
      case "$line" in
        *'"threadId":"repeat-items"'*) result='{"data":[],"nextCursor":"repeated-item-cursor"}' ;;
        *'"cursor":"scan-items-next"'*) result='{"data":[{"turnId":"turn-1","item":{"id":"formatted","type":"userMessage","clientId":"formatted-client","content":[{"type":"text","text":"foo **bar** &amp; baz"}]}},{"turnId":"turn-1","item":{"id":"steer","type":"userMessage","clientId":"steer-client","content":[{"type":"text","text":"fo&#111; bar &amp; baz"}]}},{"turnId":"turn-1","item":{"id":"tool","type":"commandExecution","text":"needle foo bar & baz"}}],"nextCursor":null}' ;;
        *'"turnId":"turn-2"'*) result='{"data":[{"turnId":"turn-2","item":{"id":"late-message","type":"agentMessage","text":"late **match**"}}],"nextCursor":null}' ;;
        *'"cursor":"older-more"'*) result='{"data":[{"turnId":"older","item":{"id":"older-head","type":"agentMessage","text":"older head"}}],"nextCursor":null}' ;;
        *'"cursor":"newer-more"'*) result='{"data":[{"turnId":"newer","item":{"id":"newer-tail","type":"agentMessage","text":"newer tail"}}],"nextCursor":null}' ;;
        *'"turnId":"older"'*) result='{"data":[{"turnId":"older","item":{"id":"older-tail","type":"agentMessage","text":"older tail"}}],"nextCursor":"older-more"}' ;;
        *'"turnId":"newer"'*) result='{"data":[{"turnId":"newer","item":{"id":"newer-head","type":"agentMessage","text":"newer head"}}],"nextCursor":"newer-more"}' ;;
        *'"turnId":"oldest"'*) result='{"data":[{"turnId":"oldest","item":{"id":"oldest-item","type":"agentMessage","text":"oldest"}}],"nextCursor":null}' ;;
        *'"turnId":"newest"'*) result='{"data":[{"turnId":"newest","item":{"id":"newest-item","type":"agentMessage","text":"newest"}}],"nextCursor":null}' ;;
        *'"cursor":null'*) result='{"data":[{"turnId":"turn-1","item":{"id":"hidden","type":"userMessage","clientId":"hidden-client","content":[{"type":"text","text":"shown\n\n# User-provided text attachments\nMIME Type: text/needle"}]}},{"turnId":"turn-1","item":{"id":"match","type":"agentMessage","text":__MATCH_TEXT__}},{"turnId":"turn-1","item":{"id":"body","type":"userMessage","client_id":"body-client","content":[{"type":"text","text":"needle raw count once"}]}}],"nextCursor":"scan-items-next"}' ;;
        *) result='{}' ;;
      esac ;;
    *) result='{}' ;;
  esac
  printf '{"id":%s,"result":%s}\n' "$id" "$result"
done
"#;
    let match_text = format!(
        "[needle](https://hidden.example/needle) ![needle](image.png) `needle` {}end",
        "padding ".repeat(30_000)
    );
    fs::write(
        &binary,
        script.replace("__LOG__", &log.to_string_lossy()).replace(
            "__MATCH_TEXT__",
            &serde_json::to_string(&match_text).unwrap(),
        ),
    )
    .unwrap();
    fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
    let request = serde_json::from_value(json!({
        "user_name":"synthetic", "team_namespace":"default", "team_name":"search",
        "team_id":12, "bot":[{"id":31,"shell_type":"Codex"}],
    }))
    .unwrap();
    let client = CodexAppServerClient::new(binary.to_string_lossy())
        .for_request(&request)
        .unwrap();
    let result = search_codex_transcript(
        &client,
        "thread-1",
        "needle",
        250,
        &HashSet::from(["reverted-turn".to_owned()]),
        &HashMap::from([
            ("hidden-client".to_owned(), "shown".to_owned()),
            ("body-client".to_owned(), "needle **needle**".to_owned()),
        ]),
    )
    .await
    .unwrap();
    assert_eq!(result["totalMatches"], 4);
    assert_eq!(result["isCapped"], false);
    assert_eq!(result["matches"][0]["itemId"], "match");
    assert_eq!(result["matches"][1]["occurrence"], 1);
    assert_eq!(result["matches"][2]["itemId"], "body");
    assert_eq!(result["matches"][2]["messageId"], "body-client");
    assert_eq!(result["matches"][3]["occurrence"], 1);
    assert!(result["matches"][0].get("text").is_none());
    let search_calls = calls(&log);
    let methods: Vec<_> = search_calls
        .iter()
        .filter_map(|call| call["method"].as_str())
        .collect();
    assert_eq!(
        methods,
        [
            "initialize",
            "initialized",
            "thread/read",
            "thread/turns/list",
            "thread/items/list",
            "thread/items/list",
            "thread/turns/list",
            "thread/items/list"
        ]
    );
    assert!(search_calls.iter().all(|call| {
        call["method"] != "thread/items/list" || call["params"]["turnId"] != "reverted-turn"
    }));
    for call in search_calls.iter().filter(|call| {
        call["method"] == "thread/turns/list" || call["method"] == "thread/items/list"
    }) {
        assert_eq!(call["params"]["limit"], 100);
        assert_eq!(call["params"]["sortDirection"], "asc");
        if call["method"] == "thread/turns/list" {
            assert_eq!(call["params"]["itemsView"], "notLoaded");
        }
    }
    let cursor = parse_search_cursor(result["matches"][0]["cursor"].as_str().unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(cursor.turn_offset, 1);
    let page = load_search_match(&client, json!({"id":"thread-1"}), cursor)
        .await
        .unwrap();
    assert_eq!(page.thread["turns"].as_array().unwrap().len(), 3);
    assert_eq!(page.thread["turns"][0]["id"], "older");
    assert_eq!(page.thread["turns"][2]["id"], "newer");
    let items = page.thread["turns"][1]["items"].as_array().unwrap();
    let ids: Vec<_> = items
        .iter()
        .map(|item| item["id"].as_str().unwrap())
        .collect();
    assert_eq!(
        ids,
        ["hidden", "match", "body", "formatted", "steer", "tool"]
    );
    assert_eq!(items[1]["text"], match_text);
    assert_eq!(page.thread["turns"][1]["itemsView"], "full");
    let projected =
        crate::runtime_work::transcript::full_transcript_messages(&page.thread, "test-device");
    // The later tool item makes this unphased text a process block in the full turn.
    assert!(projected
        .iter()
        .any(|message| message["runtimeItems"]
            .as_array()
            .is_some_and(|items| items.iter().any(|item| item["id"] == "match"
                && item["type"] == "block"
                && item["block"]["content"] == match_text))));
    let calls = calls(&log);
    let turn_call = calls
        .iter()
        .find(|call| {
            call["method"] == "thread/turns/list" && call["params"]["cursor"] == "turn-anchor"
        })
        .unwrap();
    assert_eq!(turn_call["params"]["cursor"], "turn-anchor");
    assert_eq!(turn_call["params"]["limit"], 2);
    assert!(calls.iter().all(|call| {
        call["method"] != "thread/items/read"
            && (call["method"] != "thread/items/list" || !call["params"]["cursor"].is_object())
    }));
    for call in calls.iter().filter(|call| {
        call["method"] == "thread/items/list" && call["params"]["turnId"] != "turn-1"
    }) {
        assert!(call["params"]["limit"].as_u64().unwrap() <= 100);
    }
    let metadata_calls: Vec<_> = calls
        .iter()
        .filter(|call| call["method"] == "thread/read")
        .collect();
    assert_eq!(metadata_calls.len(), 1);
    assert_eq!(metadata_calls[0]["params"]["includeTurns"], false);
    for (cursor, direction, partial_id, boundary_id) in [
        (
            page.before_cursor.as_deref().unwrap(),
            CodexTranscriptDirection::Descending,
            "older",
            "oldest",
        ),
        (
            page.after_cursor.as_deref().unwrap(),
            CodexTranscriptDirection::Ascending,
            "newer",
            "newest",
        ),
    ] {
        assert!(is_search_cursor(cursor));
        let continuation = parse_context_cursor(cursor).unwrap().unwrap();
        let partial = load_context_page(&client, json!({"id":"thread-1"}), continuation, direction)
            .await
            .unwrap();
        assert_eq!(partial.thread["turns"][0]["id"], partial_id);
        let cursor = match direction {
            CodexTranscriptDirection::Descending => partial.before_cursor.as_deref(),
            CodexTranscriptDirection::Ascending => partial.after_cursor.as_deref(),
        }
        .unwrap();
        let continuation = parse_context_cursor(cursor).unwrap().unwrap();
        let boundary =
            load_context_page(&client, json!({"id":"thread-1"}), continuation, direction)
                .await
                .unwrap();
        assert_eq!(boundary.thread["turns"][0]["id"], boundary_id);
        assert!(boundary.before_cursor.is_none());
        assert!(boundary.after_cursor.is_none());
    }
    let markdown = search_codex_transcript(
        &client,
        "thread-1",
        "foo bar & baz",
        250,
        &HashSet::from(["reverted-turn".to_owned()]),
        &HashMap::new(),
    )
    .await
    .unwrap();
    let ids: Vec<_> = markdown["matches"]
        .as_array()
        .unwrap()
        .iter()
        .map(|matched| matched["itemId"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["formatted", "steer"]);
    assert_eq!(markdown["matches"][1]["messageId"], "steer-client");
    assert_eq!(markdown["isCapped"], false);
    let late = search_codex_transcript(
        &client,
        "thread-1",
        "late match",
        250,
        &HashSet::from(["reverted-turn".to_owned()]),
        &HashMap::new(),
    )
    .await
    .unwrap();
    assert_eq!(late["totalMatches"], 1);
    assert_eq!(late["matches"][0]["itemId"], "late-message");
    let late_cursor = parse_search_cursor(late["matches"][0]["cursor"].as_str().unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(late_cursor.turn_cursor, "turn-2-anchor");
    assert_eq!(late_cursor.turn_offset, 0);

    let before_cap = self::calls(&log).len();
    let capped = search_codex_transcript(
        &client,
        "thread-1",
        "needle",
        1,
        &HashSet::from(["reverted-turn".to_owned()]),
        &HashMap::from([("hidden-client".to_owned(), "shown".to_owned())]),
    )
    .await
    .unwrap();
    assert_eq!(capped["totalMatches"], 1);
    assert_eq!(capped["isCapped"], true);
    assert_eq!(self::calls(&log).len() - before_cap, 4);

    let invalid = CodexSearchCursor {
        turn_id: "removed-turn".to_owned(),
        item_id: "match".to_owned(),
        turn_cursor: "search-page-anchor".to_owned(),
        turn_offset: 1,
        reply_source_turn_id: None,
    };
    let error = load_search_match(&client, json!({"id":"thread-1"}), invalid)
        .await
        .err()
        .unwrap();
    assert!(error.contains("no longer available"));
    let invalid_offset = CodexSearchCursor {
        turn_id: "turn-1".to_owned(),
        item_id: "match".to_owned(),
        turn_cursor: "search-page-anchor".to_owned(),
        turn_offset: SEARCH_PAGE_SIZE,
        reply_source_turn_id: None,
    };
    assert!(
        resolve_search_turn_cursor(&client, "thread-1", &invalid_offset)
            .await
            .unwrap_err()
            .contains("offset")
    );
    for (thread_id, expected_error) in [
        ("repeat-turns", "repeated turn cursor"),
        ("repeat-items", "repeated item cursor"),
    ] {
        let error = search_codex_transcript(
            &client,
            thread_id,
            "absent query",
            250,
            &HashSet::from(["reverted-turn".to_owned()]),
            &HashMap::new(),
        )
        .await
        .unwrap_err();
        assert!(error.contains(expected_error));
    }
    client.restart().await;
}

fn calls(log: &std::path::Path) -> Vec<Value> {
    fs::read_to_string(log)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

#[tokio::test]
async fn native_async_reply_search_crosses_pages_and_hydrates_its_complete_question_span() {
    let _environment = crate::agents::CodexLaunchEnvironment::new();
    let directory = tempfile::tempdir().unwrap();
    let mut question_items = vec![json!({
        "id":"question", "type":"agentMessage", "phase":"final_answer", "delivery":"async",
        "questions":[{"title":"Choose needle", "options":["one","two"]}],
        "text":"Question fallback",
    })];
    question_items.extend((0..110).map(|index| json!({
        "id":format!("question-padding-{index}"), "type":"commandExecution", "command":"echo wait",
    })));
    for (index, items) in question_items.chunks(SEARCH_PAGE_SIZE).enumerate() {
        let data: Vec<_> = items
            .iter()
            .map(|item| json!({"turnId":"question-turn", "item":item}))
            .collect();
        fs::write(
            directory.path().join(format!("question-{index}.json")),
            json!({"data":data, "nextCursor":(index == 0).then_some("question-more")}).to_string(),
        )
        .unwrap();
    }
    let binary = directory.path().join("async-reply-search-fixture");
    let script = r#"#!/bin/sh
while IFS= read -r line; do
  printf '%s\n' "$line" >> '__DIRECTORY__/requests.jsonl'
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialized"'*) continue ;;
    *'"method":"thread/read"'*) result='{"thread":{"id":"thread-async","historyMode":"paginated"}}' ;;
    *'"method":"thread/turns/list"'*)
      case "$line" in
        *'"cursor":null'*) result='{"data":[{"id":"question-turn","status":"completed"},{"id":"bridge","status":"completed"}],"nextCursor":"scan-reply","backwardsCursor":"question-anchor"}' ;;
        *'"cursor":"scan-reply"'*) result='{"data":[{"id":"reply-turn","status":"completed"}],"nextCursor":null,"backwardsCursor":"reply-anchor"}' ;;
        *'"cursor":"reply-anchor"'*'"sortDirection":"desc"'*) result='{"data":[{"id":"reply-turn","status":"completed"},{"id":"bridge","status":"completed"}],"nextCursor":"question-context"}' ;;
        *'"cursor":"reply-anchor"'*) result='{"data":[{"id":"reply-turn","status":"completed"},{"id":"newer","status":"completed"}],"nextCursor":"after-newer"}' ;;
        *'"cursor":"question-context"'*) result='{"data":[{"id":"question-turn","status":"completed"}],"nextCursor":"before-question"}' ;;
        *'"cursor":"before-question"'*) result='{"data":[{"id":"older","status":"completed"}],"nextCursor":"before-older"}' ;;
        *'"cursor":"before-older"'*) result='{"data":[{"id":"oldest","status":"completed"}],"nextCursor":null}' ;;
        *'"cursor":"after-newer"'*) result='{"data":[{"id":"newest","status":"completed"}],"nextCursor":null}' ;;
        *) result='{"data":[],"nextCursor":null}' ;;
      esac ;;
    *'"method":"thread/items/list"'*)
      case "$line" in
        *'"cursor":"question-more"'*) result=$(cat '__DIRECTORY__/question-1.json') ;;
        *'"turnId":"question-turn"'*) result=$(cat '__DIRECTORY__/question-0.json') ;;
        *'"turnId":"reply-turn"'*) result='{"data":[{"turnId":"reply-turn","item":{"id":"reply","type":"userMessage","clientId":"reply-client","content":[{"type":"text","text":"**needle**"}]}}],"nextCursor":null}' ;;
        *'"turnId":"bridge"'*) result='{"data":[{"turnId":"bridge","item":{"id":"waiting","type":"agentMessage","phase":"final_answer","text":"Waiting for your choice"}}],"nextCursor":null}' ;;
        *'"cursor":"older-more"'*) result='{"data":[{"turnId":"older","item":{"id":"older-head","type":"agentMessage","text":"Earlier context"}}],"nextCursor":null}' ;;
        *'"turnId":"older"'*) result='{"data":[{"turnId":"older","item":{"id":"older-tail","type":"agentMessage","text":"Prior context"}}],"nextCursor":"older-more"}' ;;
        *'"turnId":"oldest"'*) result='{"data":[{"turnId":"oldest","item":{"id":"oldest-item","type":"agentMessage","text":"Oldest context"}}],"nextCursor":null}' ;;
        *'"turnId":"newer"'*) result='{"data":[{"turnId":"newer","item":{"id":"newer-item","type":"agentMessage","text":"Newer context"}}],"nextCursor":null}' ;;
        *'"turnId":"newest"'*) result='{"data":[{"turnId":"newest","item":{"id":"newest-item","type":"agentMessage","text":"Newest context"}}],"nextCursor":null}' ;;
        *) result='{"data":[],"nextCursor":null}' ;;
      esac ;;
    *) result='{}' ;;
  esac
  printf '{"id":%s,"result":%s}\n' "$id" "$result"
done
"#;
    fs::write(
        &binary,
        script.replace("__DIRECTORY__", &directory.path().to_string_lossy()),
    )
    .unwrap();
    fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
    let request = serde_json::from_value(json!({
        "user_name":"synthetic", "team_namespace":"default", "team_name":"search",
        "team_id":12, "bot":[{"id":31,"shell_type":"Codex"}],
    }))
    .unwrap();
    let client = CodexAppServerClient::new(binary.to_string_lossy())
        .for_request(&request)
        .unwrap();
    for (query, expected_count) in [("needle", 2), ("**needle**", 1), ("Choose", 1)] {
        let result = search_codex_transcript(
            &client,
            "thread-async",
            query,
            250,
            &HashSet::new(),
            &HashMap::new(),
        )
        .await
        .unwrap();
        assert_eq!(result["totalMatches"], expected_count, "{query}");
        for (occurrence, matched) in result["matches"].as_array().unwrap().iter().enumerate() {
            assert_eq!(matched["itemId"], "reply");
            assert_eq!(matched["messageId"], "reply-client");
            assert_eq!(matched["occurrence"], occurrence);
            assert_eq!(matched["replyQuestions"], json!(["Choose needle"]));
        }
        let cursor = parse_search_cursor(result["matches"][0]["cursor"].as_str().unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(
            cursor.reply_source_turn_id.as_deref(),
            Some("question-turn")
        );
        let page = load_search_match(&client, json!({"id":"thread-async"}), cursor)
            .await
            .unwrap();
        let turns = page.thread["turns"].as_array().unwrap();
        let turn_ids: Vec<_> = turns
            .iter()
            .map(|turn| turn["id"].as_str().unwrap())
            .collect();
        assert_eq!(
            turn_ids,
            ["older", "question-turn", "bridge", "reply-turn", "newer"]
        );
        assert_eq!(turns[1]["items"], json!(question_items));
        assert_eq!(turns[1]["itemsView"], "full");
        assert_eq!(turns[3]["items"][0]["id"], "reply");
        let mut projection = AsyncReplySearchProjection::default();
        let projected: Vec<_> = turns
            .iter()
            .flat_map(|turn| {
                codex_turn_search_sources(
                    turn,
                    &HashMap::new(),
                    Some("thread-async"),
                    &mut projection,
                )
            })
            .collect();
        let reply = projected.iter().find(|(id, _)| id == "reply").unwrap();
        assert_eq!(reply.1, "Choose needle\n**needle**");
        assert_eq!(
            reply
                .1
                .to_lowercase()
                .match_indices(&query.to_lowercase())
                .count(),
            expected_count
        );
        for (cursor, direction, first_id, next_id) in [
            (
                page.before_cursor.as_deref().unwrap(),
                CodexTranscriptDirection::Descending,
                "older",
                Some("oldest"),
            ),
            (
                page.after_cursor.as_deref().unwrap(),
                CodexTranscriptDirection::Ascending,
                "newest",
                None,
            ),
        ] {
            let first = load_context_page(
                &client,
                json!({"id":"thread-async"}),
                parse_context_cursor(cursor).unwrap().unwrap(),
                direction,
            )
            .await
            .unwrap();
            assert_eq!(first.thread["turns"][0]["id"], first_id);
            if let Some(next_id) = next_id {
                let next = load_context_page(
                    &client,
                    json!({"id":"thread-async"}),
                    parse_context_cursor(first.before_cursor.as_deref().unwrap())
                        .unwrap()
                        .unwrap(),
                    direction,
                )
                .await
                .unwrap();
                assert_eq!(next.thread["turns"][0]["id"], next_id);
                assert!(next.before_cursor.is_none());
            } else {
                assert!(first.after_cursor.is_none());
            }
        }
    }
    client.restart().await;
}

#[tokio::test]
async fn native_search_projects_terminal_turns_across_pages_and_hydrates_complete_segments() {
    let _environment = crate::agents::CodexLaunchEnvironment::new();
    let directory = tempfile::tempdir().unwrap();
    let mut failed_segments = vec![json!({
        "id":"early", "type":"agentMessage", "phase":"final_answer",
        "text":"API error: needle needle",
    })];
    failed_segments.extend((0..110).map(|index| {
        json!({
            "id":format!("tool-{index}"), "type":"commandExecution", "command":"echo padding",
        })
    }));
    failed_segments.extend([
        json!({"id":"guidance", "type":"userMessage", "clientId":"guidance-client",
            "content":[{"type":"text", "text":"continue"}]}),
        json!({"id":"hidden-prefix", "type":"agentMessage", "phase":"final_answer", "text":"API error:"}),
        json!({"id":"hidden-tail", "type":"agentMessage", "phase":"final_answer", "text":"needle"}),
    ]);
    let mut joined_content = vec![json!({
        "id":"joined-head", "type":"agentMessage", "phase":"final_answer", "text":"needle",
    })];
    joined_content.extend((0..110).map(|index| {
        json!({
            "id":format!("tool-{index}"), "type":"commandExecution", "command":"echo padding",
        })
    }));
    joined_content.push(json!({
        "id":"joined-tail", "type":"agentMessage", "phase":"final_answer", "text":"visible suffix",
    }));
    let mut completed_duplicate = vec![
        json!({"id":"answer-head", "type":"agentMessage", "phase":"final_answer", "text":"needle"}),
        json!({"id":"analysis-match", "type":"agentMessage", "phase":"commentary", "text":"needle"}),
    ];
    completed_duplicate.extend((0..110).map(|index| {
        json!({
            "id":format!("analysis-{index}"), "type":"agentMessage", "phase":"commentary",
            "text":format!("padding {index}"),
        })
    }));
    let mut completed_joined = completed_duplicate.clone();
    completed_joined.push(json!({
        "id":"answer-tail", "type":"agentMessage", "phase":"final_answer", "text":"tail",
    }));
    let cases = [
        (
            "failed-only",
            "failed",
            "needle",
            "API error: needle",
            vec![json!({"id":"hidden", "type":"agentMessage", "text":"API error: needle"})],
            vec![],
        ),
        (
            "cancelled-only",
            "interrupted",
            "interrupted",
            "",
            vec![
                json!({"id":"hidden", "type":"agentMessage", "phase":"commentary", "text":"interrupted"}),
            ],
            vec![],
        ),
        (
            "cancelled-visible-process",
            "interrupted",
            "interrupted",
            "",
            // A later tool keeps this unphased output in the visible process area.
            vec![
                json!({"id":"visible", "type":"agentMessage", "text":"interrupted"}),
                json!({"id":"tool", "type":"commandExecution", "command":"echo padding"}),
            ],
            vec![("visible", 0)],
        ),
        (
            "failed-segments",
            "failed",
            "needle",
            "API error: needle",
            failed_segments,
            vec![("early", 0), ("early", 1)],
        ),
        (
            "failed-joined",
            "failed",
            "needle",
            "needle",
            joined_content,
            vec![("joined-head", 0)],
        ),
        (
            "cancelled-segments",
            "interrupted",
            "interrupted",
            "",
            vec![
                json!({"id":"early", "type":"agentMessage", "phase":"commentary", "text":"interrupted"}),
                json!({"id":"guidance", "type":"userMessage",
                "content":[{"type":"text", "text":"continue"}]}),
                json!({"id":"hidden", "type":"agentMessage", "phase":"commentary", "text":"interrupted"}),
            ],
            vec![("early", 0)],
        ),
        (
            "cancelled-process",
            "interrupted",
            "needle",
            "",
            vec![
                json!({"id":"narrative", "type":"agentMessage", "phase":"commentary", "text":"needle analysis"}),
                json!({"id":"tool", "type":"commandExecution", "command":"echo padding"}),
            ],
            vec![("narrative", 0)],
        ),
        (
            "completed-duplicate-body",
            "completed",
            "needle",
            "",
            completed_duplicate,
            vec![("answer-head", 0)],
        ),
        (
            "completed-joined-body",
            "completed",
            "needle",
            "",
            completed_joined,
            vec![("answer-head", 0), ("analysis-match", 0)],
        ),
    ];
    for (thread_id, status, _, error, items, _) in &cases {
        let turn = json!({"id":"turn-visible", "status":status,
            "error":{"message":error}, "items":[], "itemsView":"notLoaded"});
        fs::write(
            directory.path().join(format!("{thread_id}-turns.json")),
            json!({"data":[turn], "nextCursor":null, "backwardsCursor":"turn-anchor"}).to_string(),
        )
        .unwrap();
        let page_count = items.len().div_ceil(SEARCH_PAGE_SIZE);
        for (index, page) in items.chunks(SEARCH_PAGE_SIZE).enumerate() {
            let data: Vec<_> = page
                .iter()
                .map(|item| json!({"turnId":"turn-visible", "item":item}))
                .collect();
            let next = (index + 1 < page_count).then(|| format!("page-{}", index + 1));
            fs::write(
                directory
                    .path()
                    .join(format!("{thread_id}-page-{index}.json")),
                json!({"data":data, "nextCursor":next}).to_string(),
            )
            .unwrap();
        }
    }
    let binary = directory.path().join("terminal-search-fixture");
    let log = directory.path().join("requests.jsonl");
    let script = r#"#!/bin/sh
while IFS= read -r line; do
  printf '%s\n' "$line" >> '__DIRECTORY__/requests.jsonl'
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  thread=$(printf '%s' "$line" | sed -n 's/.*"threadId":"\([^"]*\)".*/\1/p')
  case "$line" in
    *'"method":"initialized"'*) continue ;;
    *'"method":"thread/read"'*) result='{"thread":{"historyMode":"paginated"}}' ;;
    *'"method":"thread/turns/list"'*) result=$(cat "__DIRECTORY__/$thread-turns.json") ;;
    *'"method":"thread/items/list"'*)
      case "$line" in
        *'"cursor":null'*) page=page-0 ;;
        *) page=$(printf '%s' "$line" | sed -n 's/.*"cursor":"\([^"]*\)".*/\1/p') ;;
      esac
      result=$(cat "__DIRECTORY__/$thread-$page.json") ;;
    *) result='{}' ;;
  esac
  printf '{"id":%s,"result":%s}\n' "$id" "$result"
done
"#;
    fs::write(
        &binary,
        script.replace("__DIRECTORY__", &directory.path().to_string_lossy()),
    )
    .unwrap();
    fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
    let request = serde_json::from_value(json!({
        "user_name":"synthetic", "team_namespace":"default", "team_name":"search",
        "team_id":12, "bot":[{"id":31,"shell_type":"Codex"}],
    }))
    .unwrap();
    let client = CodexAppServerClient::new(binary.to_string_lossy())
        .for_request(&request)
        .unwrap();
    for (thread_id, status, query, error, items, expected) in cases {
        let result = search_codex_transcript(
            &client,
            thread_id,
            query,
            250,
            &HashSet::new(),
            &HashMap::new(),
        )
        .await
        .unwrap();
        let found: Vec<_> = result["matches"]
            .as_array()
            .unwrap()
            .iter()
            .map(|matched| {
                (
                    matched["itemId"].as_str().unwrap(),
                    matched["occurrence"].as_u64().unwrap(),
                )
            })
            .collect();
        assert_eq!(found, expected, "{thread_id}");
        if expected.is_empty() {
            continue;
        }
        for matched in result["matches"].as_array().unwrap() {
            let cursor = parse_search_cursor(matched["cursor"].as_str().unwrap())
                .unwrap()
                .unwrap();
            let before = calls(&log).len();
            let page = load_search_match(&client, json!({"id":thread_id}), cursor)
                .await
                .unwrap();
            assert_eq!(
                page.thread["turns"][0]["items"],
                json!(items),
                "{thread_id}"
            );
            assert_eq!(page.thread["turns"][0]["status"], status);
            assert_eq!(page.thread["turns"][0]["error"]["message"], error);
            assert_eq!(page.thread["turns"][0]["itemsView"], "full");
            assert!(page.before_cursor.is_none() && page.after_cursor.is_none());
            let hydrated_sources = codex_turn_search_sources(
                &page.thread["turns"][0],
                &HashMap::new(),
                Some(thread_id),
                &mut AsyncReplySearchProjection::default(),
            );
            assert_eq!(
                hydrated_sources,
                codex_turn_search_sources(
                    &json!({"id":"turn-visible", "status":status,
                    "error":{"message":error}, "items":items}),
                    &HashMap::new(),
                    Some(thread_id),
                    &mut AsyncReplySearchProjection::default(),
                ),
                "{thread_id}"
            );
            for (item_id, occurrence) in &expected {
                let text = hydrated_sources
                    .iter()
                    .find(|(id, _)| id == *item_id)
                    .unwrap();
                assert!(
                    text.1
                        .to_lowercase()
                        .match_indices(query)
                        .nth(*occurrence as usize)
                        .is_some(),
                    "{thread_id}: {item_id}"
                );
            }
            assert!(calls(&log)[before..].iter().all(|call| {
                call["method"] != "thread/items/read"
                    && (call["method"] != "thread/items/list"
                        || call["params"]["cursor"].is_null()
                        || call["params"]["cursor"].is_string())
            }));
        }
    }
    client.restart().await;
}

#[tokio::test]
async fn legacy_dispatch_searches_rollout_without_native_history_requests() {
    let _environment = crate::agents::CodexLaunchEnvironment::new();
    let directory = tempfile::tempdir().unwrap();
    let rollout = directory.path().join("legacy.jsonl");
    let records = [
        json!({"type":"session_meta", "payload":{"id":"thread-legacy"}}),
        json!({"type":"event_msg", "payload":{"type":"task_started", "turn_id":"turn-legacy"}}),
        json!({"type":"event_msg", "payload":{"type":"user_message", "message":"visible question", "client_id":"user-client"}}),
        json!({"type":"event_msg", "payload":{"type":"agent_message", "message":"visible needle answer"}}),
        json!({"type":"event_msg", "payload":{"type":"task_complete", "turn_id":"turn-legacy"}}),
    ];
    fs::write(
        &rollout,
        records
            .iter()
            .map(|record| format!("{record}\n"))
            .collect::<String>(),
    )
    .unwrap();
    let binary = directory.path().join("legacy-search-fixture");
    let log = directory.path().join("requests.jsonl");
    let metadata = json!({"thread":{
        "id":"thread-legacy", "historyMode":"legacy", "path":rollout,
    }});
    let script = r#"#!/bin/sh
while IFS= read -r line; do
  printf '%s\n' "$line" >> '__LOG__'
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialized"'*) continue ;;
    *'"method":"thread/read"'*) result='__METADATA__' ;;
    *) result='{}' ;;
  esac
  printf '{"id":%s,"result":%s}\n' "$id" "$result"
done
"#;
    fs::write(
        &binary,
        script
            .replace("__LOG__", &log.to_string_lossy())
            .replace("__METADATA__", &metadata.to_string()),
    )
    .unwrap();
    fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
    let request = serde_json::from_value(json!({
        "user_name":"synthetic", "team_namespace":"default", "team_name":"search",
        "team_id":12, "bot":[{"id":31,"shell_type":"Codex"}],
    }))
    .unwrap();
    let client = CodexAppServerClient::new(binary.to_string_lossy())
        .for_request(&request)
        .unwrap();
    let result = search_codex_transcript(
        &client,
        "thread-legacy",
        "needle",
        250,
        &HashSet::new(),
        &HashMap::new(),
    )
    .await
    .unwrap();
    assert_eq!(result["totalMatches"], 1);
    assert_eq!(result["matches"][0]["itemId"], "item-2");
    let cursor = result["matches"][0]["cursor"].as_str().unwrap();
    assert!(is_search_cursor(cursor));
    let page = super::super::codex_transcript_page::load_codex_transcript(
        &client,
        super::super::codex_transcript_page::CodexTranscriptRequest {
            thread_id: "thread-legacy",
            cursor: Some(cursor),
            limit: 5,
            direction: super::super::codex_transcript_page::CodexTranscriptDirection::Descending,
            full_content: true,
            prefer_rollout_history: false,
        },
    )
    .await
    .unwrap();
    let items = page.thread["turns"][0]["items"].as_array().unwrap();
    assert!(items
        .iter()
        .any(|item| item["id"] == "item-2" && item["text"] == "visible needle answer"));
    let requests = calls(&log);
    let methods: Vec<_> = requests
        .iter()
        .filter_map(|call| call["method"].as_str())
        .collect();
    assert_eq!(
        methods,
        ["initialize", "initialized", "thread/read", "thread/read"]
    );
    for request in requests
        .iter()
        .filter(|call| call["method"] == "thread/read")
    {
        assert_eq!(request["params"]["includeTurns"], false);
    }
    client.restart().await;
}
