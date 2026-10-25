// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

fn live_native_messages() -> Vec<Value> {
    transcript_messages(
        &json!({
            "turns": [{
                "id": "turn-1",
                "status": "inProgress",
                "itemsView": "full",
                "items": [
                    {"id": "user-1", "type": "userMessage", "content": [
                        {"type": "text", "text": "Continue the task"}
                    ]},
                    {"id": "answer-1", "type": "agentMessage", "text": "Useful output"}
                ]
            }]
        }),
        "test-device",
    )
}

#[test]
fn canonical_turn_status_uses_completed_assistant_after_live_user_projection() {
    for status in ["done", "failed", "cancelled"] {
        let mut messages = live_native_messages();
        assert_eq!(messages[0]["role"], "user");
        assert_eq!(messages[0]["runtimeStatus"], "streaming");
        let mut completed = messages[1].clone();
        completed["status"] = json!(status);
        completed["completedAt"] = json!(1_800_000_000_000_i64);
        completed["error"] = json!("Provider outcome");
        assert!(completed.get("runtimeStatus").is_none());
        let mut link = RuntimeTaskLink {
            thread_id: Some("thread-1".to_owned()),
            ..RuntimeTaskLink::default()
        };
        append_completed_transcript_messages(&mut link.runtime_handle, "thread-1", vec![completed]);

        merge_latest_completed_transcript_messages(&mut messages, &link, None, None);
        let turns = transcript_canonical_turns(&messages, TranscriptTurnItemSource::CodexItems);

        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0]["status"], status);
        assert_eq!(turns[0]["runtimeStatus"], status);
        assert_eq!(turns[0]["completedAt"], 1_800_000_000_000_i64);
        assert_eq!(turns[0]["error"], "Provider outcome");
        assert_eq!(turns[0]["items"][1]["id"], "answer-1");
        assert_eq!(turns[0]["items"][1]["type"], "block");
        assert_eq!(turns[0]["items"][1]["block"]["type"], "text");
        assert_eq!(turns[0]["items"][1]["block"]["content"], "Useful output");
    }
}

#[test]
fn canonical_turn_status_preserves_live_assistant_and_user_only_turns() {
    let messages = live_native_messages();
    let turns = transcript_canonical_turns(&messages, TranscriptTurnItemSource::CodexItems);
    assert_eq!(turns[0]["status"], "streaming");
    assert_eq!(turns[0]["runtimeStatus"], "streaming");

    let turns = transcript_canonical_turns(&messages[..1], TranscriptTurnItemSource::CodexItems);
    assert_eq!(turns[0]["status"], "done");
    assert_eq!(turns[0]["runtimeStatus"], "streaming");
}

#[test]
fn canonical_turn_status_keeps_current_message_runtime_status() {
    let mut messages = live_native_messages();
    messages[1]["status"] = json!("done");
    messages[1]["runtimeStatus"] = json!("cancelled");

    let turns = transcript_canonical_turns(&messages, TranscriptTurnItemSource::CodexItems);

    assert_eq!(turns[0]["status"], "done");
    assert_eq!(turns[0]["runtimeStatus"], "cancelled");
}
