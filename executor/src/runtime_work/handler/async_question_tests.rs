// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[test]
fn nested_async_question_does_not_mark_the_parent_waiting() {
    let (handler, root) = isolated_runtime_work_handler("nested-async-question");
    let task_id = "parent-task";
    handler.upsert_local_task(RuntimeTaskLink::new_pending(
        task_id.to_owned(),
        "/tmp/project".to_owned(),
        "Parent".to_owned(),
    ));
    handler.register_thread_event_route(
        "child-thread",
        task_id.to_owned(),
        ExecutionRequest::default(),
        false,
    );
    handler
        .thread_event_routing
        .lock()
        .unwrap()
        .routes
        .get_mut("child-thread")
        .unwrap()
        .nested = true;
    handler.route_codex_notification(json!({
        "method": "item/completed",
        "params": {
            "threadId": "child-thread", "turnId": "child-turn",
            "item": {
                "id": "child-question", "type": "agentMessage",
                "questions": [{"title": "Continue?", "options": ["Yes", "No"]}]
            }
        }
    }));
    assert!(handler
        .local_task_link(task_id)
        .unwrap()
        .interaction_status
        .is_none());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn globally_routed_async_question_persists_waiting_until_next_send() {
    let index_path = temp_runtime_work_index_path("global-async-question");
    let (event_tx, mut event_rx) = broadcast::channel(16);
    let mut handler = RuntimeWorkRpcHandler::with_event_sender("device-1", "/bin/false", event_tx);
    handler.store = RuntimeWorkStore::new(index_path.clone());
    let task_id = "async-question-task";
    let mut link = RuntimeTaskLink::new_pending(
        task_id.to_owned(),
        "/tmp/project".to_owned(),
        "Async question".to_owned(),
    );
    link.thread_id = Some("thread-async".to_owned());
    handler.upsert_local_task(link);
    let request = ExecutionRequest {
        task_id: task_id.to_owned(),
        subtask_id: "turn-async".to_owned(),
        ..ExecutionRequest::default()
    };
    handler.register_thread_event_route("thread-async", task_id.to_owned(), request.clone(), false);
    handler.route_codex_notification(json!({
        "method": "item/completed",
        "params": {
            "threadId": "thread-async", "turnId": "turn-async",
            "item": {
                "id": "question-async", "type": "agentMessage",
                "questions": [{"title": "Continue?", "options": ["Yes", "No"]}]
            }
        }
    }));
    let events = std::iter::from_fn(|| event_rx.try_recv().ok()).collect::<Vec<_>>();
    assert!(
        events.iter().any(|event| {
            event.pointer("/payload/data/block/render_payload/delivery") == Some(&json!("async"))
        }),
        "the global router must emit the real question card"
    );
    assert_eq!(
        handler
            .local_task_link(task_id)
            .unwrap()
            .interaction_status
            .as_deref(),
        Some(INTERACTION_AWAITING_USER_REPLY),
        "the task list must agree with the emitted question card"
    );
    handler.route_codex_notification(json!({
        "method": "turn/completed",
        "params": {
            "threadId": "thread-async",
            "turn": {"id": "turn-async", "status": "completed", "items": []}
        }
    }));
    handler.store = RuntimeWorkStore::new(index_path.clone());
    assert_eq!(
        handler
            .local_task_link(task_id)
            .unwrap()
            .interaction_status
            .as_deref(),
        Some(INTERACTION_AWAITING_USER_REPLY)
    );
    handler.mark_task_running_for_send(
        task_id,
        "thread-async",
        "/tmp/project",
        &request,
        &json!({"message": "Yes"}),
    );
    assert!(handler
        .local_task_link(task_id)
        .unwrap()
        .interaction_status
        .is_none());
    let _ = fs::remove_file(index_path);
}
