use super::*;
use crate::runtime_work::handler::command_journal::{CommandState, RuntimeCommand};

fn fixture() -> (tempfile::TempDir, RuntimeWorkRpcHandler, Value) {
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.store = RuntimeWorkStore::new(root.path().join("runtime.json"));
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    handler.turn_queue_path = Arc::new(root.path().join("turn-queue.json"));
    handler.worktrees = WorktreeManager::new(root.path().join("worktrees.json"));
    handler.command_journal = Arc::new(Mutex::new(Default::default()));
    handler.turn_scheduler = Arc::new(Mutex::new(RuntimeTurnScheduler::new(
        RuntimeSettings {
            max_concurrent_tasks: 0,
            max_concurrent_stand_in_tasks: 0,
            max_concurrent_agent_tasks: 0,
        },
        VecDeque::new(),
    )));
    let origin = json!({"type":"issue_dispatch","initiatedBy":"stand_in","userId":7,
        "deviceId":"mac","standInId":"review","projectStore":"local",
        "cloudProjectId":"project","loopItemId":"issue","humanAssignmentId":"assignment"});
    let payload = json!({"taskId":"failed-issue","commandId":"explicit-retry",
        "message":"Review this Issue","executionRequest":{"task_id":"failed-issue",
        "subtask_id":"retry-subtask","user_id":7,"origin":origin,
        "prompt":"Review this Issue"}});
    handler.upsert_local_task(RuntimeTaskLink {
        local_task_id: "failed-issue".into(),
        runtime: "codex".into(),
        title: "Original Issue".into(),
        workspace_path: root.path().display().to_string(),
        created_at: 123,
        runtime_handle: json!({"origin":origin,"executionRequest":payload["executionRequest"],
            "standInIssueWakeups":["assignment"],"userMessagePresentations":[{"clientUserMessageId":"original","content":"Original input","createdAt":120,"ensureVisible":true}]}),
        ..Default::default()
    });
    handler.retain_failed_runtime_task(
        "failed-issue",
        &AppIpcError::new("runtime_start_failed", "Native process could not start"),
    );
    (root, handler, payload)
}

#[tokio::test]
async fn asynchronous_startup_error_survives_restart_without_credentials() {
    let (root, mut handler, payload) = fixture();
    let request = execution_request(&payload).unwrap();
    handler.persist_failed_assistant_message(
        "failed-issue",
        &request,
        "Native startup failed: Authorization: Bearer private-startup-token",
    );
    handler.store = RuntimeWorkStore::new(root.path().join("runtime.json"));
    let restored = handler.local_task_link("failed-issue").unwrap();
    assert_eq!(restored.status, "failed");
    assert_eq!(
        restored.runtime_handle["startupFailure"]["message"],
        "Native startup failed: Authorization: Bearer [redacted]"
    );
    let queried = handler.get_task(&json!({"taskId":"failed-issue"})).unwrap();
    assert_eq!(
        queried["task"]["runtimeHandle"]["startupFailure"],
        restored.runtime_handle["startupFailure"]
    );
    assert!(queried["task"]["runtimeHandle"]["executionRequest"].is_null());
    assert!(!queried.to_string().contains("private-startup-token"));
    assert!(!std::fs::read_to_string(root.path().join("runtime.json"))
        .unwrap()
        .contains("private-startup-token"));
}

#[tokio::test]
async fn failed_issue_start_retries_in_place_after_restart_without_replaying_the_assignment() {
    let (root, mut handler, payload) = fixture();
    handler.store = RuntimeWorkStore::new(root.path().join("runtime.json"));
    let failed = handler.local_task_link("failed-issue").unwrap();
    assert_eq!(failed.status, "failed");
    assert_eq!(
        failed.runtime_handle["startupFailure"]["code"],
        "runtime_start_failed"
    );
    let failure = failed.runtime_handle["startupFailure"].clone();
    let config = json!({"id":"review"});
    let binding = json!({"humanAssignmentId":"assignment"});
    assert!(handler.stand_in_assignment_is_handled(&config, "failed-issue", &binding));
    assert!(!handler.stand_in_assignment_is_handled(
        &json!({"id":"review","manual":true}),
        "failed-issue",
        &binding
    ));

    let result = handler
        .dispatch_stand_in_conversation(payload.clone(), false)
        .await
        .unwrap();
    assert_eq!(result["accepted"], true);
    let retry = handler.local_task_link("failed-issue").unwrap();
    assert_eq!(retry.created_at, 123);
    assert_eq!(retry.title, "Original Issue");
    assert_eq!(retry.runtime_handle["startupFailure"], failure);
    assert_eq!(
        retry.runtime_handle["standInIssueWakeups"],
        json!(["assignment"])
    );
    assert_eq!(
        retry.runtime_handle["userMessagePresentations"][0]["clientUserMessageId"],
        "original"
    );
    let duplicate = handler
        .dispatch_stand_in_conversation(payload, false)
        .await
        .unwrap();
    assert_eq!(duplicate["state"], "queued");
    assert_eq!(handler.turn_scheduler.lock().unwrap().queued_turns.len(), 1);
    assert_eq!(handler.local_task_links(true).len(), 1);
    let restored = RuntimeWorkStore::new(root.path().join("runtime.json"))
        .get_task("failed-issue")
        .unwrap();
    assert_eq!(restored.runtime_handle["startupFailure"], failure);
    assert_ne!(
        restored.status, "failed",
        "A pending retry must not restore an earlier failure as its current state"
    );
}

#[tokio::test]
async fn failed_start_recovers_native_sessions_without_replaying_unconfirmed_commands() {
    for (state, native, activity) in [
        (CommandState::Dispatching, false, false),
        (CommandState::Started, false, false),
        (CommandState::RecoveryRequired, false, false),
        (CommandState::Failed, false, false),
        (CommandState::Failed, true, false),
        (CommandState::Failed, true, true),
    ] {
        let (_root, handler, payload) = fixture();
        let mut request = execution_request(&payload).unwrap();
        apply_runtime_payload_metadata(&mut request, &payload);
        request
            .extra
            .insert("runtime_command_id".into(), json!("original-command"));
        let turn = SpawnTurnRequest::new("failed-issue".into(), "codex".into(), request);
        let mut command = RuntimeCommand::from_turn(&turn, state.clone())
            .unwrap()
            .unwrap();
        if native {
            command.native = Some((1, "native-thread".into(), "native-turn".into()));
        }
        handler
            .command_journal
            .lock()
            .unwrap()
            .insert(command.key(), command);
        let result = handler
            .dispatch_stand_in_conversation(payload, activity)
            .await;
        if state == CommandState::Failed {
            assert_eq!(result.unwrap()["accepted"], true);
            assert_eq!(
                handler
                    .local_task_link("failed-issue")
                    .unwrap()
                    .thread_id
                    .as_deref(),
                native.then_some("native-thread")
            );
            let scheduler = handler.turn_scheduler.lock().unwrap();
            assert_eq!(scheduler.queued_turns.len(), 1);
            assert_eq!(
                scheduler.queued_turns[0].resume_thread_id.as_deref(),
                native.then_some("native-thread")
            );
            if native {
                let send = scheduler.queued_turns[0].send_payload.as_ref().unwrap();
                assert_eq!(
                    send[crate::runtime_work::handler::control::connection_events::OWNER_INPUT],
                    !activity,
                    "Session recovery must preserve whether the new input came from the owner",
                );
            }
            continue;
        }
        assert_eq!(result.unwrap_err().code, "command_recovery_required");
        assert!(handler
            .turn_scheduler
            .lock()
            .unwrap()
            .queued_turns
            .is_empty());
        assert_eq!(
            handler.local_task_link("failed-issue").unwrap().status,
            "failed"
        );
    }
}
