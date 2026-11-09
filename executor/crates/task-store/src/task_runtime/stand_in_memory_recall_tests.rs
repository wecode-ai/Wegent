use super::*;

#[test]
fn role_memory_recall_filters_connection_accounts_and_revocation() {
    let directory = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
    store.materialize_implicit_primary(7, "mac").unwrap();
    let mut settings = store.personal_stand_in(7, "mac").unwrap();
    let source = json!({"providerId":"@example/calendar/events","profile":"a","kind":"calendar","id":"work","name":"Work","policy":{"automatic":true,"askBeforeAct":true}});
    let mut other = source.clone();
    other["profile"] = json!("b");
    settings["roles"][0]["connections"] = json!([source.clone()]);
    settings["primary"]["connections"] = json!([other.clone()]);
    store.save_personal_stand_in(7, "mac", settings).unwrap();
    let scope = super::super::personal_stand_in::connection_memory_scope(&source);
    let foreign = super::super::personal_stand_in::connection_memory_scope(&other);
    let saved = store
        .save_stand_in_memory(7, "mac", json!({"scope":scope,"content":"Own account"}))
        .unwrap();
    store
        .save_stand_in_memory(7, "mac", json!({"scope":foreign,"content":"Other account"}))
        .unwrap();
    assert_eq!(
        store
            .recall_stand_in_memories(7, "mac", Some("default"), None)
            .unwrap(),
        vec![saved]
    );
    assert!(store
        .recall_stand_in_memories(7, "mac", Some("default"), Some(&foreign))
        .unwrap()
        .is_empty());
    let mut settings = store.personal_stand_in(7, "mac").unwrap();
    settings["roles"][0]["connections"] = json!([]);
    store.save_personal_stand_in(7, "mac", settings).unwrap();
    assert!(store
        .recall_stand_in_memories(7, "mac", Some("default"), None)
        .unwrap()
        .is_empty());
    assert_eq!(store.stand_in_memories(7).unwrap().len(), 2);
}

#[test]
fn role_memory_recall_includes_own_connected_projects_without_borrowing_grants() {
    let directory = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
    let mut settings = store.personal_stand_in(7, "mac").unwrap();
    let mut role = settings["roles"][0].clone();
    role["id"] = json!("a");
    role["enabled"] = json!(false);
    role["collaboration"] = json!({"enabled":true,"allProjects":false,
        "projects":[{"id":"p","store":"local"}],"excludedProjects":[],"tags":[]});
    let mut other = role.clone();
    other["id"] = json!("b");
    other["collaboration"]["projects"] =
        json!([{"id":"q","store":"local"},{"id":"p","store":"cloud"}]);
    settings["roles"] = json!([role, other]);
    store.save_personal_stand_in(7, "mac", settings).unwrap();
    for (name, scope) in [
        ("personal", json!({"kind":"personal"})),
        ("role-a", json!({"kind":"role","roleId":"a"})),
        ("role-b", json!({"kind":"role","roleId":"b"})),
        (
            "local-p",
            json!({"kind":"project","id":"p","store":"local"}),
        ),
        (
            "local-q",
            json!({"kind":"project","id":"q","store":"local"}),
        ),
        (
            "cloud-p",
            json!({"kind":"project","id":"p","store":"cloud"}),
        ),
    ] {
        store
            .save_stand_in_memory(7, "mac", json!({"scope":scope,"content":name}))
            .unwrap();
    }
    let recall = |role, source: Option<&Value>| {
        store
            .recall_stand_in_memories(7, "mac", Some(role), source)
            .unwrap()
            .into_iter()
            .map(|row| row["content"].as_str().unwrap().to_owned())
            .collect::<std::collections::BTreeSet<_>>()
    };
    let expected = |names: &[&str]| {
        names
            .iter()
            .map(|name| name.to_string())
            .collect::<std::collections::BTreeSet<_>>()
    };
    assert_eq!(
        recall("a", None),
        expected(&["personal", "role-a", "local-p"])
    );
    assert_eq!(
        recall("b", None),
        expected(&["personal", "role-b", "local-q", "cloud-p"])
    );
    let own = json!({"kind":"project","id":"p","store":"local"});
    let foreign = json!({"kind":"project","id":"q","store":"local"});
    assert_eq!(recall("a", Some(&own)), expected(&["local-p"]));
    assert!(recall("a", Some(&foreign)).is_empty());
    let mut settings = store.personal_stand_in(7, "mac").unwrap();
    settings["roles"][0]["collaboration"]["excludedProjects"] = json!([{"id":"p","store":"local"}]);
    store.save_personal_stand_in(7, "mac", settings).unwrap();
    assert_eq!(recall("a", None), expected(&["personal", "role-a"]));
    assert!(recall("a", Some(&own)).is_empty());
    assert_eq!(store.stand_in_memories(7).unwrap().len(), 6);
}
