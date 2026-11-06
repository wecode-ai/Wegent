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

#[tokio::test]
async fn canonical_native_transcript_repairs_cold_terminal_metadata_durably() {
    let (mut handler, root) = isolated_runtime_work_handler("native-terminal-cold-repair");
    let completed_at = 1_800_000_000_000_i64;
    handler.upsert_local_task(RuntimeTaskLink {
        local_task_id: "task-1".into(),
        thread_id: Some("thread-1".into()),
        workspace_path: "/tmp/project".into(),
        runtime: "codex".into(),
        status: "active".into(),
        runtime_handle: json!({"lastTurnId":"turn-1"}),
        ..Default::default()
    });
    install_native_history(
        &mut handler,
        &root,
        vec![json!({
            "id":"turn-1","status":"completed","completedAt":completed_at,
            "items":[{"id":"answer","type":"agentMessage","phase":"final_answer","text":"Actual finished result"}]
        })],
        None,
    );
    let result = handler
        .transcript(json!({"taskId":"task-1","limit":10}))
        .await;
    handler
        .codex_app_server
        .request("test/stop", json!({}))
        .await
        .unwrap();
    let response = result.unwrap();
    assert_eq!(response["running"], false);
    let restored = RuntimeWorkStore::new(handler.store.index_path().to_path_buf())
        .get_task("task-1")
        .unwrap();
    assert_eq!(restored.status, "done");
    assert_eq!(restored.turn_status.as_deref(), Some("completed"));
    assert_eq!(restored.completed_at, Some(completed_at));
    assert!(restored.execution_state.is_none());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn native_terminal_repair_requires_exact_completion_and_never_overrides_new_request() {
    let (handler, root) = isolated_runtime_work_handler("native-terminal-repair-guards");
    let thread = json!({"id":"thread-1","timeline":true,"turns":[{
        "id":"turn-1","status":"completed","timelineCompleted":true,"completedAt":1_800_000_000_000_i64
    }]});
    let original = RuntimeTaskLink {
        local_task_id: "task-1".into(),
        thread_id: Some("thread-1".into()),
        runtime: "codex".into(),
        status: "active".into(),
        runtime_handle: json!({"lastTurnId":"turn-1"}),
        ..Default::default()
    };
    for variant in [
        "other-thread",
        "older-turn",
        "missing-boundary",
        "missing-time",
        "queued",
        "newer-turn",
    ] {
        let mut link = original.clone();
        let mut evidence = thread.clone();
        match variant {
            "other-thread" => evidence["id"] = json!("other-thread"),
            "older-turn" => evidence["turns"][0]["id"] = json!("old-turn"),
            "missing-boundary" => evidence["turns"][0]["timelineCompleted"] = json!(false),
            "missing-time" => evidence["turns"][0]["completedAt"] = Value::Null,
            "newer-turn" => evidence["turns"]
                .as_array_mut()
                .unwrap()
                .push(json!({"id":"new-turn","status":"inProgress"})),
            "queued" => crate::runtime_work::lifecycle::queue_native_execution(&mut link, 1, false),
            _ => unreachable!(),
        }
        handler.upsert_local_task(link);
        handler.reconcile_native_transcript_terminal("task-1", &evidence);
        let actual = handler.local_task_link("task-1").unwrap();
        assert_ne!(actual.status, "done", "{variant}");
        assert!(actual.completed_at.is_none(), "{variant}");
    }
    fs::remove_dir_all(root).unwrap();
}
