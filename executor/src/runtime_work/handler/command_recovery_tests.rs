//! Recovery requires real timeline boundaries; a normalized turn-list status is insufficient.
use super::*;
use crate::runtime_work::handler::command_journal::{CommandState, RuntimeCommand};

fn input() -> (Value, SpawnTurnRequest) {
    let payload = json!({"taskId":"task-1","commandId":"command","message":"input","executionRequest":{
        "task_id":"task-1","subtask_id":"input-1","user_id":7,"prompt":"input"
    }});
    let mut request = execution_request(&payload).unwrap();
    apply_runtime_payload_metadata(&mut request, &payload);
    let turn = SpawnTurnRequest {
        task_kind: None,
        local_task_id: "task-1".into(),
        runtime: "codex".into(),
        request,
        send_payload: Some(payload.clone()),
        direct_thread_id: None,
        fork_thread_id: None,
        fork_thread_path: None,
        resume_thread_id: None,
        initial_thread_goal: None,
    };
    (payload, turn)
}

#[tokio::test]
async fn synthetic_interruption_never_becomes_a_durable_cancel_receipt() {
    for completed in [false, true] {
        let (mut handler, root) = isolated_runtime_work_handler("command-native-boundary");
        handler.command_journal.lock().unwrap().clear();
        install_native_history(
            &mut handler,
            &root,
            vec![json!({"id":"current","status":"interrupted","items":[]})],
            None,
        );
        let mut entries = vec![json!({"type":"turnStarted","position":1,"turnId":"current"})];
        if completed {
            entries.push(json!({"type":"turnCompleted","position":2,"turnId":"current","status":"interrupted"}));
        }
        fs::write(
            root.join("thread_timeline_list.json"),
            json!({"data":entries,"nextCursor":null}).to_string(),
        )
        .unwrap();
        let (_, turn) = input();
        let mut command = RuntimeCommand::from_turn(&turn, CommandState::RecoveryRequired)
            .unwrap()
            .unwrap();
        command.native = Some((0, "thread-1".into(), "current".into()));
        handler
            .command_journal
            .lock()
            .unwrap()
            .insert(command.key(), command);
        let response = handler
            .command_receipt(json!({"taskId":"task-1","commandId":"command","userId":7}))
            .await
            .unwrap();
        assert_eq!(
            response["state"],
            if completed {
                "cancelled"
            } else {
                "recovery_required"
            }
        );
        assert_eq!(response["requiresUserReview"], !completed);
        stop_native_history(&handler).await;
        fs::remove_dir_all(root).unwrap();
    }
}

#[tokio::test]
async fn queued_history_keeps_command_unconfirmed_when_processing_admission_closes() {
    let (mut handler, root) = isolated_runtime_work_handler("command-history-busy");
    handler.command_journal.lock().unwrap().clear();
    install_native_history(
        &mut handler,
        &root,
        vec![json!({"id":"current","status":"completed","items":[]})],
        None,
    );
    let (payload, turn) = input();
    let mut command = RuntimeCommand::from_turn(&turn, CommandState::RecoveryRequired)
        .unwrap()
        .unwrap();
    command.native = Some((0, "thread-1".into(), "current".into()));
    let key = command.key();
    handler
        .command_journal
        .lock()
        .unwrap()
        .insert(key.clone(), command);
    let workers = handler.transcript_test_workers.as_ref().unwrap().clone();
    let permits = workers.clone().acquire_many_owned(2).await.unwrap();
    let receipt_handler = handler.clone();
    let mut receipt = Box::pin(
        receipt_handler
            .command_receipt(json!({"taskId":"task-1","commandId":"command","userId":7})),
    );
    let mut duplicate = Box::pin(handler.existing_payload_command(&payload));
    assert!(futures_util::poll!(receipt.as_mut()).is_pending());
    assert!(futures_util::poll!(duplicate.as_mut()).is_pending());
    assert_eq!(
        handler.command_journal.lock().unwrap()[&key].state,
        CommandState::RecoveryRequired
    );
    // Normal saturation queues verification. Closing this fixture's admission
    // exercises unavailable history without waiting on permits owned by the test.
    workers.close();
    // Drive both futures while they share the Codex client's lock queue.
    let (receipt, duplicate) = tokio::join!(receipt, duplicate);
    let error = receipt.unwrap_err();
    assert_eq!(error.code, "command_recovery_unavailable");
    let error = duplicate.unwrap_err();
    assert_eq!(error.code, "command_recovery_unavailable");
    assert_eq!(
        handler.command_journal.lock().unwrap()[&key].state,
        CommandState::RecoveryRequired
    );
    assert!(handler
        .turn_scheduler
        .lock()
        .unwrap()
        .queued_turns
        .is_empty());
    let requests = fs::read_to_string(root.join("requests.jsonl")).unwrap();
    assert!(requests.lines().all(|request| {
        serde_json::from_str::<Value>(request).unwrap()["method"] != "turn/start"
    }));
    drop(permits);
    stop_native_history(&handler).await;
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn ordinary_replay_uses_the_same_current_account_check_as_receipt_reads() {
    use axum::{routing::get, Json, Router};
    let server = Router::new().route("/api/users/me", get(|| async { Json(json!({"id":8})) }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, server).await.unwrap() });
    let (handler, root) = isolated_runtime_work_handler("command-owner-replay");
    let (payload, turn) = input();
    let command = RuntimeCommand::from_turn(&turn, CommandState::Settled)
        .unwrap()
        .unwrap();
    handler
        .command_journal
        .lock()
        .unwrap()
        .insert(command.key(), command);
    *handler.backend_connection.lock().unwrap() = Some(ConnectionConfig {
        backend_url: url,
        auth_token: "synthetic-test-token".into(),
        ..Default::default()
    });
    assert_eq!(
        handler
            .existing_payload_command(&payload)
            .await
            .unwrap_err()
            .code,
        "permission_denied"
    );
    assert_eq!(
        handler
            .command_receipt(json!({"taskId":"task-1","commandId":"command","userId":7}))
            .await
            .unwrap_err()
            .code,
        "permission_denied"
    );
    server.abort();
    if root.exists() {
        fs::remove_dir_all(root).unwrap();
    }
}
