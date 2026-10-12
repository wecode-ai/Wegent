// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use rusqlite::{params, Connection, Transaction, TransactionBehavior};

use super::{
    ensure_default_work_item_project, local_execution_activity, now, TaskRuntimeError,
    LOCAL_SCHEMA_VERSION,
};

pub(super) fn migrate(connection: &Connection) -> Result<(), TaskRuntimeError> {
    if schema_is_current(connection)? {
        ensure_default_work_item_project(connection)?;
        return Ok(());
    }
    let started = std::time::Instant::now();
    let transaction = Transaction::new_unchecked(connection, TransactionBehavior::Immediate)?;
    let connection = &transaction;
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS loop_items (
            id TEXT PRIMARY KEY,
            resource_type TEXT NOT NULL,
            project_space TEXT NOT NULL DEFAULT 'default',
            cloud_project_id TEXT REFERENCES loop_items(id) ON DELETE CASCADE,
            parent_id TEXT REFERENCES loop_items(id) ON DELETE CASCADE,
            loop_item_id TEXT REFERENCES loop_items(id) ON DELETE CASCADE,
            delivery_id TEXT REFERENCES loop_items(id) ON DELETE CASCADE,
            public_id TEXT UNIQUE,
            project_key TEXT UNIQUE,
            name TEXT,
            title TEXT,
            description TEXT NOT NULL DEFAULT '',
            storage_prefix TEXT UNIQUE,
            sequence_number INTEGER,
            next_item_number INTEGER,
            created_by_user_id INTEGER,
            updated_by_user_id INTEGER,
            assignee_user_id INTEGER,
            user_id INTEGER,
            added_by_user_id INTEGER,
            source TEXT,
            status TEXT,
            priority TEXT,
            due_at TEXT,
            sort_order INTEGER NOT NULL DEFAULT 0,
            current_delivery_id TEXT,
            local_project_id INTEGER,
            device_id TEXT,
            is_default INTEGER,
            task_user_id INTEGER,
            task_id TEXT,
            task_title TEXT,
            backend_task_id INTEGER,
            linked_by_user_id INTEGER,
            linked_at TEXT,
            unlinked_at TEXT,
            path TEXT,
            kind TEXT,
            display_name TEXT,
            relative_path TEXT,
            object_key TEXT,
            content_type TEXT,
            size_bytes INTEGER,
            sha256 TEXT,
            source_task_binding_id TEXT,
            source_task_snapshot TEXT,
            markdown_object_key TEXT,
            chat_object_key TEXT,
            manifest_object_key TEXT,
            metadata TEXT,
            version INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            completed_at TEXT,
            delivered_at TEXT,
            deleted_at TEXT,
            assignee_agent_id TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_loop_items_project_type
            ON loop_items(cloud_project_id, resource_type);
        CREATE INDEX IF NOT EXISTS idx_loop_items_parent_type
            ON loop_items(parent_id, resource_type, sort_order);
        CREATE INDEX IF NOT EXISTS idx_loop_items_project_path
            ON loop_items(cloud_project_id, path);
        CREATE INDEX IF NOT EXISTS ix_loop_items_resource_type
            ON loop_items(resource_type);
        CREATE INDEX IF NOT EXISTS ix_loop_items_project_space
            ON loop_items(project_space);
        CREATE INDEX IF NOT EXISTS ix_loop_items_deleted_at
            ON loop_items(deleted_at);
        CREATE TABLE IF NOT EXISTS loop_item_executions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            loop_item_id TEXT NOT NULL,
            cloud_project_id TEXT NOT NULL,
            agent_id TEXT NOT NULL,
            execution_environment TEXT NOT NULL DEFAULT 'local',
            execution_device_id TEXT,
            runtime_instance_id TEXT NOT NULL DEFAULT '',
            assigner_user_id INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'queued',
            priority_weight INTEGER NOT NULL DEFAULT 0,
            queued_at TEXT,
            started_at TEXT,
            completed_at TEXT,
            lease_expires_at TEXT,
            heartbeat_at TEXT,
            retry_attempt INTEGER NOT NULL DEFAULT 0,
            max_retries INTEGER NOT NULL DEFAULT 1,
            error_message TEXT NOT NULL DEFAULT '',
            execution_note TEXT NOT NULL DEFAULT '',
            approval_status TEXT,
            approved_by_user_id INTEGER,
            approved_at TEXT,
            rejected_reason TEXT,
            runtime_device_id TEXT,
            runtime_task_id TEXT,
            execution_payload TEXT,
            attempt_no INTEGER NOT NULL DEFAULT 1,
            previous_execution_id INTEGER,
            execution_scope TEXT NOT NULL DEFAULT '',
            observed_state TEXT NOT NULL DEFAULT 'unconfirmed',
            sync_state TEXT NOT NULL DEFAULT 'pending',
            claimed_at TEXT,
            start_requested_at TEXT,
            observed_at TEXT,
            cancel_requested_at TEXT,
            last_event_seq INTEGER NOT NULL DEFAULT 0,
            termination_reason TEXT NOT NULL DEFAULT '',
            version INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ix_exec_device_status_order
            ON loop_item_executions(execution_device_id, status, priority_weight, queued_at);
        CREATE INDEX IF NOT EXISTS ix_exec_agent_status
            ON loop_item_executions(agent_id, status);
        CREATE INDEX IF NOT EXISTS ix_exec_item_status
            ON loop_item_executions(loop_item_id, status);
        CREATE TABLE IF NOT EXISTS loop_item_comments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            message_id TEXT NOT NULL UNIQUE,
            client_message_id TEXT,
            project_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            sender_type TEXT NOT NULL,
            sender_id TEXT NOT NULL,
            sender_name TEXT NOT NULL,
            message_type TEXT NOT NULL DEFAULT 'text',
            content TEXT NOT NULL DEFAULT '',
            metadata TEXT NOT NULL DEFAULT '{}',
            trigger_message_id TEXT,
            reply_to_message_id TEXT,
            thread_root_message_id TEXT,
            status TEXT NOT NULL DEFAULT 'completed',
            sequence_number INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            deleted_at TEXT
        );
        CREATE INDEX IF NOT EXISTS ix_loop_item_comments_task
            ON loop_item_comments(task_id, sequence_number);
        CREATE TABLE IF NOT EXISTS project_provider_credentials (
            project_store TEXT NOT NULL,
            project_id TEXT NOT NULL,
            task_provider TEXT NOT NULL,
            provider_config TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(project_store, project_id)
        );
        CREATE TABLE IF NOT EXISTS external_project_catalog (
            project_store TEXT NOT NULL,
            project_id TEXT NOT NULL,
            descriptor TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(project_store, project_id)
        );",
    )?;
    // Existing databases created before assignee_agent_id existed.
    let has_assignee_agent = connection
        .prepare("PRAGMA table_info(loop_items)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?
        .iter()
        .any(|column| column == "assignee_agent_id");
    if !has_assignee_agent {
        connection.execute(
            "ALTER TABLE loop_items ADD COLUMN assignee_agent_id TEXT",
            [],
        )?;
    }
    let execution_columns = connection
        .prepare("PRAGMA table_info(loop_item_executions)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    for (column, definition) in [
        // Earlier upgrades only added this field to newly created tables.
        ("execution_payload", "TEXT"),
        ("attempt_no", "INTEGER NOT NULL DEFAULT 1"),
        ("previous_execution_id", "INTEGER"),
        ("execution_scope", "TEXT NOT NULL DEFAULT ''"),
        ("observed_state", "TEXT NOT NULL DEFAULT 'unconfirmed'"),
        ("sync_state", "TEXT NOT NULL DEFAULT 'pending'"),
        ("claimed_at", "TEXT"),
        ("start_requested_at", "TEXT"),
        ("observed_at", "TEXT"),
        ("cancel_requested_at", "TEXT"),
        ("last_event_seq", "INTEGER NOT NULL DEFAULT 0"),
        ("termination_reason", "TEXT NOT NULL DEFAULT ''"),
        ("runtime_instance_id", "TEXT NOT NULL DEFAULT ''"),
    ] {
        if !execution_columns.iter().any(|existing| existing == column) {
            connection.execute(
                &format!("ALTER TABLE loop_item_executions ADD COLUMN {column} {definition}"),
                [],
            )?;
        }
    }
    connection.execute_batch(
        "UPDATE loop_item_executions
         SET attempt_no = CASE WHEN attempt_no < retry_attempt + 1
                               THEN retry_attempt + 1 ELSE attempt_no END,
             execution_scope = CASE WHEN execution_scope = ''
                                    THEN 'project_robot:' || loop_item_id
                                    ELSE execution_scope END;
         UPDATE loop_item_executions
         SET status = 'claimed',
             claimed_at = COALESCE(claimed_at, started_at, queued_at),
             start_requested_at = COALESCE(start_requested_at, started_at, updated_at),
             observed_state = 'unconfirmed', sync_state = 'stale',
             termination_reason = CASE WHEN termination_reason = ''
                                       THEN 'legacy_running_state'
                                       ELSE termination_reason END
         WHERE status = 'running' AND observed_state = 'unconfirmed';
         CREATE INDEX IF NOT EXISTS ix_exec_scope_status
             ON loop_item_executions(execution_scope, status);
         CREATE INDEX IF NOT EXISTS ix_exec_runtime_capacity
             ON loop_item_executions(runtime_instance_id, status);",
    )?;
    // The index must be created after the column exists (old databases need
    // the ALTER first; a missing column here would abort the whole migration
    // and take down the wework_space MCP server).
    connection.execute(
        "CREATE INDEX IF NOT EXISTS ix_loop_items_assignee_agent_id
         ON loop_items(assignee_agent_id)",
        [],
    )?;
    connection.execute_batch(
        "CREATE TRIGGER IF NOT EXISTS tr_local_task_status_created
         AFTER INSERT ON loop_items
         WHEN NEW.resource_type = 'task' AND NEW.status IS NOT NULL
         BEGIN
           UPDATE loop_items
           SET metadata = json_set(
             COALESCE(NEW.metadata, '{}'), '$.status_history',
             json_array(json_object(
               'from_status', '', 'from_status_name', '',
               'to_status', NEW.status,
               'to_status_name', COALESCE((
                 SELECT json_extract(value, '$.name')
                 FROM json_each((SELECT metadata FROM loop_items WHERE id = NEW.cloud_project_id), '$.board_config.statuses')
                 WHERE json_extract(value, '$.id') = NEW.status LIMIT 1
               ), NEW.status),
               'trigger', 'create', 'by_user_id', NULLIF(NEW.created_by_user_id, 0),
               'at', NEW.created_at
             ))
           )
           WHERE id = NEW.id;
         END;
         CREATE TRIGGER IF NOT EXISTS tr_local_task_status_changed
         AFTER UPDATE OF status ON loop_items
         WHEN NEW.resource_type = 'task' AND OLD.status IS NOT NEW.status
         BEGIN
           UPDATE loop_items
           SET metadata = json_set(
             COALESCE(NEW.metadata, '{}'), '$.status_history',
             json_insert(
               COALESCE(json_extract(NEW.metadata, '$.status_history'), json('[]')),
               '$[#]', json_object(
                 'from_status', COALESCE(OLD.status, ''),
                 'from_status_name', COALESCE((
                   SELECT json_extract(value, '$.name')
                   FROM json_each((SELECT metadata FROM loop_items WHERE id = NEW.cloud_project_id), '$.board_config.statuses')
                   WHERE json_extract(value, '$.id') = OLD.status LIMIT 1
                 ), COALESCE(OLD.status, '')),
                 'to_status', COALESCE(NEW.status, ''),
                 'to_status_name', COALESCE((
                   SELECT json_extract(value, '$.name')
                   FROM json_each((SELECT metadata FROM loop_items WHERE id = NEW.cloud_project_id), '$.board_config.statuses')
                   WHERE json_extract(value, '$.id') = NEW.status LIMIT 1
                 ), COALESCE(NEW.status, '')),
                 'trigger', 'local_status_change',
                 'by_user_id', NULLIF(NEW.updated_by_user_id, 0),
                 'at', NEW.updated_at
               )
             )
           )
           WHERE id = NEW.id;
         END;",
    )?;
    ensure_default_work_item_project(connection)?;
    local_execution_activity::repair_missing_execution_activity(&transaction)?;
    connection.execute(
        "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?1, ?2)",
        params![LOCAL_SCHEMA_VERSION, now()],
    )?;
    transaction.commit()?;
    crate::logging::log_executor_event(
        "local task schema migrated",
        &[
            ("version", LOCAL_SCHEMA_VERSION.to_string()),
            ("elapsed_ms", started.elapsed().as_millis().to_string()),
        ],
    );
    Ok(())
}

fn schema_is_current(connection: &Connection) -> Result<bool, rusqlite::Error> {
    let migration_table_exists = connection.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM sqlite_master
            WHERE type = 'table' AND name = 'schema_migrations'
         )",
        [],
        |row| row.get::<_, bool>(0),
    )?;
    if !migration_table_exists {
        return Ok(false);
    }
    connection.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM schema_migrations WHERE version = ?1
         )",
        [LOCAL_SCHEMA_VERSION],
        |row| row.get::<_, bool>(0),
    )
}
