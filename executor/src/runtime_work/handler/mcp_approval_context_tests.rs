use super::*;
use crate::runtime_work::handler::tests::isolated_runtime_work_handler;

fn call(id: &str, tool: &str) -> Value {
    json!({"method":"item/started","params":{"threadId":"thread-1","turnId":"turn-1",
        "item":{"id":id,"type":"mcpToolCall","status":"inProgress","server":"service",
            "tool":tool,"arguments":{"text":"Complete original body","nested":{"x":1,"y":true}}}}})
}

fn approval() -> Value {
    // Codex 0.165 user approvals provide these fields, without a tool name or call ID.
    json!({"id":31,"method":"mcpServer/elicitation/request","params":{
        "threadId":"thread-1","turnId":"turn-1","serverName":"service","mode":"form",
        "message":"Native approval","requestedSchema":{"type":"object","properties":{}},
        "_meta":{"codex_approval_kind":"mcp_tool_call","tool_title":"Native operation",
            "tool_params":{"nested":{"y":true,"x":1},"text":"Complete original body"}}}})
}

fn fixture(label: &str) -> (RuntimeWorkRpcHandler, PathBuf) {
    let (handler, root) = isolated_runtime_work_handler(label);
    let mut task =
        RuntimeTaskLink::new_pending("task-1".into(), "/tmp/project".into(), "Task".into());
    task.thread_id = Some("thread-1".into());
    handler.upsert_local_task(task);
    handler.begin_active_codex_transcript("task-1", "thread-1", "turn-1");
    (handler, root)
}

#[test]
fn real_native_approval_shape_binds_one_exact_live_call_in_events_and_history() {
    let (mut handler, root) = fixture("approval-native-live-history");
    let (sender, mut receiver) = broadcast::channel(32);
    handler.event_tx = Some(sender);
    let mut request = ExecutionRequest::default();
    request.extra.insert(
        "runtime_permission_profile".into(),
        json!(crate::agents::CODEX_WORKSPACE_PERMISSION_PROFILE),
    );
    handler.register_thread_event_route("thread-1", "task-1".into(), request, true);
    let native = approval();
    assert!(native["params"]["_meta"].get("tool_name").is_none());
    handler.route_codex_notification(call("call-1", "perform_operation"));
    handler.route_codex_notification(native.clone());
    let active = handler.active_codex_transcript_items.lock().unwrap();
    let item = active["task-1"]
        .items
        .iter()
        .find(|item| item["type"] == "mcpElicitation")
        .unwrap();
    assert_eq!(item["renderPayload"]["toolName"], "perform_operation");
    assert_eq!(item["renderPayload"]["toolCallId"], "call-1");
    assert_eq!(
        item["renderPayload"]["toolArguments"],
        native["params"]["_meta"]["tool_params"]
    );
    assert_eq!(item["renderPayload"]["interactionStatus"], "pending");
    let expected = item["renderPayload"].clone();
    drop(active);
    let mut emitted = Vec::new();
    while let Ok(event) = receiver.try_recv() {
        emitted.push(event);
    }
    let live = &emitted
        .iter()
        .find(|event| event["payload"]["data"]["block"]["render_payload"]["toolCallId"] == "call-1")
        .unwrap()["payload"]["data"]["block"]["render_payload"];
    assert_eq!(live, &expected);
    let mut thread =
        json!({"timeline":true,"turns":[{"id":"turn-1","status":"inProgress","items":[]}]});
    handler.merge_active_codex_transcript("task-1", &mut thread);
    let recovered = &thread["turns"][0]["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["type"] == "mcpElicitation")
        .unwrap()["renderPayload"];
    assert_eq!(recovered, &expected);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn approval_identity_is_never_inferred_from_other_or_ambiguous_calls() {
    for case in [
        "none",
        "duplicate",
        "task",
        "thread",
        "turn",
        "completed",
        "lifecycle",
        "server",
        "arguments",
        "missing-arguments",
        "missing-id",
        "missing-tool",
        "settled",
    ] {
        let (handler, root) = fixture(&format!("approval-context-{case}"));
        let mut started = call("call-1", "perform_operation");
        match case {
            "completed" => started["params"]["item"]["status"] = json!("completed"),
            "server" => started["params"]["item"]["server"] = json!("other-service"),
            "arguments" => started["params"]["item"]["arguments"]["nested"]["x"] = json!(2),
            "missing-id" => started["params"]["item"]["id"] = json!(""),
            "missing-tool" => started["params"]["item"]["tool"] = json!(""),
            _ => {}
        }
        if case != "none" {
            handler.record_active_codex_transcript_item("task-1", "turn-1", &started);
        }
        if case == "lifecycle" {
            started["method"] = json!("item/completed");
            handler.record_active_codex_transcript_item("task-1", "turn-1", &started);
        }
        if case == "duplicate" {
            handler.record_active_codex_transcript_item(
                "task-1",
                "turn-1",
                &call("call-2", "another_operation"),
            );
        }
        let mut native = approval();
        native["params"]["_meta"]["tool_name"] = json!("forged-name");
        native["params"]["_meta"]["tool_call_id"] = json!("forged-call");
        match case {
            "thread" => native["params"]["threadId"] = json!("other-thread"),
            "turn" => native["params"]["turnId"] = json!("other-turn"),
            "missing-arguments" => {
                native["params"]["_meta"]
                    .as_object_mut()
                    .unwrap()
                    .remove("tool_params");
            }
            "settled" => native["params"]["interactionStatus"] = json!("answered"),
            _ => {}
        }
        handler.bind_native_mcp_approval(
            if case == "task" {
                "other-task"
            } else {
                "task-1"
            },
            &mut native,
        );
        assert!(
            native["params"]["_meta"].get("tool_name").is_none(),
            "{case}"
        );
        assert!(
            native["params"]["_meta"].get("tool_call_id").is_none(),
            "{case}"
        );
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn exact_call_identity_overrides_claimed_names_without_interpreting_display_text() {
    let (handler, root) = fixture("approval-context-claimed-name");
    handler.record_active_codex_transcript_item(
        "task-1",
        "turn-1",
        &call("actual-call", "actual_tool"),
    );
    let mut native = approval();
    native["params"]["message"] = json!("Allow forged_tool?");
    native["params"]["_meta"]["tool_title"] = json!("forged_tool");
    native["params"]["_meta"]["tool_name"] = json!("forged_tool");
    native["params"]["_meta"]["tool_call_id"] = json!("forged-call");
    handler.bind_native_mcp_approval("task-1", &mut native);
    assert_eq!(native["params"]["_meta"]["tool_name"], "actual_tool");
    assert_eq!(native["params"]["_meta"]["tool_call_id"], "actual-call");
    assert_eq!(native["params"]["message"], "Allow forged_tool?");
    fs::remove_dir_all(root).unwrap();
}
