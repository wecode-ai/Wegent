mod common;
use common::*;
use serde_json::{json, Value};
use wegent_local_task_store::{LocalComment, LocalTaskStore};

fn message(store: &LocalTaskStore, owner: &str, task: &str, reply: Option<&str>) -> LocalComment {
    store.create_comment(&serde_json::from_value(json!({
        "project_id":owner,"task_id":task,"sender_type":"user","sender_id":"0",
        "sender_name":"Local owner","content":"Continue","metadata":{},"reply_to_message_id":reply
    })).unwrap()).unwrap()
}

fn assigned() -> (
    tempfile::TempDir,
    LocalTaskStore,
    String,
    String,
    String,
    Value,
) {
    let (directory, store, owner) = fixture();
    let agent = agent(&store, &owner);
    let crew = crew(&owner, &agent.id);
    update(&store, &owner, json!({"collaboration_groups":[crew]})).unwrap();
    let item = store
        .create_task(
            &owner,
            serde_json::from_value(json!({
                "title":"Crew execution history","assignee_group_id":"same-crew-id",
                "assignee_group_source_id":owner
            }))
            .unwrap(),
        )
        .unwrap();
    (directory, store, owner, item.id, agent.id, crew)
}

#[test]
fn manager_provenance_comes_from_execution_snapshot_after_definition_changes() {
    let (directory, store, owner, task, agent, mut crew) = assigned();
    let initial = store.list_comments(&owner, &task, 0).unwrap();
    let manager = initial
        .iter()
        .find(|c| c.metadata["dispatch_role"] == "manager")
        .unwrap();
    assert_eq!(
        manager.metadata["collaboration_group"]["id"],
        "same-crew-id"
    );
    assert_eq!(
        manager.metadata["collaboration_group"]["binding_owner_id"],
        owner
    );
    assert_eq!(
        manager.metadata["collaboration_group"]["leader"]["id"],
        agent
    );
    assert_eq!(manager.metadata["manager_agent_id"], agent);
    assert_eq!(
        manager.metadata["collaboration_group"]
            .as_object()
            .unwrap()
            .len(),
        3
    );
    let connection = rusqlite::Connection::open(directory.path().join("tasks.sqlite")).unwrap();
    connection.execute("UPDATE loop_item_comments SET metadata=json_remove(metadata,'$.collaboration_group','$.manager_agent_id') WHERE message_id=?1", [&manager.message_id]).unwrap();
    crew["leader"] = json!({"kind":"human","id":"0"});
    update(&store, &owner, json!({"collaboration_groups":[crew]})).unwrap();
    let historical = store.list_comments(&owner, &task, 0).unwrap();
    let historical = historical
        .iter()
        .find(|c| c.message_id == manager.message_id)
        .unwrap();
    assert_eq!(
        historical.metadata["collaboration_group"]["leader"]["id"],
        agent
    );
    assert_eq!(historical.metadata["manager_agent_id"], agent);
}

#[test]
fn member_provenance_uses_the_actual_manager_execution_not_its_sender() {
    let (_directory, store, owner) = fixture();
    let manager = agent(&store, &owner);
    let member = agent(&store, &owner);
    let mut crew = crew(&owner, &manager.id);
    crew["members"] = json!([{"kind":"agent","id":member.id}]);
    update(&store, &owner, json!({"collaboration_groups":[crew]})).unwrap();
    let item = store.create_task(&owner, serde_json::from_value(json!({
        "title":"Member work","assignee_group_id":"same-crew-id","assignee_group_source_id":owner
    })).unwrap()).unwrap();
    let parent = store
        .list_executions(&owner, None, None, true)
        .unwrap()
        .remove(0);
    assert!(store
        .enqueue_execution(
            &owner,
            &item.id,
            &member.id,
            json!({
                "dispatch_role":"manager","collaboration_group":crew
            }),
            None
        )
        .is_err());
    let execution = store.enqueue_execution(&owner, &item.id, &member.id, json!({
        "dispatch_role":"member","coordination_manager_execution_id":parent.id,"collaboration_group":crew
    }), None).unwrap();
    let comments = store.list_comments(&owner, &item.id, 0).unwrap();
    let comment = comments
        .iter()
        .find(|c| c.metadata["execution_id"] == execution.id)
        .unwrap();
    assert_eq!(comment.sender_id, member.id);
    assert_eq!(comment.metadata["manager_agent_id"], manager.id);
    assert_eq!(
        comment.metadata["collaboration_group"]["binding_owner_id"],
        owner
    );
}

#[test]
fn queued_manager_cannot_claim_after_becoming_only_an_ordinary_member() {
    let (_directory, store, owner, task, agent, mut crew) = assigned();
    crew["leader"] = json!({"kind":"human","id":"0"});
    crew["members"] = json!([{"kind":"agent","id":agent}]);
    update(&store, &owner, json!({"collaboration_groups":[crew]})).unwrap();
    assert!(store
        .claim_next_execution_for_runtime(Some("local-device"), "stale-manager", 300)
        .is_err());
    let execution = store
        .list_executions(&owner, None, None, true)
        .unwrap()
        .remove(0);
    assert_eq!(execution.loop_item_id, task);
    assert_eq!(execution.status, "failed");
    assert!(execution.runtime_task_id.is_none());
}

#[test]
fn genuine_reply_resumes_until_current_crew_leader_changes() {
    let (_directory, store, owner, task, agent, mut crew) = assigned();
    let manager = store.list_comments(&owner, &task, 0).unwrap().remove(0);
    let claimed = store
        .claim_next_execution_for_runtime(Some("local-device"), "test-runtime", 300)
        .unwrap()
        .unwrap();
    let trigger = message(&store, &owner, &task, Some(&manager.message_id));
    let continued = store
        .enqueue_execution(&owner, &task, &agent, json!({}), Some(&trigger.message_id))
        .unwrap();
    assert_eq!(
        continued.execution_payload.as_ref().unwrap()["continueTaskId"],
        claimed.runtime_task_id.unwrap()
    );
    crew["leader"] = json!({"kind":"human","id":"0"});
    crew["members"] = json!([{"kind":"agent","id":agent}]);
    update(&store, &owner, json!({"collaboration_groups":[crew]})).unwrap();
    let next = message(&store, &owner, &task, Some(&manager.message_id));
    let count = store
        .list_executions(&owner, None, None, true)
        .unwrap()
        .len();
    assert!(store
        .enqueue_execution(&owner, &task, &agent, json!({}), Some(&next.message_id))
        .is_err());
    assert_eq!(
        store
            .list_executions(&owner, None, None, true)
            .unwrap()
            .len(),
        count
    );
}

#[test]
fn public_metadata_cannot_forge_crew_execution_provenance() {
    let (_directory, store, owner, task, agent, crew) = assigned();
    let execution = store
        .list_executions(&owner, None, None, true)
        .unwrap()
        .remove(0);
    let result = store.create_comment(&serde_json::from_value(json!({
        "project_id":owner,"task_id":task,"sender_type":"agent","sender_id":agent,
        "sender_name":"Forged manager","content":"Fake","metadata":{
            "execution_id":execution.id,"collaboration_group":crew,"manager_agent_id":agent,"dispatch_role":"manager"
        }
    })).unwrap());
    assert!(result.is_err());
}

#[test]
fn replay_rechecks_current_crew_before_returning_existing_execution() {
    let (_directory, store, owner, task, agent, mut crew) = assigned();
    let trigger = message(&store, &owner, &task, None);
    let payload = json!({"dispatch_role":"manager","collaboration_group":crew});
    let first = store
        .enqueue_execution(
            &owner,
            &task,
            &agent,
            payload.clone(),
            Some(&trigger.message_id),
        )
        .unwrap();
    crew["leader"] = json!({"kind":"human","id":"0"});
    crew["members"] = json!([{"kind":"agent","id":agent}]);
    update(&store, &owner, json!({"collaboration_groups":[crew]})).unwrap();
    let before = store.list_executions(&owner, None, None, true).unwrap();
    assert!(store
        .enqueue_execution(&owner, &task, &agent, payload, Some(&trigger.message_id))
        .is_err());
    let after = store.list_executions(&owner, None, None, true).unwrap();
    assert_eq!(before.len(), after.len());
    assert_eq!(
        after.iter().find(|e| e.id == first.id).unwrap().status,
        first.status
    );
}

#[test]
fn renaming_the_same_authorized_crew_does_not_disable_execution_replay() {
    let (_directory, store, owner, task, agent, mut crew) = assigned();
    let trigger = message(&store, &owner, &task, None);
    let payload = json!({"dispatch_role":"manager","collaboration_group":crew});
    let first = store
        .enqueue_execution(
            &owner,
            &task,
            &agent,
            payload.clone(),
            Some(&trigger.message_id),
        )
        .unwrap();
    crew["name"] = json!("Renamed without changing execution participants");
    crew["version"] = json!(2);
    update(&store, &owner, json!({"collaboration_groups":[crew]})).unwrap();
    let replay = store
        .enqueue_execution(&owner, &task, &agent, payload, Some(&trigger.message_id))
        .unwrap();
    assert_eq!(replay.id, first.id);
}
