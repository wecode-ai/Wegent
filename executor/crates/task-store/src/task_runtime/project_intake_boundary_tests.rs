use super::*;

const OLD: &str = "2020-01-01T00:00:00Z";

fn role() -> Value {
    json!({"enabled":true,"enabledAfter":OLD,"collaboration":{
        "enabled":true,"allProjects":false,"projects":[{"id":"existing","store":"local"}],
        "excludedProjects":[],"tags":[]}})
}

fn boundary(role: &Value, id: &str, store: &str) -> Value {
    project_role(role, 7, id, store)["enabledAfter"].clone()
}

#[test]
fn project_intake_new_connections_do_not_inherit_role_age_or_client_timestamps() {
    let previous = role();
    let mut next = previous.clone();
    next["collaboration"]["projects"] = json!([
        {"id":"existing","store":"local"}, {"id":"new","store":"local"},
        {"id":"new","store":"cloud"}]);
    next["projectBoundaries"] = json!([{"id":"new","store":"local","enabledAfter":OLD}]);
    stamp_project_enabled(&mut next, &previous);
    assert_eq!(boundary(&next, "existing", "local"), OLD);
    for store in ["local", "cloud"] {
        assert_ne!(boundary(&next, "new", store), OLD);
    }
    let saved = next.clone();
    next["prompt"] = json!("Updated instructions");
    stamp_project_enabled(&mut next, &saved);
    assert_eq!(next["collaboration"], saved["collaboration"]);
    assert_eq!(next["projectBoundaries"], saved["projectBoundaries"]);
}

#[test]
fn project_intake_reconnecting_and_reenabling_reset_only_affected_boundaries() {
    let previous = role();
    let mut disconnected = previous.clone();
    disconnected["collaboration"]["projects"] = json!([]);
    stamp_project_enabled(&mut disconnected, &previous);
    let mut reconnected = previous.clone();
    stamp_project_enabled(&mut reconnected, &disconnected);
    assert_ne!(boundary(&reconnected, "existing", "local"), OLD);
    for field in ["enabled", "collaboration"] {
        let mut disabled = previous.clone();
        if field == "enabled" {
            disabled["enabled"] = json!(false);
        } else {
            disabled["collaboration"]["enabled"] = json!(false);
        }
        let mut enabled = previous.clone();
        stamp_project_enabled(&mut enabled, &disabled);
        assert_ne!(boundary(&enabled, "existing", "local"), OLD);
    }
}

#[test]
fn project_intake_all_projects_preserves_existing_scope_and_resets_expanded_scope() {
    let previous = role();
    let mut all = previous.clone();
    all["collaboration"]["allProjects"] = json!(true);
    stamp_project_enabled(&mut all, &previous);
    assert_eq!(boundary(&all, "existing", "local"), OLD);
    assert_ne!(boundary(&all, "new", "local"), OLD);
    let mut excluded = all.clone();
    excluded["collaboration"]["excludedProjects"] = json!([{"id":"new","store":"local"}]);
    stamp_project_enabled(&mut excluded, &all);
    let mut restored = excluded.clone();
    restored["collaboration"]["excludedProjects"] = json!([]);
    // Establish a distinguishable old default without relying on wall-clock sleeps.
    excluded["enabledAfter"] = json!(OLD);
    stamp_project_enabled(&mut restored, &excluded);
    assert_ne!(boundary(&restored, "new", "local"), OLD);
    assert_eq!(boundary(&restored, "existing", "local"), OLD);
}

#[test]
fn project_intake_both_save_paths_persist_the_same_project_boundary() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("tasks.sqlite");
    let store = LocalTaskStore::open(&path).unwrap();
    let mut personal = store.personal_stand_in(7, "mac").unwrap();
    let mut initial = empty_role("default", "mac");
    initial["enabled"] = json!(true);
    initial["collaboration"] = role()["collaboration"].clone();
    personal["roles"] = json!([initial]);
    let saved = store.save_personal_stand_in(7, "mac", personal).unwrap();
    let old_boundary = boundary(&saved["roles"][0], "existing", "local");
    let mut config = project_role(&saved["roles"][0], 7, "new", "cloud");
    config["enabledAfter"] = json!(OLD);
    let connected = store.save_stand_in_settings("new", 7, config).unwrap();
    assert_ne!(connected["enabledAfter"], OLD);
    let reopened = LocalTaskStore::open(&path).unwrap();
    let persisted = reopened.personal_stand_in(7, "mac").unwrap();
    assert_eq!(
        boundary(&persisted["roles"][0], "new", "cloud"),
        connected["enabledAfter"]
    );
    assert_eq!(
        boundary(&persisted["roles"][0], "existing", "local"),
        old_boundary
    );
}
