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
        recover_usage_limits: false,
        runtime_notifications: None,
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

async fn process_fixture() -> (
    CodexAppServerClient,
    CodexNotificationHub,
    oneshot::Receiver<Result<Value, String>>,
) {
    // Complete shared endpoint initialization before single-poll assertions.
    ensure_codex_mcp_endpoints().await.unwrap();
    let client = shared_client();
    #[cfg(not(windows))]
    let mut child = super::super::tests::spawn_idle_app_server_child();
    #[cfg(windows)]
    let mut child: CodexAppServerChild = {
        // The pause fixture consumes stdin; these tests need a nonreading child.
        let mut command = Command::new("powershell.exe");
        command.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Start-Sleep -Seconds 60",
        ]);
        configure_codex_app_server_process_group(&mut command);
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap()
            .into()
    };
    let mut stdin = child.stdin.take().unwrap();
    // Make the pipe writable before manually polling an interrupt into its response wait.
    stdin.write_all(b"\n").await.unwrap();
    let (release_tx, release_rx) = oneshot::channel();
    let pending = Arc::new(Mutex::new(HashMap::from([(
        999,
        PendingCodexResponse {
            sender: release_tx,
            native_request: None,
        },
    )])));
    let notifications = CodexNotificationHub::new();
    client.state.lock().await.process = Some(CodexAppServerProcess {
        child,
        stdin: Arc::new(Mutex::new(stdin)),
        pending,
        notifications: notifications.clone(),
        reader_task: tokio::spawn(async {}),
    });
    (client, notifications, release_rx)
}

async fn assert_process_retained_and_stop(
    client: &CodexAppServerClient,
    release: &mut oneshot::Receiver<Result<Value, String>>,
) {
    let mut state = client.state.lock().await;
    let retained = state.process.is_some();
    let release_result = release.try_recv();
    stop_codex_app_server_process(&mut state, None).await;
    assert!(
        retained,
        "Ready data must prevent restart: {release_result:?}"
    );
    assert!(matches!(
        release_result,
        Err(oneshot::error::TryRecvError::Empty)
    ));
}

async fn preparing_client() -> (CodexAppServerClient, SharedTurnPreparation, u32) {
    let (client, _, _release) = process_fixture().await;
    let mut state = client.state.lock().await;
    state.active_threads.clear();
    let process = state.process.as_ref().unwrap();
    process.pending.lock().await.clear();
    let process_id = process.child.id().unwrap();
    let preparation = state.preparing_turns.begin();
    drop(state);
    (client, preparation, process_id)
}

#[tokio::test]
async fn preparing_turn_blocks_idle_restart_before_native_thread_admission() {
    let (client, preparation, process_id) = preparing_client().await;
    assert_eq!(client.restart_if_idle().await, Err((1, 0)));
    assert_eq!(
        client
            .state
            .lock()
            .await
            .process
            .as_ref()
            .unwrap()
            .child
            .id(),
        Some(process_id)
    );
    drop(preparation);
    assert_eq!(client.restart_if_idle().await, Ok(()));
    assert!(client.state.lock().await.process.is_none());
}

#[tokio::test]
async fn preparing_turn_blocks_idle_configuration_mutation() {
    let (client, preparation, process_id) = preparing_client().await;
    let called = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let observed = Arc::clone(&called);
    let result = client
        .mutate_configuration_if_idle(|| async move {
            observed.store(true, Ordering::SeqCst);
            Ok(((), true))
        })
        .await;
    assert_eq!(
        result,
        Err(CodexIdleMutationError::Busy {
            active_turn_count: 1,
            pending_request_count: 0,
        })
    );
    assert!(!called.load(Ordering::SeqCst));
    assert_eq!(
        client
            .state
            .lock()
            .await
            .process
            .as_ref()
            .unwrap()
            .child
            .id(),
        Some(process_id)
    );
    drop(preparation);
    assert_eq!(
        client
            .mutate_configuration_if_idle(|| async { Ok(((), true)) })
            .await,
        Ok(())
    );
    assert!(client.state.lock().await.process.is_none());
}

#[tokio::test]
async fn queued_completion_while_recovery_waits_for_admission_keeps_process() {
    let (client, notifications, mut release) = process_fixture().await;
    let mut rx = notifications.subscribe_thread("thread-slow");
    let mut turn = CodexRunState::default();
    turn.set_root_thread_id("thread-slow");
    let mut admission = client.state.lock().await;
    let run = read_shared_turn_notifications(
        &client,
        &mut rx,
        "thread-slow",
        &mut turn,
        1,
        Instant::now() - Duration::from_secs(1),
        options(None),
    );
    tokio::pin!(run);
    assert!(futures_util::poll!(run.as_mut()).is_pending());
    admission.active_threads.remove("thread-other");
    notifications
        .send(json!({"method":"item/completed","params":{
            "threadId":"thread-slow","turnId":"turn-slow",
            "item":{"id":"answer","type":"agentMessage","text":"late answer"}
        }}))
        .await;
    notifications
        .send(json!({"method":"turn/completed","params":{
            "threadId":"thread-slow","turn":{"id":"turn-slow","status":"completed"}
        }}))
        .await;
    drop(admission);
    let result = timeout(Duration::from_secs(5), run).await.unwrap();
    assert_process_retained_and_stop(&client, &mut release).await;
    assert_eq!(
        result.unwrap(),
        ExecutionOutcome::Completed {
            content: "late answer".into()
        }
    );
}

#[tokio::test]
async fn ready_response_while_recovery_waits_for_admission_keeps_process() {
    let (client, _, mut release) = process_fixture().await;
    let (response_tx, response_rx) = oneshot::channel();
    let request = async { response_rx.await.map_err(|error| error.to_string()) };
    let mut cancellation = None;
    let mut admission = client.state.lock().await;
    let mut deadline = Instant::now() - Duration::from_secs(1);
    let run = wait_for_shared_startup(
        &client,
        "thread-slow",
        &mut deadline,
        1,
        &mut cancellation,
        request,
    );
    tokio::pin!(run);
    assert!(futures_util::poll!(run.as_mut()).is_pending());
    admission.active_threads.remove("thread-other");
    response_tx.send("original response").unwrap();
    drop(admission);
    let result = timeout(Duration::from_secs(5), run).await.unwrap();
    assert_process_retained_and_stop(&client, &mut release).await;
    assert_eq!(result.unwrap(), "original response");
}

#[tokio::test]
async fn recovery_still_restarts_without_ready_data_after_peer_finishes() {
    let (client, _, mut release) = process_fixture().await;
    let (_response_tx, response_rx) = oneshot::channel::<()>();
    let request = async { response_rx.await.map_err(|error| error.to_string()) };
    let mut cancellation = None;
    let mut admission = client.state.lock().await;
    let mut deadline = Instant::now() - Duration::from_secs(1);
    let run = wait_for_shared_startup(
        &client,
        "thread-slow",
        &mut deadline,
        1,
        &mut cancellation,
        request,
    );
    tokio::pin!(run);
    assert!(futures_util::poll!(run.as_mut()).is_pending());
    admission.active_threads.remove("thread-other");
    drop(admission);
    assert!(timeout(Duration::from_secs(5), run)
        .await
        .unwrap()
        .unwrap_err()
        .contains("restarted"));
    assert!(client.state.lock().await.process.is_none());
    assert!(release
        .try_recv()
        .unwrap()
        .unwrap_err()
        .contains("restarted"));
}

#[tokio::test]
async fn cancellation_while_recovery_waits_for_admission_wins_over_ready_response() {
    for close_sender in [false, true] {
        let client = shared_client();
        let (response_tx, response_rx) = oneshot::channel();
        let request = async { response_rx.await.map_err(|error| error.to_string()) };
        let (cancel_tx, cancel_rx) = oneshot::channel();
        let mut cancellation = Some(cancel_rx);
        let mut admission = client.state.lock().await;
        let mut deadline = Instant::now() - Duration::from_secs(1);
        let run = wait_for_shared_startup(
            &client,
            "thread-slow",
            &mut deadline,
            1,
            &mut cancellation,
            request,
        );
        tokio::pin!(run);
        assert!(futures_util::poll!(run.as_mut()).is_pending());
        admission.active_threads.remove("thread-other");
        response_tx.send("original response").unwrap();
        if close_sender {
            drop(cancel_tx)
        } else {
            cancel_tx.send(()).unwrap()
        }
        drop(admission);
        assert_eq!(
            timeout(Duration::from_secs(5), run)
                .await
                .unwrap()
                .unwrap_err(),
            CODEX_APP_SERVER_TURN_CANCELLED
        );
    }
}

#[tokio::test]
async fn cancellation_while_recovery_waits_for_admission_interrupts_without_restart() {
    let (client, notifications, mut release) = process_fixture().await;
    let mut rx = notifications.subscribe_thread("thread-slow");
    let mut turn = CodexRunState::default();
    turn.set_root_thread_id("thread-slow");
    let (cancel_tx, cancel_rx) = oneshot::channel();
    let mut admission = client.state.lock().await;
    let run = read_shared_turn_notifications(
        &client,
        &mut rx,
        "thread-slow",
        &mut turn,
        1,
        Instant::now() - Duration::from_secs(1),
        options(Some(cancel_rx)),
    );
    tokio::pin!(run);
    assert!(futures_util::poll!(run.as_mut()).is_pending());
    admission.active_threads.remove("thread-other");
    cancel_tx.send(()).unwrap();
    drop(admission);
    assert!(futures_util::poll!(run.as_mut()).is_pending());
    let pending = {
        let state = client.state.lock().await;
        Arc::clone(
            &state
                .process
                .as_ref()
                .expect("cancel must not restart the process")
                .pending,
        )
    };
    let interrupt_tx = {
        let mut pending = pending.lock().await;
        assert_eq!(pending.len(), 2, "the native interrupt must be pending");
        let id = *pending.keys().find(|id| **id != 999).unwrap();
        pending.remove(&id).unwrap()
    };
    interrupt_tx.sender.send(Ok(json!({}))).unwrap();
    assert!(futures_util::poll!(run.as_mut()).is_pending());
    assert!(
        matches!(release.try_recv(), Err(oneshot::error::TryRecvError::Empty)),
        "interrupt acknowledgement must not restart a process awaiting its terminal event"
    );
    assert!(client.state.try_lock().unwrap().process.is_some());
    notifications
        .send(json!({"method":"turn/completed","params":{
            "threadId":"thread-slow","turn":{"id":"turn-slow","status":"interrupted"}
        }}))
        .await;
    let result = timeout(Duration::from_secs(5), run).await.unwrap();
    assert_process_retained_and_stop(&client, &mut release).await;
    assert_eq!(result.unwrap_err(), CODEX_APP_SERVER_TURN_CANCELLED);
}

#[tokio::test]
async fn shared_startup_timeout_keeps_original_request_pending() {
    let client = shared_client();
    let (response_tx, response_rx) = oneshot::channel();
    let request = async { response_rx.await.map_err(|error| error.to_string()) };
    let mut cancellation = None;
    let mut deadline = Instant::now();
    let run = wait_for_shared_startup(
        &client,
        "thread-slow",
        &mut deadline,
        1,
        &mut cancellation,
        request,
    );
    tokio::pin!(run);
    assert!(timeout(Duration::from_millis(20), &mut run).await.is_err());
    response_tx.send("original response").unwrap();
    assert_eq!(run.await.unwrap(), "original response");
    assert_eq!(client.state.lock().await.active_threads.len(), 2);
}

#[tokio::test(start_paused = true)]
async fn shared_startup_late_acceptance_retains_the_extended_deadline() {
    let client = shared_client();
    let original_deadline = Instant::now();
    let mut deadline = original_deadline;
    let (response_tx, response_rx) = oneshot::channel();
    let request = async { response_rx.await.map_err(|error| error.to_string()) };
    let mut cancellation = None;
    {
        let run = wait_for_shared_startup(
            &client,
            "thread-slow",
            &mut deadline,
            1,
            &mut cancellation,
            request,
        );
        tokio::pin!(run);
        assert!(futures_util::poll!(&mut run).is_pending());
        tokio::time::advance(Duration::from_millis(500)).await;
        response_tx.send("late acceptance").unwrap();
        assert_eq!(run.await.unwrap(), "late acceptance");
    }
    assert!(
        deadline > Instant::now(),
        "Model progress must retain the protected startup window"
    );
    assert_eq!(deadline, original_deadline + Duration::from_secs(1));
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
