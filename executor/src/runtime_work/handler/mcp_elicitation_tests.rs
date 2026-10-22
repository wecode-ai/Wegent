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
    let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.begin_active_codex_transcript("task-1", "thread-1", "turn-1");
    let mut first = request();
    let mut second = request();
    second["id"] = json!(1);
    handler.record_active_codex_transcript_item("task-1", "turn-1", &first);
    handler.record_active_codex_transcript_item("task-1", "turn-1", &second);
    first["method"] = json!("wegent/mcpElicitation/settled");
    first["params"]["interactionStatus"] = json!("expired");
    handler.record_active_codex_transcript_item("task-1", "turn-1", &first);
    assert!(handler.has_pending_mcp_elicitation("task-1"));
    second["method"] = json!("wegent/mcpElicitation/settled");
    second["params"]["interactionStatus"] = json!("answered");
    handler.record_active_codex_transcript_item("task-1", "turn-1", &second);
    assert!(!handler.has_pending_mcp_elicitation("task-1"));
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
