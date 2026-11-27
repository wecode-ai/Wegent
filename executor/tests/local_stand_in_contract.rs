use serde_json::json;
use wegent_executor::task_runtime::LocalTaskStore;

#[test]
fn project_stand_ins_keep_independent_tag_rules_and_versions() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("tasks.sqlite");
    let store = LocalTaskStore::open(&path).unwrap();
    for (id, tags) in [
        ("default", vec![]),
        ("review", vec!["review"]),
        ("docs", vec!["docs"]),
    ] {
        store.save_stand_in_settings("project", 7, json!({"id":id,"name":id,"tags":tags,"projectStore":"cloud","enabled":true,"prompt":id,"executionDeviceId":"mac","version":0})).unwrap();
    }
    let mut review = store
        .stand_in_settings("project", "cloud", 7, "review")
        .unwrap();
    review["enabled"] = json!(false);
    store.save_stand_in_settings("project", 7, review).unwrap();
    drop(store);
    let store = LocalTaskStore::open(&path).unwrap();
    assert_eq!(
        store.personal_stand_in(7, "mac").unwrap()["roles"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|role| role["enabled"] == true)
            .count(),
        2
    );
    assert_eq!(
        store
            .stand_in_settings("project", "cloud", 7, "default")
            .unwrap()["version"],
        1
    );
    assert_eq!(
        store
            .stand_in_settings("project", "cloud", 7, "review")
            .unwrap()["version"],
        2
    );
    assert_eq!(
        store
            .stand_in_settings("project", "cloud", 7, "docs")
            .unwrap()["tags"],
        json!(["docs"])
    );
}

#[test]
fn saving_from_one_project_keeps_other_project_filters() {
    let directory = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
    let project = store
        .create_project(serde_json::from_value(json!({"name":"Stand-in"})).unwrap())
        .unwrap();
    let draft = json!({
        "id": "review", "name": "Review", "projectStore": "cloud", "enabled": true,
        "prompt": "Review", "executionDeviceId": "mac", "version": 0, "tags": ["cloud-tag"]
    });
    store.save_stand_in_settings(&project.id, 7, draft).unwrap();
    let mut local = store
        .stand_in_settings(&project.id, "local", 7, "review")
        .unwrap();
    assert_eq!(local["tags"], json!([]));
    local["tags"] = json!(["local-tag"]);
    store.save_stand_in_settings(&project.id, 7, local).unwrap();

    for (kind, tag) in [("cloud", "cloud-tag"), ("local", "local-tag")] {
        let settings = store
            .stand_in_settings(&project.id, kind, 7, "review")
            .unwrap();
        assert_eq!(settings["tags"], json!([tag]));
    }
}

#[test]
fn settings_are_device_local_versioned_and_do_not_create_a_separate_execution() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("tasks.sqlite");
    let store = LocalTaskStore::open(&path).unwrap();
    let project = store
        .create_project(serde_json::from_value(json!({"name":"Stand-in"})).unwrap())
        .unwrap();
    assert_eq!(
        store
            .stand_in_settings(&project.id, "local", 7, "default")
            .unwrap()["enabled"],
        false
    );
    let input = json!({"projectStore":"local","enabled":true,"prompt":"Verify results","executionDeviceId":"mac","version":0});
    let saved = store
        .save_stand_in_settings(&project.id, 7, input.clone())
        .unwrap();
    assert!(store.save_stand_in_settings(&project.id, 7, input).is_err());
    store
        .create_task(
            &project.id,
            serde_json::from_value(json!({"title":"New","assignee_user_id":7})).unwrap(),
        )
        .unwrap();
    assert!(store
        .list_executions(&project.id, None, None, true)
        .unwrap()
        .is_empty());
    drop(store);
    let reopened = LocalTaskStore::open(&path).unwrap();
    assert_eq!(
        reopened
            .stand_in_settings(&project.id, "local", 7, "default")
            .unwrap(),
        saved
    );
    assert_eq!(
        reopened
            .stand_in_settings(&project.id, "local", 8, "default")
            .unwrap()["enabled"],
        false
    );
}

#[test]
fn cloud_settings_need_no_local_project_mirror_and_preserve_enable_time_on_edit() {
    let directory = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
    let saved = store.save_stand_in_settings("cloud-project", 7, json!({
        "projectStore":"cloud","enabled":true,"prompt":"Check","executionDeviceId":"cloud-device",
        "version":0,"enabledAfter":"untrusted-client-time"
    })).unwrap();
    assert_ne!(saved["enabledAfter"], "untrusted-client-time");
    assert!(store
        .list_projects()
        .unwrap()
        .iter()
        .all(|project| project.id != "cloud-project"));
    let mut changed = saved.clone();
    changed["prompt"] = json!("Changed");
    changed["enabledAfter"] = json!("forged");
    let mut edited = store
        .save_stand_in_settings("cloud-project", 7, changed)
        .unwrap();
    assert_eq!(edited["enabledAfter"], saved["enabledAfter"]);
    assert_eq!(
        store.personal_stand_in(7, "mac").unwrap()["roles"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|role| role["enabled"] == true)
            .count(),
        1
    );
    edited["enabled"] = json!(false);
    store
        .save_stand_in_settings("cloud-project", 7, edited)
        .unwrap();
    assert!(store.personal_stand_in(7, "mac").unwrap()["roles"]
        .as_array()
        .unwrap()
        .iter()
        .all(|role| role["enabled"] == false));
}

#[test]
fn workspace_settings_round_trip_and_reject_invalid_modes() {
    let directory = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
    let mut settings = json!({"projectStore":"cloud","enabled":false,"prompt":"","executionDeviceId":"mac","version":0,
        "workspace":{"projectKey":"repo","workspacePath":"/repo","executionMode":"git_worktree","branch":"develop"}});
    let saved = store
        .save_stand_in_settings("project", 7, settings.clone())
        .unwrap();
    assert_eq!(
        store
            .stand_in_settings("project", "cloud", 7, "default")
            .unwrap()["workspace"],
        json!({"projectKey":"repo","executionMode":"git_worktree","branch":"develop"})
    );
    settings["version"] = saved["version"].clone();
    settings["workspace"]["executionMode"] = json!("unknown");
    assert!(store
        .save_stand_in_settings("project", 7, settings.clone())
        .is_err());
    settings["workspace"]["executionMode"] = json!("current_workspace");
    settings["workspace"]["projectKey"] = json!("");
    assert!(store
        .save_stand_in_settings("project", 7, settings)
        .is_err());
}
