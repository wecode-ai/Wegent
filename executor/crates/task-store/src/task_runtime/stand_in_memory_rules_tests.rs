use super::*;

#[test]
fn legacy_fingerprints_are_owner_only_revision_checked_and_never_model_facts() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("tasks.sqlite");
    let store = LocalTaskStore::open(&path).unwrap();
    let input = json!({"scope":{"kind":"personal"},"content":"Legacy fact"});
    let id = forgotten_key(7, &input["scope"], "Legacy fact");
    let timestamp = "2026-01-01T00:00:00.000000+00:00";
    store.connection().unwrap().execute(
        "INSERT INTO loop_items(id,resource_type,metadata,created_at,updated_at) VALUES(?1,'stand_in_memory_tombstone',?2,?3,?3)",
        params![id,json!({"userId":7,"forgottenAt":timestamp}).to_string(),timestamp],
    ).unwrap();
    drop(store);
    let store = LocalTaskStore::open(&path).unwrap();
    let rows = store.stand_in_memory_rule_records(7).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["kind"], "legacy_fingerprint");
    for forbidden in ["scope", "content", "evidence", "sourceTaskId"] {
        assert!(rows[0].get(forbidden).is_none());
    }
    assert!(store.stand_in_memory_rule_records(8).unwrap().is_empty());
    assert!(store
        .recall_stand_in_memory_rules(7, "mac", None, None)
        .unwrap()
        .is_empty());
    for (user, version, revision) in [
        (8, 1, Some(timestamp)),
        (7, 0, Some(timestamp)),
        (7, 1, None),
        (7, 1, Some("stale")),
    ] {
        assert!(store
            .delete_stand_in_memory_rule(user, &id, version, revision)
            .is_err());
    }
    assert!(matches!(
        store.save_stand_in_memory(7, "mac", input.clone()),
        Err(TaskRuntimeError::MemorySuppressed)
    ));
    store
        .delete_stand_in_memory_rule(7, &id, 1, Some(timestamp))
        .unwrap();
    assert!(store.stand_in_memory_rule_records(7).unwrap().is_empty());
    store.save_stand_in_memory(7, "mac", input).unwrap();
}

#[test]
fn referenced_fingerprints_cannot_be_deleted_through_legacy_management() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
    let input = json!({"scope":{"kind":"personal"},"content":"Protected fact"});
    let saved = store.save_stand_in_memory(7, "mac", input.clone()).unwrap();
    store
        .delete_stand_in_memory(7, saved["id"].as_str().unwrap(), 1)
        .unwrap();
    let records = store.stand_in_memory_rule_records(7).unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0]["kind"], "forgetting_rule");
    let id = forgotten_key(7, &input["scope"], "Protected fact");
    let connection = store.connection().unwrap();
    let timestamp: String = connection
        .query_row(
            "SELECT json_extract(metadata,'$.forgottenAt') FROM loop_items WHERE id=?1",
            params![id],
            |row| row.get(0),
        )
        .unwrap();
    drop(connection);
    assert!(store
        .delete_stand_in_memory_rule(7, &id, 1, Some(&timestamp))
        .is_err());
    assert!(matches!(
        store.save_stand_in_memory(7, "mac", input),
        Err(TaskRuntimeError::MemorySuppressed)
    ));
}

#[test]
fn explicit_owner_restore_removes_the_matching_negative_rule_atomically() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
    let mut input = json!({"scope":{"kind":"personal"},"content":"Prefer short reports"});
    let saved = store.save_stand_in_memory(7, "mac", input.clone()).unwrap();
    store
        .delete_stand_in_memory(7, saved["id"].as_str().unwrap(), 1)
        .unwrap();
    input["restoreForgotten"] = json!(true);
    input["evidence"] = json!({"excerpt":"x".repeat(8001)});
    assert!(store.save_stand_in_memory(7, "mac", input.clone()).is_err());
    assert_eq!(store.stand_in_memory_rules(7).unwrap().len(), 1);
    input.as_object_mut().unwrap().remove("evidence");
    store.save_stand_in_memory(7, "mac", input).unwrap();
    assert!(store.stand_in_memory_rules(7).unwrap().is_empty());
}

#[test]
fn forgetting_rules_survive_restart_without_retaining_source_documents() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("tasks.sqlite");
    let store = LocalTaskStore::open(&path).unwrap();
    let input = json!({"scope":{"kind":"personal"},"content":"User prefers brief reports",
        "sourceTaskId":"private-chat","evidence":{"taskId":"private-chat","messageId":"message",
        "excerpt":"A long private source excerpt that must not be retained"}});
    let saved = store.save_stand_in_memory(7, "mac", input.clone()).unwrap();
    store
        .delete_stand_in_memory(7, saved["id"].as_str().unwrap(), 1)
        .unwrap();
    drop(store);
    let store = LocalTaskStore::open(&path).unwrap();
    assert!(store.stand_in_memories(7).unwrap().is_empty());
    assert!(store.stand_in_memory_rules(8).unwrap().is_empty());
    let rules = store.stand_in_memory_rules(7).unwrap();
    assert_eq!(rules.len(), 1);
    let rule = &rules[0];
    assert_eq!(rule["content"], input["content"]);
    assert_eq!(rule["kind"], "forgetting_rule");
    for forbidden in ["evidence", "sourceTaskId", "fingerprints"] {
        assert!(rule.get(forbidden).is_none());
    }
    let connection = store.connection().unwrap();
    let metadata: String = connection
        .query_row(
            "SELECT metadata FROM loop_items WHERE resource_type='stand_in_memory_rule'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(!metadata.contains("private-chat"));
    assert!(!metadata.contains("long private source excerpt"));
    drop(connection);
    assert!(store
        .delete_stand_in_memory_rule(8, rule["id"].as_str().unwrap(), 1, None)
        .is_err());
    assert!(store
        .delete_stand_in_memory_rule(7, rule["id"].as_str().unwrap(), 0, None)
        .is_err());
    assert!(matches!(
        store.save_stand_in_memory(7, "mac", input.clone()),
        Err(TaskRuntimeError::MemorySuppressed)
    ));
    store
        .delete_stand_in_memory_rule(7, rule["id"].as_str().unwrap(), 1, None)
        .unwrap();
    assert!(store.stand_in_memory_rules(7).unwrap().is_empty());
    assert!(store.save_stand_in_memory(7, "mac", input).is_ok());
}

#[test]
fn forgetting_rule_deletion_preserves_fingerprints_shared_by_other_rules() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
    let evidence = json!({"taskId":"chat","messageId":"message"});
    let first = store
        .save_stand_in_memory(
            7,
            "mac",
            json!({"scope":{"kind":"personal"},"content":"Fact one","evidence":evidence}),
        )
        .unwrap();
    let second = store
        .save_stand_in_memory(
            7,
            "mac",
            json!({"scope":{"kind":"personal"},"content":"Fact two","evidence":evidence}),
        )
        .unwrap();
    for row in [first, second] {
        store
            .delete_stand_in_memory(7, row["id"].as_str().unwrap(), 1)
            .unwrap();
    }
    let rules = store.stand_in_memory_rules(7).unwrap();
    store
        .delete_stand_in_memory_rule(7, rules[0]["id"].as_str().unwrap(), 1, None)
        .unwrap();
    let replay =
        json!({"scope":{"kind":"personal"},"content":"Rephrased fact","evidence":evidence});
    assert!(matches!(
        store.save_stand_in_memory(7, "mac", replay.clone()),
        Err(TaskRuntimeError::MemorySuppressed)
    ));
    store
        .delete_stand_in_memory_rule(7, rules[1]["id"].as_str().unwrap(), 1, None)
        .unwrap();
    assert!(store.save_stand_in_memory(7, "mac", replay).is_ok());
}

#[test]
fn forgetting_rule_recall_reuses_role_scope_isolation() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
    let mut settings = store.personal_stand_in(7, "mac").unwrap();
    let role = settings["roles"][0]["id"].as_str().unwrap().to_owned();
    let row = store
        .save_stand_in_memory(
            7,
            "mac",
            json!({"scope":{"kind":"role","roleId":role},"content":"Role-specific preference"}),
        )
        .unwrap();
    store
        .delete_stand_in_memory(7, row["id"].as_str().unwrap(), 1)
        .unwrap();
    assert_eq!(
        store
            .recall_stand_in_memory_rules(7, "mac", Some(&role), None)
            .unwrap()
            .len(),
        1
    );
    assert!(store
        .recall_stand_in_memory_rules(7, "mac", Some("other"), None)
        .unwrap()
        .is_empty());
    assert!(store
        .recall_stand_in_memory_rules(7, "mac", Some(&role), Some(&json!({"kind":"personal"})))
        .unwrap()
        .is_empty());
    settings["roles"] = json!([]);
    store.save_personal_stand_in(7, "mac", settings).unwrap();
    assert!(store
        .recall_stand_in_memory_rules(7, "mac", Some(&role), None)
        .unwrap()
        .is_empty());
    assert_eq!(
        store.stand_in_memory_rules(7).unwrap().len(),
        1,
        "The owner can still manage disconnected rules"
    );
}
