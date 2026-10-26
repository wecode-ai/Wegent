// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

fn shared_client() -> CodexAppServerClient {
    let mut state = CodexAppServerSharedState::default();
    state.active_threads.insert("thread-slow".into(), 1);
    state.active_threads.insert("thread-other".into(), 1);
    CodexAppServerClient {
        binary: "unused".into(),
        home: None,
        state: Arc::new(Mutex::new(state)),
    }
}

fn options(cancellation: Option<oneshot::Receiver<()>>) -> SharedTurnNotificationOptions {
    SharedTurnNotificationOptions {
        overload_turn_recovering: None,
        overload_continuation_params: json!({"threadId": "thread-slow"}),
        active_turn_id: Some("turn-slow".into()),
        expected_client_user_message_id: None,
        notifications: None,
        cancellation,
        request_user_input_answers: None,
        active_turn_started: None,
        active_turn_finished: None,
        wait_for_goal_continuation: false,
        auto_approve_mcp_tool_calls: false,
        stand_in_single_approval: false,
    }
}

#[tokio::test]
async fn shared_startup_timeout_keeps_original_request_pending() {
    let client = shared_client();
    let (response_tx, response_rx) = oneshot::channel();
    let request = async { response_rx.await.map_err(|error| error.to_string()) };
    let run = wait_for_shared_startup(&client, "thread-slow", Instant::now(), 1, request);
    tokio::pin!(run);
    assert!(timeout(Duration::from_millis(20), &mut run).await.is_err());
    response_tx.send("original response").unwrap();
    assert_eq!(run.await.unwrap(), "original response");
    assert_eq!(client.state.lock().await.active_threads.len(), 2);
}

#[tokio::test]
async fn shared_startup_timeout_keeps_listening_for_late_completion() {
    let client = shared_client();
    let (tx, mut rx) = broadcast::channel(16);
    let mut state = CodexRunState::default();
    state.set_root_thread_id("thread-slow");
    let (forward_tx, mut forward_rx) = mpsc::unbounded_channel();
    let mut options = options(None);
    options.notifications = Some(forward_tx);
    let run = read_shared_turn_notifications(
        &client,
        &mut rx,
        "thread-slow",
        &mut state,
        1,
        Instant::now(),
        options,
    );
    tokio::pin!(run);
    assert!(timeout(Duration::from_millis(20), &mut run).await.is_err());
    tx.send(
        json!({
            "method": "item/completed",
            "params": {"threadId": "thread-slow", "turnId": "turn-slow",
                "item": {"id": "answer", "type": "agentMessage", "text": "late answer"}}
        })
        .into(),
    )
    .unwrap();
    tx.send(
        json!({
            "method": "turn/completed",
            "params": {"threadId": "thread-slow",
                "turn": {"id": "turn-slow", "status": "completed"}}
        })
        .into(),
    )
    .unwrap();
    assert_eq!(
        timeout(Duration::from_secs(1), &mut run)
            .await
            .unwrap()
            .unwrap(),
        ExecutionOutcome::Completed {
            content: "late answer".into()
        }
    );
    assert_eq!(forward_rx.recv().await.unwrap()["method"], "item/completed");
}

#[tokio::test]
async fn shared_startup_timeout_still_reports_actual_process_exit() {
    let client = shared_client();
    let (tx, mut rx) = broadcast::channel(16);
    let mut state = CodexRunState::default();
    let run = read_shared_turn_notifications(
        &client,
        &mut rx,
        "thread-slow",
        &mut state,
        1,
        Instant::now(),
        options(None),
    );
    tokio::pin!(run);
    assert!(timeout(Duration::from_millis(20), &mut run).await.is_err());
    tx.send(
        json!({"method": "codex/app-server/exited",
        "params": {"message": "actual process exit"}})
        .into(),
    )
    .unwrap();
    assert_eq!(run.await.unwrap_err(), "actual process exit");
}

#[tokio::test]
async fn shared_startup_timeout_keeps_cancellation_available() {
    let client = shared_client();
    let (tx, mut rx) = broadcast::channel(16);
    let (cancel_tx, cancel_rx) = oneshot::channel();
    let mut state = CodexRunState::default();
    state.set_root_thread_id("thread-slow");
    let run = read_shared_turn_notifications(
        &client,
        &mut rx,
        "thread-slow",
        &mut state,
        1,
        Instant::now(),
        options(Some(cancel_rx)),
    );
    tokio::pin!(run);
    assert!(timeout(Duration::from_millis(20), &mut run).await.is_err());
    cancel_tx.send(()).unwrap();
    assert!(timeout(Duration::from_millis(20), &mut run).await.is_err());
    tx.send(
        json!({"method": "turn/completed", "params": {
            "threadId": "thread-slow", "turn": {"id": "turn-slow", "status": "interrupted"}
        }})
        .into(),
    )
    .unwrap();
    assert_eq!(run.await.unwrap_err(), CODEX_APP_SERVER_TURN_CANCELLED);
}
