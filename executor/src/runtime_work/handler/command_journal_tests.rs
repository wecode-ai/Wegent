use super::*;

#[test]
fn waiting_outcome_is_durable_and_cannot_be_requeued_as_a_successful_command() {
    let state = CommandState::from_execution(&ExecutionOutcome::WaitingForUserInput {
        stop_reason: "tool_deferred".into(),
    });
    assert_eq!(state, CommandState::AwaitingUser);
    let input = turn("task", json!("question"), "Original question input");
    let mut command = RuntimeCommand::from_turn(&input, CommandState::Dispatching)
        .unwrap()
        .unwrap();
    assert!(command.finish(None, state));
    let restored: RuntimeCommand =
        serde_json::from_value(serde_json::to_value(&command).unwrap()).unwrap();
    assert_eq!(restored.receipt()["state"], "awaiting_user");
    assert_eq!(restored.receipt()["requiresUserReview"], true);
    assert_eq!(restored.turn.request.prompt, json!(""));
    let mut journal = CommandJournal::from([(restored.key(), restored)]);
    assert_eq!(
        project_queue(&mut journal, &VecDeque::from([input]), &[])
            .unwrap_err()
            .code,
        "command_not_dispatchable"
    );
}

fn turn(task: &str, id: Value, prompt: &str) -> SpawnTurnRequest {
    let payload =
        json!({"taskId":task,"commandId":id,"message":prompt,"workspacePath":"/tmp/command-test"});
    let mut request = ExecutionRequest {
        prompt: json!(prompt),
        subtask_id: format!("{task}-input"),
        ..Default::default()
    };
    request.extra.insert("user_id".to_owned(), json!(7));
    apply_runtime_payload_metadata(&mut request, &payload);
    SpawnTurnRequest {
        task_kind: None,
        local_task_id: task.to_owned(),
        runtime: "codex".to_owned(),
        request,
        send_payload: Some(payload),
        direct_thread_id: None,
        fork_thread_id: None,
        fork_thread_path: None,
        resume_thread_id: None,
        initial_thread_goal: None,
    }
}

#[test]
fn invalid_command_ids_are_rejected_instead_of_disabling_deduplication() {
    for id in [
        Value::Null,
        json!(7),
        json!(""),
        json!(" padded "),
        json!("a".repeat(257)),
    ] {
        assert!(
            RuntimeCommand::from_turn(&turn("task", id, "prompt"), CommandState::Queued).is_err()
        );
    }
}

#[test]
fn replay_keeps_identity_across_goal_recovery_and_credential_rotation() {
    let original = turn("task", json!("command"), "original input");
    let first = RuntimeCommand::from_turn(&original, CommandState::Dispatching)
        .unwrap()
        .unwrap();
    let mut recovered = original.clone();
    recovered.request.prompt = json!("");
    recovered.request.auth_token = Some("rotated-secret".to_owned());
    recovered
        .request
        .extra
        .insert(RESUME_GOAL_ONLY_MARKER.to_owned(), json!(true));
    let resumed = RuntimeCommand::from_turn(&recovered, CommandState::Dispatching)
        .unwrap()
        .unwrap();
    first.validate_replay(&resumed).unwrap();
}

#[test]
fn same_id_cannot_change_input_or_account() {
    let original = turn("task", json!("command"), "original");
    let first = RuntimeCommand::from_turn(&original, CommandState::Queued)
        .unwrap()
        .unwrap();
    let changed = RuntimeCommand::from_turn(
        &turn("task", json!("command"), "changed"),
        CommandState::Queued,
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        first.validate_replay(&changed).unwrap_err().code,
        "command_conflict"
    );
    let mut other = original.clone();
    other
        .request
        .extra
        .get_mut("runtime_command_input")
        .unwrap()["userId"] = json!(8);
    assert!(first
        .validate_replay(
            &RuntimeCommand::from_turn(&other, CommandState::Queued)
                .unwrap()
                .unwrap()
        )
        .is_err());
}

#[test]
fn dequeue_keeps_the_complete_request_in_the_dispatch_journal() {
    let input = turn("task", json!("command"), "keep this input");
    let mut journal = CommandJournal::default();
    project_queue(&mut journal, &VecDeque::from([input.clone()]), &[]).unwrap();
    project_queue(&mut journal, &VecDeque::new(), &[input]).unwrap();
    let command = journal.values().next().unwrap();
    assert_eq!(command.state, CommandState::Dispatching);
    assert_eq!(command.turn.request.prompt, json!("keep this input"));
}

#[test]
fn cancellation_is_retained_after_queue_removal() {
    let input = turn("task", json!("command"), "cancel me");
    let mut journal = CommandJournal::default();
    project_queue(&mut journal, &VecDeque::from([input]), &[]).unwrap();
    project_queue(&mut journal, &VecDeque::new(), &[]).unwrap();
    assert_eq!(
        journal.values().next().unwrap().state,
        CommandState::Cancelled
    );
}

#[test]
fn starting_a_followup_does_not_settle_it_as_the_previous_command() {
    let first = turn("task", json!("one"), "first");
    let second = turn("task", json!("two"), "second");
    let mut journal = CommandJournal::default();
    project_queue(&mut journal, &VecDeque::from([second.clone()]), &[first]).unwrap();
    project_queue(&mut journal, &VecDeque::new(), &[second]).unwrap();
    assert_eq!(
        journal[&key("task", "one")].state,
        CommandState::Dispatching
    );
    assert_eq!(
        journal[&key("task", "two")].state,
        CommandState::Dispatching
    );
}
#[test]
fn late_generation_cannot_finish_a_new_execution() {
    let input = turn("task", json!("command"), "input");
    let mut command = RuntimeCommand::from_turn(&input, CommandState::Started)
        .unwrap()
        .unwrap();
    command.native = Some((42, "thread".into(), "turn".into()));
    assert!(!command.finish(Some(41), CommandState::Settled));
    assert_eq!(command.state, CommandState::Started);
    assert_eq!(command.turn.request.prompt, json!("input"));
    assert!(command.finish(Some(42), CommandState::Settled));
    assert_eq!(command.state, CommandState::Settled);
}

#[test]
fn terminal_commands_drop_launch_secrets_but_keep_owner_and_fingerprint() {
    let mut input = turn("task", json!("command"), "private input");
    input.request.auth_token = Some("secret".into());
    input.request.model_config = json!({"api_key":"secret"});
    let mut command = RuntimeCommand::from_turn(&input, CommandState::Dispatching)
        .unwrap()
        .unwrap();
    let fingerprint = command.fingerprint.clone();
    assert!(command.finish(None, CommandState::Failed));
    assert_eq!(command.fingerprint, fingerprint);
    assert_eq!(command.turn.request.extra["user_id"], json!(7));
    assert!(command.turn.request.auth_token.is_none());
    assert!(command.turn.send_payload.is_none());
    assert!(!serde_json::to_string(&command).unwrap().contains("secret"));
}

#[test]
fn cancelled_commands_cannot_be_resurrected_by_stale_queue_or_goal_records() {
    let input = turn("task", json!("command"), "input");
    let mut journal = CommandJournal::new();
    project_queue(&mut journal, &VecDeque::from([input.clone()]), &[]).unwrap();
    project_queue(&mut journal, &VecDeque::new(), &[]).unwrap();
    let error = project_queue(&mut journal, &VecDeque::new(), &[input]).unwrap_err();
    assert_eq!(error.code, "command_not_dispatchable");
    assert_eq!(
        journal[&key("task", "command")].state,
        CommandState::Cancelled
    );
}
