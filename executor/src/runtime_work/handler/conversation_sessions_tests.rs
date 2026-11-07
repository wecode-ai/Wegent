use super::*;

const TASK: &str = "stand-in-chat-7-primary";

#[test]
fn conversation_sessions_history_has_a_heap_bound_async_boundary() {
    let (_root, handler) = fixture();
    assert_eq!(
        std::mem::size_of_val(&handler.read_transcript(json!({"taskId":TASK}))),
        2 * std::mem::size_of::<usize>(),
    );
}

fn fixture() -> (tempfile::TempDir, RuntimeWorkRpcHandler) {
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.store = RuntimeWorkStore::new(root.path().join("runtime.json"));
    handler.upsert_local_task(RuntimeTaskLink {
        local_task_id: TASK.into(),
        thread_id: Some("thread-1".into()),
        workspace_path: root.path().display().to_string(),
        runtime_handle: json!({"origin":{"type":"stand_in_identity","userId":7,"deviceId":"mac"}}),
        ..Default::default()
    });
    (root, handler)
}

#[tokio::test]
async fn conversation_sessions_invalid_link_does_not_break_other_task_search() {
    let (_root, handler) = fixture();
    handler.store.update_task(TASK, |link| {
        link.runtime_handle[sessions::SESSIONS_KEY] = json!({"invalid":true});
    });
    handler.upsert_local_task(RuntimeTaskLink {
        local_task_id: "unrelated".into(),
        title: "searchable unrelated conversation".into(),
        runtime: "custom".into(),
        ..Default::default()
    });
    let result = handler
        .search_tasks(json!({"query":"searchable"}))
        .await
        .unwrap();
    assert_eq!(result["items"].as_array().unwrap().len(), 1);
    assert_eq!(result["items"][0]["taskId"], "unrelated");
    assert_eq!(
        handler
            .read_transcript(json!({"taskId":TASK}))
            .await
            .unwrap_err()
            .code,
        "invalid_session_state"
    );
}

#[test]
fn session_start_requires_idle_identity_and_the_exact_current_thread() {
    let (_root, handler) = fixture();
    let link = handler.local_task_link(TASK).unwrap();
    let payload = json!({"startNewSession":true,"expectedThreadId":"thread-1"});
    assert!(handler
        .validate_session_start(Some(&link), &payload)
        .unwrap());
    assert_eq!(
        handler
            .validate_session_start(
                Some(&link),
                &json!({"startNewSession":true,"expectedThreadId":"foreign"})
            )
            .unwrap_err()
            .code,
        "session_conflict"
    );
    for status in ["waitingForUserInput", "awaitingUserReply"] {
        let mut pending = link.clone();
        pending.interaction_status = Some(status.into());
        assert_eq!(
            handler
                .validate_session_start(Some(&pending), &payload)
                .unwrap_err()
                .code,
            "session_busy"
        );
    }
    let mut running = link.clone();
    running.running = true;
    assert_eq!(
        handler
            .validate_session_start(Some(&running), &payload)
            .unwrap_err()
            .code,
        "session_busy"
    );
    let mut goal = link.clone();
    goal.goal_status = Some("active".into());
    assert_eq!(
        handler
            .validate_session_start(Some(&goal), &payload)
            .unwrap_err()
            .code,
        "session_busy"
    );
    assert!(handler
        .validate_session_start(Some(&RuntimeTaskLink::default()), &payload)
        .is_err());
    assert!(handler
        .validate_session_start(Some(&link), &json!({"startNewSession":"true"}))
        .is_err());
}

#[tokio::test]
async fn conversation_sessions_preserve_reader_totals_for_pending_cached_history() {
    let (_root, handler) = fixture();
    handler.store.update_task(TASK, |link| {
        link.runtime_handle["messages"] = json!([{"id":"answer","turnId":"turn-1","role":"assistant","content":"needle needle needle","status":"done"}]);
        link.runtime_handle["userMessagePresentations"] = json!([{"id":"pending","content":"request"}]);
    });
    let result = handler
        .search_transcript(json!({"taskId":TASK,"query":"needle","limit":1}))
        .await
        .unwrap();
    assert_eq!(result["matches"].as_array().unwrap().len(), 1);
    assert_eq!(result["totalMatches"], 3);
    assert_eq!(result["isCapped"], true);
}

#[test]
fn old_thread_routes_and_late_notifications_cannot_replace_the_active_session() {
    let (_root, handler) = fixture();
    handler.register_thread_event_route("thread-1", TASK.into(), ExecutionRequest::default(), true);
    handler.record_local_task_thread(TASK, "thread-2");
    handler.register_thread_event_route(
        "thread-1",
        TASK.into(),
        ExecutionRequest::default(),
        false,
    );
    let before = handler.local_task_link(TASK).unwrap();
    handler.route_codex_notification(json!({"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"late-old-turn","status":"inProgress"}}}));
    let after = handler.local_task_link(TASK).unwrap();
    assert_eq!(after.thread_id.as_deref(), Some("thread-2"));
    assert_eq!(after.runtime_handle, before.runtime_handle);
    assert_eq!(after.interaction_status, before.interaction_status);
    assert_eq!(after.running, before.running);
    assert_eq!(
        sessions::thread_ids(&after).unwrap(),
        ["thread-1", "thread-2"]
    );
}

#[test]
fn session_cursors_bind_native_pages_to_task_thread_and_direction() {
    let cursor = encode_cursor(TASK, "thread-1", Some("native".into()), false);
    let decoded = decode_cursor(&cursor).unwrap().unwrap();
    assert_eq!(decoded.task, TASK);
    assert_eq!(decoded.thread, "thread-1");
    assert_eq!(decoded.native.as_deref(), Some("native"));
    assert!(!decoded.ascending);
    assert!(decode_cursor("wework-session:v1:invalid").is_err());
}

#[test]
fn closed_session_child_events_cannot_leak_into_the_current_conversation() {
    let (_root, mut handler) = fixture();
    let (tx, mut rx) = broadcast::channel(8);
    handler.event_tx = Some(tx);
    handler.register_thread_event_route("thread-1", TASK.into(), ExecutionRequest::default(), true);
    {
        let mut routing = handler.thread_event_routing.lock().unwrap();
        let mapper = routing.routes["thread-1"].event_mapper.clone();
        routing.routes.insert(
            "old-child".into(),
            RuntimeThreadEventRoute {
                local_task_id: TASK.into(),
                request: ExecutionRequest::default(),
                event_mapper: mapper,
                active: true,
                nested: true,
                generation: 10,
            },
        );
    }
    handler.record_local_task_thread(TASK, "thread-2");
    handler.register_thread_event_route("thread-2", TASK.into(), ExecutionRequest::default(), true);
    handler.route_codex_notification(json!({"method":"item/completed","params":{"threadId":"old-child","turnId":"old-turn","item":{"type":"agentMessage","id":"late-child-message","text":"Must stay in the old session"}}}));
    assert!(rx.try_recv().is_err());
    assert_eq!(
        handler.local_task_link(TASK).unwrap().thread_id.as_deref(),
        Some("thread-2")
    );
}

#[tokio::test]
async fn history_pages_cross_sessions_without_changing_the_active_task_or_approvals() {
    let (root, mut handler) = fixture();
    super::super::tests::native_history_test_support::install_native_history(
        &mut handler,
        root.path(),
        vec![
            json!({"id":"native-turn","status":"completed","items":[{"id":"native-user","type":"userMessage","content":[{"type":"text","text":"original request"}]}]}),
        ],
        None,
    );
    fs::write(root.path().join("thread_items_list.json"), json!({"data":[{"turnId":"native-turn","item":{"id":"native-user","type":"userMessage","content":[{"type":"text","text":"original request"}]}}],"nextCursor":null}).to_string()).unwrap();
    handler.record_local_task_thread(TASK, "thread-2");
    handler.store.update_task(TASK, |link| {
        link.interaction_status = Some("waitingForUserInput".into())
    });
    let first = handler
        .read_transcript(json!({"taskId":TASK,"limit":10}))
        .await
        .unwrap();
    assert_eq!(first["sessionThreadId"], "thread-2");
    assert_eq!(first["hasMoreBefore"], true);
    let cursor = first["beforeCursor"].clone();
    let older = handler
        .read_transcript(json!({"taskId":TASK,"limit":10,"beforeCursor":cursor}))
        .await
        .unwrap();
    assert_eq!(older["sessionThreadId"], "thread-1");
    assert_eq!(older["threadId"], "thread-2");
    assert_eq!(older["hasMoreBefore"], false);
    assert_eq!(older["hasMoreAfter"], true);
    assert!(!older["messages"].as_array().unwrap().is_empty());
    let newer = handler
        .read_transcript(json!({"taskId":TASK,"limit":10,"afterCursor":older["afterCursor"]}))
        .await
        .unwrap();
    assert_eq!(newer["sessionThreadId"], "thread-2");
    let link = handler.local_task_link(TASK).unwrap();
    assert_eq!(link.thread_id.as_deref(), Some("thread-2"));
    assert_eq!(
        link.interaction_status.as_deref(),
        Some("waitingForUserInput")
    );
    let foreign = handler.read_transcript(json!({"taskId":TASK,"beforeCursor":encode_cursor("other-task", "thread-1", None, false)})).await.unwrap_err();
    assert_eq!(foreign.code, "history_cursor_invalid");
    handler
        .codex_app_server
        .request("test/stop", json!({}))
        .await
        .unwrap();
}
