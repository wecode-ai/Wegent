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

fn with_code_comment_context(content: &str) -> String {
    format!(
        "{content}\n\n<workspace_comment_context>\n{}\n{}\n</workspace_comment_context>",
        "The user attached the following comments. Treat browser_annotation items as comments on parts of the visible web page, and code_selection items as comments on selected code.",
        json!([{
            "commentNumber": 1, "source": "code_selection", "location": "File: example.rs, lines 1",
            "filePath": "example.rs", "fileName": "example.rs", "selectedText": "annotation-only needle",
            "userComment": "Please review",
        }]),
    )
}

fn native_question_turn(questions: &[&str]) -> Value {
    json!({"id":"question-turn", "status":"completed", "items":[{
        "id":"card", "type":"agentMessage", "phase":"final_answer", "text":"fallback",
        "delivery":"async", "questions":questions.iter().map(|question| json!({
            "title":question, "options":["yes", "no"],
        })).collect::<Vec<_>>(),
    }]})
}

fn native_user_turn(content: &str) -> Value {
    json!({"id":"reply-turn", "status":"completed", "items":[{
        "id":"reply", "type":"userMessage", "content":[{"type":"inputText", "text":content}],
    }]})
}

#[test]
fn native_ordinary_plan_confirmation_indexes_only_the_visible_label() {
    for (content, expected) in [
        (" \nPLEASE IMPLEMENT THIS PLAN: needle", "是的，执行此计划"),
        (
            "<application_context>hidden</application_context>\nPLEASE IMPLEMENT THIS PLAN: needle",
            "是的，执行此计划",
        ),
        (
            "please implement this plan: needle",
            "please implement this plan: needle",
        ),
        (
            "before PLEASE IMPLEMENT THIS PLAN: needle",
            "before PLEASE IMPLEMENT THIS PLAN: needle",
        ),
    ] {
        let mut projection = AsyncReplySearchProjection::default();
        assert_eq!(
            codex_turn_search_sources(
                &native_user_turn(content),
                &HashMap::new(),
                None,
                &mut projection,
            ),
            vec![("reply".into(), expected.into())],
            "{content}",
        );
        assert!(projection.reply_questions("reply").is_none());
    }
}

#[test]
fn native_async_plan_and_markdown_answers_remain_raw() {
    for answer in [
        "PLEASE IMPLEMENT THIS PLAN: needle",
        "**needle** [link](url)",
    ] {
        let mut projection = AsyncReplySearchProjection::default();
        codex_turn_search_sources(
            &native_question_turn(&["question-only?"]),
            &HashMap::new(),
            None,
            &mut projection,
        );
        assert_eq!(
            codex_turn_search_sources(
                &native_user_turn(answer),
                &HashMap::new(),
                None,
                &mut projection,
            ),
            vec![("reply".into(), format!("question-only?\n{answer}"))],
        );
        assert_eq!(projection.reply_source("reply"), Some("question-turn"));
    }
}

#[test]
fn native_async_answers_strip_valid_comment_context_before_pairing() {
    let cases: [(&[&str], &str, &str); 2] = [
        (&["Choose?"], "yes", "Choose?\nyes"),
        (
            &["First?", "Second?"],
            "**one**\n[two](url)",
            "First?\n**one**\nSecond?\n[two](url)",
        ),
    ];
    for (questions, answer, expected) in cases {
        let mut projection = AsyncReplySearchProjection::default();
        codex_turn_search_sources(
            &native_question_turn(questions),
            &HashMap::new(),
            None,
            &mut projection,
        );
        let sources = codex_turn_search_sources(
            &native_user_turn(&with_code_comment_context(answer)),
            &HashMap::new(),
            None,
            &mut projection,
        );
        assert_eq!(sources, vec![("reply".into(), expected.into())]);
        assert!(!sources[0].1.contains("commentNumber"));
        assert!(!sources[0].1.contains("needle"));
        assert_eq!(
            projection.reply_questions("reply"),
            Some(
                questions
                    .iter()
                    .map(|question| (*question).to_owned())
                    .collect::<Vec<_>>()
                    .as_slice()
            ),
        );
    }
}

#[test]
fn async_comment_only_message_preserves_pending_question() {
    let mut projection = AsyncReplySearchProjection::default();
    projection.message_text(&question_message("card", &["Choose?"], "async"), "question");
    assert_eq!(
        projection
            .message_text(
                &json!({"id":"comments", "role":"user", "content":with_code_comment_context("")}),
                "comments",
            )
            .as_deref(),
        Some(""),
    );
    assert!(projection.reply_questions("comments").is_none());
    assert_eq!(
        projection
            .message_text(
                &json!({"id":"reply", "role":"user", "content":"yes"}),
                "reply"
            )
            .as_deref(),
        Some("Choose?\nyes"),
    );
    assert_eq!(projection.reply_source("reply"), Some("question"));
}

#[test]
fn async_invalid_comment_context_remains_part_of_the_raw_answer() {
    let valid = with_code_comment_context("**yes**");
    for content in [
        valid.replace(
            "The user attached the following comments.",
            "User typed example.",
        ),
        valid.replace("\"commentNumber\":1", "\"commentNumber\":\"1\""),
        format!("{valid} ordinary text"),
        "**yes**\n<workspace_comment_context>not-json</workspace_comment_context>".into(),
    ] {
        let mut projection = AsyncReplySearchProjection::default();
        projection.message_text(&question_message("card", &["Choose?"], "async"), "question");
        assert_eq!(
            projection.message_text(
                &json!({"id":"reply", "role":"user", "content":content}),
                "reply"
            ),
            Some(format!("Choose?\n{content}")),
        );
    }
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
