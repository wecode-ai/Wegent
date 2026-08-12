// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::task_runtime::TaskRuntimeError;

use super::{rows::*, run_engine::*, schema::migrate};
use crate::project_workflows::{
    engine::{validate_repository, validate_squad, validate_workflow},
    transitions::can_transition_stage,
    ConfigurationValidation, RecoverySummary, Repository, RepositoryInput, RepositoryUpdate, Squad,
    SquadInput, SquadUpdate, TaskBinding, TaskBindingInput, WorkflowDefinition, WorkflowInput,
    WorkflowRun, WorkflowRunDetail, WorkflowUpdate,
};

#[derive(Clone)]
pub struct ProjectWorkflowStore {
    path: std::path::PathBuf,
}

impl ProjectWorkflowStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, TaskRuntimeError> {
        let path = path.as_ref().to_path_buf();
        let connection = Connection::open(&path)?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        migrate(&connection)?;
        Ok(Self { path })
    }

    fn connection(&self) -> Result<Connection, TaskRuntimeError> {
        let connection = Connection::open(&self.path)?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        Ok(connection)
    }

    pub fn list_squads(&self, project_id: &str) -> Result<Vec<Squad>, TaskRuntimeError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, project_id, name, leader_agent_id, member_agent_ids,
                    routing_instructions, max_parallel_members, status,
                    created_by_user_id, version, created_at, updated_at
             FROM project_agent_squads
             WHERE project_id = ?1 AND status != 'archived'
             ORDER BY created_at ASC",
        )?;
        let result = collect(statement.query_map([project_id], map_squad)?);
        result
    }

    pub fn create_squad(
        &self,
        project_id: &str,
        user_id: i64,
        input: SquadInput,
    ) -> Result<Squad, TaskRuntimeError> {
        validate_squad(&input).map_err(TaskRuntimeError::Invalid)?;
        let connection = self.connection()?;
        validate_agent_members(
            &connection,
            project_id,
            &input.leader_agent_id,
            &input.member_agent_ids,
        )?;
        let id = workflow_id("LSQ");
        let now = now();
        connection.execute(
            "INSERT INTO project_agent_squads (
                id, project_id, name, leader_agent_id, member_agent_ids,
                routing_instructions, max_parallel_members, status,
                created_by_user_id, version, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'active', ?8, 1, ?9, ?9)",
            params![
                id,
                project_id,
                input.name.trim(),
                input.leader_agent_id,
                json!(input.member_agent_ids).to_string(),
                input.routing_instructions,
                input.max_parallel_members,
                user_id,
                now,
            ],
        )?;
        squad_row(&connection, &id)
    }

    pub fn update_squad(
        &self,
        project_id: &str,
        squad_id: &str,
        input: SquadUpdate,
    ) -> Result<Squad, TaskRuntimeError> {
        let connection = self.connection()?;
        let current = squad_row(&connection, squad_id)?;
        if current.project_id != project_id {
            return Err(TaskRuntimeError::Invalid(
                "Robot squad is not in this project".to_owned(),
            ));
        }
        if current.version != input.version {
            return Err(TaskRuntimeError::VersionConflict);
        }
        let next = SquadInput {
            name: input.name.unwrap_or(current.name),
            leader_agent_id: input.leader_agent_id.unwrap_or(current.leader_agent_id),
            member_agent_ids: input.member_agent_ids.unwrap_or(current.member_agent_ids),
            routing_instructions: input
                .routing_instructions
                .unwrap_or(current.routing_instructions),
            max_parallel_members: input
                .max_parallel_members
                .unwrap_or(current.max_parallel_members),
        };
        validate_squad(&next).map_err(TaskRuntimeError::Invalid)?;
        validate_agent_members(
            &connection,
            project_id,
            &next.leader_agent_id,
            &next.member_agent_ids,
        )?;
        let changed = connection.execute(
            "UPDATE project_agent_squads
             SET name = ?1, leader_agent_id = ?2, member_agent_ids = ?3,
                 routing_instructions = ?4, max_parallel_members = ?5,
                 status = COALESCE(?6, status), version = version + 1, updated_at = ?7
             WHERE id = ?8 AND version = ?9",
            params![
                next.name,
                next.leader_agent_id,
                json!(next.member_agent_ids).to_string(),
                next.routing_instructions,
                next.max_parallel_members,
                input.status,
                now(),
                squad_id,
                input.version,
            ],
        )?;
        version_changed(changed)?;
        squad_row(&connection, squad_id)
    }

    pub fn list_repositories(&self, project_id: &str) -> Result<Vec<Repository>, TaskRuntimeError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, project_id, provider, repository_identity, repository_url,
                    default_branch, local_project_id, default_execution_target,
                    credential_ref, workspace_policy, git_policy, provider_settings,
                    status, created_by_user_id, version, created_at, updated_at
             FROM project_repository_bindings
             WHERE project_id = ?1 AND status != 'archived'
             ORDER BY created_at ASC",
        )?;
        let result = collect(statement.query_map([project_id], map_repository)?);
        result
    }

    pub fn create_repository(
        &self,
        project_id: &str,
        user_id: i64,
        input: RepositoryInput,
    ) -> Result<Repository, TaskRuntimeError> {
        let validation = validate_repository(&input);
        if !validation.valid {
            return Err(TaskRuntimeError::Invalid(validation.issues.join("; ")));
        }
        let connection = self.connection()?;
        let id = workflow_id("LRP");
        let now = now();
        connection.execute(
            "INSERT INTO project_repository_bindings (
                id, project_id, provider, repository_identity, repository_url,
                default_branch, local_project_id, default_execution_target,
                credential_ref, workspace_policy, git_policy, provider_settings,
                status, created_by_user_id, version, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                       'active', ?13, 1, ?14, ?14)",
            params![
                id,
                project_id,
                input.provider,
                input.repository_identity,
                input.repository_url,
                input.default_branch,
                input.local_project_id,
                json_string(&input.default_execution_target)?,
                input.credential_ref,
                object_json(input.workspace_policy),
                object_json(input.git_policy),
                object_json(input.provider_settings),
                user_id,
                now,
            ],
        )?;
        repository_row(&connection, &id)
    }

    pub fn update_repository(
        &self,
        project_id: &str,
        binding_id: &str,
        input: RepositoryUpdate,
    ) -> Result<Repository, TaskRuntimeError> {
        let connection = self.connection()?;
        let current = repository_row(&connection, binding_id)?;
        if current.project_id != project_id {
            return Err(TaskRuntimeError::Invalid(
                "Repository is not in this project".to_owned(),
            ));
        }
        if current.version != input.version {
            return Err(TaskRuntimeError::VersionConflict);
        }
        let changed = connection.execute(
            "UPDATE project_repository_bindings SET
                repository_url = COALESCE(?1, repository_url),
                default_branch = COALESCE(?2, default_branch),
                local_project_id = COALESCE(?3, local_project_id),
                default_execution_target = COALESCE(?4, default_execution_target),
                credential_ref = COALESCE(?5, credential_ref),
                workspace_policy = COALESCE(?6, workspace_policy),
                git_policy = COALESCE(?7, git_policy),
                provider_settings = COALESCE(?8, provider_settings),
                status = COALESCE(?9, status),
                version = version + 1, updated_at = ?10
             WHERE id = ?11 AND version = ?12",
            params![
                input.repository_url,
                input.default_branch,
                input.local_project_id,
                input
                    .default_execution_target
                    .as_ref()
                    .map(json_string)
                    .transpose()?,
                input.credential_ref,
                input.workspace_policy.map(object_json),
                input.git_policy.map(object_json),
                input.provider_settings.map(object_json),
                input.status,
                now(),
                binding_id,
                input.version,
            ],
        )?;
        version_changed(changed)?;
        repository_row(&connection, binding_id)
    }

    pub fn validate_repository_binding(
        &self,
        binding_id: &str,
    ) -> Result<ConfigurationValidation, TaskRuntimeError> {
        let connection = self.connection()?;
        let binding = repository_row(&connection, binding_id)?;
        Ok(validate_repository(&RepositoryInput {
            provider: binding.provider,
            repository_identity: binding.repository_identity,
            repository_url: binding.repository_url,
            default_branch: binding.default_branch,
            local_project_id: binding.local_project_id,
            default_execution_target: binding.default_execution_target,
            credential_ref: None,
            workspace_policy: binding.workspace_policy,
            git_policy: binding.git_policy,
            provider_settings: binding.provider_settings,
        }))
    }

    pub fn list_workflows(
        &self,
        project_id: &str,
    ) -> Result<Vec<WorkflowDefinition>, TaskRuntimeError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, project_id, name, description, trigger_mode,
                    repository_binding_id, stages, failure_policy, is_default,
                    status, created_by_user_id, version, created_at, updated_at
             FROM project_workflow_definitions
             WHERE project_id = ?1 AND status != 'archived'
             ORDER BY is_default DESC, created_at ASC",
        )?;
        let result = collect(statement.query_map([project_id], map_workflow)?);
        result
    }

    pub fn validate_workflow_input(&self, input: &WorkflowInput) -> ConfigurationValidation {
        validate_workflow(input)
    }

    pub fn create_workflow(
        &self,
        project_id: &str,
        user_id: i64,
        input: WorkflowInput,
    ) -> Result<WorkflowDefinition, TaskRuntimeError> {
        let validation = validate_workflow(&input);
        if !validation.valid {
            return Err(TaskRuntimeError::Invalid(validation.issues.join("; ")));
        }
        let connection = self.connection()?;
        let transaction = connection.unchecked_transaction()?;
        if input.is_default {
            transaction.execute(
                "UPDATE project_workflow_definitions SET is_default = 0
                 WHERE project_id = ?1",
                [project_id],
            )?;
        }
        let id = workflow_id("LWF");
        let now = now();
        transaction.execute(
            "INSERT INTO project_workflow_definitions (
                id, project_id, name, description, trigger_mode,
                repository_binding_id, stages, failure_policy, is_default,
                status, created_by_user_id, version, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'active', ?10, 1, ?11, ?11)",
            params![
                id,
                project_id,
                input.name,
                input.description,
                input.trigger_mode,
                input.repository_binding_id,
                json_string(&input.stages)?,
                input.failure_policy,
                input.is_default,
                user_id,
                now,
            ],
        )?;
        transaction.commit()?;
        workflow_row(&connection, &id)
    }

    pub fn update_workflow(
        &self,
        project_id: &str,
        workflow_id: &str,
        input: WorkflowUpdate,
    ) -> Result<WorkflowDefinition, TaskRuntimeError> {
        let connection = self.connection()?;
        let current = workflow_row(&connection, workflow_id)?;
        if current.project_id != project_id {
            return Err(TaskRuntimeError::Invalid(
                "Workflow is not in this project".to_owned(),
            ));
        }
        if current.version != input.version {
            return Err(TaskRuntimeError::VersionConflict);
        }
        let next = WorkflowInput {
            name: input.name.unwrap_or(current.name),
            description: input.description.unwrap_or(current.description),
            trigger_mode: input.trigger_mode.unwrap_or(current.trigger_mode),
            repository_binding_id: input
                .repository_binding_id
                .or(current.repository_binding_id),
            stages: input.stages.unwrap_or(current.stages),
            failure_policy: input.failure_policy.unwrap_or(current.failure_policy),
            is_default: input.is_default.unwrap_or(current.is_default),
        };
        let validation = validate_workflow(&next);
        if !validation.valid {
            return Err(TaskRuntimeError::Invalid(validation.issues.join("; ")));
        }
        let transaction = connection.unchecked_transaction()?;
        if next.is_default {
            transaction.execute(
                "UPDATE project_workflow_definitions SET is_default = 0
                 WHERE project_id = ?1 AND id != ?2",
                params![project_id, workflow_id],
            )?;
        }
        let changed = transaction.execute(
            "UPDATE project_workflow_definitions SET
                name = ?1, description = ?2, trigger_mode = ?3,
                repository_binding_id = ?4, stages = ?5, failure_policy = ?6,
                is_default = ?7, status = COALESCE(?8, status),
                version = version + 1, updated_at = ?9
             WHERE id = ?10 AND version = ?11",
            params![
                next.name,
                next.description,
                next.trigger_mode,
                next.repository_binding_id,
                json_string(&next.stages)?,
                next.failure_policy,
                next.is_default,
                input.status,
                now(),
                workflow_id,
                input.version,
            ],
        )?;
        version_changed(changed)?;
        transaction.commit()?;
        workflow_row(&connection, workflow_id)
    }

    pub fn get_task_binding(&self, item_id: &str) -> Result<Option<TaskBinding>, TaskRuntimeError> {
        let connection = self.connection()?;
        connection
            .query_row(
                "SELECT id, item_id, target_type, target_id, target_snapshot,
                        repository_binding_id, execution_target, workspace_mode,
                        created_by_user_id, version, created_at, updated_at
                 FROM task_execution_bindings WHERE item_id = ?1",
                [item_id],
                map_binding,
            )
            .optional()
            .map_err(TaskRuntimeError::from)
    }

    pub fn upsert_task_binding(
        &self,
        project_id: &str,
        item_id: &str,
        user_id: i64,
        input: TaskBindingInput,
    ) -> Result<TaskBinding, TaskRuntimeError> {
        validate_execution_target(&input.execution_target)?;
        let connection = self.connection()?;
        validate_task(&connection, project_id, item_id)?;
        let (target_type, target_id, target_snapshot) =
            resolve_binding_target(&connection, project_id, &input)?;
        let now = now();
        match self.get_task_binding(item_id)? {
            Some(current) => {
                if input.version != Some(current.version) {
                    return Err(TaskRuntimeError::VersionConflict);
                }
                connection.execute(
                    "UPDATE task_execution_bindings SET
                        target_type = ?1, target_id = ?2, target_snapshot = ?3,
                        repository_binding_id = ?4, execution_target = ?5,
                        workspace_mode = ?6, version = version + 1, updated_at = ?7
                     WHERE item_id = ?8 AND version = ?9",
                    params![
                        target_type,
                        target_id,
                        target_snapshot.to_string(),
                        input.repository_binding_id,
                        json_string(&input.execution_target)?,
                        input.workspace_mode,
                        now,
                        item_id,
                        current.version,
                    ],
                )?;
            }
            None => {
                connection.execute(
                    "INSERT INTO task_execution_bindings (
                        item_id, target_type, target_id, target_snapshot,
                        repository_binding_id, execution_target, workspace_mode,
                        created_by_user_id, version, created_at, updated_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9, ?9)",
                    params![
                        item_id,
                        target_type,
                        target_id,
                        target_snapshot.to_string(),
                        input.repository_binding_id,
                        json_string(&input.execution_target)?,
                        input.workspace_mode,
                        user_id,
                        now,
                    ],
                )?;
            }
        }
        let binding = self
            .get_task_binding(item_id)?
            .ok_or(TaskRuntimeError::TaskNotFound)?;
        if input.start_after_save {
            self.start_run(
                project_id,
                item_id,
                user_id,
                &Uuid::new_v4().to_string(),
                None,
            )?;
        }
        Ok(binding)
    }

    pub fn list_runs(&self, item_id: &str) -> Result<Vec<WorkflowRun>, TaskRuntimeError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, item_id, workflow_definition_id, status, current_group_key,
                    repository_binding_id, execution_target, execution_target_snapshot,
                    failure_code, failure_message, trigger_message_id,
                    version, created_at, updated_at
             FROM task_workflow_runs WHERE item_id = ?1 ORDER BY created_at DESC",
        )?;
        let result = collect(statement.query_map([item_id], map_run)?);
        result
    }

    pub fn get_run(&self, run_id: &str) -> Result<WorkflowRunDetail, TaskRuntimeError> {
        let connection = self.connection()?;
        run_detail(&connection, run_id)
    }

    pub fn start_run(
        &self,
        project_id: &str,
        item_id: &str,
        user_id: i64,
        idempotency_key: &str,
        trigger_message_id: Option<&str>,
    ) -> Result<WorkflowRun, TaskRuntimeError> {
        let connection = self.connection()?;
        validate_task(&connection, project_id, item_id)?;
        if let Some(run) = connection
            .query_row(
                "SELECT id, item_id, workflow_definition_id, status, current_group_key,
                        repository_binding_id, execution_target, execution_target_snapshot,
                        failure_code, failure_message, trigger_message_id,
                        version, created_at, updated_at
                 FROM task_workflow_runs WHERE idempotency_key = ?1",
                [idempotency_key],
                map_run,
            )
            .optional()?
        {
            return Ok(run);
        }
        let binding = self.get_task_binding(item_id)?.ok_or_else(|| {
            TaskRuntimeError::Invalid("Task has no AI execution binding".to_owned())
        })?;
        if binding.target_type != "workflow" {
            return Err(TaskRuntimeError::Invalid(
                "Task binding must target a workflow".to_owned(),
            ));
        }
        let workflow = workflow_row(&connection, &binding.target_id)?;
        let run_id = workflow_id("LWR");
        let first_group = workflow.stages.first().map(|group| group.key.clone());
        let now = now();
        let transaction = connection.unchecked_transaction()?;
        transaction.execute(
            "INSERT INTO task_workflow_runs (
                id, item_id, workflow_definition_id, workflow_definition_snapshot,
                repository_binding_id, execution_target, execution_target_snapshot,
                status, current_group_key, started_by_type, started_by_id,
                idempotency_key, trigger_message_id, version, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, 'running', ?7, 'user', ?8,
                       ?9, ?10, 1, ?11, ?11)",
            params![
                run_id,
                item_id,
                workflow.id,
                json_string(&workflow)?,
                binding.repository_binding_id,
                json_string(&binding.execution_target)?,
                first_group,
                user_id.to_string(),
                idempotency_key,
                trigger_message_id,
                now,
            ],
        )?;
        create_workspace_records(&transaction, project_id, item_id, &binding, &run_id)?;
        activate_group(
            &transaction,
            project_id,
            item_id,
            &run_id,
            &workflow,
            0,
            &binding.execution_target,
        )?;
        advance_run(&transaction, project_id, item_id, &run_id)?;
        transaction.commit()?;
        run_row(&connection, &run_id)
    }

    pub fn approve_stage(
        &self,
        project_id: &str,
        run_id: &str,
        stage_id: &str,
        version: i64,
        reason: Option<&str>,
    ) -> Result<WorkflowRunDetail, TaskRuntimeError> {
        self.finish_gate(project_id, run_id, stage_id, version, "passed", reason)
    }

    pub fn reject_stage(
        &self,
        project_id: &str,
        run_id: &str,
        stage_id: &str,
        version: i64,
        reason: Option<&str>,
    ) -> Result<WorkflowRunDetail, TaskRuntimeError> {
        self.finish_gate(project_id, run_id, stage_id, version, "rejected", reason)
    }

    fn finish_gate(
        &self,
        project_id: &str,
        run_id: &str,
        stage_id: &str,
        version: i64,
        target: &str,
        reason: Option<&str>,
    ) -> Result<WorkflowRunDetail, TaskRuntimeError> {
        let connection = self.connection()?;
        let transaction = connection.unchecked_transaction()?;
        let stage = stage_row(&transaction, stage_id)?;
        if stage.workflow_run_id != run_id || stage.version != version {
            return Err(TaskRuntimeError::VersionConflict);
        }
        if !can_transition_stage(&stage.status, target) {
            return Err(TaskRuntimeError::Invalid(format!(
                "Stage cannot transition from {} to {target}",
                stage.status
            )));
        }
        let output = json!({"reason": reason, "decision": target});
        transaction.execute(
            "UPDATE task_stage_runs SET status = ?1, output_json = ?2,
                    completed_at = ?3, version = version + 1, updated_at = ?3
             WHERE id = ?4 AND version = ?5",
            params![target, output.to_string(), now(), stage_id, version],
        )?;
        insert_artifact(&transaction, run_id, stage_id, "approval_decision", &output)?;
        if target == "rejected" {
            transaction.execute(
                "UPDATE task_workflow_runs SET status = 'blocked',
                        failure_code = 'stage_rejected', failure_message = ?1,
                        version = version + 1, updated_at = ?2 WHERE id = ?3",
                params![reason.unwrap_or("Stage rejected"), now(), run_id],
            )?;
        } else {
            let item_id: String = transaction.query_row(
                "SELECT item_id FROM task_workflow_runs WHERE id = ?1",
                [run_id],
                |row| row.get(0),
            )?;
            advance_run(&transaction, project_id, &item_id, run_id)?;
        }
        transaction.commit()?;
        run_detail(&connection, run_id)
    }

    pub fn retry_stage(
        &self,
        project_id: &str,
        run_id: &str,
        stage_id: &str,
        version: i64,
    ) -> Result<WorkflowRunDetail, TaskRuntimeError> {
        let connection = self.connection()?;
        let transaction = connection.unchecked_transaction()?;
        let stage = stage_row(&transaction, stage_id)?;
        if stage.workflow_run_id != run_id || stage.version != version {
            return Err(TaskRuntimeError::VersionConflict);
        }
        if !matches!(stage.status.as_str(), "failed" | "rejected") {
            return Err(TaskRuntimeError::Invalid(
                "Only failed or rejected stages can be retried".to_owned(),
            ));
        }
        let run = run_row(&transaction, run_id)?;
        let workflow = workflow_snapshot(&transaction, run_id)?;
        let node = find_node(&workflow, &stage.group_key, &stage.node_key)?;
        let retry_id = workflow_id("LSR");
        insert_stage(
            &transaction,
            &NewStage {
                stage_id: &retry_id,
                run_id,
                group_key: &stage.group_key,
                node,
                execution_target: &run.execution_target,
                attempt: stage.attempt + 1,
                status: "pending",
                target_type: stage.target_type.as_deref(),
                target_id: stage.target_id.as_deref(),
                target_snapshot: &stage.target_snapshot,
            },
        )?;
        let scope = RunScope {
            project_id,
            item_id: &run.item_id,
            run_id,
            execution_target: &run.execution_target,
        };
        activate_stage(
            &transaction,
            &scope,
            &retry_id,
            node,
            stage.target_id.as_deref(),
        )?;
        transaction.execute(
            "UPDATE task_workflow_runs SET status = 'running', failure_code = NULL,
                    failure_message = NULL, version = version + 1, updated_at = ?1
             WHERE id = ?2",
            params![now(), run_id],
        )?;
        transaction.commit()?;
        run_detail(&connection, run_id)
    }

    pub fn cancel_run(
        &self,
        run_id: &str,
        version: i64,
    ) -> Result<WorkflowRunDetail, TaskRuntimeError> {
        let connection = self.connection()?;
        let transaction = connection.unchecked_transaction()?;
        let run = run_row(&transaction, run_id)?;
        if run.version != version {
            return Err(TaskRuntimeError::VersionConflict);
        }
        transaction.execute(
            "UPDATE loop_item_executions SET status = 'cancelled', completed_at = ?1,
                    lease_expires_at = NULL, version = version + 1, updated_at = ?1
             WHERE workflow_run_id = ?2 AND status IN ('pending_approval', 'queued', 'running')",
            params![now(), run_id],
        )?;
        transaction.execute(
            "UPDATE task_stage_runs SET status = 'cancelled', completed_at = ?1,
                    version = version + 1, updated_at = ?1
             WHERE workflow_run_id = ?2
               AND status NOT IN ('passed', 'failed', 'rejected', 'cancelled', 'skipped')",
            params![now(), run_id],
        )?;
        transaction.execute(
            "UPDATE task_workflow_runs SET status = 'cancelled', cancelled_at = ?1,
                    version = version + 1, updated_at = ?1 WHERE id = ?2",
            params![now(), run_id],
        )?;
        transaction.commit()?;
        run_detail(&connection, run_id)
    }

    pub fn on_execution_terminal(
        &self,
        execution_id: i64,
        succeeded: bool,
        message: &str,
    ) -> Result<(), TaskRuntimeError> {
        let connection = self.connection()?;
        let transaction = connection.unchecked_transaction()?;
        let stage_id: Option<String> = transaction
            .query_row(
                "SELECT stage_run_id FROM loop_item_executions WHERE id = ?1",
                [execution_id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        let Some(stage_id) = stage_id else {
            return Ok(());
        };
        let stage = stage_row(&transaction, &stage_id)?;
        if matches!(
            stage.status.as_str(),
            "passed" | "failed" | "cancelled" | "rejected" | "skipped"
        ) {
            return Ok(());
        }
        let status = if succeeded { "passed" } else { "failed" };
        let output = json!({"message": message, "executionId": execution_id});
        transaction.execute(
            "UPDATE task_stage_runs SET status = ?1, output_json = ?2,
                    failure_message = ?3, completed_at = ?4,
                    version = version + 1, updated_at = ?4 WHERE id = ?5",
            params![
                status,
                output.to_string(),
                if succeeded { None } else { Some(message) },
                now(),
                stage_id,
            ],
        )?;
        if succeeded {
            insert_artifact(
                &transaction,
                &stage.workflow_run_id,
                &stage.id,
                "execution_result",
                &output,
            )?;
        }
        let run = run_row(&transaction, &stage.workflow_run_id)?;
        if succeeded {
            advance_run(
                &transaction,
                &project_id_for_item(&transaction, &run.item_id)?,
                &run.item_id,
                &run.id,
            )?;
        } else {
            transaction.execute(
                "UPDATE task_workflow_runs SET status = 'blocked',
                        failure_code = 'stage_failed', failure_message = ?1,
                        version = version + 1, updated_at = ?2 WHERE id = ?3",
                params![message, now(), run.id],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn on_execution_claimed(&self, execution_id: i64) -> Result<(), TaskRuntimeError> {
        self.update_stage_execution_state(execution_id, "claimed", None, None)
    }

    pub fn on_execution_started(
        &self,
        execution_id: i64,
        runtime_instance_id: Option<&str>,
        runtime_task_id: Option<&str>,
    ) -> Result<(), TaskRuntimeError> {
        self.update_stage_execution_state(
            execution_id,
            "running",
            runtime_instance_id,
            runtime_task_id,
        )
    }

    pub fn on_execution_approved(&self, execution_id: i64) -> Result<(), TaskRuntimeError> {
        self.update_stage_execution_state(execution_id, "queued", None, None)
    }

    pub fn on_execution_rejected(
        &self,
        execution_id: i64,
        reason: &str,
    ) -> Result<(), TaskRuntimeError> {
        let connection = self.connection()?;
        let Some(stage_id) = execution_stage_id(&connection, execution_id)? else {
            return Ok(());
        };
        let stage = stage_row(&connection, &stage_id)?;
        if !can_transition_stage(&stage.status, "rejected") {
            return Ok(());
        }
        connection.execute(
            "UPDATE task_stage_runs SET status = 'rejected', failure_message = ?1,
                    completed_at = ?2, version = version + 1, updated_at = ?2
             WHERE id = ?3",
            params![reason, now(), stage_id],
        )?;
        connection.execute(
            "UPDATE task_workflow_runs SET status = 'blocked',
                    failure_code = 'execution_rejected', failure_message = ?1,
                    version = version + 1, updated_at = ?2 WHERE id = ?3",
            params![reason, now(), stage.workflow_run_id],
        )?;
        Ok(())
    }

    fn update_stage_execution_state(
        &self,
        execution_id: i64,
        target_status: &str,
        runtime_instance_id: Option<&str>,
        runtime_task_id: Option<&str>,
    ) -> Result<(), TaskRuntimeError> {
        let connection = self.connection()?;
        let Some(stage_id) = execution_stage_id(&connection, execution_id)? else {
            return Ok(());
        };
        let stage = stage_row(&connection, &stage_id)?;
        if !can_transition_stage(&stage.status, target_status) {
            return Ok(());
        }
        connection.execute(
            "UPDATE task_stage_runs SET status = ?1,
                    runtime_instance_id = COALESCE(?2, runtime_instance_id),
                    runtime_task_id = COALESCE(?3, runtime_task_id),
                    started_at = COALESCE(started_at, ?4),
                    version = version + 1, updated_at = ?4 WHERE id = ?5",
            params![
                target_status,
                runtime_instance_id,
                runtime_task_id,
                now(),
                stage_id,
            ],
        )?;
        Ok(())
    }

    pub fn get_task_development(&self, item_id: &str) -> Result<Vec<Value>, TaskRuntimeError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT d.id, d.item_id, d.repository_binding_id, d.workspace_id,
                    d.branch_name, d.base_branch, d.head_commit, d.provider,
                    d.pull_request_id, d.pull_request_number, d.pull_request_url,
                    d.pull_request_state, d.draft, d.mergeable_state,
                    d.review_decision, d.ci_state, d.merged_commit,
                    d.version, d.created_at, d.updated_at,
                    w.execution_target, w.source_workspace_path, w.workspace_path,
                    w.workspace_kind, w.status, w.cleanup_policy, w.version,
                    w.created_at, w.updated_at
             FROM task_development_links d
             LEFT JOIN task_workspaces w ON w.id = d.workspace_id
             WHERE d.item_id = ?1 ORDER BY d.created_at DESC",
        )?;
        let rows = statement.query_map([item_id], |row| {
            let workspace_id = row.get::<_, Option<String>>(3)?;
            let workspace = workspace_id.map(|id| {
                json!({
                    "id": id,
                    "itemId": row.get::<_, String>(1).unwrap_or_default(),
                    "repositoryBindingId": row.get::<_, String>(2).unwrap_or_default(),
                    "executionTarget": row.get::<_, Option<String>>(20).ok().flatten()
                        .map(|value| json_value(&value))
                        .unwrap_or_else(|| json!({"type": "registered_device"})),
                    "sourceWorkspacePath": row.get::<_, Option<String>>(21).unwrap_or(None),
                    "workspacePath": row.get::<_, Option<String>>(22).unwrap_or(None),
                    "workspaceKind": row.get::<_, Option<String>>(23).unwrap_or(None).unwrap_or_default(),
                    "branchName": row.get::<_, String>(4).unwrap_or_default(),
                    "baseBranch": row.get::<_, String>(5).unwrap_or_default(),
                    "headCommit": row.get::<_, Option<String>>(6).unwrap_or(None),
                    "status": row.get::<_, Option<String>>(24).unwrap_or(None).unwrap_or_default(),
                    "cleanupPolicy": row.get::<_, Option<String>>(25).unwrap_or(None).unwrap_or_default(),
                    "version": row.get::<_, Option<i64>>(26).unwrap_or(Some(1)).unwrap_or(1),
                    "createdAt": row.get::<_, Option<String>>(27).unwrap_or(None).unwrap_or_default(),
                    "updatedAt": row.get::<_, Option<String>>(28).unwrap_or(None).unwrap_or_default(),
                })
            });
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "itemId": row.get::<_, String>(1)?,
                "repositoryBindingId": row.get::<_, String>(2)?,
                "workspace": workspace,
                "branchName": row.get::<_, String>(4)?,
                "baseBranch": row.get::<_, String>(5)?,
                "headCommit": row.get::<_, Option<String>>(6)?,
                "provider": row.get::<_, String>(7)?,
                "pullRequestId": row.get::<_, Option<String>>(8)?,
                "pullRequestNumber": row.get::<_, Option<i64>>(9)?,
                "pullRequestUrl": row.get::<_, Option<String>>(10)?,
                "pullRequestState": row.get::<_, Option<String>>(11)?,
                "draft": row.get::<_, bool>(12)?,
                "mergeableState": row.get::<_, Option<String>>(13)?,
                "reviewDecision": row.get::<_, Option<String>>(14)?,
                "ciState": row.get::<_, Option<String>>(15)?,
                "mergedCommit": row.get::<_, Option<String>>(16)?,
                "checks": [],
                "reviewThreads": [],
                "version": row.get::<_, i64>(17)?,
                "createdAt": row.get::<_, String>(18)?,
                "updatedAt": row.get::<_, String>(19)?,
            }))
        })?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(TaskRuntimeError::from)
    }

    pub fn recover(&self) -> Result<RecoverySummary, TaskRuntimeError> {
        let connection = self.connection()?;
        let run_ids = {
            let mut statement = connection.prepare(
                "SELECT id FROM task_workflow_runs
                 WHERE status IN ('running', 'queued', 'waiting_approval')",
            )?;
            let result = statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            result
        };
        let transaction = connection.unchecked_transaction()?;
        let mut summary = RecoverySummary::default();
        for run_id in run_ids {
            let run = run_row(&transaction, &run_id)?;
            let before = run.status;
            advance_run(
                &transaction,
                &project_id_for_item(&transaction, &run.item_id)?,
                &run.item_id,
                &run_id,
            )?;
            let after = run_row(&transaction, &run_id)?.status;
            if before != after {
                summary.advanced += 1;
            }
        }
        transaction.commit()?;
        Ok(summary)
    }
}
