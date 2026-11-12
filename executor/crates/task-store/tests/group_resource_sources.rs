mod common;
use common::*;
use serde_json::json;
use tempfile::TempDir;
use wegent_local_task_store::{ChatAgent, LocalTaskStore, LoopItem, ProjectUpdate};

struct Sources {
    _directory: TempDir,
    store: LocalTaskStore,
    owner: String,
    project: LoopItem,
    group_agent: ChatAgent,
    project_agent: ChatAgent,
    thread: LoopItem,
}

fn sources() -> Sources {
    let (directory, store, owner) = fixture();
    let project = store
        .create_project(serde_json::from_value(json!({"name":"Linked resource source"})).unwrap())
        .unwrap();
    let group_agent = agent(&store, &owner);
    let project_agent = agent(&store, &project.id);
    update(
        &store,
        &owner,
        json!({"collaboration_groups":[crew(&owner,&group_agent.id)]}),
    )
    .unwrap();
    let project = store
        .update_project(
            &project.id,
            ProjectUpdate {
                version: project.version,
                collaboration_groups: Some(json!([crew(&project.id, &project_agent.id)])),
                ..Default::default()
            },
        )
        .unwrap();
    let thread = store
        .create_task_with_context(
            &owner,
            serde_json::from_value(json!({"title":"Choose an exact crew binding"})).unwrap(),
            None,
            None,
            Some(project.id.clone()),
        )
        .unwrap();
    Sources {
        _directory: directory,
        store,
        owner,
        project,
        group_agent,
        project_agent,
        thread,
    }
}

fn assign(
    f: &Sources,
    source: Option<&str>,
) -> Result<LoopItem, wegent_local_task_store::TaskRuntimeError> {
    let current = f.store.get_task(&f.owner, &f.thread.id).unwrap();
    let mut input = json!({"version":current.version,"assignee_group_id":"same-crew-id"});
    if let Some(source) = source {
        input["assignee_group_source_id"] = json!(source);
    }
    f.store.update_task(
        &f.owner,
        &f.thread.id,
        serde_json::from_value(input).unwrap(),
    )
}

#[test]
fn colliding_group_and_project_crews_can_each_be_selected_by_binding_source() {
    for project_source in [false, true] {
        let f = sources();
        let source = if project_source {
            &f.project.id
        } else {
            &f.owner
        };
        let chosen = assign(&f, Some(source)).unwrap();
        assert_eq!(chosen.metadata["collaboration_group"]["id"], "same-crew-id");
        assert_eq!(
            chosen.metadata["collaboration_group"]["binding_owner_id"],
            *source
        );
        assert_eq!(
            chosen.metadata["collaboration_group"]["owner_type"],
            "workspace"
        );
        assert_eq!(
            chosen.metadata["collaboration_group"]["owner_id"],
            "original-definition-owner"
        );
        let runs = f.store.list_executions(&f.owner, None, None, true).unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(
            runs[0].agent_id,
            if project_source {
                f.project_agent.id
            } else {
                f.group_agent.id
            }
        );
        assert_eq!(runs[0].cloud_project_id, f.owner);
    }
}

#[test]
fn ambiguous_missing_source_does_not_silently_choose_the_group_crew() {
    let f = sources();
    assert!(assign(&f, None).is_err());
    assert_eq!(
        f.store.get_task(&f.owner, &f.thread.id).unwrap().version,
        f.thread.version
    );
    assert!(f
        .store
        .list_executions(&f.owner, None, None, true)
        .unwrap()
        .is_empty());
}

#[test]
fn foreign_source_is_rejected_atomically_instead_of_being_ignored() {
    let f = sources();
    assert!(assign(&f, Some("unrelated-resource-container")).is_err());
    assert_eq!(
        f.store.get_task(&f.owner, &f.thread.id).unwrap().version,
        f.thread.version
    );
    assert!(f
        .store
        .list_executions(&f.owner, None, None, true)
        .unwrap()
        .is_empty());
}

#[test]
fn changing_only_the_source_for_the_same_crew_id_reassigns_the_execution() {
    let f = sources();
    assign(&f, Some(&f.owner)).unwrap();
    let switched = assign(&f, Some(&f.project.id)).unwrap();
    assert_eq!(
        switched.metadata["collaboration_group"]["binding_owner_id"],
        f.project.id
    );
    let runs = f.store.list_executions(&f.owner, None, None, true).unwrap();
    assert_eq!(runs.len(), 2);
    assert!(runs
        .iter()
        .any(|run| run.agent_id == f.group_agent.id && run.status == "cancelled"));
    assert!(runs
        .iter()
        .any(|run| run.agent_id == f.project_agent.id && run.status == "queued"));
}

#[test]
fn removing_a_crew_binding_blocks_its_queued_run_even_when_the_agent_stays_enabled() {
    let f = sources();
    assign(&f, Some(&f.owner)).unwrap();
    update(&f.store, &f.owner, json!({"collaboration_groups":[]})).unwrap();
    assert!(f
        .store
        .claim_next_execution_for_runtime(Some("local-device"), "runtime", 300)
        .is_err());
}

#[test]
fn project_crew_human_handoff_keeps_the_group_owner_and_project_classification() {
    let f = sources();
    let mut group = crew(&f.project.id, &f.project_agent.id);
    group["members"] = json!([{"kind":"human","id":"0","name":"Local owner"}]);
    f.store
        .update_project(
            &f.project.id,
            ProjectUpdate {
                version: f.project.version,
                collaboration_groups: Some(json!([group])),
                ..Default::default()
            },
        )
        .unwrap();
    assign(&f, Some(&f.project.id)).unwrap();
    let execution = f
        .store
        .claim_next_execution_for_runtime(Some("local-device"), "runtime", 300)
        .unwrap()
        .unwrap();
    let device = execution.runtime_device_id.as_deref().unwrap();
    let task = execution.runtime_task_id.as_deref().unwrap();
    f.store
        .request_runtime_start(execution.id, device, task, 300)
        .unwrap()
        .unwrap();
    f.store
        .confirm_runtime_accepted(execution.id, device, task, 300)
        .unwrap()
        .unwrap();
    f.store.mark_runtime_running(task).unwrap().unwrap();
    let round=f.store.submit_collaboration_round(task,&json!({"round_id":"project-handoff","items":[{
        "assignment_id":"confirm","title":"Confirm project resource work","instructions":"Review evidence",
        "assignee_type":"human","assignee_id":"0"
    }]})).unwrap();
    let child = round["assignments"][0]["human_assignment_id"]
        .as_str()
        .unwrap();
    let item = f.store.get_task(&f.owner, child).unwrap();
    assert_eq!(item.parent_id.as_deref(), Some(f.thread.id.as_str()));
    assert_eq!(item.cloud_project_id.as_deref(), Some(f.owner.as_str()));
    let link = f
        .store
        .chat_group_request("project_link.get", json!({"thread_id":child}))
        .unwrap();
    assert_eq!(link["project"]["id"], f.project.id);
}

#[test]
fn removing_the_project_crew_never_substitutes_the_same_id_group_crew() {
    let f = sources();
    assign(&f, Some(&f.project.id)).unwrap();
    f.store
        .update_project(
            &f.project.id,
            ProjectUpdate {
                version: f.project.version,
                collaboration_groups: Some(json!([])),
                ..Default::default()
            },
        )
        .unwrap();
    assert!(f
        .store
        .claim_next_execution_for_runtime(Some("local-device"), "runtime", 300)
        .is_err());
}

#[test]
fn group_agent_catalog_never_unions_unconfigured_default_agents() {
    let f = sources();
    let default_agent = agent(&f.store, "default-work-items");
    let listed = f.store.list_chat_agents(&f.owner).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, f.group_agent.id);
    assert!(listed
        .iter()
        .all(|entry| entry.id != default_agent.id && entry.id != f.project_agent.id));
}

#[test]
fn revoked_project_crew_cannot_dispatch_a_human_after_its_manager_started() {
    let f = sources();
    let mut definition = crew(&f.project.id, &f.project_agent.id);
    definition["members"] = json!([{"kind":"human","id":"0"}]);
    let source = f
        .store
        .update_project(
            &f.project.id,
            ProjectUpdate {
                version: f.project.version,
                collaboration_groups: Some(json!([definition])),
                ..Default::default()
            },
        )
        .unwrap();
    assign(&f, Some(&f.project.id)).unwrap();
    let execution = f
        .store
        .claim_next_execution_for_runtime(Some("local-device"), "revoked-manager", 300)
        .unwrap()
        .unwrap();
    let device = execution.runtime_device_id.as_deref().unwrap();
    let task = execution.runtime_task_id.as_deref().unwrap();
    f.store
        .request_runtime_start(execution.id, device, task, 300)
        .unwrap()
        .unwrap();
    f.store
        .confirm_runtime_accepted(execution.id, device, task, 300)
        .unwrap()
        .unwrap();
    f.store.mark_runtime_running(task).unwrap().unwrap();
    f.store
        .update_project(
            &source.id,
            ProjectUpdate {
                version: source.version,
                collaboration_groups: Some(json!([])),
                ..Default::default()
            },
        )
        .unwrap();
    let before = f.store.get_task(&f.owner, &f.thread.id).unwrap();
    assert!(f
        .store
        .submit_collaboration_round(
            task,
            &json!({"round_id":"revoked-human","items":[{
                "assignment_id":"human","title":"Must not create","instructions":"Revoked source",
                "assignee_type":"human","assignee_id":"0"
            }]})
        )
        .is_err());
    assert_eq!(
        f.store.get_task(&f.owner, &f.thread.id).unwrap().version,
        before.version
    );
    assert_eq!(f.store.list_tasks(&f.owner).unwrap().len(), 1);
}
