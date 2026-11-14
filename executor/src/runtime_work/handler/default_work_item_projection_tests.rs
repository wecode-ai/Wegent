use super::*;

const DEFAULT_PROJECT: &str = "default-work-items";

#[tokio::test]
async fn default_work_item_binding_uses_the_handler_store_path() {
    let (handler, root) = isolated_runtime_work_handler("default-work-item-store");
    handler.upsert_local_task(RuntimeTaskLink {
        local_task_id: "runtime-task-1".into(),
        runtime: "codex".into(),
        title: "Executor-owned Issue".into(),
        ..Default::default()
    });

    handler
        .track_default_work_item_async(
            "runtime-task-1".into(),
            "Executor-owned Issue".into(),
            "Created after runtime acceptance".into(),
        )
        .expect("persistent business work should be projected")
        .await
        .unwrap();

    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let binding = store
        .find_system_task_binding("device-1", "runtime-task-1")
        .unwrap();
    assert_eq!(binding.task_title.as_deref(), Some("Executor-owned Issue"));
    assert_eq!(binding.task_user_id, 0);
    assert_eq!(store.list_tasks(DEFAULT_PROJECT).unwrap().len(), 1);

    handler
        .track_default_work_item_async(
            "runtime-task-1".into(),
            "Updated title".into(),
            "Do not duplicate the Issue".into(),
        )
        .unwrap()
        .await
        .unwrap();
    let existing = store
        .find_system_task_binding("device-1", "runtime-task-1")
        .unwrap();
    assert_eq!(existing.id, binding.id);
    assert_eq!(existing.loop_item_id, binding.loop_item_id);
    assert_eq!(existing.task_title.as_deref(), Some("Updated title"));
    assert_eq!(store.list_tasks(DEFAULT_PROJECT).unwrap().len(), 1);
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn default_work_item_projection_excludes_identity_conversations_and_ephemeral_tasks() {
    let (handler, root) = isolated_runtime_work_handler("conversation-no-default-issue");
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let project = store
        .create_project(serde_json::from_value(json!({"name":"Shared project"})).unwrap())
        .unwrap();
    let issue = store
        .create_task(
            &project.id,
            serde_json::from_value(json!({"title":"Existing Issue"})).unwrap(),
        )
        .unwrap();
    let bound = store
        .bind_task(
            &project.id,
            Some(&issue.id),
            None,
            serde_json::from_value(json!({"deviceId":"device-1","taskId":"issue-conversation"}))
                .unwrap(),
            None,
        )
        .unwrap();
    for (task, origin, ephemeral) in [
        (
            "primary-conversation",
            json!({"type":"stand_in_identity","initiatedBy":"stand_in_identity","userId":7}),
            false,
        ),
        (
            "role-conversation",
            json!({"type":"stand_in_identity","initiatedBy":"stand_in_identity","userId":7,"standInId":"default"}),
            false,
        ),
        (
            "coordinator-conversation",
            json!({"type":"stand_in_coordinator","userId":7}),
            false,
        ),
        (
            "issue-conversation",
            json!({"type":"issue_dispatch","initiatedBy":"stand_in","userId":7,"cloudProjectId":project.id,"loopItemId":issue.id}),
            false,
        ),
        ("temporary-task", json!({}), true),
    ] {
        handler.upsert_local_task(RuntimeTaskLink {
            local_task_id: task.into(),
            runtime: "codex".into(),
            title: "Private conversation".into(),
            runtime_handle: json!({"origin":origin}),
            ephemeral,
            ..Default::default()
        });

        assert!(
            handler
                .track_default_work_item_async(task.into(), "Conversation".into(), "Private".into())
                .is_none(),
            "{task} must not schedule a business Issue write"
        );
        assert!(handler.local_task_link(task).is_some());
    }

    assert!(store.list_tasks(DEFAULT_PROJECT).unwrap().is_empty());
    let bindings = store.list_task_bindings(&issue.id).unwrap();
    assert_eq!(bindings.len(), 1);
    assert_eq!(bindings[0].id, bound.id);
    assert_eq!(bindings[0].task_id, "issue-conversation");
    assert_eq!(bindings[0].task_user_id, bound.task_user_id);
    assert_eq!(store.list_tasks(&project.id).unwrap().len(), 1);
    let _ = fs::remove_dir_all(root);
}
