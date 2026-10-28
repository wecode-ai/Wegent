use super::*;

#[tokio::test]
async fn deleted_stand_in_is_not_replayed_during_or_after_background_cleanup() {
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.store = RuntimeWorkStore::new(root.path().join("runtime-index.json"));
    handler.worktrees = WorktreeManager::new(root.path().join("worktrees.json"));
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    let mut config = json!({"id":"review","projectId":"project","projectStore":"local","userId":7,"workspace":{"projectKey":"unregistered-project"}});
    let issue = json!({"id":"issue"});
    let binding = json!({"humanAssignmentId":"human"});
    let task_id = handler.stand_in_task_id(&config, &binding);
    handler.upsert_local_task(RuntimeTaskLink {
        local_task_id: task_id.clone(),
        status: "archived".into(),
        ..RuntimeTaskLink::default()
    });
    handler
        .store
        .mark_deleted_archived_task_ids([task_id.clone()]);
    for cleanup_finished in [false, true] {
        if cleanup_finished {
            handler.store.delete_task(&task_id);
        }
        for manual in [false, true] {
            config["manual"] = json!(manual);
            for already_bound in [false, true] {
                handler
                    .execute_stand_in_task(&config, &issue, &binding, already_bound)
                    .await
                    .unwrap();
            }
        }
        assert!(handler.store.is_deleted_archived_task_id(&task_id));
        assert_eq!(
            handler.local_task_link(&task_id).is_none(),
            cleanup_finished
        );
    }
    config["manual"] = json!(false);
    let reassigned = json!({"humanAssignmentId":"new-human-assignment"});
    assert_ne!(handler.stand_in_task_id(&config, &reassigned), task_id);
    let error = handler
        .execute_stand_in_task(&config, &issue, &reassigned, false)
        .await
        .unwrap_err();
    assert_eq!(
        error.code, "workspace_unavailable",
        "A new assignment must reach execution preparation"
    );
}

#[tokio::test]
async fn manual_delegation_does_not_report_a_deleted_task_as_running() {
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.store = RuntimeWorkStore::new(root.path().join("runtime-index.json"));
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let project = store
        .create_project(serde_json::from_value(json!({"name":"Deleted work"})).unwrap())
        .unwrap();
    let issue = store
        .create_task(
            &project.id,
            serde_json::from_value(json!({"title":"Deleted work","assignee_user_id":7})).unwrap(),
        )
        .unwrap();
    store
        .save_stand_in_settings(
            &project.id,
            7,
            json!({"id":"review","projectStore":"local","executionDeviceId":"mac","version":0,"enabled":true,"prompt":"Review carefully"}),
        )
        .unwrap();
    let task_id = format!("stand-in-{}-1-review", issue.id);
    handler.upsert_local_task(RuntimeTaskLink {
        local_task_id: task_id.clone(),
        status: "archived".into(),
        ..RuntimeTaskLink::default()
    });
    handler.store.mark_deleted_archived_task_ids([task_id]);
    let error = handler.run_stand_in(json!({"projectId":project.id,"issueId":issue.id,"userId":7,"projectStore":"local","standInId":"review"})).await.unwrap_err();
    assert_eq!(error.code, "assignment_already_handled");
}
