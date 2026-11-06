//! Source-scoped reviewer selection and one-time native confirmation regression tests.
use super::*;

#[test]
fn personal_delegation_is_not_rebound_to_an_unrelated_project_confirmation_policy() {
    let (_root, handler, _store, _settings, _request) = source_confirmation_fixture();
    let mut request:ExecutionRequest=serde_json::from_value(json!({
        "origin":{"type":"stand_in_task","initiatedBy":"stand_in","userId":7,"standInId":"@primary","askBeforeAct":false}
    })).unwrap();
    handler
        .refresh_stand_in_confirmation(&request.task_id.clone(), &mut request)
        .unwrap();
    assert!(!crate::runtime_work::stand_in_requires_confirmation(
        &request
    ));
    request.extra.get_mut("origin").unwrap()["askBeforeAct"] = json!(true);
    handler
        .refresh_stand_in_confirmation(&request.task_id.clone(), &mut request)
        .unwrap();
    assert!(crate::runtime_work::stand_in_requires_confirmation(
        &request
    ));
}

fn original_source_task(request: &mut ExecutionRequest) -> RuntimeTaskLink {
    request.extra.insert("user_id".into(), json!(7));
    request.model_config = json!({"model_id":"original-model"});
    request.project_workspace_path = Some("/original-workspace".into());
    request.runtime_workspace_roots = vec!["/original-workspace".into()];
    request.prompt = json!("Original source contents must not be replayed");
    RuntimeTaskLink {
        local_task_id: request.task_id.clone(),
        runtime: "codex".into(),
        thread_id: Some("original-thread".into()),
        workspace_path: "/original-workspace".into(),
        runtime_handle: json!({"origin":request.extra["origin"],"executionRequest":request}),
        ..Default::default()
    }
}

#[test]
fn one_time_confirmation_keeps_the_original_task_and_does_not_replay_sent_messages() {
    let (_root, handler, store, _settings, mut request) = source_confirmation_fixture();
    let id = request.task_id.clone();
    let work = store.stand_in_work(7, &id).unwrap();
    let ids = store
        .stand_in_messages(7, &id)
        .unwrap()
        .iter()
        .map(|message| message["recordId"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    store
        .update_stand_in_dispatch(7, &id, &ids, "sent", None)
        .unwrap();
    let original = original_source_task(&mut request);
    handler.upsert_local_task(original.clone());
    let mut prepared = handler
        .confirmed_connection_request(&store, 7, &work, &original)
        .unwrap();
    assert_eq!(prepared.task_id, id);
    assert_eq!(prepared.model_config, request.model_config);
    assert_eq!(
        prepared.project_workspace_path,
        request.project_workspace_path
    );
    assert_eq!(
        prepared.runtime_workspace_roots,
        request.runtime_workspace_roots
    );
    assert_eq!(prepared.extra["standInManualConfirmation"], true);
    assert_eq!(prepared.extra["origin"]["askBeforeAct"], true);
    assert_eq!(prepared.extra["origin"]["manual"], true);
    assert_eq!(prepared.prompt, CONFIRM_CONNECTION_WORK_ONCE);
    assert_ne!(prepared.prompt, request.prompt);
    assert_eq!(
        handler.local_task_link(&id).unwrap().thread_id,
        original.thread_id
    );
    assert_eq!(
        store.stand_in_messages(7, &id).unwrap()[0]["dispatchStatus"],
        "sent"
    );
    assert_eq!(
        store.personal_stand_in(7, "mac").unwrap()["roles"][0]["connections"][0]["policy"]
            ["askBeforeAct"],
        false
    );
    prepared.extra.remove("standInManualConfirmation");
    prepared
        .extra
        .insert("standInAutomatic".into(), json!(true));
    handler
        .refresh_stand_in_confirmation(&prepared.task_id.clone(), &mut prepared)
        .unwrap();
    assert_eq!(prepared.extra["origin"]["manual"], false);
    assert_eq!(prepared.extra["origin"]["askBeforeAct"], false);
    assert_eq!(prepared.extra["standInDelegation"]["askBeforeAct"], false);
}

#[test]
fn one_time_confirmation_allows_paused_automatic_handling_but_not_a_removed_source() {
    let (_root, handler, store, mut settings, mut request) = source_confirmation_fixture();
    let work = store.stand_in_work(7, &request.task_id).unwrap();
    let original = original_source_task(&mut request);
    settings["roles"][0]["enabled"] = json!(false);
    settings["roles"][0]["connections"][0]["policy"]["automatic"] = json!(false);
    settings = store.save_personal_stand_in(7, "mac", settings).unwrap();
    let prepared = handler
        .confirmed_connection_request(&store, 7, &work, &original)
        .unwrap();
    assert_eq!(prepared.extra["origin"]["askBeforeAct"], true);
    let mut waiting = original.clone();
    waiting.interaction_status = Some("waitingForApproval".into());
    assert_eq!(
        handler
            .confirmed_connection_request(&store, 7, &work, &waiting)
            .unwrap_err()
            .code,
        "work_awaiting_user"
    );
    settings["roles"][0]["connections"]
        .as_array_mut()
        .unwrap()
        .remove(0);
    store.save_personal_stand_in(7, "mac", settings).unwrap();
    assert_eq!(
        handler
            .confirmed_connection_request(&store, 7, &work, &original)
            .unwrap_err()
            .code,
        "source_removed"
    );
}

fn source_confirmation_fixture() -> (
    tempfile::TempDir,
    RuntimeWorkRpcHandler,
    LocalTaskStore,
    Value,
    ExecutionRequest,
) {
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    handler.store = RuntimeWorkStore::new(root.path().join("runtime.json"));
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let source = |id, ask| json!({"providerId":crate::task_runtime::personal_stand_in::DINGTALK_PROVIDER,"profile":"corp","kind":"group","id":id,"name":id,"policy":{"automatic":true,"askBeforeAct":ask,"immediate":false}});
    let mut settings = store.personal_stand_in(7, "mac").unwrap();
    settings["roles"][0]["enabled"] = json!(true);
    settings["roles"][0]["connections"] =
        json!([source("group-a", false), source("group-b", true)]);
    let settings = store.save_personal_stand_in(7, "mac", settings).unwrap();
    let work = store
        .ingest_stand_in_message(
            7,
            "default",
            &source("group-a", false),
            &json!({"id":"a-message","text":"Please reply"}),
            None,
        )
        .unwrap();
    let id = work["id"].as_str().unwrap();
    let messages = store.stand_in_messages(7, id).unwrap();
    let mut request = ExecutionRequest {
        task_id: id.into(),
        ..Default::default()
    };
    request.extra.insert("origin".into(), json!({"initiatedBy":"stand_in","type":"connection_work","userId":7,"deviceId":"mac","standInId":"default","workId":id,"askBeforeAct":true}));
    request.extra.insert("standInAutomatic".into(), json!(true));
    request.extra.insert(
        "standInDelegation".into(),
        json!({"userId":7,"sourceTaskId":"primary","askBeforeAct":true}),
    );
    request.extra.insert(
        "standInSourceBindings".into(),
        json!([{"recordId":messages[0]["recordId"],"source":messages[0]["source"]}]),
    );
    (root, handler, store, settings, request)
}

#[test]
fn source_confirmation_uses_the_host_task_address_for_local_execution() {
    let (_root, handler, _store, _settings, mut request) = source_confirmation_fixture();
    let local_task_id = request.task_id.clone();
    request.task_id.clear();
    request.subtask_id.clear();
    handler
        .refresh_stand_in_confirmation(&local_task_id, &mut request)
        .unwrap();
    assert_eq!(request.extra["origin"]["askBeforeAct"], false);
    assert_eq!(request.extra["standInDelegation"]["askBeforeAct"], false);
}

#[test]
fn source_confirmation_rejects_a_different_host_task_address() {
    let (_root, handler, _store, _settings, mut request) = source_confirmation_fixture();
    let claimed_task_id = request.task_id.clone();
    request
        .extra
        .insert("runtimeLocalTaskId".into(), json!(claimed_task_id));
    assert_eq!(
        handler
            .refresh_stand_in_confirmation("different-host-task", &mut request)
            .unwrap_err()
            .code,
        "source_removed"
    );
    assert_eq!(request.extra["origin"]["askBeforeAct"], true);
}

#[tokio::test]
async fn manual_source_followup_restores_host_bindings_before_queueing() {
    let (root, mut handler, _store, _settings, mut request) = source_confirmation_fixture();
    handler.turn_queue_path = Arc::new(root.path().join("turn-queue.json"));
    handler.worktrees = WorktreeManager::new(root.path().join("worktrees.json"));
    handler.turn_scheduler.lock().unwrap().queued_turns.clear();
    handler
        .refresh_stand_in_confirmation(&request.task_id.clone(), &mut request)
        .unwrap();
    let original = original_source_task(&mut request);
    let id = original.local_task_id.clone();
    handler.upsert_local_task(original);
    let (cancel, _cancelled) = tokio::sync::oneshot::channel();
    let (_stopped, stopped) = tokio::sync::oneshot::channel();
    let execution = handler.start_local_task_execution(id.clone(), cancel, stopped);
    let response = handler
        .send_message(json!({
            "taskId":id, "message":"Try another way", "queueIfBusy":true,
            "executionRequest":{"prompt":"Try another way"}
        }))
        .await
        .unwrap();
    assert_eq!(response["accepted"], true, "{response}");
    assert_eq!(response["status"], "queued");
    {
        let scheduler = handler.turn_scheduler.lock().unwrap();
        let queued = scheduler.queued_turns.front().unwrap();
        assert_eq!(queued.local_task_id, id);
        assert_eq!(
            queued.request.extra["standInSourceBindings"],
            request.extra["standInSourceBindings"]
        );
        assert_eq!(queued.request.extra["origin"]["askBeforeAct"], false);
    }
    assert!(handler.remove_queued_turn(&id).await.unwrap());
    assert!(handler.finish_local_task_execution(&id, execution));
}

#[tokio::test]
async fn manual_source_followup_cannot_replace_a_missing_host_binding() {
    let (_root, handler, _store, _settings, mut request) = source_confirmation_fixture();
    let supplied_bindings = request.extra.remove("standInSourceBindings").unwrap();
    let original = original_source_task(&mut request);
    let id = original.local_task_id.clone();
    handler.upsert_local_task(original);
    let error = handler.send_message(json!({
        "taskId":id, "message":"Try another way",
        "executionRequest":{"prompt":"Try another way","standInSourceBindings":supplied_bindings}
    })).await.unwrap_err();
    assert_eq!(error.code, "source_removed");
    assert_eq!(handler.queued_local_task_position(&id), None);
}

#[tokio::test]
async fn manual_source_followup_rechecks_live_authorization_after_restoring_bindings() {
    let (_root, handler, store, mut settings, mut request) = source_confirmation_fixture();
    let original = original_source_task(&mut request);
    let id = original.local_task_id.clone();
    handler.upsert_local_task(original);
    settings["roles"][0]["connections"][0]["policy"]["automatic"] = json!(false);
    store.save_personal_stand_in(7, "mac", settings).unwrap();
    let error = handler
        .send_message(json!({
            "taskId":id, "message":"Try another way",
            "executionRequest":{"prompt":"Try another way"}
        }))
        .await
        .unwrap_err();
    assert_eq!(error.code, "source_removed");
    assert_eq!(handler.queued_local_task_position(&id), None);
}

#[test]
fn source_confirmation_uses_only_the_current_work_and_live_authorization() {
    let (_root, handler, store, mut settings, mut request) = source_confirmation_fixture();
    handler
        .refresh_stand_in_confirmation(&request.task_id.clone(), &mut request)
        .unwrap();
    assert_eq!(request.extra["origin"]["askBeforeAct"], false);
    assert_eq!(request.extra["standInDelegation"]["askBeforeAct"], false);
    let source_b = settings["roles"][0]["connections"][1].clone();
    let work_b = store
        .ingest_stand_in_message(
            7,
            "default",
            &source_b,
            &json!({"id":"b-message","text":"Needs confirmation"}),
            None,
        )
        .unwrap();
    let messages_b = store
        .stand_in_messages(7, work_b["id"].as_str().unwrap())
        .unwrap();
    let mut request_b = request.clone();
    request_b.task_id = work_b["taskId"].as_str().unwrap().into();
    request_b.extra.get_mut("origin").unwrap()["workId"] = work_b["id"].clone();
    request_b.extra.insert(
        "standInSourceBindings".into(),
        json!([{"recordId":messages_b[0]["recordId"],"source":messages_b[0]["source"]}]),
    );
    handler
        .refresh_stand_in_confirmation(&request_b.task_id.clone(), &mut request_b)
        .unwrap();
    assert_eq!(request_b.extra["origin"]["askBeforeAct"], true);
    settings["roles"][0]["connections"][0]["policy"]["askBeforeAct"] = json!(true);
    settings = store.save_personal_stand_in(7, "mac", settings).unwrap();
    handler
        .refresh_stand_in_confirmation(&request.task_id.clone(), &mut request)
        .unwrap();
    assert_eq!(request.extra["origin"]["askBeforeAct"], true);
    assert_eq!(request.extra["standInDelegation"]["askBeforeAct"], true);
    settings["roles"][0]["connections"][0]["policy"]["askBeforeAct"] = json!(false);
    store.save_personal_stand_in(7, "mac", settings).unwrap();
    handler
        .refresh_stand_in_confirmation(&request.task_id.clone(), &mut request)
        .unwrap();
    assert_eq!(request.extra["origin"]["askBeforeAct"], false);
    assert_eq!(request.extra["standInDelegation"]["askBeforeAct"], false);
}

#[test]
fn source_confirmation_rejects_removed_or_paused_sources_before_resuming() {
    let (_root, handler, store, mut settings, mut request) = source_confirmation_fixture();
    settings["roles"][0]["connections"][0]["policy"]["automatic"] = json!(false);
    settings = store.save_personal_stand_in(7, "mac", settings).unwrap();
    assert_eq!(
        handler
            .refresh_stand_in_confirmation(&request.task_id.clone(), &mut request)
            .unwrap_err()
            .code,
        "source_removed"
    );
    settings["roles"][0]["connections"]
        .as_array_mut()
        .unwrap()
        .remove(0);
    store.save_personal_stand_in(7, "mac", settings).unwrap();
    assert_eq!(
        handler
            .refresh_stand_in_confirmation(&request.task_id.clone(), &mut request)
            .unwrap_err()
            .code,
        "source_removed"
    );
}

#[test]
fn source_confirmation_cannot_be_downgraded_using_forged_or_missing_binding_fields() {
    let (_root, handler, _store, settings, mut request) = source_confirmation_fixture();
    let original = request.extra["standInSourceBindings"].clone();
    request.extra.get_mut("standInSourceBindings").unwrap()[0]["source"] =
        settings["roles"][0]["connections"][1].clone();
    assert_eq!(
        handler
            .refresh_stand_in_confirmation(&request.task_id.clone(), &mut request)
            .unwrap_err()
            .code,
        "source_removed"
    );
    request
        .extra
        .insert("standInSourceBindings".into(), original);
    request.extra.get_mut("standInSourceBindings").unwrap()[0]["recordId"] =
        json!("invented-message");
    assert_eq!(
        handler
            .refresh_stand_in_confirmation(&request.task_id.clone(), &mut request)
            .unwrap_err()
            .code,
        "source_removed"
    );
    request.extra.remove("standInSourceBindings");
    assert_eq!(
        handler
            .refresh_stand_in_confirmation(&request.task_id.clone(), &mut request)
            .unwrap_err()
            .code,
        "source_removed"
    );
}

#[test]
fn collection_partition_changes_do_not_change_existing_work_authority_or_live_confirmation() {
    let (_root, handler, store, mut settings, mut request) = source_confirmation_fixture();
    settings["roles"][0]["connections"][0]["collectionKey"] = json!("selected:first");
    settings["roles"][0]["connections"][0]["policy"]["askBeforeAct"] = json!(true);
    settings = store.save_personal_stand_in(7, "mac", settings).unwrap();
    handler
        .refresh_stand_in_confirmation(&request.task_id.clone(), &mut request)
        .unwrap();
    assert!(crate::runtime_work::stand_in_requires_confirmation(
        &request
    ));
    settings["roles"][0]["connections"][0]["collectionKey"] = json!("selected:second");
    settings["roles"][0]["connections"][0]["policy"]["askBeforeAct"] = json!(false);
    settings = store.save_personal_stand_in(7, "mac", settings).unwrap();
    handler
        .refresh_stand_in_confirmation(&request.task_id.clone(), &mut request)
        .unwrap();
    assert!(!crate::runtime_work::stand_in_requires_confirmation(
        &request
    ));
    settings["roles"][0]["connections"] = json!([]);
    store.save_personal_stand_in(7, "mac", settings).unwrap();
    assert_eq!(
        handler
            .refresh_stand_in_confirmation(&request.task_id.clone(), &mut request)
            .unwrap_err()
            .code,
        "source_removed"
    );
}
