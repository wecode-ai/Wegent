use super::*;

#[test]
fn archive_unfinished_subtree_preserves_statuses_and_restores_every_child() {
    let directory = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
    let project = store
        .create_project(serde_json::from_value(json!({"name":"Archive"})).unwrap())
        .unwrap();
    let parent = store
        .create_task(
            &project.id,
            serde_json::from_value(json!({"title":"Parent","status":"in_progress"})).unwrap(),
        )
        .unwrap();
    let child = store
        .create_task(
            &project.id,
            serde_json::from_value(json!({"title":"Child","parent_id":parent.id,"status":"inbox"}))
                .unwrap(),
        )
        .unwrap();
    let grandchild = store
        .create_task(
            &project.id,
            serde_json::from_value(
                json!({"title":"Grandchild","parent_id":child.id,"status":"in_review"}),
            )
            .unwrap(),
        )
        .unwrap();
    store.archive_task(&project.id, &parent.id).unwrap();
    assert!(store.list_tasks(&project.id).unwrap().is_empty());
    assert!(store.restore_task(&project.id, &child.id).is_err());
    store.restore_task(&project.id, &parent.id).unwrap();
    let tasks = store.list_tasks(&project.id).unwrap();
    assert_eq!(tasks.len(), 3);
    for original in [&parent, &child, &grandchild] {
        let restored = tasks.iter().find(|task| task.id == original.id).unwrap();
        assert_eq!(restored.status, original.status);
        assert_eq!(restored.parent_id, original.parent_id);
    }
}

#[test]
fn archive_cancels_unstarted_child_executions_transactionally() {
    for status in ["queued", "waiting_runtime"] {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
        let project = store
            .create_project(serde_json::from_value(json!({"name":"Archive queued work"})).unwrap())
            .unwrap();
        let parent = store
            .create_task(
                &project.id,
                serde_json::from_value(json!({"title":"Parent"})).unwrap(),
            )
            .unwrap();
        let child = store
            .create_task(
                &project.id,
                serde_json::from_value(json!({"title":"Child","parent_id":parent.id})).unwrap(),
            )
            .unwrap();
        let agent = store
            .create_chat_agent(
                &project.id,
                serde_json::from_value(
                    json!({"name":"Robot","runtime":"codex","execution_mode":"auto"}),
                )
                .unwrap(),
            )
            .unwrap();
        let execution = store
            .enqueue_execution(
                &project.id,
                &child.id,
                &agent.id,
                json!({"message":"work"}),
                None,
            )
            .unwrap();
        store
            .connection()
            .unwrap()
            .execute(
                "UPDATE loop_item_executions SET status=?1 WHERE id=?2",
                params![status, execution.id],
            )
            .unwrap();
        store.archive_task(&project.id, &parent.id).unwrap();
        let execution = execution_row(&store.connection().unwrap(), execution.id).unwrap();
        assert_eq!(execution.status, "cancelled");
        assert_eq!(
            execution.execution_note,
            "Issue was archived before the run finished"
        );
    }
}

#[test]
fn archive_live_subtree_refusal_rolls_back_queued_cancellations() {
    let directory = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
    let project = store
        .create_project(serde_json::from_value(json!({"name":"Live subtree"})).unwrap())
        .unwrap();
    let parent = store
        .create_task(
            &project.id,
            serde_json::from_value(json!({"title":"Parent"})).unwrap(),
        )
        .unwrap();
    let child = store
        .create_task(
            &project.id,
            serde_json::from_value(json!({"title":"Child","parent_id":parent.id})).unwrap(),
        )
        .unwrap();
    let agent = store
        .create_chat_agent(
            &project.id,
            serde_json::from_value(
                json!({"name":"Robot","runtime":"codex","execution_mode":"auto"}),
            )
            .unwrap(),
        )
        .unwrap();
    let queued = store
        .enqueue_execution(
            &project.id,
            &parent.id,
            &agent.id,
            json!({"message":"queued"}),
            None,
        )
        .unwrap();
    let active = store
        .enqueue_execution(
            &project.id,
            &child.id,
            &agent.id,
            json!({"message":"active"}),
            None,
        )
        .unwrap();
    store.connection().unwrap().execute("UPDATE loop_item_executions SET status='running', start_requested_at='2026-11-04T12:00:00Z' WHERE id=?1", params![active.id]).unwrap();
    assert!(store.archive_task(&project.id, &parent.id).is_err());
    assert_eq!(store.list_tasks(&project.id).unwrap().len(), 2);
    let connection = store.connection().unwrap();
    assert_eq!(
        execution_row(&connection, queued.id).unwrap().status,
        "queued"
    );
    assert_eq!(
        execution_row(&connection, active.id).unwrap().status,
        "running"
    );
}
