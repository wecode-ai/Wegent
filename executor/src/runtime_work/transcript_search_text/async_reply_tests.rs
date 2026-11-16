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
