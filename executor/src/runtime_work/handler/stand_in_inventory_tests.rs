use super::*;

#[tokio::test]
async fn authorized_inventory_survives_read_capacity_and_conversations_are_read_on_demand() {
    use super::super::tests::{install_native_history, isolated_runtime_work_handler};
    use crate::task_runtime::mcp::StandInMcpIdentity;
    let (mut handler, root) = isolated_runtime_work_handler("coordinator-metadata-inventory");
    handler.task_store_path = Arc::new(root.join("tasks.sqlite"));
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let mut settings = store.personal_stand_in(7, "device-1").unwrap();
    settings["primary"] = json!({"enabled":true,"prompt":"","preferences":""});
    let settings = store
        .save_personal_stand_in(7, "device-1", settings)
        .unwrap();
    let target = "authorized-delegate";
    for (id, user) in [(target, 7), ("unlisted-owned", 7), ("foreign", 8)] {
        handler.upsert_local_task(RuntimeTaskLink {local_task_id:id.into(),runtime:"codex".into(),thread_id:Some("thread-1".into()),status:"done".into(),title:"Existing delegated work".into(),runtime_handle:json!({"origin":{"type":"stand_in_task","initiatedBy":"stand_in","userId":user,"deviceId":"device-1","standInId":"@primary","sourceTaskId":"stand-in-chat-7-primary"},"executionRequest":{"user_id":user}}),..Default::default()});
    }
    install_native_history(
        &mut handler,
        &root,
        vec![
            json!({"id":"original-turn","status":"completed","startedAt":chrono::Utc::now().timestamp(),"items":[{"id":"answer","type":"agentMessage","phase":"final_answer","text":"Verified delegated result","createdAt":chrono::Utc::now().timestamp()}]}),
        ],
        None,
    );
    let permits = handler
        .transcript_test_workers
        .as_ref()
        .unwrap()
        .clone()
        .acquire_many_owned(2)
        .await
        .unwrap();
    let inventory = handler
        .coordination_works(&store, 7, &settings)
        .await
        .unwrap();
    assert!(
        inventory.iter().any(|work| work["taskId"] == target),
        "Read capacity must not remove an authorized work from the batch inventory"
    );
    assert!(inventory
        .iter()
        .all(|work| work.get("transcript").is_none()));
    assert!(
        !root.join("requests.jsonl").exists(),
        "Inventory must not issue eager native transcript RPCs"
    );
    handler.upsert_local_task(RuntimeTaskLink {local_task_id:task_id(7),runtime_handle:json!({"origin":{"type":"stand_in_coordinator","userId":7,"deviceId":"device-1","batchId":"current"},"executionRequest":{"user_id":7}}),..Default::default()});
    let mut state = json!({"batchId":"current","snapshot":{"works":inventory.into_iter().filter(|work|work["taskId"]==target).collect::<Vec<_>>()}});
    store.save_stand_in_processing_state(7, &state).unwrap();
    let identity = StandInMcpIdentity {
        task_id: task_id(7),
        user: 7,
        device: "device-1".into(),
        role: None,
        work: None,
        project: None,
        review: false,
        memory_review: false,
        readonly_worker: false,
        ask_before_act: false,
        coordinator_batch: Some("current".into()),
    };
    let args = json!({"taskId":target,"limit":3});
    let mut queued = Box::pin(handler.read_stand_in_conversations(&identity, "read_task", &args));
    assert!(futures_util::poll!(queued.as_mut()).is_pending());
    assert_eq!(
        handler
            .read_stand_in_conversations(
                &identity,
                "read_task",
                &json!({"taskId":"unlisted-owned"})
            )
            .await
            .unwrap_err()
            .code,
        "permission_denied"
    );
    drop(permits);
    let page = queued.await.unwrap();
    assert!(page["messages"]
        .to_string()
        .contains("Verified delegated result"));
    state["snapshot"]["works"]
        .as_array_mut()
        .unwrap()
        .push(json!({"taskId":"foreign"}));
    store.save_stand_in_processing_state(7, &state).unwrap();
    assert_eq!(
        handler
            .read_stand_in_conversations(&identity, "read_task", &json!({"taskId":"foreign"}))
            .await
            .unwrap_err()
            .code,
        "permission_denied"
    );
    state["batchId"] = json!("replaced");
    store.save_stand_in_processing_state(7, &state).unwrap();
    assert_eq!(
        handler
            .read_stand_in_conversations(&identity, "read_task", &args)
            .await
            .unwrap_err()
            .code,
        "permission_denied"
    );
    handler
        .codex_app_server
        .request("test/stop", json!({}))
        .await
        .unwrap();
    fs::remove_dir_all(root).unwrap();
}
