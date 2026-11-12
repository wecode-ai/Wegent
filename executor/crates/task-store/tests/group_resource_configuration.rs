mod common;
use common::*;
use serde_json::json;
use wegent_local_task_store::{LocalTaskStore, LoopItem, ProjectUpdate};

#[test]
fn group_configuration_roundtrips_crew_rules_and_environment_after_reopen() {
    let (directory, store, owner) = fixture();
    let agent = agent(&store, &owner);
    let configuration = json!({"collaboration_groups":[crew(&owner,&agent.id)],
        "automatic_processing_rules":[],"execution_environment":{"repositories":[],"setup_steps":[]}});
    update(&store, &owner, configuration.clone()).unwrap();
    drop(store);
    let reopened = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
    let group = reopened
        .chat_group_request("get", json!({"group_id":owner}))
        .unwrap();
    for key in [
        "collaboration_groups",
        "automatic_processing_rules",
        "execution_environment",
    ] {
        assert_eq!(group["group"]["configuration"][key], configuration[key]);
    }
}

#[test]
fn configured_group_event_rule_dispatches_through_the_original_queue() {
    let (_directory, store, owner) = fixture();
    update(&store, &owner, json!({"automatic_processing_rules":[{
        "id":"assign-human","name":"Assign owner","triggerType":"event","eventType":"task.created",
        "targetKind":"human","targetId":"0","enabled":true
    }]})).unwrap();
    let thread = store
        .create_task(
            &owner,
            serde_json::from_value(json!({"title":"Rule-created assignment"})).unwrap(),
        )
        .unwrap();
    assert_eq!(thread.assignee_user_id, Some(0));
}

#[test]
fn invalid_group_configuration_is_atomic_and_cannot_write_permission_fields() {
    let (_directory, store, owner) = fixture();
    for invalid in [
        json!({"automatic_processing_rules":{},"tags":["must-not-persist"]}),
        json!({"collaboration_groups":[],"permission_grants":["forged"]}),
    ] {
        let before = store.get_work_container(&owner).unwrap();
        assert!(update(&store, &owner, invalid).is_err());
        let after = store.get_work_container(&owner).unwrap();
        assert_eq!(after.version, before.version);
        assert_eq!(after.metadata, before.metadata);
    }
}

#[test]
fn identical_crew_ids_are_valid_in_distinct_binding_containers() {
    let (_directory, store, _owner) = fixture();
    let mut projects = Vec::new();
    for name in ["First source", "Second source"] {
        let project: LoopItem = store
            .create_project(serde_json::from_value(json!({"name":name})).unwrap())
            .unwrap();
        let agent = agent(&store, &project.id);
        let updated = store
            .update_project(
                &project.id,
                ProjectUpdate {
                    version: project.version,
                    collaboration_groups: Some(json!([crew(&project.id, &agent.id)])),
                    ..Default::default()
                },
            )
            .unwrap();
        projects.push(updated);
    }
    assert_eq!(
        projects[0].metadata["collaboration_groups"][0]["id"],
        projects[1].metadata["collaboration_groups"][0]["id"]
    );
    assert_ne!(
        projects[0].metadata["collaboration_groups"][0]["binding_owner_id"],
        projects[1].metadata["collaboration_groups"][0]["binding_owner_id"]
    );
    assert_ne!(
        projects[0].metadata["collaboration_groups"][0]["leader"]["id"],
        projects[1].metadata["collaboration_groups"][0]["leader"]["id"]
    );
}

#[test]
fn group_agent_event_rule_creates_a_real_execution_with_the_original_model_policy() {
    let (_directory, store, owner) = fixture();
    let agent = store.create_chat_agent(&owner, serde_json::from_value(json!({
        "name":"Automatic Group Agent","execution_mode":"auto",
        "execution_policy":{"mode":"project_pool"},
        "model_policy":{"mode":"fixed","model":{"runtime":"codex","provider":"test","model_id":"model-a"}}
    })).unwrap()).unwrap();
    update(
        &store,
        &owner,
        json!({"automatic_processing_rules":[{
            "id":"group-auto","name":"Group AI","triggerType":"event","eventType":"task.created",
            "targetKind":"agent","targetId":agent.id,"enabled":true
        }]}),
    )
    .unwrap();
    let thread = store
        .create_task(
            &owner,
            serde_json::from_value(json!({"title":"Automatic AI execution"})).unwrap(),
        )
        .unwrap();
    let runs = store.list_executions(&owner, None, None, true).unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].agent_id, agent.id);
    assert_eq!(runs[0].cloud_project_id, owner);
    assert_eq!(runs[0].loop_item_id, thread.id);
    assert_eq!(
        runs[0].execution_payload.as_ref().unwrap()["runnerPolicy"]["model_policy"]["model"]
            ["model_id"],
        "model-a"
    );
}

#[test]
fn configured_group_rule_can_be_run_manually_and_by_the_schedule_tick() {
    let (directory, store, owner) = fixture();
    update(&store,&owner,json!({"automatic_processing_rules":[{
        "id":"schedule","name":"Schedule","version":1,"triggerType":"schedule",
        "cronExpression":"* * * * *","timezone":"UTC","targetKind":"human","targetId":"0","enabled":true
    }]})).unwrap();
    let thread = store
        .create_task(
            &owner,
            serde_json::from_value(json!({"title":"Scheduled Group work"})).unwrap(),
        )
        .unwrap();
    store
        .run_project_automation(&owner, "schedule", Some(&thread.id))
        .unwrap();
    assert_eq!(
        store.get_task(&owner, &thread.id).unwrap().assignee_user_id,
        Some(0)
    );
    let connection = rusqlite::Connection::open(directory.path().join("tasks.sqlite")).unwrap();
    connection
        .execute(
            "UPDATE loop_items SET assignee_user_id=NULL WHERE id=?1",
            [&thread.id],
        )
        .unwrap();
    connection.execute("UPDATE loop_items SET metadata=json_set(metadata,'$.automation_schedule',json(?1)) WHERE id=?2",
        rusqlite::params![json!({"schedule:1":"2000-01-01T00:00:00Z"}).to_string(),owner]).unwrap();
    drop(connection);
    store.tick_project_automations().unwrap();
    assert_eq!(
        store.get_task(&owner, &thread.id).unwrap().assignee_user_id,
        Some(0)
    );
}
