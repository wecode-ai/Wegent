mod common;
use common::*;
use serde_json::{json, Value};
use tempfile::TempDir;
use wegent_local_task_store::{ChatAgent, LocalTaskStore, LoopItem, ProjectUpdate};

struct Legacy {
    _directory: TempDir,
    store: LocalTaskStore,
    target: String,
    source: LoopItem,
    agent: ChatAgent,
    thread: LoopItem,
}

fn legacy(crew_assignment: bool) -> Legacy {
    let (directory, store, target) = fixture();
    let source = store
        .create_project(
            serde_json::from_value(json!({"name":"Original authorized source"})).unwrap(),
        )
        .unwrap();
    let agent = agent(&store, &source.id);
    let target_agent = common::agent(&store, &target);
    update(
        &store,
        &target,
        json!({"collaboration_groups":[crew(&target,&target_agent.id)]}),
    )
    .unwrap();
    let source = store
        .update_project(
            &source.id,
            ProjectUpdate {
                version: source.version,
                collaboration_groups: Some(json!([crew(&source.id, &agent.id)])),
                ..Default::default()
            },
        )
        .unwrap();
    let mut input = json!({"title":"Preserved original assignment"});
    if crew_assignment {
        input["assignee_group_id"] = json!("same-crew-id");
    } else {
        input["assignee_agent_id"] = json!(agent.id);
    }
    let thread = store
        .create_task(&source.id, serde_json::from_value(input).unwrap())
        .unwrap();
    store
        .create_comment(
            &serde_json::from_value(json!({
                "project_id":source.id,"task_id":thread.id,"sender_type":"user","sender_id":"0",
                "sender_name":"Local owner","content":"Original public participation","metadata":{}
            }))
            .unwrap(),
        )
        .unwrap();
    for execution in store.list_executions(&source.id, None, None, true).unwrap() {
        store
            .fail_runtime_preflight(execution.id, "Historical run already settled")
            .unwrap();
    }
    Legacy {
        _directory: directory,
        store,
        target,
        source,
        agent,
        thread,
    }
}

fn inspect(f: &Legacy) -> Value {
    f.store
        .chat_group_request(
            "migration.inspect",
            json!({"source_project_id":f.source.id,"target_group_id":f.target}),
        )
        .unwrap()["inventory"]
        .clone()
}

#[test]
fn retained_original_project_agent_migrates_without_rebinding_or_clearing_assignment() {
    let f = legacy(false);
    let report = inspect(&f);
    f.store
        .chat_group_request(
            "migration.apply",
            json!({"inventory":report,"retain_source_project":true}),
        )
        .unwrap();
    let migrated = f.store.get_task(&f.target, &f.thread.id).unwrap();
    assert_eq!(
        migrated.assignee_agent_id.as_deref(),
        Some(f.agent.id.as_str())
    );
    let run = f
        .store
        .enqueue_execution(
            &f.target,
            &f.thread.id,
            &f.agent.id,
            json!({"message":"Continue original resource"}),
            None,
        )
        .unwrap();
    assert_eq!(run.cloud_project_id, f.target);
    assert_eq!(run.agent_id, f.agent.id);
    assert!(f
        .store
        .list_chat_agents(&f.target)
        .unwrap()
        .iter()
        .all(|agent| agent.id != f.agent.id));
}

#[test]
fn retained_project_crew_keeps_binding_source_when_the_target_has_the_same_id() {
    let f = legacy(true);
    let report = inspect(&f);
    f.store
        .chat_group_request(
            "migration.apply",
            json!({"inventory":report,"retain_source_project":true}),
        )
        .unwrap();
    let migrated = f.store.get_task(&f.target, &f.thread.id).unwrap();
    let group = &migrated.metadata["collaboration_group"];
    assert_eq!(group["id"], "same-crew-id");
    assert_eq!(group["binding_owner_id"], f.source.id);
    assert_eq!(group["owner_id"], "original-definition-owner");
    let replay = f
        .store
        .enqueue_execution(
            &f.target,
            &f.thread.id,
            &f.agent.id,
            json!({"message":"Continue original crew","collaboration_group":group}),
            None,
        )
        .unwrap();
    assert_eq!(replay.agent_id, f.agent.id);
}

#[test]
fn removing_project_classification_does_not_implicitly_map_or_clear_historical_resources() {
    for crew_assignment in [false, true] {
        let f = legacy(crew_assignment);
        assert!(f
            .store
            .chat_group_request(
                "migration.apply",
                json!({"inventory":inspect(&f),"retain_source_project":false})
            )
            .is_err());
        assert_eq!(
            f.store
                .get_task(&f.source.id, &f.thread.id)
                .unwrap()
                .cloud_project_id
                .as_deref(),
            Some(f.source.id.as_str())
        );
    }
}

#[test]
fn retained_migration_revalidates_resource_revocation_after_inventory() {
    let f = legacy(false);
    let report = inspect(&f);
    f.store
        .archive_chat_agent(&f.source.id, &f.agent.id, f.agent.version)
        .unwrap();
    assert!(f
        .store
        .chat_group_request(
            "migration.apply",
            json!({"inventory":report,"retain_source_project":true})
        )
        .is_err());
    assert_eq!(
        f.store
            .get_task(&f.source.id, &f.thread.id)
            .unwrap()
            .cloud_project_id
            .as_deref(),
        Some(f.source.id.as_str())
    );
}

#[test]
fn retained_legacy_installation_preserves_only_its_original_assigned_agent() {
    let (_directory, store, target) = fixture();
    let source = store
        .create_project(
            serde_json::from_value(json!({"name":"Legacy installation authority"})).unwrap(),
        )
        .unwrap();
    let original = agent(&store, "default-work-items");
    let unrelated = agent(&store, "default-work-items");
    let thread = store
        .create_task(
            &source.id,
            serde_json::from_value(json!({
                "title":"Original installed default resource","assignee_agent_id":original.id
            }))
            .unwrap(),
        )
        .unwrap();
    store.create_comment(&serde_json::from_value(json!({"project_id":source.id,"task_id":thread.id,
        "sender_type":"user","sender_id":"0","sender_name":"Local owner","content":"Historical actor","metadata":{}})).unwrap()).unwrap();
    for execution in store.list_executions(&source.id, None, None, true).unwrap() {
        store
            .fail_runtime_preflight(execution.id, "Historical run finished")
            .unwrap();
    }
    let report = store
        .chat_group_request(
            "migration.inspect",
            json!({"source_project_id":source.id,"target_group_id":target}),
        )
        .unwrap()["inventory"]
        .clone();
    store
        .chat_group_request(
            "migration.apply",
            json!({"inventory":report,"retain_source_project":true}),
        )
        .unwrap();
    let run = store
        .enqueue_execution(
            &target,
            &thread.id,
            &original.id,
            json!({"message":"Original authority only"}),
            None,
        )
        .unwrap();
    assert_eq!(run.agent_id, original.id);
    assert!(store
        .enqueue_execution(
            &target,
            &thread.id,
            &unrelated.id,
            json!({"message":"No new default grant"}),
            None
        )
        .is_err());
    let connection = rusqlite::Connection::open(_directory.path().join("tasks.sqlite")).unwrap();
    connection
        .execute(
            "UPDATE loop_items SET assignee_agent_id=?1 WHERE id=?2",
            rusqlite::params![unrelated.id, thread.id],
        )
        .unwrap();
    drop(connection);
    assert!(store
        .enqueue_execution(
            &target,
            &thread.id,
            &unrelated.id,
            json!({"message":"Current assignment alone is not original installation proof"}),
            None
        )
        .is_err());
}

#[test]
fn archived_resource_assignments_retain_their_history_and_exact_source() {
    for crew_assignment in [false, true] {
        let f = legacy(crew_assignment);
        f.store.archive_task(&f.source.id, &f.thread.id).unwrap();
        let report = inspect(&f);
        let result = f
            .store
            .chat_group_request(
                "migration.apply",
                json!({"inventory":report,"retain_source_project":true}),
            )
            .unwrap();
        assert_eq!(result["replayed"], false);
        assert_eq!(
            f.store
                .chat_group_request(
                    "migration.apply",
                    json!({"inventory":report,"retain_source_project":true})
                )
                .unwrap()["replayed"],
            true
        );
        let connection =
            rusqlite::Connection::open(f._directory.path().join("tasks.sqlite")).unwrap();
        let (owner,archived,agent,metadata):(String,Option<String>,Option<String>,String)=connection.query_row(
            "SELECT cloud_project_id,deleted_at,assignee_agent_id,metadata FROM loop_items WHERE id=?1",
            [&f.thread.id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))).unwrap();
        assert_eq!(owner, f.target);
        assert!(archived.is_some());
        if crew_assignment {
            assert_eq!(
                serde_json::from_str::<Value>(&metadata).unwrap()["collaboration_group"]
                    ["binding_owner_id"],
                f.source.id
            );
        } else {
            assert_eq!(agent.as_deref(), Some(f.agent.id.as_str()));
        }
    }
}
