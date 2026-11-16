// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

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
