// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

const TASK: &str = "bound-conversation";
const THREAD: &str = "native-thread";

fn fixture(root: &Path) -> (RuntimeWorkRpcHandler, LocalTaskStore, String, String) {
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.store = RuntimeWorkStore::new(root.join("runtime.json"));
    handler.task_store_path = Arc::new(root.join("tasks.sqlite"));
    handler.automation_store =
        crate::runtime_work::automations::AutomationStore::new(root.join("automations.json"));
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let project = store
        .create_project(serde_json::from_value(json!({"name":"Shared project"})).unwrap())
        .unwrap();
    let issue = store
        .create_task(
            &project.id,
            serde_json::from_value(json!({"title":"Existing Issue","status":"inbox"})).unwrap(),
        )
        .unwrap();
    store
        .bind_task(
            &project.id,
            Some(&issue.id),
            None,
            serde_json::from_value(json!({"deviceId":"mac","taskId":TASK})).unwrap(),
            None,
        )
        .unwrap();
    handler.upsert_local_task(RuntimeTaskLink {
        local_task_id: TASK.into(),
        thread_id: Some(THREAD.into()),
        runtime_handle: json!({"origin":{
            "type":"issue_dispatch","initiatedBy":"stand_in","publicConversation":true,
            "runtimeTaskId":TASK,"userId":7,"standInId":"review",
            "projectStore":"local","cloudProjectId":project.id,"loopItemId":issue.id
        }}),
        ..Default::default()
    });
    (handler, store, project.id, issue.id)
}

#[test]
fn private_completion_does_not_finish_a_later_automation_on_the_same_task() {
    let root = tempfile::tempdir().unwrap();
    let (handler, _, _, _) = fixture(root.path());
    let automation = handler
        .automation_store
        .create(
            serde_json::from_value(json!({
                "id":"same-conversation","version":1,"name":"Existing automation",
                "prompt":"Public work","taskPayload":{},
                "schedule":{"type":"interval","value":1,"unit":"hours"}
            }))
            .unwrap(),
        )
        .unwrap();
    let private = request(&handler, true);
    let public = request(&handler, false);
    admit(&handler, &public);
    for _ in 0..2 {
        let (_, run) = handler
            .automation_store
            .start_manual_run(&automation.id)
            .unwrap();
        handler
            .automation_store
            .mark_running(&run.id, TASK.into())
            .unwrap();
        let before = serde_json::to_value(handler.automation_store.list_runs(None)).unwrap();
        handler.finish_automation_run(TASK, &private, AutomationRunStatus::Succeeded, None);
        assert_eq!(
            serde_json::to_value(handler.automation_store.list_runs(None)).unwrap(),
            before
        );
        handler.finish_automation_run(TASK, &public, AutomationRunStatus::Succeeded, None);
        let runs = handler.automation_store.list_runs(None);
        assert!(runs
            .iter()
            .all(|run| matches!(run.status, AutomationRunStatus::Succeeded)));
    }
}

fn request(handler: &RuntimeWorkRpcHandler, private: bool) -> ExecutionRequest {
    let mut request = runtime_event_request_from_link(&handler.local_task_link(TASK).unwrap());
    super::super::util::apply_runtime_payload_metadata(
        &mut request,
        &if private {
            json!({"conversationContext":"private_discussion"})
        } else {
            json!({})
        },
    );
    request
}

fn admit(handler: &RuntimeWorkRpcHandler, request: &ExecutionRequest) {
    handler.store.update_task(TASK, |link| {
        store_runtime_execution_request(&mut link.runtime_handle, request);
    });
}

fn turn(request: ExecutionRequest) -> SpawnTurnRequest {
    SpawnTurnRequest {
        task_kind: None,
        local_task_id: TASK.into(),
        runtime: "codex".into(),
        request,
        send_payload: None,
        direct_thread_id: None,
        fork_thread_id: None,
        fork_thread_path: None,
        resume_thread_id: Some(THREAD.into()),
        initial_thread_goal: None,
    }
}

fn boundary(method: &str, turn: &str, generation: u64) -> CodexNotification {
    CodexNotification::from(json!({"method":method,"params":{
        "threadId":THREAD,"turn":{"id":turn,"status":"completed"}
    }}))
    .with_process_generation(generation)
}

fn reply(turn: &str, generation: u64, text: &str) -> CodexNotification {
    CodexNotification::from(json!({"method":"item/completed","params":{
        "threadId":THREAD,"turnId":turn,
        "item":{"id":format!("item-{text}"),"type":"agentMessage",
            "phase":"final_answer","text":text}
    }}))
    .with_process_generation(generation)
}

#[test]
fn private_queue_native_lifecycle_and_collection_leave_bound_issue_unchanged() {
    let root = tempfile::tempdir().unwrap();
    let (handler, store, project, issue) = fixture(root.path());
    let before = store.get_task(&project, &issue).unwrap();
    let private = request(&handler, true);
    handler
        .turn_scheduler
        .lock()
        .unwrap()
        .queued_turns
        .push_back(turn(private.clone()));
    let mut queued = handler.local_task_link(TASK).unwrap();
    queued.status = "queued".into();
    queued.updated_at = crate::runtime_work::util::now_ms();
    handler.upsert_local_task(queued);
    assert_eq!(
        store.get_task(&project, &issue).unwrap().version,
        before.version
    );
    handler.turn_scheduler.lock().unwrap().queued_turns.clear();
    admit(&handler, &private);

    for method in ["turn/started", "turn/completed"] {
        handler.apply_native_lifecycle(TASK, &private, &boundary(method, "private", 11));
        handler.upsert_local_task(handler.local_task_link(TASK).unwrap());
        let after = store.get_task(&project, &issue).unwrap();
        assert_eq!(after.status, before.status, "{method} changed Issue status");
        assert_eq!(after.version, before.version, "{method} wrote the Issue");
    }
    let reopened = RuntimeWorkStore::new(root.path().join("runtime.json"));
    let restored = reopened.get_task(TASK).unwrap();
    assert!(super::super::util::is_private_discussion(
        &runtime_event_request_from_link(&restored)
    ));
    assert_eq!(restored.runtime_handle["origin"], private.extra["origin"]);

    let public = request(&handler, false);
    handler
        .turn_scheduler
        .lock()
        .unwrap()
        .queued_turns
        .push_back(turn(public.clone()));
    let mut queued = handler.local_task_link(TASK).unwrap();
    queued.status = "queued".into();
    queued.running = false;
    queued.updated_at = crate::runtime_work::util::now_ms();
    handler.upsert_local_task(queued);
    handler.project_runtime_link_status_now(&handler.local_task_link(TASK).unwrap());
    assert_eq!(
        store.get_task(&project, &issue).unwrap().status.as_deref(),
        Some("pending")
    );
    handler.turn_scheduler.lock().unwrap().queued_turns.clear();
    admit(&handler, &public);
    for (method, expected) in [
        ("turn/started", "in_progress"),
        ("turn/completed", "in_review"),
    ] {
        handler.apply_native_lifecycle(TASK, &public, &boundary(method, "public", 12));
        assert_eq!(
            store.get_task(&project, &issue).unwrap().status.as_deref(),
            Some(expected)
        );
    }
    assert_eq!(store.list_task_bindings(&issue).unwrap().len(), 1);
}

#[test]
fn queued_private_followup_does_not_suppress_the_active_public_turn() {
    let root = tempfile::tempdir().unwrap();
    let (handler, store, project, issue) = fixture(root.path());
    let public = request(&handler, false);
    admit(&handler, &public);
    handler.apply_native_lifecycle(TASK, &public, &boundary("turn/started", "public", 13));
    handler
        .turn_scheduler
        .lock()
        .unwrap()
        .queued_turns
        .push_back(turn(request(&handler, true)));

    handler.project_runtime_link_status_now(&handler.local_task_link(TASK).unwrap());
    assert_eq!(
        store.get_task(&project, &issue).unwrap().status.as_deref(),
        Some("in_progress")
    );
    handler.apply_native_lifecycle(TASK, &public, &boundary("turn/completed", "public", 13));
    assert_eq!(
        store.get_task(&project, &issue).unwrap().status.as_deref(),
        Some("in_review")
    );
    assert!(!super::super::util::is_private_discussion(
        &runtime_event_request_from_link(&handler.local_task_link(TASK).unwrap())
    ));
}

#[test]
fn private_issue_dispatch_replies_never_enter_the_public_outbox_and_public_resumes() {
    let root = tempfile::tempdir().unwrap();
    let (handler, _, _, _) = fixture(root.path());
    let origin = handler.local_task_link(TASK).unwrap().runtime_handle["origin"].clone();
    let private = request(&handler, true);
    admit(&handler, &private);
    let private_started = boundary("turn/started", "private", 17);
    let private_reply = reply("private", 17, "private body");
    handler.apply_native_lifecycle(TASK, &private, &private_started);
    handler.persist_stand_in_issue_reply(TASK, &private_started);
    handler.persist_stand_in_issue_reply(TASK, &private_reply);
    let link = handler.local_task_link(TASK).unwrap();
    assert!(link.runtime_handle["standInIssueReplies"].is_null());
    assert!(link.runtime_handle["standInPublicTurn"].is_null());
    handler.apply_native_lifecycle(TASK, &private, &boundary("turn/completed", "private", 17));

    let public = request(&handler, false);
    admit(&handler, &public);
    let public_started = boundary("turn/started", "public", 18);
    handler.apply_native_lifecycle(TASK, &public, &public_started);
    handler.persist_stand_in_issue_reply(TASK, &public_started);
    handler.persist_stand_in_issue_reply(TASK, &reply("public", 18, "public body"));
    // Late private events and a former process cannot claim the new public turn.
    handler.persist_stand_in_issue_reply(TASK, &private_started);
    handler.persist_stand_in_issue_reply(TASK, &private_reply);
    handler.persist_stand_in_issue_reply(TASK, &reply("public", 17, "stale process body"));
    let reopened = RuntimeWorkStore::new(root.path().join("runtime.json"));
    let link = reopened.get_task(TASK).unwrap();
    let reports = link.runtime_handle["standInIssueReplies"]
        .as_object()
        .unwrap();
    assert_eq!(reports.len(), 1);
    assert_eq!(reports.values().next().unwrap()["body"], "public body");
    assert_eq!(link.runtime_handle["standInPublicTurn"]["turn"], "public");
    assert_eq!(link.runtime_handle["origin"], origin);
}

#[test]
fn late_private_writeback_cannot_modify_a_subsequently_admitted_public_execution() {
    use crate::runtime_work::automations::AutomationRunStatus;

    let root = tempfile::tempdir().unwrap();
    let (handler, store, project, issue) = fixture(root.path());
    let agent = store
        .create_chat_agent(
            &project,
            serde_json::from_value(json!({
                "name":"Local reviewer","runtime":"codex",
                "capability_mode":"follow_device","execution_environment":"local",
                "execution_mode":"auto","execution_device_id":"mac",
                "created_by_user_id":7
            }))
            .unwrap(),
        )
        .unwrap();
    store
        .enqueue_execution(
            &project,
            &issue,
            &agent.id,
            json!({"text":"Public work"}),
            None,
        )
        .unwrap();
    let execution = store
        .claim_next_execution_for_runtime(Some("mac"), "test-runtime", 300)
        .unwrap()
        .unwrap();
    let task = execution.runtime_task_id.as_deref().unwrap();
    store
        .request_runtime_start(execution.id, "mac", task, 300)
        .unwrap()
        .unwrap();
    store
        .confirm_runtime_accepted(execution.id, "mac", task, 300)
        .unwrap()
        .unwrap();
    let private = request(&handler, true);
    let public = request(&handler, false);
    let mut link = handler.local_task_link(TASK).unwrap();
    link.local_task_id = task.into();
    store_runtime_execution_request(&mut link.runtime_handle, &public);
    handler.upsert_local_task(link);
    let snapshot = || {
        // The active-runtime lookup excludes completed rows; inspect this exact
        // persisted execution throughout both active and terminal states.
        let persisted_execution = store
            .list_executions(&project, None, None, true)
            .unwrap()
            .into_iter()
            .find(|candidate| candidate.id == execution.id)
            .expect("the original execution must remain persisted");
        json!({
            "issue":store.get_task(&project, &issue).unwrap(),
            "execution":persisted_execution,
            "comments":store.list_comments(&project, &issue, 0).unwrap()
        })
    };
    let before = snapshot();

    // These callbacks retain the old turn's context after the public admission.
    handler.start_queue_run(task, &private);
    handler.project_queue_progress(task, "Private progress", true);
    handler.finish_queue_run(
        task,
        &private,
        AutomationRunStatus::Succeeded,
        None,
        Some("Private result".into()),
    );
    assert_eq!(snapshot(), before);

    // The same existing public execution still follows the ordinary writeback path.
    handler.start_queue_run(task, &public);
    assert_eq!(
        store
            .execution_by_runtime_task_id(task)
            .unwrap()
            .unwrap()
            .status,
        "running"
    );
    handler.store.update_task(task, |link| {
        store_runtime_execution_request(&mut link.runtime_handle, &private);
    });
    assert!(handler.runtime_task_is_private_discussion(task));
    let before_private_progress = snapshot();
    handler.project_queue_progress(task, "Private progress", true);
    assert_eq!(snapshot(), before_private_progress);

    // A captured public update remains public after the next private admission.
    handler.project_queue_progress(task, "Public progress", false);
    assert!(store
        .list_comments(&project, &issue, 0)
        .unwrap()
        .iter()
        .any(|comment| {
            comment.content == "Public progress"
                && comment.metadata["execution_id"] == execution.id
                && comment.metadata["runtime_address"]["taskId"] == task
        }));
    handler.store.update_task(task, |link| {
        store_runtime_execution_request(&mut link.runtime_handle, &public);
    });
    handler.finish_queue_run(
        task,
        &public,
        AutomationRunStatus::Succeeded,
        None,
        Some("Public result".into()),
    );
    let after = snapshot();
    assert_eq!(after["execution"]["status"], "completed");
    assert!(store.execution_by_runtime_task_id(task).unwrap().is_none());
    assert!(after["comments"]
        .as_array()
        .unwrap()
        .iter()
        .any(|comment| comment["content"] == "Public result"));
    assert!(!after.to_string().contains("Private progress"));
    assert!(!after.to_string().contains("Private result"));
}

#[tokio::test]
async fn guidance_rejects_cross_context_before_steering_the_existing_native_turn() {
    for active_private in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let (handler, store, project, issue) = fixture(root.path());
        let active_request = request(&handler, active_private);
        admit(&handler, &active_request);
        handler.apply_native_lifecycle(
            TASK,
            &active_request,
            &boundary("turn/started", "active", 21),
        );
        let before_link = handler.local_task_link(TASK).unwrap();
        let before_issue = serde_json::to_value(store.get_task(&project, &issue).unwrap()).unwrap();
        let mut payload = json!({
            "taskId":TASK,"message":"Keep this message private to its context",
            "clientGuidanceId":"context-bound-guidance"
        });
        if !active_private {
            payload["conversationContext"] = json!("private_discussion");
        }

        let result = handler.send_guidance(payload).await.unwrap();

        assert_eq!(result["accepted"], false);
        assert_eq!(result["success"], false);
        assert_eq!(result["code"], "conversation_context_mismatch");
        let after_link = handler.local_task_link(TASK).unwrap();
        assert_eq!(after_link.execution_state, before_link.execution_state);
        assert_eq!(after_link.runtime_handle, before_link.runtime_handle);
        assert_eq!(
            serde_json::to_value(store.get_task(&project, &issue).unwrap()).unwrap(),
            before_issue
        );
        assert!(store.list_comments(&project, &issue, 0).unwrap().is_empty());
    }
}
