use rusqlite::{Connection, Row};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    project_workflows::{
        Artifact, ExecutionTargetRef, Repository, Squad, StageRun, TaskBinding, WorkflowDefinition,
        WorkflowRun,
    },
    task_runtime::TaskRuntimeError,
};

pub(super) fn squad_row(connection: &Connection, id: &str) -> Result<Squad, TaskRuntimeError> {
    connection
        .query_row(
            "SELECT id, project_id, name, leader_agent_id, member_agent_ids,
                    routing_instructions, max_parallel_members, status,
                    created_by_user_id, version, created_at, updated_at
             FROM project_agent_squads WHERE id = ?1",
            [id],
            map_squad,
        )
        .map_err(TaskRuntimeError::from)
}

pub(super) fn repository_row(
    connection: &Connection,
    id: &str,
) -> Result<Repository, TaskRuntimeError> {
    connection
        .query_row(
            "SELECT id, project_id, provider, repository_identity, repository_url,
                    default_branch, local_project_id, default_execution_target,
                    credential_ref, workspace_policy, git_policy, provider_settings,
                    status, created_by_user_id, version, created_at, updated_at
             FROM project_repository_bindings WHERE id = ?1",
            [id],
            map_repository,
        )
        .map_err(TaskRuntimeError::from)
}

pub(super) fn workflow_row(
    connection: &Connection,
    id: &str,
) -> Result<WorkflowDefinition, TaskRuntimeError> {
    connection
        .query_row(
            "SELECT id, project_id, name, description, trigger_mode,
                    repository_binding_id, stages, failure_policy, is_default,
                    status, created_by_user_id, version, created_at, updated_at
             FROM project_workflow_definitions WHERE id = ?1",
            [id],
            map_workflow,
        )
        .map_err(TaskRuntimeError::from)
}

pub(super) fn run_row(connection: &Connection, id: &str) -> Result<WorkflowRun, TaskRuntimeError> {
    connection
        .query_row(
            "SELECT id, item_id, workflow_definition_id, status, current_group_key,
                    repository_binding_id, execution_target, execution_target_snapshot,
                    failure_code, failure_message, trigger_message_id,
                    version, created_at, updated_at
             FROM task_workflow_runs WHERE id = ?1",
            [id],
            map_run,
        )
        .map_err(TaskRuntimeError::from)
}

pub(super) fn stage_row(connection: &Connection, id: &str) -> Result<StageRun, TaskRuntimeError> {
    connection
        .query_row(
            "SELECT id, workflow_run_id, group_key, node_key, node_type,
                    target_type, target_id, target_snapshot, execution_target,
                    status, attempt, loop_item_execution_id, runtime_instance_id,
                    runtime_task_id, workspace_id, input_snapshot, output_json,
                    failure_code, failure_message, version, created_at, updated_at
             FROM task_stage_runs WHERE id = ?1",
            [id],
            map_stage,
        )
        .map_err(TaskRuntimeError::from)
}

pub(super) fn map_squad(row: &Row<'_>) -> rusqlite::Result<Squad> {
    Ok(Squad {
        id: row.get(0)?,
        project_id: row.get(1)?,
        name: row.get(2)?,
        leader_agent_id: row.get(3)?,
        member_agent_ids: parse_json(row.get::<_, String>(4)?, Vec::new()),
        routing_instructions: row.get(5)?,
        max_parallel_members: row.get(6)?,
        status: row.get(7)?,
        created_by_user_id: row.get(8)?,
        version: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

pub(super) fn map_repository(row: &Row<'_>) -> rusqlite::Result<Repository> {
    let target = row.get::<_, Option<String>>(7)?;
    let credential = row.get::<_, Option<String>>(8)?;
    Ok(Repository {
        id: row.get(0)?,
        project_id: row.get(1)?,
        provider: row.get(2)?,
        repository_identity: row.get(3)?,
        repository_url: row.get(4)?,
        default_branch: row.get(5)?,
        local_project_id: row.get(6)?,
        default_execution_target: target.and_then(|value| serde_json::from_str(&value).ok()),
        has_credential: credential.as_deref().is_some_and(|value| !value.is_empty()),
        webhook_configured: false,
        workspace_policy: json_value(&row.get::<_, String>(9)?),
        git_policy: json_value(&row.get::<_, String>(10)?),
        provider_settings: json_value(&row.get::<_, String>(11)?),
        status: row.get(12)?,
        created_by_user_id: row.get(13)?,
        version: row.get(14)?,
        created_at: row.get(15)?,
        updated_at: row.get(16)?,
    })
}

pub(super) fn map_workflow(row: &Row<'_>) -> rusqlite::Result<WorkflowDefinition> {
    Ok(WorkflowDefinition {
        id: row.get(0)?,
        project_id: row.get(1)?,
        name: row.get(2)?,
        description: row.get(3)?,
        trigger_mode: row.get(4)?,
        repository_binding_id: row.get(5)?,
        stages: parse_json(row.get::<_, String>(6)?, Vec::new()),
        failure_policy: row.get(7)?,
        is_default: row.get(8)?,
        status: row.get(9)?,
        created_by_user_id: row.get(10)?,
        version: row.get(11)?,
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
    })
}

pub(super) fn map_binding(row: &Row<'_>) -> rusqlite::Result<TaskBinding> {
    Ok(TaskBinding {
        id: row.get(0)?,
        item_id: row.get(1)?,
        target_type: row.get(2)?,
        target_id: row.get(3)?,
        target_snapshot: json_value(&row.get::<_, String>(4)?),
        repository_binding_id: row.get(5)?,
        execution_target: parse_json(
            row.get::<_, String>(6)?,
            ExecutionTargetRef {
                target_type: "registered_device".to_owned(),
                id: None,
            },
        ),
        workspace_mode: row.get(7)?,
        created_by_user_id: row.get(8)?,
        version: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

pub(super) fn map_run(row: &Row<'_>) -> rusqlite::Result<WorkflowRun> {
    Ok(WorkflowRun {
        id: row.get(0)?,
        item_id: row.get(1)?,
        workflow_definition_id: row.get(2)?,
        status: row.get(3)?,
        current_group_key: row.get(4)?,
        repository_binding_id: row.get(5)?,
        execution_target: parse_json(
            row.get::<_, String>(6)?,
            ExecutionTargetRef {
                target_type: "registered_device".to_owned(),
                id: None,
            },
        ),
        execution_target_snapshot: json_value(&row.get::<_, String>(7)?),
        failure_code: row.get(8)?,
        failure_message: row.get(9)?,
        trigger_message_id: row.get(10)?,
        version: row.get(11)?,
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
    })
}

pub(super) fn map_stage(row: &Row<'_>) -> rusqlite::Result<StageRun> {
    Ok(StageRun {
        id: row.get(0)?,
        workflow_run_id: row.get(1)?,
        group_key: row.get(2)?,
        node_key: row.get(3)?,
        node_type: row.get(4)?,
        target_type: row.get(5)?,
        target_id: row.get(6)?,
        target_snapshot: json_value(&row.get::<_, String>(7)?),
        execution_target: parse_json(
            row.get::<_, String>(8)?,
            ExecutionTargetRef {
                target_type: "registered_device".to_owned(),
                id: None,
            },
        ),
        status: row.get(9)?,
        attempt: row.get(10)?,
        loop_item_execution_id: row.get(11)?,
        runtime_instance_id: row.get(12)?,
        runtime_task_id: row.get(13)?,
        workspace_id: row.get(14)?,
        input_snapshot: json_value(&row.get::<_, String>(15)?),
        output: json_value(&row.get::<_, String>(16)?),
        failure_code: row.get(17)?,
        failure_message: row.get(18)?,
        version: row.get(19)?,
        created_at: row.get(20)?,
        updated_at: row.get(21)?,
    })
}

pub(super) fn map_artifact(row: &Row<'_>) -> rusqlite::Result<Artifact> {
    Ok(Artifact {
        id: row.get(0)?,
        workflow_run_id: row.get(1)?,
        stage_run_id: row.get(2)?,
        artifact_type: row.get(3)?,
        schema_version: row.get(4)?,
        content: json_value(&row.get::<_, String>(5)?),
        object_key: row.get(6)?,
        sha256: row.get(7)?,
        created_at: row.get(8)?,
    })
}

pub(super) fn ensure_column(
    connection: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), TaskRuntimeError> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    if !columns.iter().any(|value| value == column) {
        connection.execute(
            &format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"),
            [],
        )?;
    }
    Ok(())
}

pub(super) fn version_changed(changed: usize) -> Result<(), TaskRuntimeError> {
    if changed == 1 {
        Ok(())
    } else {
        Err(TaskRuntimeError::VersionConflict)
    }
}

pub(super) fn workflow_id(prefix: &str) -> String {
    format!("{prefix}-{}", Uuid::new_v4().simple())
}

pub(super) fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

pub(super) fn priority_weight(priority: Option<&str>) -> i64 {
    match priority {
        Some("urgent") => 400,
        Some("high") => 300,
        Some("medium") => 200,
        Some("low") => 100,
        _ => 0,
    }
}

pub(super) fn object_json(value: Value) -> String {
    if value.is_object() {
        value.to_string()
    } else {
        "{}".to_owned()
    }
}

pub(super) fn json_string<T: serde::Serialize>(value: &T) -> Result<String, TaskRuntimeError> {
    serde_json::to_string(value).map_err(|error| TaskRuntimeError::Invalid(error.to_string()))
}

pub(super) fn from_json<T: serde::de::DeserializeOwned>(
    value: &str,
) -> Result<T, TaskRuntimeError> {
    serde_json::from_str(value).map_err(|error| TaskRuntimeError::Invalid(error.to_string()))
}

pub(super) fn json_value(value: &str) -> Value {
    serde_json::from_str(value).unwrap_or_else(|_| json!({}))
}

pub(super) fn parse_json<T: serde::de::DeserializeOwned>(value: String, default: T) -> T {
    serde_json::from_str(&value).unwrap_or(default)
}

pub(super) fn collect<T>(
    rows: rusqlite::MappedRows<'_, impl FnMut(&Row<'_>) -> rusqlite::Result<T>>,
) -> Result<Vec<T>, TaskRuntimeError> {
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(TaskRuntimeError::from)
}
