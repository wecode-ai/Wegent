// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

fn question_message(id: &str, questions: &[&str], delivery: &str) -> Value {
    json!({"id":id, "role":"assistant", "blocks":[{
        "type":"tool", "render_payload":{
            "kind":"request_user_input", "delivery":delivery,
            "questions": questions.iter().map(|question| json!({"question":question})).collect::<Vec<_>>(),
        },
    }]})
}

#[test]
fn async_reply_uses_last_pairable_question_group_and_raw_answer() {
    let mut projection = AsyncReplySearchProjection::default();
    projection.message_text(&question_message("old", &["old"], "async"), "old-turn");
    projection.message_text(
        &question_message("latest", &["**needle**?"], "async"),
        "question-turn",
    );
    projection.message_text(
        &question_message("unpaired", &["one", "two"], "async"),
        "unpaired-turn",
    );
    projection.message_text(
        &question_message("blocking", &["blocking"], "blocking"),
        "blocking-turn",
    );
    projection.message_text(
        &json!({"id":"empty", "role":"user", "content":" \n "}),
        "reply-turn",
    );
    let reply = json!({"id":"reply", "role":"user", "content":" **needle** "});
    assert_eq!(
        projection.message_text(&reply, "reply-turn").as_deref(),
        Some("**needle**?\n**needle**")
    );
    assert_eq!(projection.reply_source("reply"), Some("question-turn"));
    assert_eq!(
        projection.reply_questions("reply"),
        Some(["**needle**?".to_owned()].as_slice())
    );
    let ordinary = json!({"id":"ordinary", "role":"user", "content":"**needle**"});
    assert_eq!(
        projection.message_text(&ordinary, "later").as_deref(),
        Some("needle")
    );
    assert!(projection.reply_questions("ordinary").is_none());
}

#[test]
fn async_reply_joins_multiple_question_rows_without_markdown_parsing() {
    let mut projection = AsyncReplySearchProjection::default();
    projection.message_text(
        &question_message("card", &["first?", "second?"], "async"),
        "question",
    );
    assert_eq!(
        projection
            .message_text(
                &json!({
                    "id":"reply", "role":"user", "content":"\n **one** \n\n [two](url) \n",
                }),
                "answer"
            )
            .as_deref(),
        Some("first?\n**one**\nsecond?\n[two](url)")
    );
    projection.message_text(
        &question_message("unmatched", &["first?", "second?"], "async"),
        "question",
    );
    assert_eq!(
        projection
            .message_text(
                &json!({"id":"unmatched-reply", "role":"user", "content":"**one**"}),
                "answer"
            )
            .as_deref(),
        Some("one")
    );
    assert_eq!(
        projection
            .message_text(
                &json!({"id":"later", "role":"user", "content":"one\ntwo"}),
                "later"
            )
            .as_deref(),
        Some("one\ntwo")
    );
    assert!(projection.reply_questions("later").is_none());
}

#[test]
fn async_reply_projection_keeps_provider_ids_across_native_turns() {
    for card in [
        json!({"id":"question", "type":"agentMessage", "phase":"final_answer", "text":"fallback", "delivery":"async", "questions":[{"title":"needle needle?", "options":["a", "b"]}]}),
        json!({"id":"question", "type":"functionCall", "name":"request_user_input_async", "arguments":json!({"questions":[{"title":"needle needle?", "options":["a", "b"]}]}).to_string()}),
    ] {
        let mut projection = AsyncReplySearchProjection::default();
        codex_turn_search_sources(
            &json!({"id":"question-turn", "status":"completed", "items":[card]}),
            &HashMap::new(),
            None,
            &mut projection,
        );
        codex_turn_search_sources(
            &json!({"id":"between", "status":"completed", "items":[{"id":"comment", "type":"agentMessage", "phase":"commentary", "text":"working"}]}),
            &HashMap::new(),
            None,
            &mut projection,
        );
        let sources = codex_turn_search_sources(
            &json!({"id":"reply-turn", "status":"completed", "items":[{
                "id":"provider-reply", "clientId":"client-reply", "type":"userMessage", "content":[],
            }]}),
            &HashMap::from([("client-reply".into(), "**needle**".into())]),
            None,
            &mut projection,
        );
        assert_eq!(
            sources,
            vec![("provider-reply".into(), "needle needle?\n**needle**".into())]
        );
        assert_eq!(
            projection.reply_source("provider-reply"),
            Some("question-turn")
        );
    }
}

#[test]
fn async_reply_empty_restored_user_body_preserves_pending_question() {
    let mut projection = AsyncReplySearchProjection::default();
    codex_turn_search_sources(
        &json!({"id":"question-turn", "status":"completed", "items":[{
            "id":"question", "type":"agentMessage", "phase":"final_answer",
            "text":"fallback", "delivery":"async",
            "questions":[{"title":"needle?", "options":["yes", "no"]}],
        }]}),
        &HashMap::new(),
        None,
        &mut projection,
    );
    let sources = codex_turn_search_sources(
        &json!({"id":"reply-turn", "status":"completed", "items":[
            {"id":"hidden-reply", "clientId":"hidden-client", "type":"userMessage",
                "content":[{"type":"inputText", "text":"injected attachment needle"}]},
            {"id":"actual-reply", "type":"userMessage",
                "content":[{"type":"inputText", "text":"**answer**"}]},
        ]}),
        &HashMap::from([("hidden-client".into(), String::new())]),
        None,
        &mut projection,
    );
    assert_eq!(
        sources,
        vec![
            ("hidden-reply".into(), String::new()),
            ("actual-reply".into(), "needle?\n**answer**".into()),
        ]
    );
    assert!(projection.reply_questions("hidden-reply").is_none());
    assert_eq!(
        projection.reply_source("actual-reply"),
        Some("question-turn")
    );
}
