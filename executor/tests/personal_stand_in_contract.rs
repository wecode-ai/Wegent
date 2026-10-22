use serde_json::{json, Value};
use wegent_executor::task_runtime::{personal_stand_in::role_project_matches, LocalTaskStore};

fn role(id: &str) -> Value {
    json!({"id":id,"name":id,"enabled":true,"prompt":"Review the task","executionDeviceId":"mac","version":0,
        "collaboration":{"enabled":true,"allProjects":true,"projects":[],"excludedProjects":[],"tags":[]}})
}

#[test]
fn personal_roles_cover_existing_and_future_projects_and_respect_exclusions() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
    let mut value = store.personal_stand_in(7, "mac").unwrap();
    value["roles"] = json!([role("default"), role("review")]);
    value["roles"][1]["collaboration"]["tags"] = json!(["review"]);
    value["roles"][0]["collaboration"]["excludedProjects"] =
        json!([{"id":"private","store":"cloud"}]);
    let saved = store
        .save_personal_stand_in(7, "mac", value.clone())
        .unwrap();
    assert!(role_project_matches(&saved["roles"][0], "future", "local"));
    assert!(role_project_matches(&saved["roles"][0], "future", "cloud"));
    assert!(!role_project_matches(
        &saved["roles"][0],
        "private",
        "cloud"
    ));
    assert!(role_project_matches(&saved["roles"][0], "private", "local"));
    assert!(role_project_matches(&saved["roles"][1], "private", "cloud"));
    assert!(store.save_personal_stand_in(7, "mac", value).is_err());
    assert_eq!(store.personal_stand_in(7, "mac").unwrap(), saved);
    assert_eq!(store.personal_stand_in(8, "mac").unwrap()["version"], 0);
}

#[test]
fn reorder_and_unrelated_edits_preserve_enable_time_and_failures_are_atomic() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
    let mut value = store.personal_stand_in(7, "mac").unwrap();
    value["roles"] = json!([role("development"), role("review")]);
    let first = store.save_personal_stand_in(7, "mac", value).unwrap();
    let mut reordered = first.clone();
    reordered["roles"].as_array_mut().unwrap().reverse();
    reordered["autoSelect"] = json!(true);
    let second = store.save_personal_stand_in(7, "mac", reordered).unwrap();
    assert_eq!(second["roles"][0]["id"], "review");
    assert_eq!(
        second["roles"][0]["enabledAfter"],
        first["roles"][1]["enabledAfter"]
    );
    for invalid in [
        json!([]),
        json!([role("duplicate"), role("duplicate")]),
        json!([{"id":"missing-fields"}]),
    ] {
        let mut bad = second.clone();
        bad["roles"] = invalid;
        assert!(store.save_personal_stand_in(7, "mac", bad).is_err());
        assert_eq!(store.personal_stand_in(7, "mac").unwrap(), second);
    }
    assert!(store
        .save_personal_stand_in(7, "other-device", second.clone())
        .is_err());
}

#[test]
fn migration_preserves_project_scopes_agent_permissions_and_assignment_cutoff() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("tasks.sqlite");
    let store = LocalTaskStore::open(&path).unwrap();
    let connection = rusqlite::Connection::open(&path).unwrap();
    let timestamp = "2026-10-22T06:54:17Z";
    for project in ["first", "second"] {
        let old = json!({"id":"default","name":project,"projectId":project,"projectStore":"cloud","userId":7,
            "enabled":true,"prompt":"Review","executionDeviceId":"mac","version":4,"enabledAfter":timestamp,
            "agentId":"project-reviewer","tags":["review"]});
        connection.execute("INSERT INTO loop_items (id,resource_type,metadata,created_at,updated_at) VALUES (?1,'stand_in_settings',?2,?3,?3)",
            rusqlite::params![format!("stand_in:{project}:7:default"),old.to_string(),timestamp]).unwrap();
    }
    let personal = store.personal_stand_in(7, "mac").unwrap();
    let roles = personal["roles"].as_array().unwrap();
    assert_eq!(roles.len(), 2);
    assert_ne!(roles[0]["id"], roles[1]["id"]);
    assert_eq!(personal["executionDeviceId"], "mac");
    for (index, project) in ["first", "second"].into_iter().enumerate() {
        assert_eq!(roles[index]["enabledAfter"], timestamp);
        assert_eq!(roles[index]["version"], 4);
        assert!(role_project_matches(&roles[index], project, "cloud"));
        assert!(!role_project_matches(&roles[index], "unrelated", "cloud"));
        let mut broadened = roles[index].clone();
        broadened["collaboration"]["allProjects"] = json!(true);
        assert!(!role_project_matches(&broadened, "unrelated", "cloud"));
    }
    let remaining: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM loop_items WHERE resource_type='stand_in_settings'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(remaining, 0);
    assert_eq!(store.personal_stand_in(7, "mac").unwrap(), personal);
}

#[test]
fn project_agent_selection_cannot_expand_to_another_project() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
    let mut settings = store.personal_stand_in(7, "mac").unwrap();
    let mut selected = role("review");
    selected["agentId"] = json!("reviewer");
    selected["agentProject"] = json!({"id":"owning-project","store":"cloud"});
    settings["roles"] = json!([selected]);
    let saved = store.save_personal_stand_in(7, "mac", settings).unwrap();
    assert_eq!(saved["roles"][0]["collaboration"]["allProjects"], false);
    assert_eq!(
        saved["roles"][0]["collaboration"]["projects"],
        json!([{"id":"owning-project","store":"cloud"}])
    );
    assert!(role_project_matches(
        &saved["roles"][0],
        "owning-project",
        "cloud"
    ));
    assert!(!role_project_matches(
        &saved["roles"][0],
        "other-project",
        "cloud"
    ));
    assert!(!role_project_matches(
        &saved["roles"][0],
        "owning-project",
        "local"
    ));
}

#[test]
fn failed_selection_is_owner_and_version_scoped_and_retry_invalidates_it() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
    let settings = store.personal_stand_in(7, "mac").unwrap();
    store.save_stand_in_decision("decision", &json!({"userId":7,"version":0,"issueId":"issue","title":"Review","error":"invalid output"})).unwrap();
    assert_eq!(
        store.stand_in_selection_errors(7, &json!(0)).unwrap().len(),
        1
    );
    assert!(store
        .stand_in_selection_errors(8, &json!(0))
        .unwrap()
        .is_empty());
    let updated = store.save_personal_stand_in(7, "mac", settings).unwrap();
    assert!(store
        .stand_in_selection_errors(7, &updated["version"])
        .unwrap()
        .is_empty());
    assert!(store.stand_in_decision("decision").unwrap().is_some());
}
