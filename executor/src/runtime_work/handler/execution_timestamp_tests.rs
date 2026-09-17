// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[test]
fn starting_follow_up_advances_the_previous_completion_timestamp() {
    let (handler, root) = isolated_runtime_work_handler("follow-up-start-timestamp");
    let completed_at = 1_780_000_002_355;
    handler.upsert_local_task(RuntimeTaskLink {
        local_task_id: "task-1".to_owned(),
        thread_id: Some("thread-1".to_owned()),
        workspace_path: root.to_string_lossy().into_owned(),
        status: "done".to_owned(),
        updated_at: completed_at,
        completed_at: Some(completed_at),
        ..RuntimeTaskLink::default()
    });

    let execution_id = start_test_execution(&handler, "task-1");
    let link = handler.local_task_link("task-1").unwrap();

    assert!(link.running);
    assert_eq!(link.completed_at, None);
    assert!(link.updated_at > completed_at);
    assert!(handler.finish_local_task_execution("task-1", execution_id));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn running_projection_preserves_local_start_when_provider_timestamp_lags() {
    let started_at = 1_780_000_003_456;
    for provider_updated_at in [1_780_000_002_000, 1_780_000_004_000] {
        let link = RuntimeTaskLink::from_thread_metadata(
            &json!({
                "id": "thread-1",
                "status": {"type": "idle"},
                "updatedAt": provider_updated_at,
                "turns": [{"status": "completed"}],
            }),
            Some(RuntimeTaskLink {
                local_task_id: "task-1".to_owned(),
                updated_at: started_at,
                ..RuntimeTaskLink::default()
            }),
            "/tmp/project".to_owned(),
            true,
        );

        assert!(link.running);
        assert_eq!(link.completed_at, None);
        assert_eq!(link.updated_at, started_at.max(provider_updated_at));
    }
}
