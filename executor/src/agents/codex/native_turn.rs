// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

/// Reuse the stream result projection for a completed native turn's full items.
pub(crate) fn completed_native_codex_turn(thread_id: &str, turn: &Value) -> CodexAppServerTurn {
    let mut state = CodexRunState::default();
    state.set_root_thread_id(thread_id);
    for item in turn
        .get("items")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        state.handle_message(&json!({"method": "item/completed", "params": {
            "threadId": thread_id, "turnId": turn["id"], "item": item,
        }}));
    }
    let outcome = state
        .handle_message(&json!({"method": "turn/completed", "params": {
            "threadId": thread_id, "turn": turn,
        }}))
        .expect("A root completion must have an outcome");
    let (started_at_ms, completed_at_ms, duration_ms) = state.turn_timing();
    CodexAppServerTurn {
        thread_id: thread_id.to_owned(),
        outcome,
        response_item_id: state.response_item_id().map(str::to_owned),
        response_value_origin: state.response_value_origin(),
        goal_status: None,
        goal_status_observed: false,
        started_at_ms,
        completed_at_ms,
        duration_ms,
    }
}
