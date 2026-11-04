use serde_json::{json, Value};
use wegent_executor::task_runtime::{LocalTaskStore, ProjectUpdate};

fn fixture() -> (tempfile::TempDir, LocalTaskStore, Value) {
    let root = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
    let project = store
        .create_project(serde_json::from_value(json!({"name":"Publication project"})).unwrap())
        .unwrap();
    let agent = store
        .create_chat_agent(
            &project.id,
            serde_json::from_value(
                json!({"name":"Processor","runtime":"claude_code","local_project_id":7}),
            )
            .unwrap(),
        )
        .unwrap();
    let rule = store.save_connection_rule(7,"mac",json!({"id":"source-rule","version":0,"name":"Report failures","enabled":true,
        "source":{"providerId":"test/source","id":"private-group","profile":"private-account","kind":"group","name":"Private group"},
        "eventType":"message.received","project":{"id":project.id,"store":"local"},"targetKind":"agent","targetId":agent.id,
        "condition":{"contains":"failure","senderId":"customer"},"instruction":"Investigate the published failure",
        "publication":{"title":"Reported failure","instruction":"Publish an anonymized problem summary"}})).unwrap();
    (root, store, rule)
}

fn event(id: &str) -> Value {
    json!({"id":id,"eventType":"message.received","senderId":"customer","text":"Private FAILURE message", "at":"2026-11-04T00:00:00Z"})
}

#[test]
fn durable_intake_filters_and_deduplicates_each_rule_without_sharing_raw_data() {
    let (root, store, rule) = fixture();
    let mut excluded = event("excluded");
    excluded["senderId"] = json!("other");
    store
        .enqueue_connection_rule(7, &rule, &rule["source"], &excluded)
        .unwrap();
    assert!(store.connection_rule_runs(7).unwrap().is_empty());
    for _ in 0..2 {
        store
            .enqueue_connection_rule(7, &rule, &rule["source"], &event("one"))
            .unwrap();
    }
    assert_eq!(store.connection_rule_runs(7).unwrap().len(), 1);
    assert!(store.connection_rule_runs(8).unwrap().is_empty());
    let project = store
        .list_projects()
        .unwrap()
        .into_iter()
        .find(|project| json!(project.id) == rule["project"]["id"])
        .unwrap();
    let shared = project.metadata.to_string();
    for secret in [
        "Private FAILURE message",
        "private-group",
        "private-account",
        "anonymized",
    ] {
        assert!(
            !shared.contains(secret),
            "Project configuration leaked {secret}"
        );
    }
    drop(store);
    let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
    assert_eq!(store.connection_rule_runs(7).unwrap().len(), 1);
    assert_eq!(store.connection_rules(7).unwrap(), vec![rule]);
}

#[test]
fn publication_and_dispatch_are_atomic_and_replaying_the_run_does_not_create_another_issue() {
    let (_root, store, rule) = fixture();
    store
        .enqueue_connection_rule(7, &rule, &rule["source"], &event("one"))
        .unwrap();
    let mut run = store.connection_rule_runs(7).unwrap().remove(0);
    run["error"] = json!("previous_failure");
    store.save_connection_rule_run(7, &run).unwrap();
    let publication =
        json!({"title":"Reported failure","description":"An anonymized problem summary"});
    for _ in 0..2 {
        store
            .publish_connection_rule_locally(7, &rule, &run, &publication)
            .unwrap();
    }
    let runs = store.connection_rule_runs(7).unwrap();
    assert_eq!(runs[0]["status"], "published");
    assert!(runs[0]["error"].is_null());
    let project = rule["project"]["id"].as_str().unwrap();
    let executions = store.list_executions(project, None, None, true).unwrap();
    assert_eq!(executions.len(), 1);
    let issue = store
        .get_task(project, runs[0]["issueId"].as_str().unwrap())
        .unwrap();
    assert_eq!(issue.description, "An anonymized problem summary");
    assert!(!serde_json::to_string(&executions)
        .unwrap()
        .contains("Private FAILURE message"));
    assert_eq!(
        store
            .list_project_automation_runs(project, "source-rule")
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn disabling_a_rule_cancels_pending_work_and_stale_collectors_cannot_enqueue_it_again() {
    let (_root, store, rule) = fixture();
    store
        .enqueue_connection_rule(7, &rule, &rule["source"], &event("one"))
        .unwrap();
    let run = store.connection_rule_runs(7).unwrap().remove(0);
    let mut disabled = rule.clone();
    disabled["enabled"] = json!(false);
    store.save_connection_rule(7, "mac", disabled).unwrap();
    store
        .enqueue_connection_rule(7, &rule, &rule["source"], &event("two"))
        .unwrap();
    assert_eq!(store.connection_rule_runs(7).unwrap().len(), 1);
    assert_eq!(
        store.connection_rule_runs(7).unwrap()[0]["status"],
        "cancelled"
    );
    assert!(store
        .publish_connection_rule_locally(7, &rule, &run, &json!({"title":"No","description":"No"}))
        .is_err());
    assert!(store
        .list_executions(rule["project"]["id"].as_str().unwrap(), None, None, true)
        .unwrap()
        .is_empty());
}

#[test]
fn project_revocation_is_checked_again_before_private_data_can_be_published() {
    let (_root, store, rule) = fixture();
    store
        .enqueue_connection_rule(7, &rule, &rule["source"], &event("one"))
        .unwrap();
    let run = store.connection_rule_runs(7).unwrap().remove(0);
    let project = store
        .list_projects()
        .unwrap()
        .into_iter()
        .find(|project| json!(project.id) == rule["project"]["id"])
        .unwrap();
    let mut shared = project.metadata["automatic_processing_rules"].clone();
    shared[0]["enabled"] = json!(false);
    store
        .update_project(
            &project.id,
            ProjectUpdate {
                version: project.version,
                automatic_processing_rules: Some(shared),
                ..Default::default()
            },
        )
        .unwrap();
    assert!(store
        .publish_connection_rule_locally(7, &rule, &run, &json!({"title":"No","description":"No"}))
        .is_err());
    assert!(store
        .list_executions(&project.id, None, None, true)
        .unwrap()
        .is_empty());
}

#[test]
fn private_rule_owner_device_and_revision_cannot_be_replaced() {
    let (_root, store, rule) = fixture();
    assert!(store.save_connection_rule(8, "mac", rule.clone()).is_err());
    assert!(store
        .save_connection_rule(7, "other-device", rule.clone())
        .is_err());
    let mut stale = rule.clone();
    stale["version"] = json!(0);
    assert!(store.save_connection_rule(7, "mac", stale).is_err());
    assert!(store.remove_connection_rule(8, "source-rule", 1).is_err());
    assert_eq!(store.connection_rules(7).unwrap(), vec![rule]);
}

#[test]
fn independent_rules_share_one_private_event_and_one_failed_run_does_not_block_another() {
    let (root, store, first) = fixture();
    let mut second = first.clone();
    second["id"] = json!("other-rule");
    second["version"] = json!(0);
    let second = store.save_connection_rule(7, "mac", second).unwrap();
    for rule in [&first, &second] {
        store
            .enqueue_connection_rule(7, rule, &rule["source"], &event("shared"))
            .unwrap();
    }
    let runs = store.connection_rule_runs(7).unwrap();
    assert_eq!(runs.len(), 2);
    let mut failed = runs
        .iter()
        .find(|run| run["ruleId"] == first["id"])
        .unwrap()
        .clone();
    failed["status"] = json!("failed");
    store.save_connection_rule_run(7, &failed).unwrap();
    let successful = runs
        .iter()
        .find(|run| run["ruleId"] == second["id"])
        .unwrap();
    store
        .publish_connection_rule_locally(
            7,
            &second,
            successful,
            &json!({"title":"Published","description":"Authorized result"}),
        )
        .unwrap();
    let connection = rusqlite::Connection::open(root.path().join("tasks.sqlite")).unwrap();
    let count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM loop_items WHERE resource_type='connection_event'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);
    let runs = store.connection_rule_runs(7).unwrap();
    assert!(runs.iter().any(|run| run["status"] == "failed"));
    assert!(runs.iter().any(|run| run["status"] == "published"));
}

#[test]
fn private_edits_cannot_overwrite_new_project_actions_and_reload_uses_the_canonical_action() {
    let (_root, store, rule) = fixture();
    let project = store.list_projects().unwrap().remove(0);
    let mut shared = project.metadata["automatic_processing_rules"].clone();
    shared[0]["prompt"] = json!("New shared instruction");
    shared[0]["enabled"] = json!(false);
    shared[0]["version"] = json!(2);
    store
        .update_project(
            &project.id,
            ProjectUpdate {
                version: project.version,
                automatic_processing_rules: Some(shared),
                ..Default::default()
            },
        )
        .unwrap();
    let mut stale = rule.clone();
    stale["condition"]["contains"] = json!("new filter");
    assert!(store.save_connection_rule(7, "mac", stale).is_err());
    let mut reloaded = store.connection_rule_view(rule.clone()).unwrap();
    assert_eq!(reloaded["instruction"], "New shared instruction");
    assert_eq!(reloaded["enabled"], false);
    assert_eq!(reloaded["sharedRuleVersion"], 2);
    reloaded["condition"]["contains"] = json!("new filter");
    let saved = store.save_connection_rule(7, "mac", reloaded).unwrap();
    assert_eq!(saved["enabled"], false);
    assert_eq!(saved["instruction"], "New shared instruction");
    store
        .remove_connection_rule(
            7,
            saved["id"].as_str().unwrap(),
            saved["version"].as_i64().unwrap(),
        )
        .unwrap();
}

#[test]
fn deleting_own_subscription_after_another_project_edit_does_not_require_a_private_resave() {
    let (_root, store, rule) = fixture();
    let project = store.list_projects().unwrap().remove(0);
    let mut shared = project.metadata["automatic_processing_rules"].clone();
    shared[0]["prompt"] = json!("New shared instruction");
    shared[0]["version"] = json!(2);
    store
        .update_project(
            &project.id,
            ProjectUpdate {
                version: project.version,
                automatic_processing_rules: Some(shared),
                ..Default::default()
            },
        )
        .unwrap();
    store
        .remove_connection_rule(
            7,
            rule["id"].as_str().unwrap(),
            rule["version"].as_i64().unwrap(),
        )
        .unwrap();
    assert!(store.connection_rules(7).unwrap().is_empty());
}

#[test]
fn group_dispatch_retains_the_authored_processing_instruction_in_manager_context() {
    let (_root, store, mut rule) = fixture();
    let project = store.list_projects().unwrap().remove(0);
    let agent_id = rule["targetId"].clone();
    let agent = store.list_chat_agents(&project.id).unwrap().remove(0);
    store.update_chat_agent(&project.id, &agent.id, serde_json::from_value(json!({"version":agent.version,"execution_policy":{"mode":"fixed","environment_id":"mac"},"model_policy":{"mode":"fixed","model":{"runtime":"claude_code","provider":"test","model_id":"test-model","source":"native"}}})).unwrap()).unwrap();

    store.update_project(&project.id, ProjectUpdate {
        version: project.version,
        collaboration_groups: Some(json!([{"id":"source-group","name":"Source processors","coordination_mode":"manager","leader":{"kind":"agent","id":agent_id,"name":"Processor","responsibility":"Coordinate"},"members":[{"kind":"agent","id":agent_id,"name":"Processor","responsibility":"Coordinate"}],"stages":[]}])),
        ..Default::default()
    }).unwrap();
    rule["targetKind"] = json!("collaboration_group");
    rule["targetId"] = json!("source-group");
    let rule = store.save_connection_rule(7, "mac", rule).unwrap();
    store
        .enqueue_connection_rule(7, &rule, &rule["source"], &event("group-event"))
        .unwrap();
    let run = store.connection_rule_runs(7).unwrap().remove(0);
    store
        .publish_connection_rule_locally(
            7,
            &rule,
            &run,
            &json!({"title":"Result","description":"Allowed summary"}),
        )
        .unwrap();
    let project_runs = store
        .list_project_automation_runs(&project.id, rule["id"].as_str().unwrap())
        .unwrap();
    assert_ne!(project_runs[0]["status"], "failed", "{project_runs:?}");
    let executions = store
        .list_executions(&project.id, None, None, true)
        .unwrap();
    assert_eq!(executions.len(), 1);
    let payload = executions[0].execution_payload.as_ref().unwrap();
    assert!(payload["message"]
        .as_str()
        .unwrap()
        .contains("Investigate the published failure"));
    assert!(payload["collaboration_manager_context"]
        .as_str()
        .unwrap()
        .contains("Investigate the published failure"));
    assert!(!payload.to_string().contains("Private FAILURE message"));
}

#[test]
fn publication_uses_the_projects_initial_status_on_a_custom_board() {
    let (_root, store, rule) = fixture();
    let project = store.list_projects().unwrap().remove(0);
    store
        .update_project(
            &project.id,
            ProjectUpdate {
                version: project.version,
                board_config: Some(json!({"group_by":"status", "statuses":[
                    {"id":"new","name":"New","color":"gray"},
                    {"id":"doing","name":"Doing","color":"blue"},
                    {"id":"done","name":"Done","color":"green"}
                ]})),
                ..Default::default()
            },
        )
        .unwrap();
    store
        .enqueue_connection_rule(7, &rule, &rule["source"], &event("custom-board"))
        .unwrap();
    let run = store.connection_rule_runs(7).unwrap().remove(0);
    store
        .publish_connection_rule_locally(
            7,
            &rule,
            &run,
            &json!({"title":"Result","description":"Approved summary"}),
        )
        .unwrap();
    let run = store.connection_rule_runs(7).unwrap().remove(0);
    let issue = store
        .get_task(&project.id, run["issueId"].as_str().unwrap())
        .unwrap();
    assert_eq!(issue.status.as_deref(), Some("new"));
    assert_eq!(issue.description, "Approved summary");
    assert_eq!(
        store
            .list_executions(&project.id, None, None, true)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn account_evidence_is_persistent_and_bound_to_the_exact_device_and_connection() {
    let (root, store, _) = fixture();
    store
        .remember_connection_user(
            "mac",
            "verified-fingerprint",
            7,
            store
                .update_connection_identity("mac", Some("verified-fingerprint"))
                .unwrap(),
        )
        .unwrap();
    assert_eq!(
        store
            .verified_connection_user("mac", "other-connection")
            .unwrap(),
        None
    );
    assert_eq!(
        store
            .verified_connection_user("other-device", "verified-fingerprint")
            .unwrap(),
        None
    );
    drop(store);
    let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
    assert_eq!(
        store
            .verified_connection_user("mac", "verified-fingerprint")
            .unwrap(),
        Some(7)
    );
    store.forget_connection_user("mac").unwrap();
    assert_eq!(
        store
            .verified_connection_user("mac", "verified-fingerprint")
            .unwrap(),
        None
    );
}

#[test]
fn switching_away_and_back_invalidates_old_evidence_and_rejects_late_verification_writes() {
    let (_root, store, _) = fixture();
    let generation = store
        .update_connection_identity("mac", Some("account-a"))
        .unwrap();
    store
        .remember_connection_user("mac", "account-a", 7, generation)
        .unwrap();
    store
        .update_connection_identity("mac", Some("account-b"))
        .unwrap();
    let returned = store
        .update_connection_identity("mac", Some("account-a"))
        .unwrap();
    assert!(returned > generation);
    assert_eq!(
        store.verified_connection_user("mac", "account-a").unwrap(),
        None
    );
    assert!(store
        .remember_connection_user("mac", "account-a", 7, generation)
        .is_err());
    store
        .remember_connection_user("mac", "account-a", 7, returned)
        .unwrap();
    store.forget_connection_user("mac").unwrap();
    assert!(store
        .remember_connection_user("mac", "account-a", 7, returned)
        .is_err());
}

#[test]
fn restarting_without_a_connection_retires_the_previous_accounts_offline_evidence() {
    let (root, store, _) = fixture();
    let generation = store
        .update_connection_identity("mac", Some("account-a"))
        .unwrap();
    store
        .remember_connection_user("mac", "account-a", 7, generation)
        .unwrap();
    drop(store);
    let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
    let disconnected = store.update_connection_identity("mac", None).unwrap();
    assert!(disconnected > generation);
    assert_eq!(
        store.connection_identity("mac").unwrap(),
        (disconnected, None)
    );
    assert_eq!(
        store.verified_connection_user("mac", "account-a").unwrap(),
        None
    );
}

#[test]
fn an_owned_rule_can_be_removed_after_its_local_project_is_archived() {
    let (_root, store, rule) = fixture();
    store
        .enqueue_connection_rule(7, &rule, &rule["source"], &event("before-archive"))
        .unwrap();
    let project = store.list_projects().unwrap().remove(0);
    store.archive_project(&project.id, project.version).unwrap();
    assert!(store
        .remove_connection_rule(8, rule["id"].as_str().unwrap(), 1)
        .is_err());
    assert!(store
        .remove_connection_rule(7, rule["id"].as_str().unwrap(), 2)
        .is_err());
    store
        .remove_connection_rule(7, rule["id"].as_str().unwrap(), 1)
        .unwrap();
    assert!(store.connection_rules(7).unwrap().is_empty());
    assert_eq!(
        store.connection_rule_runs(7).unwrap()[0]["status"],
        "cancelled"
    );
    store
        .enqueue_connection_rule(7, &rule, &rule["source"], &event("after-archive"))
        .unwrap();
    assert_eq!(store.connection_rule_runs(7).unwrap().len(), 1);
}
