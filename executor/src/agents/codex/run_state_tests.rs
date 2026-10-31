// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde_json::{json, Value};

use super::CodexRunState;
use crate::{agents::codex::CodexResponseValueOrigin, runner::ExecutionOutcome};

fn notify(state: &mut CodexRunState, method: &str, params: Value) -> Option<ExecutionOutcome> {
    state.handle_message(&json!({ "method": method, "params": params }))
}

fn message(state: &mut CodexRunState, id: &str, phase: Option<&str>, text: &str) {
    notify(
        state,
        "item/completed",
        json!({ "item": {
            "id": id, "type": "agentMessage", "role": "assistant", "phase": phase, "text": text
        }}),
    );
}

fn complete(state: &mut CodexRunState, status: &str) -> ExecutionOutcome {
    notify(
        state,
        "turn/completed",
        json!({ "turn": { "status": status } }),
    )
    .unwrap()
}

#[test]
fn unphased_terminal_message_has_final_origin_only_after_success() {
    for streamed in [false, true] {
        let mut state = CodexRunState::default();
        if streamed {
            notify(
                &mut state,
                "item/agentMessage/delta",
                json!({
                    "itemId": "answer", "delta": "Complete answer"
                }),
            );
        }
        message(&mut state, "answer", None, "Complete answer");
        assert_eq!(
            state.response_value_origin(),
            CodexResponseValueOrigin::ProcessFallback
        );
        assert_eq!(
            complete(&mut state, "completed"),
            ExecutionOutcome::Completed {
                content: "Complete answer".into()
            }
        );
        assert_eq!(
            state.response_value_origin(),
            CodexResponseValueOrigin::Final
        );
        assert_eq!(state.response_item_id(), Some("answer"));
    }
}

#[test]
fn process_phases_and_unknown_phases_are_never_promoted() {
    for phase in ["analysis", "commentary", "unknown"] {
        let mut state = CodexRunState::default();
        notify(
            &mut state,
            "item/started",
            json!({ "item": {
                "id": "process", "type": "agentMessage", "phase": phase
            }}),
        );
        notify(
            &mut state,
            "item/agentMessage/delta",
            json!({
                "itemId": "process", "delta": "Still working"
            }),
        );
        message(&mut state, "process", None, "Still working");
        complete(&mut state, "completed");
        assert_eq!(
            state.response_value_origin(),
            CodexResponseValueOrigin::ProcessFallback,
            "{phase}"
        );
    }
}

#[test]
fn later_process_activity_invalidates_unphased_final_candidate() {
    for item_type in [
        "commandExecution",
        "function_call_output",
        "reasoning",
        "plan",
        "fileChange",
        "contextCompaction",
    ] {
        for method in ["item/started", "item/completed"] {
            let mut state = CodexRunState::default();
            message(&mut state, "preamble", None, "I will inspect it");
            notify(
                &mut state,
                method,
                json!({ "item": { "type": item_type, "id": "work" }}),
            );
            complete(&mut state, "completed");
            assert_eq!(
                state.response_value_origin(),
                CodexResponseValueOrigin::ProcessFallback,
                "{method} {item_type}"
            );
        }
    }
}

#[test]
fn final_message_after_tools_is_promoted_and_new_turn_resets_it() {
    let mut state = CodexRunState::default();
    message(&mut state, "preamble", None, "I will inspect it");
    notify(
        &mut state,
        "item/completed",
        json!({ "item": { "type": "commandExecution" }}),
    );
    message(&mut state, "answer", None, "Fixed it");
    complete(&mut state, "completed");
    assert_eq!(
        state.response_value_origin(),
        CodexResponseValueOrigin::Final
    );
    notify(&mut state, "turn/started", json!({}));
    complete(&mut state, "completed");
    assert_eq!(
        state.response_value_origin(),
        CodexResponseValueOrigin::Empty
    );
}

#[test]
fn unsuccessful_turns_do_not_promote_unphased_text() {
    for status in ["failed", "interrupted", "cancelled"] {
        let mut state = CodexRunState::default();
        message(&mut state, "preamble", None, "Still working");
        complete(&mut state, status);
        assert_eq!(
            state.response_value_origin(),
            CodexResponseValueOrigin::ProcessFallback
        );
    }
}

#[test]
fn subagent_activity_does_not_change_root_final_candidate() {
    let mut state = CodexRunState::default();
    state.set_root_thread_id("root");
    message(&mut state, "answer", None, "Root answer");
    notify(
        &mut state,
        "item/completed",
        json!({
            "threadId": "child", "item": { "type": "commandExecution" }
        }),
    );
    complete(&mut state, "completed");
    assert_eq!(
        state.response_value_origin(),
        CodexResponseValueOrigin::Final
    );
}
