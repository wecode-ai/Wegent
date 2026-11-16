// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

fn queued_im_turn(task: &str, callback: &str) -> SpawnTurnRequest {
    let mut request = ExecutionRequest {
        task_id: task.into(),
        subtask_id: callback.into(),
        prompt: json!(callback),
        ..Default::default()
    };
    request.extra.insert(
        "source".into(),
        json!({"source":"im","channel_type":"telegram","callback_id":callback}),
    );
    SpawnTurnRequest {
        task_kind: None,
        local_task_id: task.into(),
        runtime: "codex".into(),
        request,
        send_payload: None,
        direct_thread_id: None,
        fork_thread_id: None,
        fork_thread_path: None,
        resume_thread_id: Some("native-thread".into()),
        initial_thread_goal: None,
    }
}

#[tokio::test]
async fn persisted_im_queue_routes_each_native_reply_to_its_own_callback() {
    let root = tempfile::tempdir().unwrap();
    let (event_tx, mut events) = broadcast::channel(64);
    let mut handler = RuntimeWorkRpcHandler::with_event_sender("mac", "/bin/false", event_tx);
    handler.store = RuntimeWorkStore::new(root.path().join("runtime.json"));
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    handler.turn_queue_path = Arc::new(root.path().join("queue.json"));
    handler.command_journal = Arc::new(Mutex::new(Default::default()));
    let task = "im-identity";
    handler.upsert_local_task(RuntimeTaskLink {
        local_task_id: task.into(),
        runtime: "codex".into(),
        thread_id: Some("native-thread".into()),
        ..Default::default()
    });
    for callback in ["im-first", "im-second"] {
        handler
            .queue_turn(queued_im_turn(task, callback))
            .await
            .unwrap();
    }
    let restored = read_runtime_turn_queue(&handler.turn_queue_path).unwrap();
    assert_eq!(restored.len(), 2);
    while events.try_recv().is_ok() {}
    for (turn, callback) in restored.iter().zip(["im-first", "im-second"]) {
        assert_eq!(turn.request.extra["source"]["callback_id"], callback);
        let execution = start_test_execution(&handler, task);
        handler.register_thread_event_route(
            "native-thread",
            task.into(),
            turn.request.clone(),
            true,
        );
        handler.record_active_codex_turn(task, execution, "native-thread".into(), callback.into());
        handler.begin_active_codex_transcript(task, "native-thread", callback);
        let active = handler.active_codex_turn(task).unwrap();
        let notification = CodexNotification::from(json!({"method":"item/completed","params":{
            "threadId":"native-thread","turnId":callback,
            "item":{"id":format!("reply-{callback}"),"type":"agentMessage","phase":"final_answer","text":callback}
        }}));
        handler
            .deliver_native_notification_for_execution(
                task,
                execution,
                &turn.request,
                Some(active),
                notification.clone(),
            )
            .await;
        handler.route_codex_notification(notification);
        let mut replies = Vec::new();
        while let Ok(event) = events.try_recv() {
            if event["event"] == "response.output_text.done" {
                replies.push(event);
            }
        }
        assert_eq!(
            replies.len(),
            1,
            "Each native reply must be emitted exactly once"
        );
        assert_eq!(replies[0]["payload"]["source"]["callback_id"], callback);
        assert_eq!(replies[0]["payload"]["data"]["text"], callback);
        finish_test_native_turn(&handler, task, "native-thread");
    }
}
