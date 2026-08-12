use rusqlite::{params, Connection};
use serde_json::{json, Value};

use crate::task_runtime::TaskRuntimeError;

use super::rows::{ensure_column, json_value, now};

pub(super) fn migrate(connection: &Connection) -> Result<(), TaskRuntimeError> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS project_agent_squads (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            name TEXT NOT NULL,
            leader_agent_id TEXT NOT NULL,
            member_agent_ids TEXT NOT NULL,
            routing_instructions TEXT NOT NULL DEFAULT '',
            max_parallel_members INTEGER NOT NULL DEFAULT 1,
            status TEXT NOT NULL DEFAULT 'active',
            created_by_user_id INTEGER NOT NULL DEFAULT 0,
            version INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ix_local_squads_project
            ON project_agent_squads(project_id, status);
        CREATE TABLE IF NOT EXISTS project_repository_bindings (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            provider TEXT NOT NULL,
            repository_identity TEXT NOT NULL,
            repository_url TEXT NOT NULL,
            default_branch TEXT NOT NULL,
            local_project_id INTEGER,
            default_execution_target TEXT,
            credential_ref TEXT,
            workspace_policy TEXT NOT NULL DEFAULT '{}',
            git_policy TEXT NOT NULL DEFAULT '{}',
            provider_settings TEXT NOT NULL DEFAULT '{}',
            status TEXT NOT NULL DEFAULT 'active',
            created_by_user_id INTEGER NOT NULL DEFAULT 0,
            version INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(project_id, provider, repository_identity)
        );
        CREATE TABLE IF NOT EXISTS project_workflow_definitions (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            trigger_mode TEXT NOT NULL DEFAULT 'manual',
            repository_binding_id TEXT,
            stages TEXT NOT NULL,
            failure_policy TEXT NOT NULL DEFAULT 'pause',
            is_default INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'active',
            created_by_user_id INTEGER NOT NULL DEFAULT 0,
            version INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ix_local_workflows_project
            ON project_workflow_definitions(project_id, status, is_default);
        CREATE TABLE IF NOT EXISTS task_execution_bindings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            item_id TEXT NOT NULL UNIQUE,
            target_type TEXT NOT NULL,
            target_id TEXT NOT NULL,
            target_snapshot TEXT NOT NULL DEFAULT '{}',
            repository_binding_id TEXT,
            execution_target TEXT NOT NULL,
            workspace_mode TEXT NOT NULL,
            created_by_user_id INTEGER NOT NULL DEFAULT 0,
            version INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS task_workflow_runs (
            id TEXT PRIMARY KEY,
            item_id TEXT NOT NULL,
            workflow_definition_id TEXT,
            workflow_definition_snapshot TEXT NOT NULL,
            repository_binding_id TEXT,
            execution_target TEXT NOT NULL,
            execution_target_snapshot TEXT NOT NULL,
            status TEXT NOT NULL,
            current_group_key TEXT,
            started_by_type TEXT NOT NULL,
            started_by_id TEXT NOT NULL,
            idempotency_key TEXT NOT NULL UNIQUE,
            trigger_message_id TEXT,
            started_at TEXT,
            completed_at TEXT,
            cancelled_at TEXT,
            failure_code TEXT,
            failure_message TEXT,
            version INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ix_local_workflow_runs_item
            ON task_workflow_runs(item_id, created_at);
        CREATE TABLE IF NOT EXISTS task_stage_runs (
            id TEXT PRIMARY KEY,
            workflow_run_id TEXT NOT NULL,
            group_key TEXT NOT NULL,
            node_key TEXT NOT NULL,
            node_type TEXT NOT NULL,
            target_type TEXT,
            target_id TEXT,
            target_snapshot TEXT NOT NULL DEFAULT '{}',
            execution_target TEXT NOT NULL,
            status TEXT NOT NULL,
            attempt INTEGER NOT NULL DEFAULT 1,
            loop_item_execution_id INTEGER,
            runtime_instance_id TEXT,
            runtime_task_id TEXT,
            workspace_id TEXT,
            started_at TEXT,
            completed_at TEXT,
            input_snapshot TEXT NOT NULL DEFAULT '{}',
            output_json TEXT NOT NULL DEFAULT '{}',
            failure_code TEXT,
            failure_message TEXT,
            version INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(workflow_run_id, node_key, target_id, attempt)
        );
        CREATE INDEX IF NOT EXISTS ix_local_stage_runs_run
            ON task_stage_runs(workflow_run_id, group_key, status);
        CREATE TABLE IF NOT EXISTS task_workflow_artifacts (
            id TEXT PRIMARY KEY,
            workflow_run_id TEXT NOT NULL,
            stage_run_id TEXT NOT NULL,
            artifact_type TEXT NOT NULL,
            schema_version INTEGER NOT NULL DEFAULT 1,
            content_json TEXT NOT NULL DEFAULT '{}',
            object_key TEXT,
            sha256 TEXT,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ix_local_artifacts_run
            ON task_workflow_artifacts(workflow_run_id, stage_run_id);
        CREATE TABLE IF NOT EXISTS task_workspaces (
            id TEXT PRIMARY KEY,
            item_id TEXT NOT NULL,
            repository_binding_id TEXT NOT NULL,
            execution_target TEXT NOT NULL,
            source_workspace_path TEXT,
            workspace_path TEXT,
            workspace_kind TEXT NOT NULL,
            branch_name TEXT NOT NULL,
            base_branch TEXT NOT NULL,
            head_commit TEXT,
            status TEXT NOT NULL,
            cleanup_policy TEXT NOT NULL,
            version INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS task_development_links (
            id TEXT PRIMARY KEY,
            item_id TEXT NOT NULL,
            repository_binding_id TEXT NOT NULL,
            workspace_id TEXT,
            branch_name TEXT NOT NULL,
            base_branch TEXT NOT NULL,
            head_commit TEXT,
            provider TEXT NOT NULL,
            pull_request_id TEXT,
            pull_request_number INTEGER,
            pull_request_url TEXT,
            pull_request_state TEXT,
            draft INTEGER NOT NULL DEFAULT 0,
            mergeable_state TEXT,
            review_decision TEXT,
            ci_state TEXT,
            merged_commit TEXT,
            version INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS task_development_checks (
            id TEXT PRIMARY KEY,
            development_link_id TEXT NOT NULL,
            provider_check_id TEXT NOT NULL,
            name TEXT NOT NULL,
            status TEXT NOT NULL,
            conclusion TEXT,
            details_url TEXT,
            started_at TEXT,
            completed_at TEXT,
            updated_at TEXT NOT NULL,
            UNIQUE(development_link_id, provider_check_id)
        );",
    )?;
    ensure_column(
        connection,
        "loop_item_executions",
        "workflow_run_id",
        "TEXT",
    )?;
    ensure_column(connection, "loop_item_executions", "stage_run_id", "TEXT")?;
    ensure_column(
        connection,
        "task_workflow_runs",
        "trigger_message_id",
        "TEXT",
    )?;
    ensure_column(
        connection,
        "loop_item_executions",
        "workflow_attempt",
        "INTEGER NOT NULL DEFAULT 1",
    )?;
    migrate_legacy_agent_assignments(connection)?;
    Ok(())
}

fn migrate_legacy_agent_assignments(connection: &Connection) -> Result<(), TaskRuntimeError> {
    let columns = connection
        .prepare("PRAGMA table_info(loop_items)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    if !columns.iter().any(|column| column == "assignee_agent_id") {
        return Ok(());
    }

    let legacy_bindings = {
        let mut statement = connection.prepare(
            "SELECT task.id, task.assignee_agent_id,
                    COALESCE(task.created_by_user_id, 0),
                    COALESCE(agent.name, agent.title, ''),
                    COALESCE(agent.version, 1),
                    COALESCE(agent.metadata, '{}')
             FROM loop_items task
             LEFT JOIN loop_items agent
               ON agent.id = task.assignee_agent_id
              AND agent.resource_type = 'chat_agent'
             WHERE task.resource_type = 'task'
               AND task.deleted_at IS NULL
               AND task.assignee_agent_id IS NOT NULL
               AND task.assignee_agent_id != ''",
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };

    let migrated_at = now();
    for (item_id, agent_id, user_id, agent_name, agent_version, metadata_json) in legacy_bindings {
        let metadata = json_value(&metadata_json);
        let device_id = metadata
            .get("execution_device_id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty());
        let execution_target = match device_id {
            Some(id) => json!({"type": "registered_device", "id": id}),
            None => json!({"type": "managed_container", "id": null}),
        };
        let target_snapshot = json!({
            "type": "project_agent",
            "id": agent_id,
            "name": agent_name,
            "version": agent_version,
        });
        connection.execute(
            "INSERT OR IGNORE INTO task_execution_bindings (
                item_id, target_type, target_id, target_snapshot,
                repository_binding_id, execution_target, workspace_mode,
                created_by_user_id, version, created_at, updated_at
             ) VALUES (?1, 'project_agent', ?2, ?3, NULL, ?4, 'shared',
                       ?5, 1, ?6, ?6)",
            params![
                item_id,
                agent_id,
                target_snapshot.to_string(),
                execution_target.to_string(),
                user_id,
                migrated_at,
            ],
        )?;
    }

    connection.execute("DROP INDEX IF EXISTS ix_loop_items_assignee_agent_id", [])?;
    connection.execute("ALTER TABLE loop_items DROP COLUMN assignee_agent_id", [])?;
    Ok(())
}
