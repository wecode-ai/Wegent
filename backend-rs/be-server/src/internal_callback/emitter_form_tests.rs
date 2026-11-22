// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Callback enrichment through the emitted execution frame.

use super::*;
use serde_json::json;
use wegent_execution_emission::test_support::RecordingRedis;

struct CountingFormNormalizer(std::sync::Arc<std::sync::atomic::AtomicUsize>);

#[async_trait::async_trait]
impl crate::InteractiveFormQuestionNormalizer for CountingFormNormalizer {
    async fn normalize(&self, task_id: i64, mut questions: Vec<Value>) -> Vec<Value> {
        assert_eq!(task_id, 7);
        self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        questions[0]["question"] = json!("Continue the normalized diff changes?");
        questions
    }
}

async fn emit_function_call(
    redis: &RecordingRedis,
    registry: &crate::InteractiveFormRegistry,
    tool_name: &str,
) -> Vec<super::super::event::ExecutionEvent> {
    let parser = super::super::parser::ResponsesApiEventParser::default();
    let item = json!({
        "type": "function_call", "call_id": "codex-interaction-1", "name": tool_name,
        "arguments": json!({"questions": [{
            "id": "diff_scope", "question": "Continue the diff changes?",
            "input_type": "choice", "options": [{"label": "Continue", "value": "continue"}],
        }]}).to_string(),
        "output": r#"{"__deferred_user_input__":true,"success":true,"status":"waiting_for_user_response"}"#,
        "status": "completed",
    });
    let mut events = Vec::new();
    for event_type in [
        "response.output_item.added",
        "response.output_item.done",
        "response.output_item.done",
    ] {
        let mut event = parser
            .parse(7, 9, Some(4), event_type, &json!({"item": item}))
            .expect("parse")
            .expect("event");
        super::super::prepare_interactive_form_event(registry, &mut event).await;
        let mut emitter = StatusUpdatingEmitter::new(redis.clone(), 7, 9);
        emitter.emit(&mut event).await.expect("emit");
        emitter.close().await;
        events.push(event);
    }
    events
}

#[tokio::test]
async fn native_user_input_callback_preserves_form_in_storage_and_socket_updates() {
    let redis = RecordingRedis::default();
    let registry = crate::InteractiveFormRegistry::default();
    let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    registry.register(std::sync::Arc::new(CountingFormNormalizer(calls.clone())));
    let events = emit_function_call(&redis, &registry, "interactive_form_question").await;
    let blocks = session::get_blocks(&redis, 9).await;
    assert_eq!(
        blocks.len(),
        1,
        "a repeated callback must update the same block"
    );
    let form = blocks[0]
        .get("render_payload")
        .expect("stored interactive form payload");
    assert_eq!(form["type"], "interactive_form_question");
    assert_eq!(form["task_id"], 7);
    assert_eq!(form["subtask_id"], 9);
    assert_eq!(
        form["questions"][0]["question"],
        "Continue the normalized diff changes?"
    );
    assert_eq!(form["questions"][0]["options"][0]["value"], "continue");
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
    let state = redis.state.lock().expect("state");
    let updates: Vec<_> = state
        .published
        .iter()
        .filter(|message| message["event"] == "chat:block_updated")
        .collect();
    assert_eq!(updates.len(), 2);
    for update in updates {
        assert_eq!(&update["data"][0]["render_payload"], form);
        assert_eq!(update["data"][0]["block_id"], "codex-interaction-1");
    }
    assert_eq!(events[1].tool_input, events[2].tool_input);
    assert!(
        events[1]
            .tool_input
            .as_ref()
            .unwrap()
            .get("render_payload")
            .is_none()
    );
}

#[tokio::test]
async fn ordinary_tool_callbacks_do_not_normalize_or_attach_a_form() {
    let redis = RecordingRedis::default();
    let registry = crate::InteractiveFormRegistry::default();
    let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    registry.register(std::sync::Arc::new(CountingFormNormalizer(calls.clone())));
    emit_function_call(&redis, &registry, "exec_command").await;
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 0);
    let blocks = session::get_blocks(&redis, 9).await;
    assert_eq!(blocks.len(), 1);
    assert!(!blocks[0].contains_key("render_payload"));
    let state = redis.state.lock().expect("state");
    assert!(
        state
            .published
            .iter()
            .all(|message| message["data"][0].get("render_payload").is_none())
    );
}
