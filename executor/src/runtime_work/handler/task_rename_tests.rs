// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[tokio::test]
async fn manual_rename_notifies_other_consumers_after_persisting_the_title() {
    let (mut handler, root) = isolated_runtime_work_handler("rename-title-event");
    let (sender, mut receiver) = broadcast::channel(8);
    handler.event_tx = Some(sender);
    handler.upsert_local_task(RuntimeTaskLink::new_pending(
        "task-1".into(),
        "/project".into(),
        "Original title".into(),
    ));

    let result = handler
        .rename_task(json!({"taskId": "task-1", "title": "Private conversation"}))
        .await
        .unwrap();

    assert_eq!(result["accepted"], true);
    let event = receiver.try_recv().expect("Rename must notify observers");
    assert_eq!(event["event"], "runtime.task.title.updated");
    assert_eq!(event["payload"]["deviceId"], "device-1");
    assert_eq!(event["payload"]["taskId"], "task-1");
    assert_eq!(event["payload"]["data"]["title"], "Private conversation");
    assert_eq!(
        handler.local_task_link("task-1").unwrap().title,
        "Private conversation"
    );
    fs::remove_dir_all(root).unwrap();
}
