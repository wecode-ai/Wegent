use rusqlite::Connection;
use serde_json::{json, Value};
use tempfile::TempDir;
use wegent_executor::task_runtime::{LocalTaskStore, ProjectUpdate, TaskUpdate};

fn fixture(event: &str) -> (TempDir, LocalTaskStore, String, Value) {
    let directory = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
    let project = store
        .create_project(serde_json::from_value(json!({"name":"Local"})).unwrap())
        .unwrap();
    let agent = store
        .create_chat_agent(
            &project.id,
            serde_json::from_value(
                json!({"name":"Local agent", "runtime":"claude_code", "local_project_id":7}),
            )
            .unwrap(),
        )
        .unwrap();
    let rule = json!({"id":"rule-1","name":"Process","targetKind":"agent","targetId":agent.id,"triggerType":"event","eventType":event,"eventConfig":{"tags":["ready"]},"prompt":"Process this Issue","enabled":true,"version":1});
    store
        .update_project(
            &project.id,
            ProjectUpdate {
                version: project.version,
                automatic_processing_rules: Some(json!([rule])),
                ..Default::default()
            },
        )
        .unwrap();
    (directory, store, project.id, rule)
}

#[test]
fn issue_creation_enqueues_locally_and_survives_reopening() {
    let (directory, store, project_id, _) = fixture("task.created");
    let task = store
        .create_task(
            &project_id,
            serde_json::from_value(json!({"title":"Run pwd"})).unwrap(),
        )
        .unwrap();
    let executions = store
        .list_executions(&project_id, None, None, true)
        .unwrap();
    assert_eq!(executions.len(), 1);
    assert_eq!(executions[0].loop_item_id, task.id);
    assert_eq!(executions[0].agent_runtime, "claude_code");
    let claimed = claim(&store);
    let payload = claimed.execution_payload.as_ref().unwrap();
    assert_eq!(payload["projectId"], 7);
    assert_eq!(payload["origin"]["projectStore"], "local");
    assert_eq!(payload["standaloneChatWorkspace"], false);
    assert_eq!(task.status.as_deref(), Some("in_progress"));
    drop(store);
    let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
    let runs = store
        .list_project_automation_runs(&project_id, "rule-1")
        .unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0]["status"], "running");
    assert_eq!(
        store
            .list_executions(&project_id, None, None, true)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn tag_rule_only_runs_for_a_new_matching_tag() {
    let (_directory, store, project_id, _) = fixture("task.tag_added");
    let task = store
        .create_task(
            &project_id,
            serde_json::from_value(json!({"title":"Tagged issue"})).unwrap(),
        )
        .unwrap();
    assert!(store
        .list_executions(&project_id, None, None, true)
        .unwrap()
        .is_empty());
    let task = store
        .update_task(
            &project_id,
            &task.id,
            TaskUpdate {
                version: task.version,
                tags: Some(vec!["ready".into()]),
                ..Default::default()
            },
        )
        .unwrap();
    store
        .update_task(
            &project_id,
            &task.id,
            TaskUpdate {
                version: task.version,
                tags: Some(vec!["ready".into()]),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(
        store
            .list_executions(&project_id, None, None, true)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        store
            .list_project_automation_runs(&project_id, "rule-1")
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn unavailable_agent_records_a_failure_without_losing_the_issue() {
    let (_directory, store, project_id, rule) = fixture("task.created");
    let agent = store.list_chat_agents(&project_id).unwrap().remove(0);
    store
        .archive_chat_agent(
            &project_id,
            rule["targetId"].as_str().unwrap(),
            agent.version,
        )
        .unwrap();
    let task = store
        .create_task(
            &project_id,
            serde_json::from_value(json!({"title":"Keep this issue"})).unwrap(),
        )
        .unwrap();
    assert_eq!(
        store
            .get_task(&project_id, &task.id)
            .unwrap()
            .title
            .as_deref(),
        Some("Keep this issue")
    );
    let runs = store
        .list_project_automation_runs(&project_id, "rule-1")
        .unwrap();
    assert_eq!(runs[0]["status"], "failed");
    assert!(runs[0]["error"].as_str().unwrap().contains("Agent"));
    assert!(store
        .list_executions(&project_id, None, None, true)
        .unwrap()
        .is_empty());
}

#[test]
fn scheduled_rule_uses_a_persistent_cursor_and_does_not_dispatch_twice() {
    let (directory, store, project_id, mut rule) = fixture("task.tag_added");
    rule["triggerType"] = json!("schedule");
    rule["cronExpression"] = json!("* * * * *");
    rule["timezone"] = json!("Asia/Shanghai");
    let project = store
        .list_projects()
        .unwrap()
        .into_iter()
        .find(|item| item.id == project_id)
        .unwrap();
    store
        .update_project(
            &project_id,
            ProjectUpdate {
                version: project.version,
                automatic_processing_rules: Some(json!([rule])),
                ..Default::default()
            },
        )
        .unwrap();
    store
        .create_task(
            &project_id,
            serde_json::from_value(json!({"title":"Scheduled issue"})).unwrap(),
        )
        .unwrap();
    store.tick_project_automations().unwrap();
    assert!(store
        .list_executions(&project_id, None, None, true)
        .unwrap()
        .is_empty());
    let connection = Connection::open(directory.path().join("tasks.sqlite")).unwrap();
    connection.execute("UPDATE loop_items SET metadata=json_set(metadata,'$.automation_schedule.\"rule-1:1\"','2000-01-01T00:00:00Z') WHERE id=?1",[&project_id]).unwrap();
    store.tick_project_automations().unwrap();
    drop(store);
    let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
    store.tick_project_automations().unwrap();
    assert_eq!(
        store
            .list_executions(&project_id, None, None, true)
            .unwrap()
            .len(),
        1
    );
}

fn group_fixture(second_kind: &str) -> (TempDir, LocalTaskStore, String, String) {
    let (directory, store, project_id, mut rule) = fixture("task.created");
    let agent_id = rule["targetId"].as_str().unwrap().to_owned();
    rule["targetKind"] = json!("collaboration_group");
    rule["targetId"] = json!("group-1");
    let project = store.list_projects().unwrap().remove(0);
    store.update_project(&project_id, ProjectUpdate {
        version: project.version,
        automatic_processing_rules: Some(json!([rule])),
        collaboration_groups: Some(json!([{"id":"group-1","name":"Review","leader":{"kind":"agent","id":agent_id},"stages":[
            {"id":"build","name":"Build","assignee":{"kind":"agent","id":agent_id}},
            {"id":"review","name":"Review","assignee":{"kind":second_kind,"id":if second_kind=="agent" {agent_id.as_str()} else {"1"}}}
        ]}])),
        ..Default::default()
    }).unwrap();
    let task = store
        .create_task(
            &project_id,
            serde_json::from_value(json!({"title":"Group issue"})).unwrap(),
        )
        .unwrap();
    (directory, store, project_id, task.id)
}

fn claim(store: &LocalTaskStore) -> wegent_executor::task_runtime::LocalExecution {
    store.claim_next_local_execution(&serde_json::from_value(json!({"execution_device_id":"local-device","runtime_instance_id":"instance","device_capacity":1,"runtime_active":0,"runtime_active_task_ids":[],"lease_seconds":300})).unwrap()).unwrap().unwrap()
}

#[test]
fn group_waiting_for_human_is_not_reported_as_complete() {
    let (directory, store, project_id, _task_id) = group_fixture("human");
    let execution = claim(&store);
    store
        .complete_execution(execution.id, Some("Build done"))
        .unwrap();
    drop(store);
    let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
    let runs = store
        .list_project_automation_runs(&project_id, "rule-1")
        .unwrap();
    assert_eq!(runs[0]["status"], "running");
    store
        .cancel_project_automation_run(&project_id, runs[0]["id"].as_str().unwrap())
        .unwrap();
    assert_eq!(
        store
            .list_project_automation_runs(&project_id, "rule-1")
            .unwrap()[0]["status"],
        "cancelled"
    );
}

#[test]
fn cancelled_group_does_not_launch_next_stage_on_a_racing_completion() {
    let (_directory, store, project_id, _task_id) = group_fixture("agent");
    let execution = claim(&store);
    let runs = store
        .list_project_automation_runs(&project_id, "rule-1")
        .unwrap();
    let run_id = runs[0]["id"].as_str().unwrap();
    store
        .cancel_project_automation_run(&project_id, run_id)
        .unwrap();
    store
        .complete_execution(execution.id, Some("Late completion"))
        .unwrap();
    assert_eq!(
        store
            .list_executions(&project_id, None, None, true)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        store
            .list_project_automation_runs(&project_id, "rule-1")
            .unwrap()[0]["status"],
        "cancelled"
    );
    let retry = store
        .retry_project_automation_run(&project_id, run_id)
        .unwrap();
    assert_eq!(retry[0]["status"], "queued");
    assert_ne!(retry[0]["id"], run_id);
    assert_eq!(
        store
            .list_executions(&project_id, None, None, true)
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn group_finishes_only_after_both_agent_stages() {
    let (_directory, store, project_id, task_id) = group_fixture("agent");
    let first = claim(&store);
    store.complete_execution(first.id, Some("Built")).unwrap();
    assert_eq!(
        store
            .list_project_automation_runs(&project_id, "rule-1")
            .unwrap()[0]["status"],
        "queued"
    );
    let second = claim(&store);
    assert_ne!(first.id, second.id);
    store
        .complete_execution(second.id, Some("Reviewed"))
        .unwrap();
    assert_eq!(
        store
            .list_project_automation_runs(&project_id, "rule-1")
            .unwrap()[0]["status"],
        "succeeded"
    );
    assert_eq!(
        store
            .get_task(&project_id, &task_id)
            .unwrap()
            .status
            .as_deref(),
        Some("completed")
    );
}

#[test]
fn unavailable_next_stage_does_not_undo_completed_runtime_state() {
    let (_directory, store, project_id, task_id) = group_fixture("agent");
    let first = claim(&store);
    let agent = store.list_chat_agents(&project_id).unwrap().remove(0);
    store
        .archive_chat_agent(&project_id, &agent.id, agent.version)
        .unwrap();
    let completed = store
        .complete_execution(first.id, Some("Built successfully"))
        .unwrap()
        .unwrap();
    assert_eq!(completed.status, "completed");
    let task = store.get_task(&project_id, &task_id).unwrap();
    assert_eq!(task.metadata["workflow"]["nodes"][0]["status"], "completed");
    assert_eq!(task.metadata["workflow"]["nodes"][1]["status"], "failed");
    let runs = store
        .list_project_automation_runs(&project_id, "rule-1")
        .unwrap();
    assert_eq!(runs[0]["status"], "failed");
    assert!(runs[0]["error"].as_str().unwrap().contains("not active"));
}

#[test]
fn automatic_run_has_activity_and_binding_through_completion() {
    let (_directory, store, project_id, _) = fixture("task.created");
    let task = store
        .create_task(
            &project_id,
            serde_json::from_value(json!({"title":"Visible run"})).unwrap(),
        )
        .unwrap();
    let comments = store.list_comments(&project_id, &task.id, 0).unwrap();
    assert_eq!(comments.len(), 1);
    assert_eq!(comments[0].status, "pending");
    let execution = claim(&store);
    let device = execution.runtime_device_id.as_deref().unwrap();
    let runtime_task = execution.runtime_task_id.as_deref().unwrap();
    store
        .request_runtime_start(execution.id, device, runtime_task, 300)
        .unwrap()
        .unwrap();
    let bindings = store.list_task_bindings(&task.id).unwrap();
    assert_eq!(bindings.len(), 1);
    assert_eq!(bindings[0].task_id, runtime_task);
    assert_eq!(bindings[0].device_id, device);
    store.mark_runtime_running(runtime_task).unwrap();
    let running = store.list_comments(&project_id, &task.id, 0).unwrap();
    assert_eq!(running[0].status, "streaming");
    assert_eq!(
        running[0].metadata["runtime_address"]["taskId"],
        runtime_task
    );
    store
        .update_execution_progress(runtime_task, "Reading the Issue")
        .unwrap();
    assert_eq!(
        store.list_comments(&project_id, &task.id, 0).unwrap()[0].content,
        "Reading the Issue"
    );
    store
        .complete_execution(execution.id, Some("Automatically processed"))
        .unwrap();
    store
        .update_execution_progress(runtime_task, "Late progress must not replace the result")
        .unwrap();
    let finished = store.list_comments(&project_id, &task.id, 0).unwrap();
    assert_eq!(finished.len(), 1);
    assert_eq!(finished[0].message_id, comments[0].message_id);
    assert_eq!(finished[0].status, "completed");
    assert_eq!(finished[0].content, "Automatically processed");
    // Runtime acceptance may arrive after a very short task has already completed.
    store
        .confirm_runtime_accepted(execution.id, device, runtime_task, 300)
        .unwrap();
    assert_eq!(store.list_task_bindings(&task.id).unwrap().len(), 1);
    assert_eq!(
        store.list_comments(&project_id, &task.id, 0).unwrap()[0].status,
        "completed"
    );
}

#[test]
fn upgrade_restores_missing_automatic_activity_and_binding_without_rerunning() {
    let (directory, store, project_id, _) = fixture("task.created");
    let task = store
        .create_task(
            &project_id,
            serde_json::from_value(json!({"title":"Old invisible run"})).unwrap(),
        )
        .unwrap();
    let execution = claim(&store);
    let device = execution.runtime_device_id.as_deref().unwrap();
    let runtime_task = execution.runtime_task_id.as_deref().unwrap();
    store
        .request_runtime_start(execution.id, device, runtime_task, 300)
        .unwrap();
    store
        .complete_execution(execution.id, Some("Persisted original result"))
        .unwrap();
    drop(store);
    let path = directory.path().join("tasks.sqlite");
    let connection = Connection::open(&path).unwrap();
    connection.execute_batch("DELETE FROM loop_item_comments; DELETE FROM loop_items WHERE resource_type='execution'; DELETE FROM schema_migrations WHERE version >= 9;").unwrap();
    drop(connection);
    for _ in 0..2 {
        let reopened = LocalTaskStore::open(&path).unwrap();
        let comments = reopened.list_comments(&project_id, &task.id, 0).unwrap();
        assert_eq!(comments.len(), 1);
        assert_eq!(comments[0].content, "Persisted original result");
        assert_eq!(comments[0].status, "completed");
        assert_eq!(
            comments[0].metadata["runtime_address"]["taskId"],
            runtime_task
        );
        assert_eq!(reopened.list_task_bindings(&task.id).unwrap().len(), 1);
        let executions = reopened
            .list_executions(&project_id, None, None, true)
            .unwrap();
        assert_eq!(executions.len(), 1);
        assert_eq!(executions[0].status, "completed");
    }
}

#[test]
fn migration_preserves_existing_comments_and_explicitly_unlinked_tasks() {
    let (directory, store, project_id, _) = fixture("task.created");
    let task = store
        .create_task(
            &project_id,
            serde_json::from_value(json!({"title":"Unlinked run"})).unwrap(),
        )
        .unwrap();
    let execution = claim(&store);
    let device = execution.runtime_device_id.as_deref().unwrap();
    let runtime_task = execution.runtime_task_id.as_deref().unwrap();
    store
        .request_runtime_start(execution.id, device, runtime_task, 300)
        .unwrap();
    store
        .complete_execution(execution.id, Some("Existing result"))
        .unwrap();
    let original = store.list_comments(&project_id, &task.id, 0).unwrap();
    store
        .unbind_task(device, runtime_task, Some(&task.id))
        .unwrap();
    drop(store);
    let path = directory.path().join("tasks.sqlite");
    let connection = Connection::open(&path).unwrap();
    connection
        .execute("DELETE FROM schema_migrations WHERE version >= 9", [])
        .unwrap();
    drop(connection);
    let reopened = LocalTaskStore::open(path).unwrap();
    assert!(reopened.list_task_bindings(&task.id).unwrap().is_empty());
    let restored = reopened.list_comments(&project_id, &task.id, 0).unwrap();
    assert_eq!(restored.len(), 1);
    assert_eq!(restored[0].message_id, original[0].message_id);
    assert_eq!(restored[0].content, "Existing result");
}

#[test]
fn automatic_failure_remains_visible_without_late_progress_overwriting_it() {
    let (_directory, store, project_id, _) = fixture("task.created");
    let task = store
        .create_task(
            &project_id,
            serde_json::from_value(json!({"title":"Failed run"})).unwrap(),
        )
        .unwrap();
    let execution = claim(&store);
    let device = execution.runtime_device_id.as_deref().unwrap();
    let runtime_task = execution.runtime_task_id.as_deref().unwrap();
    store
        .request_runtime_start(execution.id, device, runtime_task, 300)
        .unwrap();
    store
        .fail_execution(execution.id, "Model unavailable", false)
        .unwrap();
    store
        .update_execution_progress(runtime_task, "Late output")
        .unwrap();
    let comments = store.list_comments(&project_id, &task.id, 0).unwrap();
    assert_eq!(comments.len(), 1);
    assert_eq!(comments[0].status, "failed");
    assert_eq!(comments[0].content, "Model unavailable");
    assert_eq!(
        comments[0].metadata["runtime_address"]["taskId"],
        runtime_task
    );
}
