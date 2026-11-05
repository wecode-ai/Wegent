use serde_json::json;
use wegent_executor::local::app_ipc::AppIpcServer;

#[tokio::test]
async fn issue_identity_and_follow_survive_reload_and_stay_independent_of_assignment() {
    let home = tempfile::tempdir().unwrap();
    let codex_home = tempfile::tempdir().unwrap();
    std::env::set_var("WEGENT_EXECUTOR_HOME", home.path());
    std::env::set_var("CODEX_HOME", codex_home.path());
    let server = AppIpcServer::new();
    let project = server
        .dispatch("projects.create", json!({"name":"Identity"}))
        .await
        .unwrap();
    let issue = server
        .dispatch(
            "todos.create",
            json!({
                "project_id": project["id"], "actor_user_id": 17,
                "todo": {"title": "Unassigned"}
            }),
        )
        .await
        .unwrap();
    assert_eq!(issue["created_by_user_id"], 17);
    assert_eq!(issue["metadata"]["reporter_user_id"], 17);
    assert!(issue["assignee_user_id"].is_null());

    server
        .dispatch(
            "todos.follow",
            json!({
                "project_id":project["id"], "task_id":issue["id"], "user_id":17, "following":true
            }),
        )
        .await
        .unwrap();
    let saved = server
        .dispatch(
            "todos.get",
            json!({
                "project_id":project["id"], "task_id":issue["id"]
            }),
        )
        .await
        .unwrap();
    assert_eq!(saved["metadata"]["follower_user_ids"], json!([17]));
    assert!(saved["assignee_user_id"].is_null());
    assert_eq!(saved["version"], issue["version"]);
    server
        .dispatch(
            "todos.comment.create",
            json!({"comment": {
                "project_id": project["id"], "task_id": issue["id"], "sender_type":"user",
                "sender_id":"17", "sender_name":"User", "content":"Hello", "metadata":{}
            }}),
        )
        .await
        .unwrap();
    let updated = server
        .dispatch(
            "todos.update",
            json!({
                "project_id":project["id"], "task_id":issue["id"],
                "todo":{"version":saved["version"], "status":"in_progress", "assignee_user_id":17}
            }),
        )
        .await
        .unwrap();
    assert!(server
        .dispatch(
            "todos.update",
            json!({
                "project_id":project["id"], "task_id":issue["id"], "actor_user_id":18,
                "todo":{"version":updated["version"], "reporter_user_id":19}
            })
        )
        .await
        .is_err());
    let reporter_updated = server
        .dispatch(
            "todos.update",
            json!({
                "project_id":project["id"], "task_id":issue["id"], "actor_user_id":18,
                "todo":{"version":updated["version"], "reporter_user_id":18}
            }),
        )
        .await
        .unwrap();
    assert_eq!(reporter_updated["created_by_user_id"], 17);
    assert_eq!(reporter_updated["metadata"]["reporter_user_id"], 18);
    let notifications = server
        .dispatch("todos.notifications.list", json!({"user_id":17}))
        .await
        .unwrap();
    assert_eq!(notifications.as_array().unwrap().len(), 3);
    for event in ["comment", "status", "assignee"] {
        assert!(notifications
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n["payload"]["event"] == event));
    }
    assert!(server
        .dispatch("todos.notifications.list", json!({"user_id":18}))
        .await
        .unwrap()
        .as_array()
        .unwrap()
        .is_empty());
    server
        .dispatch(
            "todos.notifications.read",
            json!({"user_id":17, "notification_id":notifications[0]["id"]}),
        )
        .await
        .unwrap();
    let read = server
        .dispatch("todos.notifications.list", json!({"user_id":17}))
        .await
        .unwrap();
    assert!(read
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["id"] == notifications[0]["id"])
        .unwrap()["read_at"]
        .is_string());
    server
        .dispatch(
            "todos.follow",
            json!({
                "project_id":project["id"], "task_id":issue["id"], "user_id":17, "following":false
            }),
        )
        .await
        .unwrap();
    let saved = server
        .dispatch(
            "todos.get",
            json!({
                "project_id":project["id"], "task_id":issue["id"]
            }),
        )
        .await
        .unwrap();
    assert_eq!(saved["metadata"]["follower_user_ids"], json!([]));
    assert_eq!(saved["created_by_user_id"], 17);
    assert_eq!(saved["metadata"]["reporter_user_id"], 18);
    server.dispatch("todos.update", json!({"project_id":project["id"], "task_id":issue["id"], "todo":{"version":reporter_updated["version"], "status":"completed"}})).await.unwrap();
    let after_unfollow = server
        .dispatch("todos.notifications.list", json!({"user_id":17}))
        .await
        .unwrap();
    assert_eq!(after_unfollow.as_array().unwrap().len(), 3);
}
