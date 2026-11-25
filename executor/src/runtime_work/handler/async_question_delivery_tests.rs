use super::*;

#[cfg(unix)]
#[test]
fn queued_async_answer_drains_after_native_worker_cleanup() {
    let _lock = crate::test_env::lock();
    let home = tempfile::tempdir().unwrap();
    let _environment: Vec<_> = [
        "HOME",
        "CODEX_HOME",
        "WEGENT_CODEX_HOME",
        "WEGENT_EXECUTOR_HOME",
        "WEGENT_WORKBENCH_HOME",
        "WEGENT_CAPABILITIES_HOME",
        "CODEX_SQLITE_HOME",
    ]
    .into_iter()
    .map(|key| {
        let directory = home.path().join(key);
        fs::create_dir_all(&directory).unwrap();
        ScalarEnv::set(key, directory.to_str().unwrap())
    })
    .collect();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(assert_native_worker_drains_async_answer());
}

#[cfg(unix)]
async fn assert_native_worker_drains_async_answer() {
    use std::io::Write;

    let (handler, root, mut events) = native_async_question_handler();
    let payload = |subtask: &str, message: &str| {
        json!({"taskId":"task", "message":message, "executionRequest": {
            "task_id":"task", "subtask_id":subtask, "prompt":message,
            "project_workspace_path":root, "bot":[{"shell_type":"Codex"}],
            "model_config":{"model_id":"gpt-test", "base_url":"http://127.0.0.1:9/v1",
                "api_key":"synthetic-key", "protocol":"openai-responses"}
        }})
    };
    let started = handler
        .send_message(payload("question", "Ask a question"))
        .await
        .unwrap();
    assert_eq!(started["accepted"], true);
    let mut gate = open_native_response_gate(root.join("turn_start.json")).await;
    let first = wait_for_native_answer_turn(&handler, &mut events, "question-native").await;
    assert!(first.process_generation.is_some());
    assert!(handler.is_active_local_task("task"));
    assert!(!handler.native_task_holds_capacity("task"));
    assert_eq!(handler.local_task_link("task").unwrap().goal_status, None);
    assert_eq!(
        handler
            .local_task_link("task")
            .unwrap()
            .interaction_status
            .as_deref(),
        Some(INTERACTION_AWAITING_USER_REPLY),
        "The native question must remain pending before its queued answer"
    );
    let queued = handler
        .send_message(payload("answer", "Complete"))
        .await
        .unwrap();
    assert_eq!(queued["accepted"], true);
    assert_eq!(queued["status"], "queued");
    assert_eq!(handler.queued_local_task_position("task"), Some(0));
    assert!(handler.is_active_local_task("task"));
    assert!(handler
        .turn_scheduler
        .lock()
        .unwrap()
        .active_task_ids
        .contains_key("task"));

    // The first native reader owns this FIFO. Replace only its path for the
    // next turn, then let the original RPC return and production cleanup run.
    write_native_answer_turn(&root, "answer-native", false);
    gate.write_all(br#"{"turn":{"id":"question-native"}}"#)
        .unwrap();
    drop(gate);
    let second = wait_for_native_answer_turn(&handler, &mut events, "answer-native").await;
    assert_eq!(second.process_generation, first.process_generation);
    tokio::time::timeout(Duration::from_secs(5), async {
        while handler.is_active_local_task("task")
            || handler
                .turn_scheduler
                .lock()
                .unwrap()
                .active_task_ids
                .contains_key("task")
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("Native cleanup must release the local execution and reservation");
    assert_eq!(handler.queued_local_task_position("task"), None);
    assert!(handler
        .local_task_link("task")
        .unwrap()
        .interaction_status
        .is_none());
    let calls: Vec<Value> = fs::read_to_string(root.join("requests.jsonl"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let starts: Vec<_> = calls
        .iter()
        .filter(|call| call["method"] == "turn/start")
        .collect();
    assert_eq!(
        starts.len(),
        2,
        "Each question and answer must run exactly once"
    );
    assert!(starts[1]["params"]["input"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["text"] == "Complete"));
    handler
        .codex_app_server
        .request("test/stop", json!({}))
        .await
        .unwrap();
    let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
fn native_async_question_handler() -> (RuntimeWorkRpcHandler, PathBuf, broadcast::Receiver<Value>) {
    let (mut handler, root) = isolated_runtime_work_handler("native-async-answer-cleanup");
    install_native_history(&mut handler, &root, vec![], None);
    for (method, response) in [
        ("thread_resume", json!({"thread":{"id":"thread-1"}})),
        ("thread_unsubscribe", json!({"status":"notLoaded"})),
        ("thread_goal_get", json!({"goal":null})),
    ] {
        fs::write(root.join(format!("{method}.json")), response.to_string()).unwrap();
    }
    write_native_answer_turn(&root, "question-native", true);
    fs::remove_file(root.join("turn_start.json")).unwrap();
    assert!(std::process::Command::new("mkfifo")
        .arg(root.join("turn_start.json"))
        .status()
        .unwrap()
        .success());
    let (sender, receiver) = broadcast::channel(256);
    handler.event_tx = Some(sender);
    let mut link = RuntimeTaskLink::new_pending(
        "task".into(),
        root.to_string_lossy().into_owned(),
        "Async question".into(),
    );
    link.thread_id = Some("thread-1".into());
    handler.upsert_local_task(link);
    (handler, root, receiver)
}

#[cfg(unix)]
fn write_native_answer_turn(root: &Path, turn: &str, question: bool) {
    let mut notifications = vec![json!({"method":"turn/started", "params": {
        "threadId":"thread-1", "turn":{"id":turn, "status":"inProgress"}
    }})];
    if question {
        notifications.push(json!({"method":"item/completed", "params": {
            "threadId":"thread-1", "turnId":turn, "item": {
                "id":"question", "type":"agentMessage", "questions":[{
                    "title":"Which async implementation direction should be used?",
                    "options":["Complete", "Investigate"]
                }]
            }
        }}));
    }
    notifications.push(json!({"method":"turn/completed", "params": {
        "threadId":"thread-1", "turn":{"id":turn, "status":"completed"}
    }}));
    fs::write(
        root.join("turn_start.notifications.jsonl"),
        notifications
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n")
            + "\n",
    )
    .unwrap();
    let response = root.join("turn-start-response.json");
    fs::write(&response, json!({"turn":{"id":turn}}).to_string()).unwrap();
    fs::rename(response, root.join("turn_start.json")).unwrap();
}

#[cfg(unix)]
async fn open_native_response_gate(path: PathBuf) -> fs::File {
    use std::os::unix::fs::OpenOptionsExt;

    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match fs::OpenOptions::new()
                .write(true)
                .custom_flags(libc::O_NONBLOCK)
                .open(&path)
            {
                Ok(writer) => return writer,
                Err(error) if error.raw_os_error() == Some(libc::ENXIO) => {
                    tokio::task::yield_now().await;
                }
                Err(error) => panic!("Cannot open native response gate: {error}"),
            }
        }
    })
    .await
    .expect("Native fixture must reach the first turn response gate")
}

#[cfg(unix)]
async fn wait_for_native_answer_turn(
    handler: &RuntimeWorkRpcHandler,
    events: &mut broadcast::Receiver<Value>,
    turn: &str,
) -> crate::runtime_work::lifecycle::NativeExecutionState {
    use crate::runtime_work::lifecycle::{native_execution_state, NativeExecutionPhase};

    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(state) = handler
                .local_task_link("task")
                .and_then(|link| native_execution_state(&link))
                .filter(|state| {
                    state.phase == NativeExecutionPhase::Idle
                        && state.latest_turn_id.as_deref() == Some(turn)
                        && state.execution_outcome.as_deref() == Some("succeeded")
                })
            {
                return state;
            }
            events
                .recv()
                .await
                .expect("Native lifecycle event stream must stay open");
        }
    })
    .await
    .expect("The real native notification must settle the expected turn")
}

#[tokio::test]
async fn settled_async_answer_is_admitted_after_local_cleanup() {
    for (cleanup_before_answer, queue_if_busy) in
        [(false, false), (true, false), (false, true), (true, true)]
    {
        let (handler, root, execution) = completed_async_question();
        if cleanup_before_answer {
            assert!(handler.finish_local_task("task", execution, None, "done"));
            assert!(!handler.is_active_local_task("task"));
            handler
                .finish_command_execution("task", execution, None, None)
                .await;
        }

        let answer = handler
            .send_message(json!({
                "taskId": "task", "message": "Complete", "queueIfBusy": queue_if_busy,
                "executionRequest": {
                    "task_id": "task", "subtask_id": "answer", "prompt": "Complete"
                }
            }))
            .await
            .unwrap();
        assert_eq!(answer["accepted"], true);
        if !cleanup_before_answer {
            assert_eq!(answer["status"], "queued");
            assert_eq!(handler.queued_local_task_position("task"), Some(0));
            assert!(handler.finish_local_task("task", execution, None, "done"));
            assert!(!handler.is_active_local_task("task"));
            handler
                .finish_command_execution("task", execution, None, None)
                .await;
        }

        assert_eq!(handler.queued_local_task_position("task"), None);
        assert!(handler.is_active_local_task("task"));
        assert!(!handler.is_current_local_task_execution("task", execution));
        assert!(handler
            .local_task_link("task")
            .unwrap()
            .interaction_status
            .is_none());
        let _ = fs::remove_dir_all(root);
    }
}

#[tokio::test]
async fn completed_async_question_releases_capacity_after_local_cleanup() {
    let (handler, root, execution) = completed_async_question();
    {
        let mut scheduler = handler.turn_scheduler.lock().unwrap();
        scheduler.settings = RuntimeSettings::uniform(2);
        scheduler
            .active_task_ids
            .insert("capacity-blocker".into(), RuntimeTaskKind::Personal);
        assert_eq!(scheduler.active_task_ids.len(), 2);
    }

    assert!(handler.finish_local_task("task", execution, None, "done"));
    tokio::time::timeout(Duration::from_secs(1), async {
        while handler
            .turn_scheduler
            .lock()
            .unwrap()
            .active_task_ids
            .contains_key("task")
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("A settled native question must release its slot after local cleanup");
    let scheduler = handler.turn_scheduler.lock().unwrap();
    assert_eq!(scheduler.active_task_ids.len(), 1);
    assert!(scheduler.active_task_ids.contains_key("capacity-blocker"));
    drop(scheduler);
    assert_eq!(
        handler
            .local_task_link("task")
            .unwrap()
            .interaction_status
            .as_deref(),
        Some(INTERACTION_AWAITING_USER_REPLY),
        "Releasing execution capacity must preserve the unanswered question"
    );
    let _ = fs::remove_dir_all(root);
}

fn completed_async_question() -> (RuntimeWorkRpcHandler, PathBuf, u64) {
    let (handler, root) = isolated_runtime_work_handler("async-answer-cleanup");
    let mut link = RuntimeTaskLink::new_pending(
        "task".into(),
        root.to_string_lossy().into_owned(),
        "Async question".into(),
    );
    link.thread_id = Some("thread".into());
    handler.upsert_local_task(link);
    handler.register_thread_event_route("thread", "task".into(), ExecutionRequest::default(), true);
    handler
        .turn_scheduler
        .lock()
        .unwrap()
        .active_task_ids
        .insert("task".into(), RuntimeTaskKind::Personal);
    let execution = start_test_execution(&handler, "task");
    handler.route_codex_notification(
        CodexNotification::from(json!({"method":"turn/started", "params": {
            "threadId":"thread", "turn":{"id":"turn", "status":"inProgress"}
        }}))
        .with_process_generation(5),
    );
    handler.route_codex_notification(
        CodexNotification::from(json!({"method":"item/completed", "params": {
            "threadId":"thread", "turnId":"turn", "item": {
                "id":"question", "type":"agentMessage", "questions":[{
                    "title":"Which async implementation direction should be used?",
                    "options":["Complete", "Investigate"]
                }]
            }
        }}))
        .with_process_generation(5),
    );
    handler.route_codex_notification(
        CodexNotification::from(json!({"method":"turn/completed", "params": {
            "threadId":"thread", "turn":{"id":"turn", "status":"completed"}
        }}))
        .with_process_generation(5),
    );
    assert_eq!(
        handler
            .local_task_link("task")
            .unwrap()
            .interaction_status
            .as_deref(),
        Some(INTERACTION_AWAITING_USER_REPLY)
    );
    let link = handler.local_task_link("task").unwrap();
    let state = crate::runtime_work::lifecycle::native_execution_state(&link).unwrap();
    assert!(!link.running);
    assert_eq!(
        state.phase,
        crate::runtime_work::lifecycle::NativeExecutionPhase::Idle
    );
    assert_eq!(state.process_generation, Some(5));
    assert_eq!(state.execution_outcome.as_deref(), Some("succeeded"));
    assert!(handler.is_current_local_task_execution("task", execution));
    (handler, root, execution)
}

#[tokio::test]
async fn global_router_persists_async_question_after_execution_settles() {
    let root = tempfile::tempdir().unwrap();
    let (event_tx, mut event_rx) = broadcast::channel(16);
    let mut handler = RuntimeWorkRpcHandler::with_event_sender("device-1", "/bin/false", event_tx);
    let index = root.path().join("runtime.json");
    handler.store = RuntimeWorkStore::new(index.clone());
    let mut link =
        RuntimeTaskLink::new_pending("task".into(), "/tmp/project".into(), "Task".into());
    link.thread_id = Some("thread".into());
    link.runtime_handle = json!({"lastTurnId":"turn"});
    handler.upsert_local_task(link);
    let execution = start_test_execution(&handler, "task");
    assert!(handler.finish_local_task("task", execution, None, "done"));
    handler.register_thread_event_route(
        "thread",
        "task".into(),
        ExecutionRequest {
            task_id: "task".into(),
            subtask_id: "turn".into(),
            ..Default::default()
        },
        false,
    );
    let question = CodexNotification::from(json!({
        "method":"item/completed", "params":{"threadId":"thread", "turnId":"turn",
        "item":{"id":"question", "type":"agentMessage", "questions":[{"title":"Continue?","options":["Yes","No"]}]}}
    }));
    handler.route_codex_notification(question.clone());
    handler.route_codex_notification(question.clone());
    handler
        .observe_execution_codex_notification(
            "task",
            execution,
            &ExecutionRequest {
                task_id: "task".into(),
                subtask_id: "turn".into(),
                ..Default::default()
            },
            None,
            question,
        )
        .await;
    let mut cards = 0;
    while let Ok(event) = event_rx.try_recv() {
        if event["event"] == "response.block.created" {
            assert_eq!(
                event["payload"]["data"]["block"]["render_payload"]["delivery"],
                "async"
            );
            cards += 1;
        }
    }
    assert_eq!(
        cards, 1,
        "The global receiver must publish the question exactly once"
    );
    assert_eq!(
        handler
            .local_task_link("task")
            .unwrap()
            .interaction_status
            .as_deref(),
        Some(INTERACTION_AWAITING_USER_REPLY)
    );
    let restored = RuntimeWorkStore::new(index);
    assert_eq!(
        restored
            .get_task("task")
            .unwrap()
            .interaction_status
            .as_deref(),
        Some(INTERACTION_AWAITING_USER_REPLY)
    );
}

#[tokio::test]
async fn global_router_persists_async_question_for_identified_active_root_turn() {
    assert_execution_question_delivery(false).await;
}

#[tokio::test]
async fn async_question_remains_pending_after_native_turn_callback_clears_active_context() {
    assert_execution_question_delivery(true).await;
}

async fn assert_execution_question_delivery(clear_active: bool) {
    let root = tempfile::tempdir().unwrap();
    let (event_tx, mut event_rx) = broadcast::channel(16);
    let mut handler = RuntimeWorkRpcHandler::with_event_sender("device-1", "/bin/false", event_tx);
    handler.store = RuntimeWorkStore::new(root.path().join("runtime.json"));
    let mut link =
        RuntimeTaskLink::new_pending("task".into(), "/tmp/project".into(), "Task".into());
    link.thread_id = Some("thread".into());
    link.runtime_handle = json!({"lastTurnId":"turn"});
    handler.upsert_local_task(link);
    let execution = start_test_execution(&handler, "task");
    handler.record_active_codex_turn("task", execution, "thread".into(), "turn".into());
    let request = ExecutionRequest {
        task_id: "task".into(),
        subtask_id: "turn".into(),
        ..Default::default()
    };
    handler.register_thread_event_route("thread", "task".into(), request.clone(), true);
    let question = CodexNotification::from(json!({
        "method":"item/completed", "params":{"threadId":"thread", "turnId":"turn",
        "item":{"id":"question", "type":"agentMessage", "questions":[{"title":"Continue?","options":["Yes","No"]}]}}
    }));
    let mapper_turn = handler.active_codex_turn("task");
    if clear_active {
        handler.clear_active_codex_turn("task", execution);
    }
    handler
        .observe_execution_codex_notification(
            "task",
            execution,
            &request,
            mapper_turn,
            question.clone(),
        )
        .await;
    assert!(
        handler
            .local_task_link("task")
            .unwrap()
            .interaction_status
            .is_none(),
        "The RPC observer must not persist native notification state"
    );
    assert!(
        !std::iter::from_fn(|| event_rx.try_recv().ok())
            .any(|event| event["event"] == "response.block.created"),
        "The RPC observer must not publish or claim native delivery"
    );
    handler.route_codex_notification(question.clone());
    handler.route_codex_notification(question);
    assert!(handler.finish_local_task("task", execution, None, "done"));
    assert_eq!(
        handler
            .local_task_link("task")
            .unwrap()
            .interaction_status
            .as_deref(),
        Some(INTERACTION_AWAITING_USER_REPLY)
    );
    let mut cards = 0;
    while let Ok(event) = event_rx.try_recv() {
        if event["event"] == "response.block.created" {
            cards += 1;
        }
    }
    assert_eq!(cards, 1);
}

#[test]
fn async_question_delivery_ignores_foreign_stale_and_terminal_notifications() {
    let root = tempfile::tempdir().unwrap();
    for (index, (status, thread, turn, interaction, executing, active_turn)) in [
        ("done", "child-thread", "turn", None, false, None),
        ("done", "thread", "old-turn", None, false, None),
        ("failed", "thread", "turn", None, false, None),
        ("cancelled", "thread", "turn", None, false, None),
        ("archived", "thread", "turn", None, false, None),
        (
            "running",
            "thread",
            "turn",
            Some(INTERACTION_WAITING_FOR_USER_INPUT),
            true,
            Some("turn"),
        ),
        ("running", "thread", "turn", None, true, Some("next-turn")),
        ("running", "thread", "turn", None, true, None),
    ]
    .into_iter()
    .enumerate()
    {
        let mut handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
        handler.store = RuntimeWorkStore::new(root.path().join(format!("runtime-{index}.json")));
        let mut link =
            RuntimeTaskLink::new_pending("task".into(), "/tmp/project".into(), "Task".into());
        link.thread_id = Some("thread".into());
        link.status = status.into();
        link.runtime_handle = json!({"lastTurnId":"turn"});
        link.interaction_status = interaction.map(str::to_owned);
        handler.upsert_local_task(link);
        if executing {
            let execution = start_test_execution(&handler, "task");
            if let Some(active_turn) = active_turn {
                handler.record_active_codex_turn(
                    "task",
                    execution,
                    "thread".into(),
                    active_turn.into(),
                );
            }
        }
        handler.store.update_task("task", |link| {
            if executing {
                link.runtime_handle["lastTurnId"] = json!(active_turn.unwrap_or("next-turn"));
            }
        });
        handler.persist_async_question_interaction("task", &json!({
            "method":"item/completed", "params":{"threadId":thread,"turnId":turn,
            "item":{"id":"question","type":"agentMessage","questions":[{"title":"Continue?","options":["Yes","No"]}]}}
        }).into());
        assert_eq!(
            handler
                .local_task_link("task")
                .unwrap()
                .interaction_status
                .as_deref(),
            interaction,
            "Rejected question case {index} must preserve interaction state"
        );
    }
}

#[test]
fn async_question_rejects_notification_older_than_recorded_native_turn() {
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.store = RuntimeWorkStore::new(root.path().join("runtime.json"));
    let mut link =
        RuntimeTaskLink::new_pending("task".into(), "/tmp/project".into(), "Task".into());
    link.thread_id = Some("thread".into());
    link.runtime_handle = json!({"lastTurnId":"next-turn"});
    handler.upsert_local_task(link);
    handler.persist_async_question_interaction("task", &json!({
        "method":"item/completed", "params":{"threadId":"thread","turnId":"old-turn",
        "item":{"id":"question","type":"agentMessage","questions":[{"title":"Continue?","options":["Yes","No"]}]}}
    }).into());
    assert!(handler
        .local_task_link("task")
        .unwrap()
        .interaction_status
        .is_none());
}

#[test]
fn async_question_uses_native_generation_after_rpc_observer_finishes() {
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.store = RuntimeWorkStore::new(root.path().join("runtime.json"));
    let mut link =
        RuntimeTaskLink::new_pending("task".into(), "/tmp/project".into(), "Task".into());
    link.thread_id = Some("thread".into());
    handler.upsert_local_task(link);
    handler.register_thread_event_route(
        "thread",
        "task".into(),
        ExecutionRequest::default(),
        false,
    );
    handler.route_codex_notification(
        CodexNotification::from(json!({
            "method":"turn/started", "params":{"threadId":"thread", "turn":{"id":"turn"}}
        }))
        .with_process_generation(2),
    );
    let question = json!({
        "method":"item/completed", "params":{"threadId":"thread", "turnId":"turn",
        "item":{"id":"question", "type":"agentMessage", "questions":[{"title":"Continue?","options":["Yes","No"]}]}}
    });
    handler.route_codex_notification(
        CodexNotification::from(question.clone()).with_process_generation(1),
    );
    assert!(handler
        .local_task_link("task")
        .unwrap()
        .interaction_status
        .is_none());
    handler.route_codex_notification(CodexNotification::from(question).with_process_generation(2));
    assert_eq!(
        handler
            .local_task_link("task")
            .unwrap()
            .interaction_status
            .as_deref(),
        Some(INTERACTION_AWAITING_USER_REPLY)
    );
}
