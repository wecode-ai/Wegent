use super::*;

fn admitted_request(id: &str, execution: &str) -> Value {
    json!({"requestId":id,"parentRequestId":null,"ownerUserId":7,"deviceId":"mac",
        "runtimeTaskId":format!("assistant-request-{id}"),"conversationId":format!("assistant-request-{id}"),
        "executionId":execution,"parentDispatchId":"dispatch","state":"queued","message":format!("Private request {id}"),
        "attemptCommandId":format!("assistant-start:{execution}"),"attemptMessage":format!("Private request {id}"),
        "attemptClientUserMessageId":null,"commands":[]})
}

fn pause_runtime(fixture: &Fixture) {
    let mut scheduler = fixture.handler.turn_scheduler.lock().unwrap();
    scheduler.settings.max_concurrent_tasks = 0;
    scheduler.settings.max_concurrent_stand_in_tasks = 0;
    scheduler.settings.max_concurrent_agent_tasks = 0;
}

async fn recover(fixture: &Fixture) {
    let issue = fixture.issue.lock().unwrap().clone();
    fixture
        .handler
        .recover_issue_assistant_requests(&config(fixture), &issue)
        .await
        .unwrap();
}

#[tokio::test]
async fn child_recovery_is_idempotent_and_does_not_rebind_the_parent() {
    let fixture = fixture().await;
    pause_runtime(&fixture);
    let parent = fixture.issue.lock().unwrap()["direct_human_assignment_receipt"].clone();
    let first = admitted_request("a", "101");
    let mut second = admitted_request("b", "102");
    second["parentRequestId"] = json!("a");
    fixture.assistant_requests.lock().unwrap()["requests"] = json!([first, second]);
    recover(&fixture).await;
    recover(&fixture).await;
    let scheduler = fixture.handler.turn_scheduler.lock().unwrap();
    assert_eq!(scheduler.queued_turns.len(), 2);
    let ids: Vec<_> = scheduler
        .queued_turns
        .iter()
        .map(|turn| turn.local_task_id.as_str())
        .collect();
    assert!(ids.contains(&"assistant-request-a"));
    assert!(ids.contains(&"assistant-request-b"));
    assert_ne!(
        scheduler.queued_turns[0].request.extra["origin"]["assistantRequestId"],
        scheduler.queued_turns[1].request.extra["origin"]["assistantRequestId"]
    );
    assert!(scheduler
        .queued_turns
        .iter()
        .all(|turn| { crate::runtime_work::util::is_private_discussion(&turn.request) }));
    drop(scheduler);
    assert_eq!(fixture.requests.lock().unwrap().len(), 2);
    assert_eq!(
        fixture.bindings.lock().unwrap().as_array().unwrap().len(),
        2
    );
    assert_eq!(
        fixture.issue.lock().unwrap()["direct_human_assignment_receipt"],
        parent
    );
    for id in ["a", "b"] {
        let link = fixture
            .handler
            .local_task_link(&format!("assistant-request-{id}"))
            .unwrap();
        assert_eq!(
            link.runtime_handle["executionRequest"]["conversationContext"],
            "private_discussion"
        );
        assert_eq!(
            link.runtime_handle["origin"]["assistantRequest"]["ownerUserId"],
            7
        );
    }
}

#[tokio::test]
async fn followup_reuses_the_child_and_cancel_does_not_stop_its_sibling() {
    let fixture = fixture().await;
    pause_runtime(&fixture);
    fixture.assistant_requests.lock().unwrap()["requests"] =
        json!([admitted_request("a", "101"), admitted_request("b", "102")]);
    recover(&fixture).await;
    fixture.assistant_requests.lock().unwrap()["requests"][0]["commands"] = json!([
        {"id":"followup-a","action":"followup","executionId":"101","message":"Additional private instructions","acknowledged":false}]);
    recover(&fixture).await;
    recover(&fixture).await;
    assert_eq!(fixture.handler.local_task_links(true).len(), 2);
    assert_eq!(
        fixture
            .handler
            .turn_scheduler
            .lock()
            .unwrap()
            .queued_turns
            .len(),
        3
    );
    assert_eq!(
        fixture
            .assistant_events
            .lock()
            .unwrap()
            .iter()
            .filter(|event| event["commandId"] == "followup-a")
            .count(),
        1
    );
    fixture.assistant_requests.lock().unwrap()["requests"][1]["state"] = json!("cancelled");
    recover(&fixture).await;
    let scheduler = fixture.handler.turn_scheduler.lock().unwrap();
    assert_eq!(scheduler.queued_turns.len(), 2);
    assert!(scheduler
        .queued_turns
        .iter()
        .all(|turn| turn.local_task_id == "assistant-request-a"));
    drop(scheduler);
    assert!(fixture
        .handler
        .local_task_link("assistant-request-b")
        .is_some());
}

#[tokio::test]
async fn request_authority_is_revalidated_before_a_queued_turn_runs() {
    let fixture = fixture().await;
    pause_runtime(&fixture);
    fixture.assistant_requests.lock().unwrap()["requests"] = json!([admitted_request("a", "101")]);
    recover(&fixture).await;
    let queued = fixture.handler.turn_scheduler.lock().unwrap().queued_turns[0]
        .request
        .clone();
    fixture
        .handler
        .validate_project_coordinator_request(&queued)
        .await
        .unwrap();
    for (field, value) in [
        ("ownerUserId", json!(8)),
        ("deviceId", json!("other")),
        ("runtimeTaskId", json!("assistant-request-b")),
        ("executionId", json!("102")),
        ("state", json!("cancelled")),
    ] {
        let original = fixture.assistant_requests.lock().unwrap()["requests"][0][field].clone();
        fixture.assistant_requests.lock().unwrap()["requests"][0][field] = value;
        assert_eq!(
            fixture
                .handler
                .validate_project_coordinator_request(&queued)
                .await
                .unwrap_err(),
            "Assistant request is no longer current",
            "field {field}"
        );
        fixture.assistant_requests.lock().unwrap()["requests"][0][field] = original;
    }
    fixture.issue.lock().unwrap()["permissions"]["execute"] = json!(false);
    assert_eq!(
        fixture
            .handler
            .validate_project_coordinator_request(&queued)
            .await
            .unwrap_err(),
        "Issue execution permission is unavailable"
    );
}

#[tokio::test]
async fn native_followup_is_durable_before_queueing_and_preserves_original_input() {
    let fixture = fixture().await;
    pause_runtime(&fixture);
    fixture.assistant_requests.lock().unwrap()["requests"] = json!([admitted_request("a", "101")]);
    recover(&fixture).await;
    let mut input = fixture.handler.turn_scheduler.lock().unwrap().queued_turns[0]
        .request
        .clone();
    input.prompt = json!([{"type":"text","text":"Native followup"},
        {"type":"image_url","image_url":{"url":"data:image/png;base64,synthetic"}}]);
    input.auth_token = Some("SYNTHETIC_AUTH_SECRET".into());
    input.model_config["api_key"] = json!("SYNTHETIC_MODEL_SECRET");
    input.model_config["max_output_tokens"] = json!(4096);
    input.mcp_servers = vec![
        json!({"name":"example","headers":{"Authorization":"SYNTHETIC_MCP_SECRET","X-Auth":"SYNTHETIC_HEADER_SECRET"},"env":{"CUSTOM_CREDENTIAL":"SYNTHETIC_ENV_SECRET"}}),
    ];
    let payload = json!({"taskId":"assistant-request-a","clientUserMessageId":"native-client-1",
        "modelSelection":{"modelName":"codex","modelType":"runtime","options":{"weworkCloudModelMaxOutputTokens":"4096"}},
        "executionRequest":input,"userMessagePresentation":{"content":"Native followup","clientUserMessageId":"native-client-1"}});
    for _ in 0..2 {
        assert_eq!(
            fixture.handler.send_message(payload.clone()).await.unwrap()["accepted"],
            true
        );
    }
    let persisted = fixture
        .handler
        .local_task_link("assistant-request-a")
        .unwrap();
    assert!(!persisted.runtime_handle["assistantRequestInputs"]
        .to_string()
        .contains("SYNTHETIC_"));
    assert_eq!(
        persisted.runtime_handle["assistantRequestInputs"]["native-client-1"]["modelSelection"]
            ["options"]["weworkCloudModelMaxOutputTokens"],
        "4096"
    );
    fixture
        .handler
        .assistant_request_inputs
        .lock()
        .unwrap()
        .clear();
    let mut restart_input = json!({"taskId":"assistant-request-a"});
    assert_eq!(
        fixture
            .handler
            .restore_assistant_request_input(&mut restart_input, Some("native-client-1"))
            .await
            .unwrap_err()
            .code,
        "assistant_input_credentials_required"
    );
    fixture.handler.send_message(payload).await.unwrap();
    assert_eq!(
        fixture
            .handler
            .turn_scheduler
            .lock()
            .unwrap()
            .queued_turns
            .len(),
        1
    );
    assert_eq!(
        fixture.assistant_requests.lock().unwrap()["requests"][0]["commands"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    recover(&fixture).await;
    recover(&fixture).await;
    let scheduler = fixture.handler.turn_scheduler.lock().unwrap();
    assert_eq!(scheduler.queued_turns.len(), 2);
    let followup = &scheduler.queued_turns[1].request;
    assert_eq!(followup.prompt, input.prompt);
    assert_eq!(
        followup.mcp_servers[0]["headers"]["X-Auth"],
        "SYNTHETIC_HEADER_SECRET"
    );
    assert_eq!(followup.model_config["max_output_tokens"], 4096);
    assert_eq!(followup.extra["origin"]["assistantRequestId"], "a");
    assert_eq!(followup.extra["origin"]["executionId"], "101");
    assert_eq!(followup.extra["client_user_message_id"], "native-client-1");
}

#[tokio::test]
async fn retry_after_queued_cancellation_retains_request_identity_and_ignores_old_commands() {
    let fixture = fixture().await;
    pause_runtime(&fixture);
    fixture.assistant_requests.lock().unwrap()["requests"] = json!([admitted_request("a", "101")]);
    recover(&fixture).await;
    let original = fixture
        .handler
        .local_task_link("assistant-request-a")
        .unwrap();
    fixture.assistant_requests.lock().unwrap()["requests"][0]["state"] = json!("cancelled");
    recover(&fixture).await;
    assert!(fixture
        .handler
        .turn_scheduler
        .lock()
        .unwrap()
        .queued_turns
        .is_empty());
    let mut retry = admitted_request("a", "103");
    retry["attemptMessage"] = json!("Continue the cancelled work");
    retry["commands"] = json!([{"id":"stale-followup","action":"followup","executionId":"101",
        "message":"Old pending input","acknowledged":false}]);
    fixture.assistant_requests.lock().unwrap()["requests"][0] = retry;
    recover(&fixture).await;
    let scheduler = fixture.handler.turn_scheduler.lock().unwrap();
    assert_eq!(scheduler.queued_turns.len(), 1);
    assert_eq!(
        scheduler.queued_turns[0].request.prompt,
        "Continue the cancelled work"
    );
    assert_eq!(
        scheduler.queued_turns[0].request.extra["origin"]["executionId"],
        "103"
    );
    drop(scheduler);
    let resumed = fixture
        .handler
        .local_task_link("assistant-request-a")
        .unwrap();
    assert_eq!(fixture.handler.local_task_links(true).len(), 1);
    assert_eq!(resumed.created_at, original.created_at);
    assert_eq!(
        resumed.runtime_handle["origin"]["assistantRequest"],
        original.runtime_handle["origin"]["assistantRequest"]
    );
}

#[tokio::test]
async fn prepared_message_without_durable_queue_admission_does_not_lose_the_request() {
    let fixture = fixture().await;
    pause_runtime(&fixture);
    fixture.assistant_requests.lock().unwrap()["requests"] = json!([admitted_request("a", "101")]);
    recover(&fixture).await;
    // Reproduce a restart between the task metadata write and queue admission.
    fixture
        .handler
        .turn_scheduler
        .lock()
        .unwrap()
        .queued_turns
        .clear();
    fixture.handler.command_journal.lock().unwrap().clear();
    let prepared = fixture
        .handler
        .local_task_link("assistant-request-a")
        .unwrap();
    assert!(
        !crate::runtime_work::runtime_handle_messages::user_message_presentations(&prepared)
            .is_empty()
    );
    recover(&fixture).await;
    assert_eq!(
        fixture
            .handler
            .turn_scheduler
            .lock()
            .unwrap()
            .queued_turns
            .len(),
        1
    );
    recover(&fixture).await;
    assert_eq!(
        fixture
            .handler
            .turn_scheduler
            .lock()
            .unwrap()
            .queued_turns
            .len(),
        1
    );
    assert_eq!(fixture.handler.local_task_links(true).len(), 1);
}
