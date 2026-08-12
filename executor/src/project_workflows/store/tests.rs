use rusqlite::{params, Connection};
use serde_json::json;
use tempfile::TempDir;

use crate::{
    project_workflows::{
        ExecutionActorRef, ExecutionTargetRef, TaskBindingInput, WorkflowInput, WorkflowNode,
        WorkflowStageGroup,
    },
    task_runtime::{ChatAgentCreate, LocalTaskStore, ProjectCreate, TaskCreate, TaskProviderKind},
};

use super::ProjectWorkflowStore;

fn fixture() -> (
    TempDir,
    LocalTaskStore,
    ProjectWorkflowStore,
    String,
    String,
) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("tasks.sqlite");
    let task_store = LocalTaskStore::open(&path).unwrap();
    let project = task_store
        .create_project(ProjectCreate {
            name: "Workflow project".to_owned(),
            project_key: Some("WF".to_owned()),
            description: String::new(),
            task_provider: TaskProviderKind::Local,
            provider_config: json!({}),
        })
        .unwrap();
    let task = task_store
        .create_task(
            &project.id,
            TaskCreate {
                title: "Implement workflow".to_owned(),
                description: String::new(),
                status: "inbox".to_owned(),
                priority: "high".to_owned(),
                parent_id: None,
                tags: vec![],
            },
        )
        .unwrap();
    task_store
        .create_chat_agent(
            &project.id,
            ChatAgentCreate {
                name: "Developer".to_owned(),
                execution_device_id: Some("device-1".to_owned()),
                ..ChatAgentCreate::default()
            },
        )
        .unwrap();
    let workflow_store = ProjectWorkflowStore::open(&path).unwrap();
    (directory, task_store, workflow_store, project.id, task.id)
}

#[test]
fn migrates_legacy_agent_assignment_to_workflow_binding() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("tasks.sqlite");
    let task_store = LocalTaskStore::open(&path).unwrap();
    let project = task_store
        .create_project(ProjectCreate {
            name: "Legacy assignment".to_owned(),
            project_key: Some("LEGACY".to_owned()),
            description: String::new(),
            task_provider: TaskProviderKind::Local,
            provider_config: json!({}),
        })
        .unwrap();
    let task = task_store
        .create_task(
            &project.id,
            TaskCreate {
                title: "Migrate me".to_owned(),
                description: String::new(),
                status: "inbox".to_owned(),
                priority: "none".to_owned(),
                parent_id: None,
                tags: vec![],
            },
        )
        .unwrap();
    let agent = task_store
        .create_chat_agent(
            &project.id,
            ChatAgentCreate {
                name: "Legacy developer".to_owned(),
                execution_device_id: Some("device-legacy".to_owned()),
                ..ChatAgentCreate::default()
            },
        )
        .unwrap();
    drop(task_store);

    let legacy = Connection::open(&path).unwrap();
    legacy
        .execute(
            "ALTER TABLE loop_items ADD COLUMN assignee_agent_id TEXT",
            [],
        )
        .unwrap();
    legacy
        .execute(
            "CREATE INDEX ix_loop_items_assignee_agent_id
                 ON loop_items(assignee_agent_id)",
            [],
        )
        .unwrap();
    legacy
        .execute(
            "UPDATE loop_items SET assignee_agent_id = ?1 WHERE id = ?2",
            params![agent.id, task.id],
        )
        .unwrap();
    drop(legacy);

    let workflow_store = ProjectWorkflowStore::open(&path).unwrap();
    let binding = workflow_store
        .get_task_binding(&task.id)
        .unwrap()
        .expect("legacy assignment must become a workflow binding");
    assert_eq!(binding.target_type, "project_agent");
    assert_eq!(binding.target_id, agent.id);
    assert_eq!(binding.execution_target.target_type, "registered_device");
    assert_eq!(
        binding.execution_target.id.as_deref(),
        Some("device-legacy")
    );

    let migrated = Connection::open(&path).unwrap();
    let columns = migrated
        .prepare("PRAGMA table_info(loop_items)")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert!(!columns.iter().any(|column| column == "assignee_agent_id"));
}

#[test]
fn local_workflow_uses_existing_execution_queue_and_advances_after_callback() {
    let (_directory, task_store, store, project_id, task_id) = fixture();
    let agent = task_store.list_chat_agents(&project_id).unwrap().remove(0);
    let workflow = store
        .create_workflow(
            &project_id,
            7,
            WorkflowInput {
                name: "Develop".to_owned(),
                description: String::new(),
                trigger_mode: "manual".to_owned(),
                repository_binding_id: None,
                stages: vec![
                    WorkflowStageGroup {
                        key: "develop".to_owned(),
                        name: "Develop".to_owned(),
                        execution: "serial".to_owned(),
                        completion: "all".to_owned(),
                        nodes: vec![WorkflowNode {
                            key: "code".to_owned(),
                            name: "Code".to_owned(),
                            node_type: "agent".to_owned(),
                            actor: Some(ExecutionActorRef {
                                actor_type: "project_agent".to_owned(),
                                id: Some(agent.id),
                                team_id: None,
                                namespace: None,
                                name: None,
                                user_id: None,
                                version: None,
                            }),
                            prompt_template: "Implement the task".to_owned(),
                            input_artifacts: vec![],
                            required_outputs: vec!["execution_result".to_owned()],
                            workspace_mode: None,
                            max_retries: 1,
                            timeout_seconds: 3600,
                            condition: None,
                        }],
                    },
                    WorkflowStageGroup {
                        key: "complete".to_owned(),
                        name: "Complete".to_owned(),
                        execution: "serial".to_owned(),
                        completion: "all".to_owned(),
                        nodes: vec![WorkflowNode {
                            key: "done".to_owned(),
                            name: "Done".to_owned(),
                            node_type: "complete".to_owned(),
                            actor: None,
                            prompt_template: String::new(),
                            input_artifacts: vec![],
                            required_outputs: vec![],
                            workspace_mode: None,
                            max_retries: 0,
                            timeout_seconds: 3600,
                            condition: None,
                        }],
                    },
                ],
                failure_policy: "pause".to_owned(),
                is_default: true,
            },
        )
        .unwrap();
    store
        .upsert_task_binding(
            &project_id,
            &task_id,
            7,
            TaskBindingInput {
                version: None,
                actor: None,
                workflow_id: Some(workflow.id),
                repository_binding_id: None,
                execution_target: ExecutionTargetRef {
                    target_type: "registered_device".to_owned(),
                    id: Some("device-1".to_owned()),
                },
                workspace_mode: "current_workspace".to_owned(),
                start_after_save: false,
            },
        )
        .unwrap();
    let run = store
        .start_run(&project_id, &task_id, 7, "idempotent-start", None)
        .unwrap();
    let execution = task_store
        .list_executions(&project_id, None, None, false)
        .unwrap()
        .remove(0);
    store
        .on_execution_terminal(execution.id, true, "Implemented")
        .unwrap();
    let detail = store.get_run(&run.id).unwrap();
    assert_eq!(detail.run.status, "completed");
    assert!(detail
        .artifacts
        .iter()
        .any(|artifact| artifact.artifact_type == "execution_result"));
}
