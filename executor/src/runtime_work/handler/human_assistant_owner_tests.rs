use super::*;

#[tokio::test]
async fn human_assistant_owner_changes_preserve_existing_local_manual_private_turns() {
    let fixture = fixture().await;
    let store = LocalTaskStore::open(fixture.handler.task_store_path.as_ref()).unwrap();
    let project = store
        .create_project(serde_json::from_value(json!({"name":"Local private work"})).unwrap())
        .unwrap();
    let issue = store
        .create_task(
            &project.id,
            serde_json::from_value(json!({"title":"Existing manual work"})).unwrap(),
        )
        .unwrap();
    let mut link = RuntimeTaskLink::new_pending(
        "existing-local-private".into(),
        fixture._root.path().display().to_string(),
        "Local private work".into(),
    );
    link.runtime_handle = json!({"origin":{
        "type":"issue_dispatch","initiatedBy":"stand_in","publicConversation":true,
        "runtimeTaskId":link.local_task_id,"userId":7,"standInId":"@primary",
        "projectStore":"local","cloudProjectId":project.id,"loopItemId":issue.id,
        "manual":true,"trigger":"manual"
    }});
    let mut request = runtime_event_request_from_link(&link);
    crate::runtime_work::util::apply_runtime_payload_metadata(
        &mut request,
        &json!({"conversationContext":"private_discussion"}),
    );
    fixture.handler.upsert_local_task(link);
    let result = fixture
        .handler
        .validate_project_coordinator_request(&request)
        .await;
    assert!(
        result.is_ok(),
        "Local manual turns must retain their native authorization: {result:?}"
    );
    assert!(fixture.requests.lock().unwrap().is_empty());
}

async fn private_followup_fixture() -> (Fixture, Value, ExecutionRequest) {
    let mut fixture = fixture().await;
    fixture.handler.command_journal = Arc::new(Mutex::new(Default::default()));
    {
        let mut scheduler = fixture.handler.turn_scheduler.lock().unwrap();
        scheduler.settings.max_concurrent_tasks = 0;
        scheduler.settings.max_concurrent_stand_in_tasks = 0;
        scheduler.settings.max_concurrent_agent_tasks = 0;
    }
    let config = config(&fixture);
    let issue = fixture.issue.lock().unwrap().clone();
    let prepared = fixture
        .handler
        .prepare_stand_in_task(&config, &issue, &issue["human_task_binding"])
        .await
        .unwrap();
    let task_id = fixture.handler.stand_in_task_id(&config, &issue);
    let mut link = RuntimeTaskLink::new_pending(
        task_id.clone(),
        fixture._root.path().display().to_string(),
        "Completed assigned work".into(),
    );
    link.status = "done".into();
    link.thread_id = Some("existing-private-thread".into());
    link.project_instructions = prepared["executionRequest"]["system_prompt"]
        .as_str()
        .unwrap()
        .to_owned();
    link.runtime_handle = json!({"origin":prepared["origin"],"executionRequest":prepared["executionRequest"],"standInIssueWakeups":["human"]});
    *fixture.bindings.lock().unwrap() = json!([{"task_id":task_id,"device_id":"mac","task_user_id":7,
        "human_assignment_id":"human","stand_in_pending":false,"execution_id":"42"}]);
    fixture.handler.upsert_local_task(link);
    fixture.issue.lock().unwrap()["direct_human_assignment_receipt"]["state"] = json!("completed");
    let mut ui_request = prepared["executionRequest"].clone();
    ui_request.as_object_mut().unwrap().remove("origin");
    ui_request["prompt"] = json!("Explain the completed result privately");
    ui_request["system_prompt"] = json!("");
    let payload = json!({
        "taskId":task_id,"commandId":"owner-private-followup","message":"Explain the completed result privately",
        "conversationContext":"private_discussion","executionRequest":ui_request
    });
    let automatic = serde_json::from_value(prepared["executionRequest"].clone()).unwrap();
    (fixture, payload, automatic)
}

#[tokio::test]
async fn human_assistant_completed_work_allows_an_owners_private_manual_followup() {
    let (fixture, payload, automatic) = private_followup_fixture().await;
    let accepted = fixture.handler.send_message(payload).await.unwrap();
    assert_eq!(accepted["accepted"], true);
    let queued = fixture.handler.turn_scheduler.lock().unwrap().queued_turns[0]
        .request
        .clone();
    let validation = fixture
        .handler
        .validate_project_coordinator_request(&queued)
        .await;
    assert!(
        validation.is_ok(),
        "Owner manual follow-up must retain project authorization: {validation:?}"
    );
    assert!(queued.extra["origin"]
        .get("humanAssistantDispatchId")
        .is_none());
    assert!(queued.extra["origin"].get("executionId").is_none());
    assert!(crate::runtime_work::util::is_private_discussion(&queued));
    assert_eq!(fixture.handler.local_task_links(true).len(), 1);
    assert_eq!(automatic.extra["origin"]["executionId"], "42");
    assert!(fixture
        .handler
        .validate_project_coordinator_request(&automatic)
        .await
        .is_err());
    assert!(
        fixture.requests.lock().unwrap().is_empty(),
        "Private follow-up must not claim another automatic execution"
    );
    let task_id = queued.extra["origin"]["runtimeTaskId"].as_str().unwrap();
    fixture
        .handler
        .send_internal_message(json!({
            "taskId":task_id,"commandId":"late-automatic-retry","queueIfBusy":true,
            "message":"Original automatic request retry","conversationContext":"private_discussion",
            "executionRequest":automatic
        }))
        .await
        .unwrap();
    let late = fixture
        .handler
        .turn_scheduler
        .lock()
        .unwrap()
        .queued_turns
        .back()
        .unwrap()
        .request
        .clone();
    assert_eq!(late.extra["origin"]["executionId"], "42");
    assert_eq!(late.extra["origin"]["humanAssistantDispatchId"], "dispatch");
    assert!(fixture
        .handler
        .validate_project_coordinator_request(&late)
        .await
        .is_err());
    let store = LocalTaskStore::open(fixture.handler.task_store_path.as_ref()).unwrap();
    let mut settings = store.personal_stand_in(7, "").unwrap();
    settings["primary"]["enabled"] = json!(false);
    settings["primary"]["collaboration"]["enabled"] = json!(false);
    store.save_personal_stand_in(7, "mac", settings).unwrap();
    fixture
        .handler
        .validate_project_coordinator_request(&queued)
        .await
        .unwrap();
    for changed in ["task_user_id", "device_id", "task_id"] {
        let original = fixture.bindings.lock().unwrap().clone();
        fixture.bindings.lock().unwrap()[0][changed] = json!("changed");
        assert!(fixture
            .handler
            .validate_project_coordinator_request(&queued)
            .await
            .is_err());
        *fixture.bindings.lock().unwrap() = original;
    }
    fixture.issue.lock().unwrap()["permissions"]["execute"] = json!(false);
    assert!(fixture
        .handler
        .validate_project_coordinator_request(&queued)
        .await
        .is_err());
}

#[tokio::test]
async fn human_assistant_private_owner_admission_rejects_missing_or_foreign_authority() {
    for changed in [
        "task_user_id",
        "device_id",
        "task_id",
        "missing",
        "execute",
        "owner",
    ] {
        let (fixture, mut payload, _) = private_followup_fixture().await;
        match changed {
            "missing" => *fixture.bindings.lock().unwrap() = json!([]),
            "execute" => fixture.issue.lock().unwrap()["permissions"]["execute"] = json!(false),
            "owner" => fixture
                .handler
                .store
                .update_task(payload["taskId"].as_str().unwrap(), |task| {
                    task.runtime_handle["origin"]["userId"] = json!(8);
                })
                .map(|_| ())
                .unwrap(),
            key => fixture.bindings.lock().unwrap()[0][key] = json!("foreign"),
        }
        payload["executionRequest"]["origin"] = json!({"type":"issue_dispatch", "trigger":"manual", "userId":8, "privateOwnerFollowup":true});
        let error = fixture.handler.send_message(payload).await.unwrap_err();
        assert_eq!(error.code, "permission_denied", "{changed}");
        assert!(fixture
            .handler
            .turn_scheduler
            .lock()
            .unwrap()
            .queued_turns
            .is_empty());
    }
}

#[tokio::test]
async fn human_assistant_internal_and_active_turns_keep_their_automatic_identity() {
    let (fixture, payload, _) = private_followup_fixture().await;
    fixture
        .handler
        .send_internal_message(payload)
        .await
        .unwrap();
    let queued = fixture.handler.turn_scheduler.lock().unwrap().queued_turns[0]
        .request
        .clone();
    assert_eq!(queued.extra["origin"]["executionId"], "42");
    assert!(fixture
        .handler
        .validate_project_coordinator_request(&queued)
        .await
        .is_err());
    for state in [
        "queued",
        "waiting_device",
        "running",
        "waiting_user",
        "cancelling",
    ] {
        let (fixture, payload, _) = private_followup_fixture().await;
        fixture.issue.lock().unwrap()["direct_human_assignment_receipt"]["state"] = json!(state);
        fixture.handler.send_message(payload).await.unwrap();
        let queued = fixture.handler.turn_scheduler.lock().unwrap().queued_turns[0]
            .request
            .clone();
        assert_eq!(queued.extra["origin"]["executionId"], "42", "{state}");
        assert_eq!(
            queued.extra["origin"]["humanAssistantDispatchId"],
            "dispatch"
        );
        assert_eq!(
            fixture
                .handler
                .validate_project_coordinator_request(&queued)
                .await
                .is_ok(),
            matches!(state, "running" | "waiting_user")
        );
    }
}
