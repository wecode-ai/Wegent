// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[tokio::test]
async fn manual_rename_persists_and_publishes_the_same_title() {
    let (mut handler, root) = isolated_runtime_work_handler("manual-title-event");
    let (events_tx, mut events) = tokio::sync::broadcast::channel(8);
    handler.event_tx = Some(events_tx);
    handler.upsert_local_task(RuntimeTaskLink {
        local_task_id: "task-1".to_owned(),
        title: "Original".to_owned(),
        status: "done".to_owned(),
        workspace_path: root.to_string_lossy().into_owned(),
        ..RuntimeTaskLink::default()
    });

    let response = handler
        .rename_task(json!({"taskId":"task-1", "title":"Private title"}))
        .await
        .unwrap();

    assert_eq!(response["accepted"], true);
    assert_eq!(
        handler.local_task_link("task-1").unwrap().title,
        "Private title"
    );
    let event = events
        .try_recv()
        .expect("Renaming must notify every subscribed viewer");
    assert_eq!(event["event"], "runtime.task.title.updated");
    assert_eq!(event["payload"]["taskId"], "task-1");
    assert_eq!(event["payload"]["data"]["title"], "Private title");
    fs::remove_dir_all(root).unwrap();
}
