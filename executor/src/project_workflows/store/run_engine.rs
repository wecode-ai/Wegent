use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    project_workflows::{
        artifacts::validate_artifact,
        transitions::{can_transition_stage, group_satisfied},
        ExecutionTargetRef, StageRun, TaskBinding, TaskBindingInput, WorkflowDefinition,
        WorkflowNode, WorkflowRunDetail,
    },
    task_runtime::TaskRuntimeError,
};

use super::rows::*;

type ResolvedNodeTarget = (Option<String>, Option<String>, Value);

pub(super) struct RunScope<'a> {
    pub project_id: &'a str,
    pub item_id: &'a str,
    pub run_id: &'a str,
    pub execution_target: &'a ExecutionTargetRef,
}

pub(super) struct NewStage<'a> {
    pub stage_id: &'a str,
    pub run_id: &'a str,
    pub group_key: &'a str,
    pub node: &'a WorkflowNode,
    pub execution_target: &'a ExecutionTargetRef,
    pub attempt: i64,
    pub status: &'a str,
    pub target_type: Option<&'a str>,
    pub target_id: Option<&'a str>,
    pub target_snapshot: &'a Value,
}

pub(super) fn activate_group(
    transaction: &Transaction<'_>,
    project_id: &str,
    item_id: &str,
    run_id: &str,
    workflow: &WorkflowDefinition,
    group_index: usize,
    execution_target: &ExecutionTargetRef,
) -> Result<(), TaskRuntimeError> {
    let Some(group) = workflow.stages.get(group_index) else {
        complete_run(transaction, item_id, run_id)?;
        return Ok(());
    };
    transaction.execute(
        "UPDATE task_workflow_runs SET current_group_key = ?1, status = 'running',
                version = version + 1, updated_at = ?2 WHERE id = ?3",
        params![group.key, now(), run_id],
    )?;
    let scope = RunScope {
        project_id,
        item_id,
        run_id,
        execution_target,
    };
    for node in &group.nodes {
        let members = resolve_node_targets(transaction, project_id, node)?;
        for (target_type, target_id, snapshot) in members {
            let stage_id = workflow_id("LSR");
            insert_stage(
                transaction,
                &NewStage {
                    stage_id: &stage_id,
                    run_id,
                    group_key: &group.key,
                    node,
                    execution_target,
                    attempt: 1,
                    status: "pending",
                    target_type: target_type.as_deref(),
                    target_id: target_id.as_deref(),
                    target_snapshot: &snapshot,
                },
            )?;
        }
    }
    let stage_ids = group_stage_ids(transaction, run_id, &group.key)?;
    if group.execution == "serial" {
        if let Some(stage_id) = stage_ids.first() {
            let stage = stage_row(transaction, stage_id)?;
            let node = find_node(workflow, &stage.group_key, &stage.node_key)?;
            activate_stage(
                transaction,
                &scope,
                stage_id,
                node,
                stage.target_id.as_deref(),
            )?;
        }
    } else {
        for stage_id in stage_ids {
            let stage = stage_row(transaction, &stage_id)?;
            let node = find_node(workflow, &stage.group_key, &stage.node_key)?;
            activate_stage(
                transaction,
                &scope,
                &stage_id,
                node,
                stage.target_id.as_deref(),
            )?;
        }
    }
    Ok(())
}

pub(super) fn activate_stage(
    transaction: &Transaction<'_>,
    scope: &RunScope<'_>,
    stage_id: &str,
    node: &WorkflowNode,
    resolved_target_id: Option<&str>,
) -> Result<(), TaskRuntimeError> {
    match node.node_type.as_str() {
        "agent" => {
            let agent_id = resolved_target_id.ok_or_else(|| {
                TaskRuntimeError::Invalid("Local agent stage requires an agent".to_owned())
            })?;
            enqueue_stage_execution(transaction, scope, stage_id, agent_id, node)?;
        }
        "human_gate" => set_stage_status(transaction, stage_id, "waiting_approval")?,
        "complete" => set_stage_status(transaction, stage_id, "passed")?,
        "ci_gate" | "merge" => set_stage_status(transaction, stage_id, "blocked")?,
        other => {
            return Err(TaskRuntimeError::Invalid(format!(
                "Unsupported local workflow node: {other}"
            )))
        }
    }
    Ok(())
}

pub(super) fn advance_run(
    transaction: &Transaction<'_>,
    project_id: &str,
    item_id: &str,
    run_id: &str,
) -> Result<(), TaskRuntimeError> {
    let run = run_row(transaction, run_id)?;
    if matches!(run.status.as_str(), "completed" | "cancelled" | "failed") {
        return Ok(());
    }
    let workflow = workflow_snapshot(transaction, run_id)?;
    let Some(group_key) = run.current_group_key.as_deref() else {
        return Ok(());
    };
    let group_index = workflow
        .stages
        .iter()
        .position(|group| group.key == group_key)
        .ok_or_else(|| TaskRuntimeError::Invalid("Current workflow group is missing".to_owned()))?;
    let group = &workflow.stages[group_index];
    let stages = group_stages(transaction, run_id, group_key)?;
    let scope = RunScope {
        project_id,
        item_id,
        run_id,
        execution_target: &run.execution_target,
    };
    if group.execution == "serial" {
        if stages
            .iter()
            .any(|stage| matches!(stage.status.as_str(), "queued" | "claimed" | "running"))
        {
            return Ok(());
        }
        if let Some(stage) = stages.iter().find(|stage| stage.status == "pending") {
            let node = find_node(&workflow, &stage.group_key, &stage.node_key)?;
            activate_stage(
                transaction,
                &scope,
                &stage.id,
                node,
                stage.target_id.as_deref(),
            )?;
            return Ok(());
        }
    }
    let statuses = stages
        .iter()
        .map(|stage| stage.status.clone())
        .collect::<Vec<_>>();
    if group_satisfied(&group.completion, &statuses) {
        activate_group(
            transaction,
            project_id,
            item_id,
            run_id,
            &workflow,
            group_index + 1,
            &run.execution_target,
        )?;
        if group_index + 1 < workflow.stages.len() {
            advance_run(transaction, project_id, item_id, run_id)?;
        }
    } else if statuses
        .iter()
        .any(|status| matches!(status.as_str(), "failed" | "rejected"))
    {
        transaction.execute(
            "UPDATE task_workflow_runs SET status = 'blocked',
                    failure_code = 'group_failed', failure_message = ?1,
                    version = version + 1, updated_at = ?2 WHERE id = ?3",
            params![
                format!("Stage group {group_key} did not pass"),
                now(),
                run_id
            ],
        )?;
    } else if statuses.iter().any(|status| status == "waiting_approval") {
        transaction.execute(
            "UPDATE task_workflow_runs SET status = 'waiting_approval',
                    version = version + 1, updated_at = ?1 WHERE id = ?2",
            params![now(), run_id],
        )?;
    }
    Ok(())
}

pub(super) fn enqueue_stage_execution(
    transaction: &Transaction<'_>,
    scope: &RunScope<'_>,
    stage_id: &str,
    agent_id: &str,
    node: &WorkflowNode,
) -> Result<(), TaskRuntimeError> {
    let RunScope {
        project_id,
        item_id,
        run_id,
        execution_target,
    } = scope;
    let (agent_name, metadata): (String, String) = transaction
        .query_row(
            "SELECT COALESCE(title, name, 'AI'), COALESCE(metadata, '{}')
             FROM loop_items
             WHERE id = ?1 AND resource_type = 'chat_agent'
               AND cloud_project_id = ?2 AND status = 'active' AND deleted_at IS NULL",
            params![agent_id, project_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| TaskRuntimeError::Invalid("Workflow robot is not active".to_owned()))?;
    let priority: Option<String> = transaction.query_row(
        "SELECT priority FROM loop_items WHERE id = ?1 AND resource_type = 'task'",
        [item_id],
        |row| row.get(0),
    )?;
    let agent_config = json_value(&metadata);
    let mode = agent_config
        .get("execution_mode")
        .and_then(Value::as_str)
        .unwrap_or("auto");
    let status = if mode == "manual_approval" {
        "pending_approval"
    } else {
        "queued"
    };
    let environment = if execution_target.target_type == "managed_container" {
        "cloud"
    } else {
        "local"
    };
    let trigger_context = transaction
        .query_row(
            "SELECT comment.message_id, comment.content, comment.metadata
             FROM task_workflow_runs AS workflow
             JOIN loop_item_comments AS comment
               ON comment.message_id = workflow.trigger_message_id
              AND comment.project_id = ?1
              AND comment.task_id = ?2
              AND comment.sender_type = 'user'
             WHERE workflow.id = ?3",
            params![project_id, item_id, run_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    json_value(&row.get::<_, String>(2)?),
                ))
            },
        )
        .optional()?;
    let trigger_content = trigger_context
        .as_ref()
        .map(|(_, content, _)| content.trim())
        .filter(|content| !content.is_empty());
    let execution_prompt = match trigger_content {
        Some(content) if node.prompt_template.trim().is_empty() => content.to_owned(),
        Some(content) => format!(
            "{}\n\nCurrent task comment instruction:\n{}",
            node.prompt_template, content
        ),
        None => node.prompt_template.clone(),
    };
    let trigger_metadata = trigger_context
        .as_ref()
        .map(|(_, _, metadata)| metadata)
        .cloned()
        .unwrap_or_else(|| json!({}));
    let now = now();
    transaction.execute(
        "INSERT INTO loop_item_executions (
            loop_item_id, cloud_project_id, agent_id, execution_environment,
            execution_device_id, assigner_user_id, status, priority_weight,
            queued_at, retry_attempt, max_retries, error_message, execution_note,
            approval_status, execution_payload, workflow_run_id, stage_run_id,
            workflow_attempt, version, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7, ?8, 0, ?9, '', '',
                   ?10, ?11, ?12, ?13, 1, 1, ?8, ?8)",
        params![
            item_id,
            project_id,
            agent_id,
            environment,
            execution_target.id,
            status,
            priority_weight(priority.as_deref()),
            now,
            node.max_retries,
            if status == "pending_approval" {
                Some("pending")
            } else {
                None
            },
            json!({
                "source": "project_workflow",
                "workflowRunId": run_id,
                "stageRunId": stage_id,
                "prompt": execution_prompt,
                "requiredOutputs": node.required_outputs,
                "agentConfig": agent_config,
                "triggerMessageId": trigger_context.as_ref().map(|value| &value.0),
                "triggerComment": trigger_content,
                "attachmentIds": trigger_metadata
                    .get("attachment_ids")
                    .cloned()
                    .unwrap_or_else(|| json!([])),
                "attachments": trigger_metadata
                    .get("attachments")
                    .cloned()
                    .unwrap_or_else(|| json!([])),
            })
            .to_string(),
            run_id,
            stage_id,
        ],
    )?;
    let execution_id = transaction.last_insert_rowid();
    transaction.execute(
        "UPDATE task_stage_runs SET status = ?1, loop_item_execution_id = ?2,
                started_at = ?3, version = version + 1, updated_at = ?3 WHERE id = ?4",
        params![
            if status == "queued" {
                "queued"
            } else {
                "waiting_approval"
            },
            execution_id,
            now,
            stage_id,
        ],
    )?;
    transaction.execute(
        "INSERT INTO loop_item_comments (
            message_id, project_id, task_id, sender_type, sender_id, sender_name,
            message_type, content, metadata, status, sequence_number, created_at, updated_at
         ) VALUES (?1, ?2, ?3, 'agent', ?4, ?5, 'text', '', ?6, 'streaming',
                   COALESCE((SELECT MAX(sequence_number) + 1 FROM loop_item_comments
                             WHERE task_id = ?3), 1), ?7, ?7)",
        params![
            Uuid::new_v4().to_string(),
            project_id,
            item_id,
            agent_id,
            agent_name,
            json!({
                "execution_id": execution_id,
                "workflow_run_id": run_id,
                "stage_run_id": stage_id,
            })
            .to_string(),
            now,
        ],
    )?;
    Ok(())
}

pub(super) fn resolve_node_targets(
    transaction: &Transaction<'_>,
    project_id: &str,
    node: &WorkflowNode,
) -> Result<Vec<ResolvedNodeTarget>, TaskRuntimeError> {
    let Some(actor) = node.actor.as_ref() else {
        return Ok(vec![(None, None, json!({}))]);
    };
    match actor.actor_type.as_str() {
        "project_agent" => Ok(vec![(
            Some("project_agent".to_owned()),
            actor.id.clone(),
            serde_json::to_value(actor)
                .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))?,
        )]),
        "project_squad" => {
            let squad_id = actor.id.as_deref().ok_or_else(|| {
                TaskRuntimeError::Invalid("Robot squad actor requires id".to_owned())
            })?;
            let squad = squad_row(transaction, squad_id)?;
            if squad.project_id != project_id {
                return Err(TaskRuntimeError::Invalid(
                    "Robot squad is not in this project".to_owned(),
                ));
            }
            Ok(squad
                .member_agent_ids
                .iter()
                .take(squad.max_parallel_members as usize)
                .map(|member_id| {
                    (
                        Some("project_agent".to_owned()),
                        Some(member_id.clone()),
                        json!({
                            "sourceActor": actor,
                            "squadId": squad.id,
                            "squadLeaderAgentId": squad.leader_agent_id,
                            "routingInstructions": squad.routing_instructions,
                        }),
                    )
                })
                .collect())
        }
        "wegent_team" => Err(TaskRuntimeError::Invalid(
            "Offline local workflows currently require a project robot; Wegent Team runs use a registered online device"
                .to_owned(),
        )),
        other => Err(TaskRuntimeError::Invalid(format!(
            "Unsupported workflow actor: {other}"
        ))),
    }
}

pub(super) fn create_workspace_records(
    transaction: &Transaction<'_>,
    _project_id: &str,
    item_id: &str,
    binding: &TaskBinding,
    run_id: &str,
) -> Result<(), TaskRuntimeError> {
    let Some(repository_id) = binding.repository_binding_id.as_deref() else {
        return Ok(());
    };
    let repository = repository_row(transaction, repository_id)?;
    let workspace_id = workflow_id("LWS");
    let branch_name = format!("wework/{item_id}");
    let now = now();
    transaction.execute(
        "INSERT INTO task_workspaces (
            id, item_id, repository_binding_id, execution_target,
            workspace_kind, branch_name, base_branch, status, cleanup_policy,
            version, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', 'on_workflow_complete',
                   1, ?8, ?8)",
        params![
            workspace_id,
            item_id,
            repository_id,
            json_string(&binding.execution_target)?,
            binding.workspace_mode,
            branch_name,
            repository.default_branch,
            now,
        ],
    )?;
    transaction.execute(
        "INSERT INTO task_development_links (
            id, item_id, repository_binding_id, workspace_id, branch_name,
            base_branch, provider, version, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?8)",
        params![
            workflow_id("LDV"),
            item_id,
            repository_id,
            workspace_id,
            branch_name,
            repository.default_branch,
            repository.provider,
            now,
        ],
    )?;
    transaction.execute(
        "UPDATE task_stage_runs SET workspace_id = ?1
         WHERE workflow_run_id = ?2 AND workspace_id IS NULL",
        params![workspace_id, run_id],
    )?;
    Ok(())
}

pub(super) fn complete_run(
    transaction: &Transaction<'_>,
    item_id: &str,
    run_id: &str,
) -> Result<(), TaskRuntimeError> {
    let now = now();
    transaction.execute(
        "UPDATE task_workflow_runs SET status = 'completed', current_group_key = NULL,
                completed_at = ?1, version = version + 1, updated_at = ?1 WHERE id = ?2",
        params![now, run_id],
    )?;
    transaction.execute(
        "UPDATE loop_items SET status = 'completed', completed_at = ?1,
                version = version + 1, updated_at = ?1
         WHERE id = ?2 AND resource_type = 'task'",
        params![now, item_id],
    )?;
    transaction.execute(
        "UPDATE task_workspaces SET status = 'released',
                version = version + 1, updated_at = ?1 WHERE item_id = ?2",
        params![now, item_id],
    )?;
    Ok(())
}

pub(super) fn insert_stage(
    transaction: &Transaction<'_>,
    stage: &NewStage<'_>,
) -> Result<(), TaskRuntimeError> {
    let now = now();
    transaction.execute(
        "INSERT INTO task_stage_runs (
            id, workflow_run_id, group_key, node_key, node_type,
            target_type, target_id, target_snapshot, execution_target,
            status, attempt, input_snapshot, output_json, version,
            created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, '{}', '{}',
                   1, ?12, ?12)",
        params![
            stage.stage_id,
            stage.run_id,
            stage.group_key,
            stage.node.key,
            stage.node.node_type,
            stage.target_type,
            stage.target_id,
            stage.target_snapshot.to_string(),
            json_string(stage.execution_target)?,
            stage.status,
            stage.attempt,
            now,
        ],
    )?;
    Ok(())
}

pub(super) fn insert_artifact(
    transaction: &Transaction<'_>,
    run_id: &str,
    stage_id: &str,
    artifact_type: &str,
    content: &Value,
) -> Result<(), TaskRuntimeError> {
    validate_artifact(artifact_type, content).map_err(TaskRuntimeError::Invalid)?;
    transaction.execute(
        "INSERT INTO task_workflow_artifacts (
            id, workflow_run_id, stage_run_id, artifact_type,
            schema_version, content_json, created_at
         ) VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6)",
        params![
            workflow_id("LAR"),
            run_id,
            stage_id,
            artifact_type,
            content.to_string(),
            now(),
        ],
    )?;
    Ok(())
}

pub(super) fn set_stage_status(
    transaction: &Transaction<'_>,
    stage_id: &str,
    status: &str,
) -> Result<(), TaskRuntimeError> {
    let current = stage_row(transaction, stage_id)?;
    if !can_transition_stage(&current.status, status) {
        return Err(TaskRuntimeError::Invalid(format!(
            "Stage cannot transition from {} to {status}",
            current.status
        )));
    }
    transaction.execute(
        "UPDATE task_stage_runs SET status = ?1, started_at = COALESCE(started_at, ?2),
                completed_at = CASE WHEN ?1 = 'passed' THEN ?2 ELSE completed_at END,
                version = version + 1, updated_at = ?2 WHERE id = ?3",
        params![status, now(), stage_id],
    )?;
    Ok(())
}

pub(super) fn resolve_binding_target(
    connection: &Connection,
    project_id: &str,
    input: &TaskBindingInput,
) -> Result<(String, String, Value), TaskRuntimeError> {
    match (&input.actor, &input.workflow_id) {
        (Some(actor), None) => {
            let target_id = actor.stable_id().ok_or_else(|| {
                TaskRuntimeError::Invalid("Execution actor identity is incomplete".to_owned())
            })?;
            if actor.actor_type == "project_agent" {
                validate_agent_members(
                    connection,
                    project_id,
                    &target_id,
                    std::slice::from_ref(&target_id),
                )?;
            } else if actor.actor_type == "project_squad" {
                let squad = squad_row(connection, &target_id)?;
                if squad.project_id != project_id {
                    return Err(TaskRuntimeError::Invalid(
                        "Robot squad is not in this project".to_owned(),
                    ));
                }
            }
            Ok((
                actor.actor_type.clone(),
                target_id,
                serde_json::to_value(actor)
                    .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))?,
            ))
        }
        (None, Some(workflow_id)) => {
            let workflow = workflow_row(connection, workflow_id)?;
            if workflow.project_id != project_id {
                return Err(TaskRuntimeError::Invalid(
                    "Workflow is not in this project".to_owned(),
                ));
            }
            Ok((
                "workflow".to_owned(),
                workflow_id.clone(),
                serde_json::to_value(workflow)
                    .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))?,
            ))
        }
        _ => Err(TaskRuntimeError::Invalid(
            "Exactly one execution actor or workflow is required".to_owned(),
        )),
    }
}

pub(super) fn validate_execution_target(
    target: &ExecutionTargetRef,
) -> Result<(), TaskRuntimeError> {
    match target.target_type.as_str() {
        "registered_device" if target.id.as_deref().unwrap_or("").is_empty() => {
            Err(TaskRuntimeError::Invalid(
                "Registered device execution requires a device id".to_owned(),
            ))
        }
        "registered_device" | "managed_container" => Ok(()),
        _ => Err(TaskRuntimeError::Invalid(
            "Execution target must be registered_device or managed_container".to_owned(),
        )),
    }
}

pub(super) fn validate_agent_members(
    connection: &Connection,
    project_id: &str,
    leader_id: &str,
    member_ids: &[String],
) -> Result<(), TaskRuntimeError> {
    for id in member_ids {
        let exists: bool = connection.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM loop_items WHERE id = ?1 AND resource_type = 'chat_agent'
                  AND cloud_project_id = ?2 AND status = 'active' AND deleted_at IS NULL
             )",
            params![id, project_id],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(TaskRuntimeError::Invalid(format!(
                "Robot {id} is not active in this project"
            )));
        }
    }
    if !member_ids.iter().any(|id| id == leader_id) {
        return Err(TaskRuntimeError::Invalid(
            "Robot squad leader must be a member".to_owned(),
        ));
    }
    Ok(())
}

pub(super) fn validate_task(
    connection: &Connection,
    project_id: &str,
    item_id: &str,
) -> Result<(), TaskRuntimeError> {
    let exists: bool = connection.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM loop_items WHERE id = ?1 AND resource_type = 'task'
              AND cloud_project_id = ?2 AND deleted_at IS NULL
         )",
        params![item_id, project_id],
        |row| row.get(0),
    )?;
    if exists {
        Ok(())
    } else {
        Err(TaskRuntimeError::TaskNotFound)
    }
}

pub(super) fn project_id_for_item(
    connection: &Connection,
    item_id: &str,
) -> Result<String, TaskRuntimeError> {
    connection
        .query_row(
            "SELECT cloud_project_id FROM loop_items WHERE id = ?1",
            [item_id],
            |row| row.get(0),
        )
        .map_err(TaskRuntimeError::from)
}

pub(super) fn execution_stage_id(
    connection: &Connection,
    execution_id: i64,
) -> Result<Option<String>, TaskRuntimeError> {
    connection
        .query_row(
            "SELECT stage_run_id FROM loop_item_executions WHERE id = ?1",
            [execution_id],
            |row| row.get(0),
        )
        .optional()
        .map(|value| value.flatten())
        .map_err(TaskRuntimeError::from)
}

pub(super) fn find_node<'a>(
    workflow: &'a WorkflowDefinition,
    group_key: &str,
    node_key: &str,
) -> Result<&'a WorkflowNode, TaskRuntimeError> {
    workflow
        .stages
        .iter()
        .find(|group| group.key == group_key)
        .and_then(|group| group.nodes.iter().find(|node| node.key == node_key))
        .ok_or_else(|| TaskRuntimeError::Invalid("Workflow node is missing".to_owned()))
}

pub(super) fn workflow_snapshot(
    connection: &Connection,
    run_id: &str,
) -> Result<WorkflowDefinition, TaskRuntimeError> {
    let raw: String = connection.query_row(
        "SELECT workflow_definition_snapshot FROM task_workflow_runs WHERE id = ?1",
        [run_id],
        |row| row.get(0),
    )?;
    from_json(&raw)
}

pub(super) fn group_stage_ids(
    connection: &Connection,
    run_id: &str,
    group_key: &str,
) -> Result<Vec<String>, TaskRuntimeError> {
    let mut statement = connection.prepare(
        "SELECT id FROM task_stage_runs
         WHERE workflow_run_id = ?1 AND group_key = ?2 ORDER BY created_at ASC, id ASC",
    )?;
    let result = statement
        .query_map(params![run_id, group_key], |row| row.get(0))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(TaskRuntimeError::from);
    result
}

pub(super) fn group_stages(
    connection: &Connection,
    run_id: &str,
    group_key: &str,
) -> Result<Vec<StageRun>, TaskRuntimeError> {
    let mut statement = connection.prepare(
        "SELECT id, workflow_run_id, group_key, node_key, node_type,
                target_type, target_id, target_snapshot, execution_target,
                status, attempt, loop_item_execution_id, runtime_instance_id,
                runtime_task_id, workspace_id, input_snapshot, output_json,
                failure_code, failure_message, version, created_at, updated_at
         FROM task_stage_runs WHERE workflow_run_id = ?1 AND group_key = ?2
         ORDER BY created_at ASC, id ASC",
    )?;
    let result = collect(statement.query_map(params![run_id, group_key], map_stage)?);
    result
}

pub(super) fn run_detail(
    connection: &Connection,
    run_id: &str,
) -> Result<WorkflowRunDetail, TaskRuntimeError> {
    let run = run_row(connection, run_id)?;
    let mut stages_statement = connection.prepare(
        "SELECT id, workflow_run_id, group_key, node_key, node_type,
                target_type, target_id, target_snapshot, execution_target,
                status, attempt, loop_item_execution_id, runtime_instance_id,
                runtime_task_id, workspace_id, input_snapshot, output_json,
                failure_code, failure_message, version, created_at, updated_at
         FROM task_stage_runs WHERE workflow_run_id = ?1
         ORDER BY created_at ASC, id ASC",
    )?;
    let stages = collect(stages_statement.query_map([run_id], map_stage)?)?;
    let mut artifact_statement = connection.prepare(
        "SELECT id, workflow_run_id, stage_run_id, artifact_type,
                schema_version, content_json, object_key, sha256, created_at
         FROM task_workflow_artifacts WHERE workflow_run_id = ?1 ORDER BY created_at ASC",
    )?;
    let artifacts = collect(artifact_statement.query_map([run_id], map_artifact)?)?;
    Ok(WorkflowRunDetail {
        run,
        stages,
        artifacts,
    })
}
