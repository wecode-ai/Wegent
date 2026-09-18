use serde_json::{json, Value};
use wegent_executor::local::app_ipc::AppIpcServer;

#[tokio::test]
async fn task_projects_join_local_space_once_without_resurrecting_archived_projects() {
    let home = tempfile::tempdir().unwrap();
    let codex_home = tempfile::tempdir().unwrap();
    std::env::set_var("WEGENT_EXECUTOR_HOME", home.path());
    std::env::set_var("CODEX_HOME", codex_home.path());
    let server = AppIpcServer::new();
    let existing = server
        .dispatch("projects.create", json!({"name":"Existing"}))
        .await
        .unwrap();
    std::fs::write(codex_home.path().join(".codex-global-state.json"), json!({
        "local-projects": {
            "product": {"name":"Product"},
            "other": {"name":"Product"},
            "bound": {"name":"Bound", "defaultProjectSpace": {
                "projectStore":"local", "projectId":existing["id"]
            }}
        },
        "project-writable-roots": {
            "product":[{"path":"/work/product"}, {"path":"/work/shared"}],
            "other":[{"path":"/work/other"}],
            "bound":[{"path":"/work/bound"}]
        },
        "remote-projects": [{"id":"remote", "label":"Remote", "hostId":"server-1", "remotePath":"/remote"}]
    }).to_string()).unwrap();
    let projects = server.dispatch("projects.list", json!({})).await.unwrap();
    let imported: Vec<&Value> = projects
        .as_array()
        .unwrap()
        .iter()
        .filter(|project| project["metadata"]["code_project_key"].is_string())
        .collect();
    assert_eq!(imported.len(), 2);
    assert_ne!(imported[0]["id"], imported[1]["id"]);
    let product = imported
        .iter()
        .find(|project| project["metadata"]["code_project_key"] == "product")
        .unwrap();
    assert_eq!(
        product["metadata"]["workspace_roots"],
        json!(["/work/product", "/work/shared"])
    );
    assert!(!projects
        .as_array()
        .unwrap()
        .iter()
        .any(|project| project["name"] == "Remote"));
    assert_eq!(projects.as_array().unwrap().len(), 4);
    let repeated = server.dispatch("projects.list", json!({})).await.unwrap();
    assert_eq!(projects, repeated);
    let first = imported[0];
    let issue = server.dispatch("todos.create", json!({
        "project_id":first["id"], "todo":{"title":"Real issue", "description":"Preserve this"}
    })).await.unwrap();
    assert!(issue["id"].is_string());
    let assigned = server
        .dispatch(
            "todos.update",
            json!({
                "project_id":first["id"], "task_id":issue["id"],
                "todo":{"version":issue["version"], "assignee_user_id":7}
            }),
        )
        .await
        .unwrap();
    assert_eq!(assigned["assignee_user_id"], 7);
    let persisted = server
        .dispatch(
            "todos.get",
            json!({
                "project_id":first["id"], "task_id":issue["id"]
            }),
        )
        .await
        .unwrap();
    assert_eq!(persisted["assignee_user_id"], 7);
    let cleared = server
        .dispatch(
            "todos.update",
            json!({
                "project_id":first["id"], "task_id":issue["id"],
                "todo":{"version":persisted["version"], "assignee_user_id":null}
            }),
        )
        .await
        .unwrap();
    assert!(cleared["assignee_user_id"].is_null());
    let catalog = server.dispatch("projects.list", json!({})).await.unwrap();
    let project_version = catalog.as_array().unwrap().iter().find(|project| project["id"] == first["id"]).unwrap()["version"].clone();
    server.dispatch("projects.update", json!({"project_id": first["id"], "project": {
        "version": project_version, "collaboration_groups": [{"id":"squad-1", "name":"Delivery team"}]
    }})).await.unwrap();
    let grouped = server.dispatch("todos.update", json!({"project_id":first["id"], "task_id":issue["id"], "todo":{
        "version":cleared["version"], "assignee_group_id":"squad-1"
    }})).await.unwrap();
    assert_eq!(grouped["metadata"]["collaboration_group"]["id"], "squad-1");
    assert!(grouped["assignee_user_id"].is_null());
    let invalid = server.dispatch("todos.update", json!({"project_id":first["id"], "task_id":issue["id"], "todo":{
        "version":grouped["version"], "assignee_group_id":"other-project-group"
    }})).await;
    assert!(invalid.is_err());
    let restored = server.dispatch("todos.update", json!({"project_id":first["id"], "task_id":issue["id"], "todo":{
        "version":grouped["version"], "assignee_user_id":7
    }})).await.unwrap();
    assert!(restored["metadata"]["collaboration_group"].is_null());
    assert_eq!(restored["assignee_user_id"], 7);
    server.dispatch("projects.list", json!({})).await.unwrap();
    let issues = server
        .dispatch("todos.list", json!({"project_id":first["id"]}))
        .await
        .unwrap();
    assert_eq!(issues[0]["id"], issue["id"]);
    let current = server.dispatch("projects.list", json!({})).await.unwrap();
    let first = current
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == first["id"])
        .unwrap();
    server
        .dispatch(
            "projects.archive",
            json!({"project_id":first["id"], "version":first["version"]}),
        )
        .await
        .unwrap();
    let remaining = server.dispatch("projects.list", json!({})).await.unwrap();
    assert!(!remaining
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["id"] == first["id"]));
}
