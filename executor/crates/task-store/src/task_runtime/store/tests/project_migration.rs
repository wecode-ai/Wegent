use super::*;

fn migration_issue(store: &LocalTaskStore, project: &str) -> LoopItem {
    store
        .create_task(
            project,
            TaskCreate {
                milestone_id: None,
                title: "Shared work".into(),
                description: "Shared description".into(),
                status: "inbox".into(),
                priority: "medium".into(),
                parent_id: None,
                tags: vec![],
                assignee_user_id: None,
                assignee_agent_id: None,
                assignee_group_id: None,
                workflow: None,
            },
        )
        .unwrap()
}
fn migration_comment(store: &LocalTaskStore, project: &str, issue: &str) {
    store
        .create_comment(&LocalCommentCreate {
            project_id: project.into(),
            task_id: issue.into(),
            client_message_id: None,
            sender_type: "user".into(),
            sender_id: "0".into(),
            sender_name: "Owner".into(),
            content: "A newly written comment".into(),
            metadata: json!({}),
            reply_to_message_id: None,
        })
        .unwrap();
}

#[test]
fn migration_archive_rejects_concurrent_comments_and_keeps_the_source_open() {
    let (_directory, store, project) = chat_agent_store();
    let issue = migration_issue(&store, &project.id);
    let snapshot = store.project_migration_snapshot(&project.id).unwrap();
    migration_comment(&store, &project.id, &issue.id);
    assert!(matches!(
        store.archive_migrated_project(
            &project.id,
            snapshot.version,
            &snapshot.fingerprint,
            "cloud-target"
        ),
        Err(TaskRuntimeError::VersionConflict)
    ));
    assert!(
        !store
            .project_migration_snapshot(&project.id)
            .unwrap()
            .archived
    );
    assert_eq!(
        store
            .list_comments(&project.id, &issue.id, 0)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn migration_archive_is_atomic_and_records_durable_recovery_without_deleting_shared_rows() {
    let (_directory, store, project) = chat_agent_store();
    let issue = migration_issue(&store, &project.id);
    migration_comment(&store, &project.id, &issue.id);
    store
        .bind_task(
            &project.id,
            Some(&issue.id),
            None,
            RuntimeTaskAddress {
                device_id: "local-device".into(),
                task_id: "private-session".into(),
                task_title: Some("Private work".into()),
                backend_task_id: None,
                model_selection: Some(json!({"modelName":"private-local-model"})),
                execution_context: Some(json!({"workspacePath":"/local/private-worktree"})),
                workflow_node_id: None,
            },
            None,
        )
        .unwrap();
    let private_binding =
        serde_json::to_value(store.list_task_bindings(&issue.id).unwrap()).unwrap();
    let snapshot = store.project_migration_snapshot(&project.id).unwrap();
    store
        .archive_migrated_project(
            &project.id,
            snapshot.version,
            &snapshot.fingerprint,
            "cloud-target",
        )
        .unwrap();
    let archived = store.project_migration_snapshot(&project.id).unwrap();
    assert!(archived.archived);
    assert_eq!(archived.migration_target.as_deref(), Some("cloud-target"));
    assert_eq!(
        archived.migration_fingerprint.as_deref(),
        Some(snapshot.fingerprint.as_str())
    );
    assert_eq!(
        store
            .list_comments(&project.id, &issue.id, 0)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        serde_json::to_value(store.list_task_bindings(&issue.id).unwrap()).unwrap(),
        private_binding
    );
    let connection = store.connection().unwrap();
    let deleted: Option<String> = connection
        .query_row(
            "SELECT deleted_at FROM loop_items WHERE id=?1",
            [&issue.id],
            |row| row.get(0),
        )
        .unwrap();
    assert!(deleted.is_none());
}
