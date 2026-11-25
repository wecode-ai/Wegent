// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[tokio::test]
async fn async_question_guidance_accepts_one_reply_before_native_history_catches_up() {
    let _activation = crate::services::capability_activation::begin_execution().await;
    let (mut handler, root, request) = setup("async-question-guidance-once");
    install_native_history(
        &mut handler,
        &root,
        vec![json!({
            "id":"turn-1", "status":"inProgress", "items":[{
                "id":"question-1", "type":"agentMessage",
                "questions":[{"title":"Continue?", "options":["Yes", "No"]}]
            }]
        })],
        None,
    );
    handler
        .codex_app_server
        .request("thread/read", json!({"threadId":"thread-1"}))
        .await
        .unwrap();
    handler.store.update_task("task-1", |link| {
        link.runtime_handle["executionRequest"] = json!(request);
    });
    let execution = start_test_execution(&handler, "task-1");
    handler.record_active_codex_turn("task-1", execution, "thread-1".into(), "turn-1".into());
    handler.route_codex_notification(notification("turn/started", "turn-1"));
    fs::write(
        root.join("turn_steer.json"),
        json!({"turnId":"turn-1"}).to_string(),
    )
    .unwrap();
    fs::write(
        root.join("turn_steer.error-once.json"),
        json!({"code":-32600,"message":"Guidance was rejected"}).to_string(),
    )
    .unwrap();
    let payload = json!({
        "taskId":"task-1", "message":"Yes", "requestUserInputResponse":{
            "delivery":"async", "itemId":"question-1", "interactionScope":"turn-1",
            "answers":{"q":{"answers":["Yes"]}}
        }
    });
    let rejected = handler.send_message(payload.clone()).await.unwrap();
    let (first, second) = tokio::join!(
        handler.send_message(payload.clone()),
        handler.send_message(payload.clone())
    );
    // The fixture deliberately keeps the question pending after turn/steer accepts it.
    handler.finish_local_task_execution("task-1", execution);
    let reloaded = RuntimeWorkStore::new(handler.store.index_path().to_owned());
    let remembered =
        reloaded.get_task("task-1").unwrap().runtime_handle["answeredAsyncQuestions"].clone();
    handler
        .codex_app_server
        .request("test/stop", json!({}))
        .await
        .unwrap();
    let requests = fs::read_to_string(root.join("requests.jsonl")).unwrap();
    fs::remove_dir_all(root).unwrap();
    assert_eq!(rejected["accepted"], false);
    assert_eq!(first.unwrap()["accepted"], true);
    assert_eq!(second.unwrap_err().code, "stale_request_user_input");
    assert_eq!(remembered.as_object().unwrap().len(), 1);
    assert_eq!(
        requests
            .lines()
            .filter(|line| {
                serde_json::from_str::<Value>(line).unwrap()["method"] == "turn/steer"
            })
            .count(),
        2,
        "only the rejected send and its accepted retry reach Codex"
    );
}

#[test]
fn late_native_start_after_local_settlement_cannot_reactivate_the_turn() {
    let (handler, root, request) = setup("native-guidance-late-start-after-stop");
    let execution = start_test_execution(&handler, "task-1");
    handler.bind_native_turn_start("task-1", &request, execution, "thread-1", "turn-1");
    assert!(handler.force_settle_local_task_execution(
        "task-1",
        Some("thread-1".into()),
        "cancelled",
        "test stop"
    ));
    let settled = handler.local_task_link("task-1").unwrap().execution_state;
    assert_eq!(settled.as_ref().unwrap().process_generation, None);
    handler.route_codex_notification(
        notification("turn/started", "turn-1").with_process_generation(7),
    );
    assert_eq!(
        handler.local_task_link("task-1").unwrap().execution_state,
        settled
    );
    assert!(!handler.local_task_link("task-1").unwrap().running);
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn guidance_uses_native_continuation_after_local_request_finishes() {
    // Unrelated capability tests must not restart this synthetic native session.
    let _activation = crate::services::capability_activation::begin_execution().await;
    let (mut handler, root, _) = setup("native-guidance-continuation");
    install_native_history(&mut handler, &root, vec![], None);
    handler
        .codex_app_server
        .request("thread/read", json!({"threadId":"thread-1"}))
        .await
        .unwrap();
    fs::write(
        root.join("turn_steer.json"),
        json!({"turnId":"turn-2"}).to_string(),
    )
    .unwrap();
    let execution = start_test_execution(&handler, "task-1");
    handler.record_active_codex_turn("task-1", execution, "thread-1".into(), "turn-1".into());
    handler.route_codex_notification(notification("turn/started", "turn-1"));
    handler.route_codex_notification(notification("turn/completed", "turn-1"));
    assert!(handler.finish_local_task_execution("task-1", execution));
    handler.route_codex_notification(notification("turn/started", "turn-2"));
    assert!(!handler.is_active_local_task("task-1"));
    assert!(handler.local_task_link("task-1").unwrap().running);
    assert_eq!(
        handler.wait_for_guidance_turn("task-1").await,
        Some(("thread-1".into(), "turn-2".into()))
    );
    let before = handler.local_task_link("task-1").unwrap().execution_state;

    let result = handler
        .send_guidance(json!({
            "taskId":"task-1", "message":"continue with this", "clientGuidanceId":"guide-2"
        }))
        .await
        .unwrap();

    assert_eq!(result["accepted"], true, "{result}");
    assert_eq!(result["turnId"], "turn-2");
    assert_eq!(result["guidanceId"], "guide-2");
    assert!(!handler.is_active_local_task("task-1"));
    assert_eq!(
        handler.local_task_link("task-1").unwrap().execution_state,
        before
    );
    handler
        .codex_app_server
        .request("test/stop", json!({}))
        .await
        .unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn guidance_uses_accepted_start_before_native_notification_and_keeps_native_settlement() {
    let (handler, root, request) = setup("native-guidance-start-response");
    let execution = start_test_execution(&handler, "task-1");
    handler.bind_native_turn_start("task-1", &request, execution, "thread-1", "turn-1");
    assert_eq!(
        handler.wait_for_guidance_turn("task-1").await,
        Some(("thread-1".into(), "turn-1".into()))
    );
    handler.route_codex_notification(
        notification("turn/started", "turn-1").with_process_generation(7),
    );
    assert_eq!(
        handler
            .local_task_link("task-1")
            .unwrap()
            .execution_state
            .unwrap()
            .process_generation,
        Some(7)
    );
    handler
        .store
        .update_task("task-1", |link| link.goal_status = None);
    handler.route_codex_notification(
        notification("turn/completed", "turn-1").with_process_generation(7),
    );
    let settled = handler.local_task_link("task-1").unwrap().execution_state;
    handler.bind_native_turn_start("task-1", &request, execution, "thread-1", "turn-1");
    assert_eq!(
        handler.local_task_link("task-1").unwrap().execution_state,
        settled
    );
    assert_eq!(handler.wait_for_guidance_turn("task-1").await, None);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn obsolete_start_receipt_cannot_bind_a_replacement_request() {
    let (handler, root, request) = setup("native-guidance-stale-start-response");
    let obsolete = start_test_execution(&handler, "task-1");
    let current = start_test_execution(&handler, "task-1");
    let before = handler.local_task_link("task-1").unwrap().execution_state;
    handler.bind_native_turn_start("task-1", &request, obsolete, "thread-1", "old-turn");
    assert_eq!(
        handler.local_task_link("task-1").unwrap().execution_state,
        before
    );
    handler.bind_native_turn_start("task-1", &request, current, "thread-1", "new-turn");
    assert_eq!(
        handler
            .local_task_link("task-1")
            .unwrap()
            .execution_state
            .unwrap()
            .turn_id
            .as_deref(),
        Some("new-turn")
    );
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn guidance_rejects_a_completed_native_turn_with_stale_local_control() {
    let (handler, root, _) = setup("native-guidance-terminal");
    let execution = start_test_execution(&handler, "task-1");
    handler.record_active_codex_turn("task-1", execution, "thread-1".into(), "turn-1".into());
    handler.route_codex_notification(notification("turn/started", "turn-1"));
    handler
        .store
        .update_task("task-1", |link| link.goal_status = None);
    handler.route_codex_notification(notification("turn/completed", "turn-1"));
    assert!(handler.active_codex_turn("task-1").is_some());

    let result = handler
        .send_guidance(json!({"taskId":"task-1", "message":"too late"}))
        .await
        .unwrap();

    assert_eq!(result["accepted"], false);
    assert_eq!(result["code"], "no_active_turn");
    assert!(!handler.local_task_link("task-1").unwrap().running);
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn guidance_waits_for_native_goal_continuation_without_local_control() {
    let (handler, root, _) = setup("native-guidance-between-turns");
    handler.route_codex_notification(notification("turn/started", "turn-1"));
    handler.route_codex_notification(notification("turn/completed", "turn-1"));
    let waiter = handler.clone();
    let wait = tokio::spawn(async move { waiter.wait_for_guidance_turn("task-1").await });
    tokio::task::yield_now().await;
    assert!(!wait.is_finished());
    handler.route_codex_notification(notification("turn/started", "turn-2"));
    assert_eq!(
        wait.await.unwrap(),
        Some(("thread-1".into(), "turn-2".into()))
    );
    fs::remove_dir_all(root).unwrap();
}
