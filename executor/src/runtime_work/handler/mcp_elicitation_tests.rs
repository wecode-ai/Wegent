// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

fn request() -> Value {
    json!({"id": 0, "method": "mcpServer/elicitation/request", "params": {
        "threadId": "thread-1", "turnId": "turn-1", "serverName": "wegent-sites-interactions",
        "mode": "form", "expiresAtUnixMs": now_ms() + 300_000,
        "interactionStatus": "pending", "message": "Choose deployment",
        "requestedSchema": {"type": "object", "properties": {
            "action": {"type": "string", "enum": ["production", "preview"]}
        }}
    }})
}

fn ordinary_request(request_id: Value, turn_id: &str) -> Value {
    json!({"id": request_id, "method": "item/tool/requestUserInput", "params": {
        "threadId": "thread-1", "turnId": turn_id,
        "questions": [{"id": "choice", "header": "Choice", "question": "Continue?",
            "options": [{"label": "Yes", "description": "Continue the task"}]}]
    }})
}

fn interaction_handler(label: &str) -> (RuntimeWorkRpcHandler, PathBuf) {
    let (handler, root) = isolated_runtime_work_handler(label);
    let mut link = RuntimeTaskLink::new_pending(
        "task-1".to_owned(),
        "/tmp/project".to_owned(),
        "Task".to_owned(),
    );
    link.thread_id = Some("thread-1".to_owned());
    handler.upsert_local_task(link);
    handler.begin_active_codex_transcript("task-1", "thread-1", "turn-1");
    (handler, root)
}

fn assert_interaction_status(handler: &RuntimeWorkRpcHandler, expected: Option<&str>) {
    assert_eq!(
        handler
            .local_task_link("task-1")
            .unwrap()
            .interaction_status
            .as_deref(),
        expected
    );
}

#[test]
fn ordinary_question_recovers_with_real_request_identity_and_persists_its_answer() {
    let (handler, root) = interaction_handler("ordinary-refresh-history");
    let ordinary = ordinary_request(json!(1), "turn-1");
    handler.record_active_codex_transcript_item("task-1", "turn-1", &ordinary);
    handler.record_active_codex_transcript_item("task-1", "turn-1", &request());
    let mut native =
        json!({"timeline": true, "turns": [{"id": "turn-1", "status": "inProgress", "items": []}]});
    handler.merge_active_codex_transcript("task-1", &mut native);
    let messages = transcript_messages(&native, "device-1");
    let blocks = messages[0]["blocks"].as_array().unwrap();
    assert_eq!(blocks.len(), 2);
    let payload = &blocks[0]["render_payload"];
    assert_eq!(payload["requestId"], 1);
    assert_eq!(payload["interactionScope"], "turn-1");
    assert_eq!(payload["questions"], ordinary["params"]["questions"]);
    assert_eq!(payload["interactionStatus"], "pending");
    let answer = json!({"requestId": 1, "interactionScope": "turn-1", "answers": {"choice": {"answers": ["Yes"]}}});
    handler.settle_request_user_input_response("task-1", "turn-1", Some("1"), &answer);
    handler.record_active_codex_transcript_item("task-1", "turn-1", &ordinary);
    handler.settle_request_user_input_response(
        "task-1",
        "turn-1",
        Some("1"),
        &json!({"answers": {"choice": {"answers": ["No"]}}}),
    );
    assert_interaction_status(&handler, Some(INTERACTION_WAITING_FOR_USER_INPUT));
    handler.persist_and_clear_active_codex_transcript("task-1", "completed");
    let link = handler.local_task_link("task-1").unwrap();
    let recovered = super::transcript_overlays::runtime_transcript_overlay_turns(
        &link,
        &[json!({"id": "turn-1", "items": []})],
    );
    let items = recovered[0]["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    let ordinary = &items
        .iter()
        .find(|item| item["id"] == "request-user-input-1")
        .unwrap()["block"]["render_payload"];
    assert_eq!(ordinary["interactionStatus"], "answered");
    assert_eq!(ordinary["response"], answer);
    let mcp = &items
        .iter()
        .find(|item| item["id"] == "request-user-input-0")
        .unwrap()["block"]["render_payload"];
    assert_eq!(mcp["interactionStatus"], "cancelled");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn mcp_elicitation_recovers_pending_and_settled_without_duplicate_or_resurrection() {
    let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.begin_active_codex_transcript("task-1", "thread-1", "turn-1");
    let pending = request();
    handler.record_active_codex_transcript_item("task-1", "turn-1", &pending);
    let messages = handler.active_codex_transcript_messages("task-1");
    let block = &messages[0]["blocks"][0];
    assert_eq!(block["id"], "request-user-input-0");
    assert_eq!(block["status"], "pending");
    assert_eq!(block["render_payload"]["requestId"], 0);
    assert_eq!(block["render_payload"]["interactionScope"], "turn-1");
    assert_eq!(
        block["render_payload"]["expiresAtUnixMs"],
        pending["params"]["expiresAtUnixMs"]
    );
    let mut duplicate = pending.clone();
    duplicate["params"]["expiresAtUnixMs"] = json!(now_ms() + 1_800_000);
    handler.record_active_codex_transcript_item("task-1", "turn-1", &duplicate);
    assert!(handler.normalize_pending_mcp_elicitation("task-1", &mut duplicate));
    assert_eq!(
        duplicate["params"]["expiresAtUnixMs"],
        pending["params"]["expiresAtUnixMs"]
    );
    for status in ["answered", "cancelled", "expired"] {
        handler.begin_active_codex_transcript("task-1", "thread-1", "turn-1");
        handler.record_active_codex_transcript_item("task-1", "turn-1", &pending);
        let mut settled = pending.clone();
        settled["method"] = json!("wegent/mcpElicitation/settled");
        settled["params"]["interactionStatus"] = json!(status);
        settled["params"]["settledAtUnixMs"] = json!(now_ms());
        handler.record_active_codex_transcript_item("task-1", "turn-1", &settled);
        handler.record_active_codex_transcript_item("task-1", "turn-1", &pending);
        assert!(!handler.normalize_pending_mcp_elicitation("task-1", &mut pending.clone()));
        let messages = handler.active_codex_transcript_messages("task-1");
        let blocks = messages[0]["blocks"].as_array().unwrap();
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0]["status"], "done");
        assert_eq!(blocks[0]["render_payload"]["interactionStatus"], status);
    }
}

#[test]
fn mcp_elicitation_keeps_other_pending_forms_after_one_settles() {
    let (handler, root) = interaction_handler("elicitation-multiple-pending");
    let mut first = request();
    let mut second = request();
    second["id"] = json!(1);
    handler.record_active_codex_transcript_item("task-1", "turn-1", &first);
    handler.record_active_codex_transcript_item("task-1", "turn-1", &second);
    first["method"] = json!("wegent/mcpElicitation/settled");
    first["params"]["interactionStatus"] = json!("expired");
    handler.record_active_codex_transcript_item("task-1", "turn-1", &first);
    handler.refresh_pending_user_input_status("task-1");
    assert_interaction_status(&handler, Some(INTERACTION_WAITING_FOR_USER_INPUT));
    second["method"] = json!("wegent/mcpElicitation/settled");
    second["params"]["interactionStatus"] = json!("answered");
    handler.record_active_codex_transcript_item("task-1", "turn-1", &second);
    handler.refresh_pending_user_input_status("task-1");
    assert_interaction_status(&handler, None);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn ordinary_user_input_answers_settle_only_the_matching_pending_request() {
    let (handler, root) = interaction_handler("ordinary-multiple-pending");
    for id in [0, 1] {
        handler.record_active_codex_transcript_item(
            "task-1",
            "turn-1",
            &ordinary_request(json!(id), "turn-1"),
        );
    }
    handler.refresh_pending_user_input_status("task-1");
    assert_interaction_status(&handler, Some(INTERACTION_WAITING_FOR_USER_INPUT));
    assert_eq!(
        handler.request_user_input_response_key("task-1", "turn-1", &json!({"answers": {}})),
        None,
        "an uncorrelated answer cannot choose between two pending requests"
    );
    handler.settle_request_user_input_response("task-1", "turn-1", None, &json!({"answers": {}}));
    handler.settle_request_user_input_response(
        "task-1",
        "turn-1",
        Some("unknown"),
        &json!({"answers": {}}),
    );
    assert_interaction_status(&handler, Some(INTERACTION_WAITING_FOR_USER_INPUT));

    let first_key = handler.request_user_input_response_key(
        "task-1",
        "turn-1",
        &json!({"request_id": "0", "answers": {}}),
    );
    assert_eq!(first_key.as_deref(), Some("0"));
    handler.settle_request_user_input_response(
        "task-1",
        "turn-1",
        first_key.as_deref(),
        &json!({"answers": {}}),
    );
    assert_interaction_status(&handler, Some(INTERACTION_WAITING_FOR_USER_INPUT));
    let remaining_key =
        handler.request_user_input_response_key("task-1", "turn-1", &json!({"answers": {}}));
    assert_eq!(remaining_key.as_deref(), Some("1"));
    handler.settle_request_user_input_response(
        "task-1",
        "turn-1",
        remaining_key.as_deref(),
        &json!({"answers": {}}),
    );
    assert_interaction_status(&handler, None);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn answered_ordinary_requests_and_approvals_cannot_reopen_on_same_turn_replay() {
    let (handler, root) = interaction_handler("ordinary-replay");
    for method in [
        "item/tool/requestUserInput",
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
        "item/permissions/requestApproval",
    ] {
        handler.begin_active_codex_transcript("task-1", "thread-1", "turn-1");
        let mut pending = ordinary_request(json!(0), "turn-1");
        pending["method"] = json!(method);
        handler.record_active_codex_transcript_item("task-1", "turn-1", &pending);
        handler.refresh_pending_user_input_status("task-1");
        assert_interaction_status(&handler, Some(INTERACTION_WAITING_FOR_USER_INPUT));
        handler.settle_request_user_input_response(
            "task-1",
            "turn-1",
            Some("0"),
            &json!({"answers": {}}),
        );
        assert_interaction_status(&handler, None);
        handler.record_active_codex_transcript_item("task-1", "turn-1", &pending);
        handler.refresh_pending_user_input_status("task-1");
        assert_interaction_status(&handler, None);
    }
    let _ = fs::remove_dir_all(root);
}

#[test]
fn ordinary_answer_from_previous_turn_cannot_settle_reused_request_id() {
    let (handler, root) = interaction_handler("ordinary-answer-turn-scope");
    handler.record_active_codex_transcript_item(
        "task-1",
        "turn-1",
        &ordinary_request(json!(0), "turn-1"),
    );
    let previous_key = handler.request_user_input_response_key(
        "task-1",
        "turn-1",
        &json!({"requestId": 0, "answers": {}}),
    );
    assert_eq!(previous_key.as_deref(), Some("0"));
    handler.begin_active_codex_transcript("task-1", "thread-1", "turn-2");
    handler.record_active_codex_transcript_item(
        "task-1",
        "turn-2",
        &ordinary_request(json!(0), "turn-2"),
    );
    handler.refresh_pending_user_input_status("task-1");
    handler.settle_request_user_input_response(
        "task-1",
        "turn-1",
        previous_key.as_deref(),
        &json!({"answers": {}}),
    );
    assert_interaction_status(&handler, Some(INTERACTION_WAITING_FOR_USER_INPUT));
    handler.settle_request_user_input_response(
        "task-1",
        "turn-2",
        Some("0"),
        &json!({"answers": {}}),
    );
    assert_interaction_status(&handler, None);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn ordinary_pending_requests_are_cleared_by_turn_changes_and_completion() {
    let (handler, root) = interaction_handler("ordinary-terminal-cleanup");
    handler.record_active_codex_transcript_item(
        "task-1",
        "turn-1",
        &ordinary_request(json!(0), "turn-1"),
    );
    handler.refresh_pending_user_input_status("task-1");
    assert_interaction_status(&handler, Some(INTERACTION_WAITING_FOR_USER_INPUT));
    handler.begin_active_codex_transcript("task-1", "thread-1", "turn-2");
    handler.refresh_pending_user_input_status("task-1");
    assert_interaction_status(&handler, None);
    handler.record_active_codex_transcript_item(
        "task-1",
        "turn-2",
        &ordinary_request(json!(1), "turn-2"),
    );
    handler.refresh_pending_user_input_status("task-1");
    assert_interaction_status(&handler, Some(INTERACTION_WAITING_FOR_USER_INPUT));
    handler.record_active_codex_transcript_item(
        "task-1",
        "turn-3",
        &json!({"method": "item/agentMessage/delta", "params": {
            "threadId": "thread-1", "turnId": "turn-3", "itemId": "message-3", "delta": "Continuing"
        }}),
    );
    handler.refresh_pending_user_input_status("task-1");
    assert_interaction_status(&handler, None);
    handler.record_active_codex_transcript_item(
        "task-1",
        "turn-3",
        &ordinary_request(json!(2), "turn-3"),
    );
    handler.refresh_pending_user_input_status("task-1");
    for turn_id in ["turn-2", "turn-3"] {
        handler.persist_completed_codex_turn_from_notification(
            "task-1",
            &json!({"method": "turn/completed", "params": {
                "threadId": "thread-1",
                "turn": {"id": turn_id, "status": "completed", "items": []}
            }}),
        );
        handler.refresh_pending_user_input_status("task-1");
        assert_interaction_status(
            &handler,
            if turn_id == "turn-2" {
                Some(INTERACTION_WAITING_FOR_USER_INPUT)
            } else {
                None
            },
        );
    }
    let _ = fs::remove_dir_all(root);
}

#[test]
fn mixed_requests_wait_for_mcp_settlement_and_preserve_nonblocking_reply_status() {
    let (handler, root) = interaction_handler("ordinary-mcp-settlement");
    handler.record_active_codex_transcript_item(
        "task-1",
        "turn-1",
        &ordinary_request(json!(1), "turn-1"),
    );
    let mut mcp = request();
    mcp["params"]["expiresAtUnixMs"] = json!(now_ms() - 1);
    handler.record_active_codex_transcript_item("task-1", "turn-1", &mcp);
    assert_eq!(
        handler.request_user_input_response_key("task-1", "turn-1", &json!({"answers": {}})),
        None,
        "a pending MCP response makes an uncorrelated ordinary answer ambiguous"
    );
    handler.settle_request_user_input_response(
        "task-1",
        "turn-1",
        Some("1"),
        &json!({"answers": {}}),
    );
    assert_interaction_status(&handler, Some(INTERACTION_WAITING_FOR_USER_INPUT));
    mcp["method"] = json!("wegent/mcpElicitation/settled");
    mcp["params"]["interactionStatus"] = json!("expired");
    handler.record_active_codex_transcript_item("task-1", "turn-1", &mcp);
    handler.refresh_pending_user_input_status("task-1");
    assert_interaction_status(&handler, None);

    handler.set_interaction_status("task-1", Some(INTERACTION_AWAITING_USER_REPLY));
    handler.refresh_pending_user_input_status("task-1");
    assert_interaction_status(&handler, Some(INTERACTION_AWAITING_USER_REPLY));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn mcp_elicitation_terminal_turn_and_expired_deadline_cannot_restore_pending_card() {
    let mut item = crate::runtime_work::mcp_elicitation::item(&request()).unwrap();
    for status in ["cancelled", "completed", "interrupted"] {
        let thread =
            json!({"turns": [{"id": "turn-1", "status": status, "items": [item.clone()]}]});
        let messages = transcript_messages(&thread, "device-1");
        assert_eq!(
            messages[0]["blocks"][0]["render_payload"]["interactionStatus"],
            "cancelled"
        );
    }
    item["renderPayload"]["expiresAtUnixMs"] = json!(now_ms() - 1);
    let thread = json!({"turns": [{"id": "turn-1", "status": "inProgress", "items": [item]}]});
    let messages = transcript_messages(&thread, "device-1");
    assert_eq!(
        messages[0]["blocks"][0]["render_payload"]["interactionStatus"],
        "expired"
    );
}

#[tokio::test]
async fn mcp_elicitation_completed_history_restores_answers_after_active_cache_is_cleared() {
    for completion_notification in [false, true] {
        let (mut handler, root) = isolated_runtime_work_handler("elicitation-answered-history");
        let mut link = RuntimeTaskLink::new_pending(
            "task-1".to_owned(),
            "/tmp/project".to_owned(),
            "Task".to_owned(),
        );
        link.thread_id = Some("thread-1".to_owned());
        handler.upsert_local_task(link);
        install_native_history(
            &mut handler,
            &root,
            vec![json!({"id":"turn-1", "status":"completed", "items":[
                {"id":"native-answer", "type":"agentMessage", "text":"Done"}
            ]})],
            None,
        );
        start_test_execution(&handler, "task-1");
        handler.begin_active_codex_transcript("task-1", "thread-1", "turn-1");
        let cases = [
            (
                "form",
                "answered",
                Some(json!({"action": {"answers": ["preview"]}})),
            ),
            (
                "url",
                "answered",
                Some(json!({"__mcp_url": {"answers": ["accept"]}})),
            ),
            ("form", "cancelled", Some(json!({}))),
            ("url", "expired", None),
        ];
        for (index, (mode, status, answers)) in cases.iter().enumerate() {
            let mut pending = request();
            pending["id"] = json!(index);
            pending["params"]["mode"] = json!(mode);
            if *mode == "url" {
                pending["params"]["url"] = json!("https://example.com/authorize");
                pending["params"]["elicitationId"] = json!("authorize-1");
            }
            handler.record_active_codex_transcript_item("task-1", "turn-1", &pending);
            let mut settled = pending;
            settled["method"] = json!("wegent/mcpElicitation/settled");
            settled["params"]["interactionStatus"] = json!(status);
            settled["params"]["settledAtUnixMs"] = json!(now_ms());
            if let Some(answers) = answers {
                settled["params"]["response"] = json!({
                    "requestId": index, "interactionScope": "turn-1", "answers": answers
                });
            }
            handler.record_active_codex_transcript_item("task-1", "turn-1", &settled);
        }
        if completion_notification {
            handler.persist_completed_codex_turn_from_notification(
                "task-1",
                &json!({
                    "method": "turn/completed", "params": {
                        "threadId": "thread-1",
                        "turn": {"id": "turn-1", "status": "completed", "items": []}
                    }
                }),
            );
        } else {
            handler.persist_and_clear_active_codex_transcript("task-1", "completed");
        }
        handler.clear_active_codex_transcript("task-1");
        assert!(handler
            .active_codex_transcript_messages("task-1")
            .is_empty());

        // WebView reload reads Runtime history without any renderer or active-turn cache.
        let transcript = handler
            .handle_runtime_rpc(json!({
                "method": "runtime.tasks.transcript",
                "payload": {"taskId": "task-1", "workspacePath": "/tmp/project"}
            }))
            .await
            .unwrap();
        handler
            .codex_app_server
            .request("test/stop", json!({}))
            .await
            .unwrap();
        let blocks = transcript["runtimeTurns"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|turn| turn["items"].as_array().into_iter().flatten())
            .map(|item| &item["block"])
            .filter(|block| block["tool_name"] == "request_user_input")
            .collect::<Vec<_>>();
        assert_eq!(blocks.len(), cases.len());
        for (index, (_, status, answers)) in cases.iter().enumerate() {
            let payload = &blocks[index]["render_payload"];
            assert_eq!(blocks[index]["status"], "done");
            assert_eq!(payload["interactionStatus"], *status);
            assert_eq!(payload["requestId"], index);
            assert_eq!(payload["interactionScope"], "turn-1");
            if let Some(answers) = answers {
                assert_eq!(
                    payload["response"],
                    json!({
                        "requestId": index, "interactionScope": "turn-1", "answers": answers
                    })
                );
            } else {
                assert!(payload.get("response").is_none());
            }
        }
        let _ = fs::remove_dir_all(root);
    }
}

#[test]
fn mcp_elicitation_history_keeps_reused_request_ids_scoped_to_their_turn() {
    let (handler, root) = isolated_runtime_work_handler("elicitation-answer-turn-scope");
    let mut link = RuntimeTaskLink::new_pending(
        "task-1".to_owned(),
        "/tmp/project".to_owned(),
        "Task".to_owned(),
    );
    link.thread_id = Some("thread-1".to_owned());
    handler.upsert_local_task(link);
    let mut previous_settled = None;
    for (turn_id, choice) in [("turn-1", "preview"), ("turn-2", "production")] {
        handler.begin_active_codex_transcript("task-1", "thread-1", turn_id);
        let mut pending = request();
        pending["params"]["turnId"] = json!(turn_id);
        handler.record_active_codex_transcript_item("task-1", turn_id, &pending);
        if let Some(previous) = &previous_settled {
            handler.record_active_codex_transcript_item("task-1", turn_id, previous);
            let messages = handler.active_codex_transcript_messages("task-1");
            let payload = &messages[0]["blocks"][0]["render_payload"];
            assert_eq!(payload["interactionStatus"], "pending");
            assert!(payload.get("response").is_none());
        }
        let mut settled = pending;
        settled["method"] = json!("wegent/mcpElicitation/settled");
        settled["params"]["interactionStatus"] = json!("answered");
        settled["params"]["response"] = json!({
            "requestId": 0, "interactionScope": turn_id,
            "answers": {"action": {"answers": [choice]}}
        });
        handler.record_active_codex_transcript_item("task-1", turn_id, &settled);
        handler.persist_and_clear_active_codex_transcript("task-1", "completed");
        previous_settled = Some(settled);
    }
    let history = completed_transcript_messages(&handler.local_task_link("task-1").unwrap());
    assert_eq!(history.len(), 2);
    for (index, (turn_id, choice)) in [("turn-1", "preview"), ("turn-2", "production")]
        .iter()
        .enumerate()
    {
        let response = &history[index]["blocks"][0]["render_payload"]["response"];
        assert_eq!(response["requestId"], 0);
        assert_eq!(response["interactionScope"], *turn_id);
        assert_eq!(response["answers"]["action"]["answers"][0], *choice);
    }
    let link = handler.local_task_link("task-1").unwrap();
    let overlay = super::super::transcript_overlays::runtime_transcript_overlay_turns;
    assert!(overlay(&link, &[]).is_empty());
    assert!(overlay(&link, &[json!({"id":"other-page", "items":[]})]).is_empty());
    for (turn_id, choice) in [("turn-1", "preview"), ("turn-2", "production")] {
        let turns = overlay(&link, &[json!({"id":turn_id, "items":[]})]);
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0]["id"], turn_id);
        assert_eq!(turns[0]["items"].as_array().unwrap().len(), 1);
        let payload = &turns[0]["items"][0]["block"]["render_payload"];
        assert_eq!(payload["interactionScope"], turn_id);
        assert_eq!(
            payload["response"]["answers"]["action"]["answers"][0],
            choice
        );
    }
    handler.record_superseded_runtime_transcript_turn("task-1", "turn-1");
    assert!(overlay(
        &handler.local_task_link("task-1").unwrap(),
        &[json!({"id":"turn-1", "items":[]})]
    )
    .is_empty());
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn mcp_elicitation_rejects_late_answers_and_answers_from_previous_turn() {
    let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.begin_active_codex_transcript("task-1", "thread-1", "turn-1");
    let execution_id = start_test_execution(&handler, "task-1");
    handler.record_active_codex_turn(
        "task-1",
        execution_id,
        "thread-1".to_owned(),
        "turn-1".to_owned(),
    );
    let (sender, mut receiver) = mpsc::channel(1);
    handler.active_request_user_inputs.lock().unwrap().insert(
        "task-1".to_owned(),
        ActiveRequestUserInput {
            execution_id,
            sender,
        },
    );
    let mut pending = request();
    handler.record_active_codex_transcript_item("task-1", "turn-1", &pending);
    for invalid in [
        json!({"request_id": 0, "answers": {}}),
        json!({"itemId": "0", "answers": {}}),
        json!({"answers": {}}),
    ] {
        let rejected = handler
            .send_request_user_input_response("task-1", invalid)
            .await
            .unwrap();
        assert_eq!(rejected["code"], "stale_request_user_input");
    }
    let mut answer = json!({"requestId": 0, "interactionScope": "turn-old", "answers": {"action": {"answers": ["production"]}}});
    let stale = handler
        .send_request_user_input_response("task-1", answer.clone())
        .await
        .unwrap();
    assert_eq!(stale["code"], "stale_request_user_input");
    answer["interactionScope"] = json!("turn-1");
    let accepted = handler
        .send_request_user_input_response("task-1", answer.clone())
        .await
        .unwrap();
    assert_eq!(accepted["success"], true);
    assert_eq!(receiver.recv().await.unwrap(), answer);
    let generic = json!({"requestId": 42, "interactionScope": "turn-1", "answers": {"question": {"answers": ["yes"]}}});
    let accepted = handler
        .send_request_user_input_response("task-1", generic.clone())
        .await
        .unwrap();
    assert_eq!(
        accepted["success"], true,
        "a separate generic question in the same turn remains answerable"
    );
    assert_eq!(receiver.recv().await.unwrap(), generic);
    pending["method"] = json!("wegent/mcpElicitation/settled");
    pending["params"]["interactionStatus"] = json!("expired");
    handler.record_active_codex_transcript_item("task-1", "turn-1", &pending);
    let stale = handler
        .send_request_user_input_response("task-1", answer)
        .await
        .unwrap();
    assert_eq!(stale["code"], "stale_request_user_input");
    assert!(receiver.try_recv().is_err());
}
