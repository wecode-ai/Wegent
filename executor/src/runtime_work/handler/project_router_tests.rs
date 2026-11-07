use super::super::project_coordination_commands::tests::fixture;
use super::*;

#[test]
fn assessment_uses_the_existing_leaders_fixed_model_instead_of_device_default() {
    let default =
        json!({"runtime":"codex","provider":"test","model_id":"default","is_default":true});
    let fixed = json!({"runtime":"codex","provider":"test","model_id":"leader"});
    let agent = json!({"runtime":"codex","execution_policy":{"mode":"project_pool"},
        "model_policy":{"mode":"fixed","model":fixed},"system_prompt":"PRIVATE_PROMPT",
        "plugins":["PRIVATE_PLUGIN"],"mcp_servers":{"private":{}}});
    let result =
        assessment::assessment_model(&agent, &json!({"models":[default,fixed]}), "runner-a")
            .unwrap();
    assert_eq!(result["model_id"], "leader");
    assert!(!result.to_string().contains("PRIVATE"));
}

#[test]
fn assessment_rejects_an_unavailable_leader_model_instead_of_substituting_default() {
    let agent = json!({"runtime":"codex","execution_policy":{"mode":"project_pool"},
        "model_policy":{"mode":"fixed","model":{"runtime":"codex","provider":"test","model_id":"removed"}}});
    let result = assessment::assessment_model(
        &agent,
        &json!({"models":[{"runtime":"codex","provider":"test","model_id":"default","is_default":true}]}),
        "runner-a",
    );
    assert!(result.is_err());
}

#[test]
fn assessment_does_not_replace_a_non_codex_leader_with_a_codex_default() {
    let agent = json!({"runtime":"claude_code"});
    let error = assessment::assessment_model(&agent, &json!({}), "runner-a").unwrap_err();
    assert_eq!(error.code, "unsupported_runtime");
}

#[tokio::test]
async fn queued_assessment_rechecks_the_existing_leaders_model_configuration_before_start() {
    let (_directory, handler, store, target, source, event) = routing_fixture().await;
    let snapshot = assess(&store, &target, &source, &event);
    let state = store.project_router_state(&target).unwrap();
    let context = handler
        .current_project_router_context(&target)
        .await
        .unwrap();
    let request: ExecutionRequest = serde_json::from_value(json!({
        "task_id":state["batch"]["taskId"],"ephemeral":true,"enable_tools":false,"user_id":7,
        "projectLeaderVersion":LocalTaskStore::coordination_event_version(&context["agent"]),
        "origin":{"type":"project_assessment","contextId":context_id(&target),"batchId":snapshot["id"],"userId":7,"deviceId":"runner-a"}
    })).unwrap();
    handler
        .validate_project_router_assessment(&request)
        .await
        .unwrap();
    let agent = &context["agent"];
    store.update_chat_agent(target["projectId"].as_str().unwrap(), agent["id"].as_str().unwrap(),
        serde_json::from_value(json!({"version":agent["version"],"model_policy":{"mode":"fixed","model":{"runtime":"codex","provider":"test","model_id":"replacement"}}})).unwrap()).unwrap();
    let error = handler
        .validate_project_router_assessment(&request)
        .await
        .unwrap_err();
    assert!(error.contains("configuration changed"));
}

async fn routing_fixture() -> (
    tempfile::TempDir,
    RuntimeWorkRpcHandler,
    LocalTaskStore,
    Value,
    Value,
    Value,
) {
    let (directory, handler, store, payload, _) = fixture();
    let binding = store
        .project_coordination_binding(payload["projectId"].as_str().unwrap(), "group")
        .unwrap();
    let target = target(
        "local",
        payload["projectId"].as_str().unwrap(),
        "group",
        &binding,
        "runner-a",
    );
    store.register_project_router_target(&target).unwrap();
    let (source, events) = handler
        .project_router_source_events(&store, &target)
        .await
        .unwrap();
    assert_eq!(events.len(), 1);
    (directory, handler, store, target, source, events[0].clone())
}

fn assess(store: &LocalTaskStore, target: &Value, source: &Value, event: &Value) -> Value {
    store.project_router_wake(target).unwrap();
    let snapshot = store
        .project_router_snapshot(target, source, std::slice::from_ref(event))
        .unwrap();
    let plan = json!({"snapshotId":snapshot["id"],"actions":[{"kind":"assess","eventIds":[event["id"]]}],"assessmentInstructions":"Only classify shared project inputs.","nextWakeAt":null});
    store.commit_project_router_plan(target, &plan).unwrap();
    snapshot
}

fn dispatch_output(event: &Value) -> Value {
    json!({"decisions":[{"kind":"dispatch_issue","eventIds":[event["id"]],"issueId":event["issueId"],"reason":"Shared work requires the existing group","at":null}]})
}

#[test]
fn project_assessment_payload_selects_an_isolated_workspace_inside_execution_request() {
    let request: ExecutionRequest = serde_json::from_value(
        json!({"task_id":"assessment","ephemeral":true,"enable_tools":false}),
    )
    .unwrap();
    let payload = assessment::assessment_payload(
        request,
        &json!({"userId":7}),
        &json!({"id":"batch","taskId":"assessment"}),
        "runner-a",
        "command",
    );
    let request = execution_request(&payload).unwrap();
    assert!(is_standalone_chat_workspace(&request));
    assert!(request.ephemeral);
    assert_eq!(request.extra["enable_tools"], false);
    assert_eq!(request.extra["user_id"], 7);
    assert_eq!(request.extra["origin"]["batchId"], "batch");
}

#[tokio::test]
async fn router_native_assessment_requires_exact_actor_batch_and_read_only_request() {
    let (_directory, handler, store, target, source, event) = routing_fixture().await;
    let snapshot = assess(&store, &target, &source, &event);
    let state = store.project_router_state(&target).unwrap();
    let context = handler
        .current_project_router_context(&target)
        .await
        .unwrap();
    let request: ExecutionRequest = serde_json::from_value(json!({
        "projectLeaderVersion":LocalTaskStore::coordination_event_version(&context["agent"]),
        "task_id":state["batch"]["taskId"],"ephemeral":true,"enable_tools":false,"user_id":7,
        "origin":{"type":"project_assessment","contextId":context_id(&target),"batchId":snapshot["id"],"userId":7,"deviceId":"runner-a"}
    })).unwrap();
    handler
        .validate_project_router_assessment(&request)
        .await
        .unwrap();
    for (key, value) in [("user_id", json!(99)), ("enable_tools", json!(true))] {
        let mut forged = request.clone();
        forged.extra.insert(key.into(), value);
        assert!(handler
            .validate_project_router_assessment(&forged)
            .await
            .is_err());
        handler.record_project_router_assessment(
            &forged,
            Ok(&ExecutionOutcome::Completed {
                content: dispatch_output(&event).to_string(),
            }),
        );
        assert!(store.project_router_state(&target).unwrap()["batch"]["decisions"].is_null());
    }
    handler.record_project_router_assessment(
        &request,
        Ok(&ExecutionOutcome::Completed {
            content: dispatch_output(&event).to_string(),
        }),
    );
    assert_eq!(
        store.project_router_state(&target).unwrap()["batch"]["status"],
        "dispatching"
    );
    handler
        .advance_project_router_batch(&store, &target)
        .await
        .unwrap();
    assert!(store.project_router_state(&target).unwrap()["batch"].is_null());
}

#[tokio::test]
async fn router_assessment_cannot_start_after_binding_is_stopped() {
    let (_directory, handler, store, target, source, event) = routing_fixture().await;
    let snapshot = assess(&store, &target, &source, &event);
    let state = store.project_router_state(&target).unwrap();
    let request: ExecutionRequest = serde_json::from_value(json!({
        "task_id":state["batch"]["taskId"],"ephemeral":true,"enable_tools":false,"user_id":7,
        "origin":{"type":"project_assessment","contextId":context_id(&target),"batchId":snapshot["id"],"userId":7,"deviceId":"runner-a"}
    })).unwrap();
    store
        .set_project_coordination_binding(
            target["projectId"].as_str().unwrap(),
            "group",
            7,
            "runner-a",
            &json!({"enabled":false,"expectedGeneration":target["binding"]["generation"]}),
        )
        .unwrap();
    assert!(handler
        .validate_project_router_assessment(&request)
        .await
        .unwrap_err()
        .contains("stopped"));
    assert!(handler.project_router_contexts(&store).await["contexts"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(handler
        .advance_project_router_batch(&store, &target)
        .await
        .is_err());
    assert_eq!(
        store.project_router_state(&target).unwrap()["batch"]["status"],
        "failed"
    );
    assert!(!project_processing_due(
        &store.project_router_state(&target).unwrap()
    ));
}

#[tokio::test]
async fn router_archived_issue_does_not_block_new_shared_work() {
    let (_directory, handler, store, target, source, event) = routing_fixture().await;
    let snapshot = assess(&store, &target, &source, &event);
    store
        .finish_project_router_assessment(
            &target,
            snapshot["id"].as_str().unwrap(),
            &dispatch_output(&event),
        )
        .unwrap();
    let project = target["projectId"].as_str().unwrap();
    let issue = event["issueId"].as_str().unwrap();
    store
        .update_task(
            project,
            issue,
            serde_json::from_value(
                json!({"version":event["issue"]["version"],"status":"completed"}),
            )
            .unwrap(),
        )
        .unwrap();
    store.archive_task(project, issue).unwrap();
    let new_issue = store
        .create_task(
            project,
            serde_json::from_value(json!({"title":"New shared work"})).unwrap(),
        )
        .unwrap();
    handler
        .advance_project_router_batch(&store, &target)
        .await
        .unwrap();
    assert!(store.project_router_state(&target).unwrap()["batch"].is_null());
    let (source, events) = handler
        .project_router_source_events(&store, &target)
        .await
        .unwrap();
    let snapshot = store
        .project_router_snapshot(&target, &source, &events)
        .unwrap();
    assert_eq!(snapshot["events"].as_array().unwrap().len(), 1);
    assert_eq!(snapshot["events"][0]["issueId"], new_issue.id);
}

#[tokio::test]
async fn router_retains_decisions_and_recovers_actual_queue_receipts_without_duplicate_work() {
    let (_directory, handler, store, target, source, event) = routing_fixture().await;
    let snapshot = assess(&store, &target, &source, &event);
    store
        .finish_project_router_assessment(
            &target,
            snapshot["id"].as_str().unwrap(),
            &dispatch_output(&event),
        )
        .unwrap();
    let state = store.project_router_state(&target).unwrap();
    let effect = &state["batch"]["effects"][0];
    // Simulate a successful admission followed by a crash before saving its receipt.
    let request = json!({"userId":7,"projectStore":"local","projectId":target["projectId"],"groupId":"group","commandId":effect["commandId"],"input":effect["input"]});
    let receipt = handler
        .project_coordination_command(
            "runtime.project_coordinator.command.dispatch",
            request.clone(),
        )
        .await
        .unwrap();
    assert_eq!(receipt["accepted"], true);
    handler
        .advance_project_router_batch(&store, &target)
        .await
        .unwrap();
    assert!(store.project_router_state(&target).unwrap()["batch"].is_null());
    assert_eq!(
        handler
            .project_coordination_command("runtime.project_coordinator.command.get", request)
            .await
            .unwrap(),
        receipt
    );
    let connection = rusqlite::Connection::open(store.path()).unwrap();
    let count: i64 = connection
        .query_row("SELECT COUNT(*) FROM loop_item_executions", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(count, 1);
    assert!(handler.local_task_links(true).is_empty());
}

#[tokio::test]
async fn router_does_not_admit_stale_issue_and_refreshes_retained_inputs() {
    let (_directory, handler, store, target, source, event) = routing_fixture().await;
    let snapshot = assess(&store, &target, &source, &event);
    store
        .finish_project_router_assessment(
            &target,
            snapshot["id"].as_str().unwrap(),
            &dispatch_output(&event),
        )
        .unwrap();
    let id = event["issueId"].as_str().unwrap();
    store
        .update_task(
            target["projectId"].as_str().unwrap(),
            id,
            serde_json::from_value(
                json!({"version":event["issue"]["version"],"title":"Changed before admission"}),
            )
            .unwrap(),
        )
        .unwrap();
    handler
        .advance_project_router_batch(&store, &target)
        .await
        .unwrap();
    let state = store.project_router_state(&target).unwrap();
    assert!(state["batch"].is_null());
    assert_eq!(state["lastBatch"]["effects"][0]["status"], "stale");
    assert_eq!(state["force"], true);
    let (source, events) = handler
        .project_router_source_events(&store, &target)
        .await
        .unwrap();
    let fresh = store
        .project_router_snapshot(&target, &source, &events)
        .unwrap();
    assert!(fresh["events"]
        .as_array()
        .unwrap()
        .iter()
        .all(|event| event["issue"]["title"] == "Changed before admission"));
    let count: i64 = rusqlite::Connection::open(store.path())
        .unwrap()
        .query_row("SELECT COUNT(*) FROM loop_item_executions", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn router_enforces_source_window_and_deferral_even_when_plugin_plan_is_forged() {
    let (_directory, _handler, store, target, source, event) = routing_fixture().await;
    let snapshot = store
        .project_router_snapshot(&target, &source, std::slice::from_ref(&event))
        .unwrap();
    let plan = json!({"snapshotId":snapshot["id"],"actions":[{"kind":"assess","eventIds":[event["id"]]}],"assessmentInstructions":"Classify shared inputs","force":true});
    assert!(store
        .commit_project_router_plan(&target, &plan)
        .unwrap_err()
        .to_string()
        .contains("not due"));
    let snapshot = assess(&store, &target, &source, &event);
    let at = (chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339();
    store.finish_project_router_assessment(&target, snapshot["id"].as_str().unwrap(), &json!({"decisions":[{"kind":"defer","eventIds":[event["id"]],"reason":"Wait for published input","at":at}]})).unwrap();
    store.settle_project_router_batch(&target).unwrap();
    store.project_router_wake(&target).unwrap();
    let snapshot = store
        .project_router_snapshot(&target, &source, std::slice::from_ref(&event))
        .unwrap();
    assert!(store.commit_project_router_plan(&target, &json!({"snapshotId":snapshot["id"],"actions":[{"kind":"assess","eventIds":[event["id"]]}],"assessmentInstructions":"Classify"})).is_err());
}

#[tokio::test]
async fn router_rejects_incomplete_model_output_atomically() {
    let (_directory, _handler, store, target, source, event) = routing_fixture().await;
    let snapshot = assess(&store, &target, &source, &event);
    let before = store.project_router_state(&target).unwrap();
    assert!(store
        .finish_project_router_assessment(
            &target,
            snapshot["id"].as_str().unwrap(),
            &json!({"decisions":[]})
        )
        .is_err());
    assert_eq!(store.project_router_state(&target).unwrap(), before);
}

#[tokio::test]
async fn router_generation_journals_survive_late_registration_and_callbacks() {
    let (_directory, handler, store, target, source, event) = routing_fixture().await;
    let snapshot = assess(&store, &target, &source, &event);
    let mut replacement = target.clone();
    replacement["binding"]["generation"] = json!("replacement-generation");
    store.register_project_router_target(&replacement).unwrap();
    assess(&store, &replacement, &source, &event);
    let before = store.project_router_state(&replacement).unwrap();
    assert_eq!(before["batch"]["status"], "pending");
    store.register_project_router_target(&target).unwrap();
    assert_ne!(context_id(&target), context_id(&replacement));
    // Late completion belongs to its old generation's private journal. It may
    // persist there, but must never reset the replacement generation's batch.
    store
        .finish_project_router_assessment(
            &target,
            snapshot["id"].as_str().unwrap(),
            &dispatch_output(&event),
        )
        .unwrap();
    assert!(handler
        .current_project_router_source(&replacement)
        .await
        .is_err());
    assert_eq!(store.project_router_state(&replacement).unwrap(), before);
}

#[tokio::test]
async fn project_processing_status_checks_current_owner_and_filters_inaccessible_questions() {
    let (_directory, handler, store, target, source, event) = routing_fixture().await;
    let snapshot = assess(&store, &target, &source, &event);
    store.finish_project_router_assessment(&target,snapshot["id"].as_str().unwrap(),&json!({"decisions":[{"kind":"ask","eventIds":[event["id"]],"reason":"What is the acceptance criterion?","at":null}]})).unwrap();
    store.settle_project_router_batch(&target).unwrap();
    let payload = json!({"userId":7,"projectStore":"local","projectId":target["projectId"],"groupId":"group"});
    let status = handler
        .dispatch_method(
            "runtime.project_coordinator.processing.get",
            payload.clone(),
        )
        .await
        .unwrap();
    assert_eq!(status["questions"].as_object().unwrap().len(), 1);
    let mut other = payload.clone();
    other["userId"] = json!(8);
    assert_eq!(
        handler
            .dispatch_method("runtime.project_coordinator.processing.check", other)
            .await
            .unwrap_err()
            .code,
        "stale_context"
    );
    let project = target["projectId"].as_str().unwrap();
    let issue = event["issueId"].as_str().unwrap();
    store
        .update_task(
            project,
            issue,
            serde_json::from_value(
                json!({"version":event["issue"]["version"],"status":"completed"}),
            )
            .unwrap(),
        )
        .unwrap();
    store.archive_task(project, issue).unwrap();
    let status = handler
        .dispatch_method("runtime.project_coordinator.processing.check", payload)
        .await
        .unwrap();
    assert!(status["questions"].as_object().unwrap().is_empty());
    assert_eq!(store.project_router_state(&target).unwrap()["force"], true);
    let (source, events) = handler
        .project_router_source_events(&store, &target)
        .await
        .unwrap();
    assert_eq!(
        store
            .project_router_snapshot(&target, &source, &events)
            .unwrap()["skip"],
        true
    );
    assert!(!project_processing_due(
        &store.project_router_state(&target).unwrap()
    ));
}

#[test]
fn project_shared_payload_excludes_private_runtime_and_agent_configuration() {
    let original = json!({"id":"issue","title":"Shared","description":"Published","version":2,"metadata":{"private_chat":"PRIVATE_CANARY"},"runtime_handle":{"token":"PRIVATE_CANARY"},"model_policy":"PRIVATE_CANARY","prompt":"PRIVATE_CANARY"});
    assert!(!shared_issue(&original)
        .to_string()
        .contains("PRIVATE_CANARY"));
    assert!(!shared_participant(&original)
        .to_string()
        .contains("PRIVATE_CANARY"));
    assert!(!shared_comment(&original)
        .to_string()
        .contains("PRIVATE_CANARY"));
}

#[test]
fn project_processing_polls_sources_at_window_or_due_time_but_advances_pending_batches() {
    let now = chrono::Utc::now();
    assert!(!project_processing_due(
        &json!({"lastCheckAt":now.to_rfc3339()})
    ));
    assert!(project_processing_due(
        &json!({"lastCheckAt":now.to_rfc3339(),"nextWakeAt":(now-chrono::Duration::seconds(1)).to_rfc3339()})
    ));
    assert!(project_processing_due(
        &json!({"batch":{"status":"dispatching"}})
    ));
    assert!(!project_processing_due(
        &json!({"batch":{"status":"failed"}})
    ));
}
