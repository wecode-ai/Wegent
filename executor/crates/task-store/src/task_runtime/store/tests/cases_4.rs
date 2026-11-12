use super::*;

#[test]
fn local_recovery_requeues_expired_runs() {
    let (directory, store, project) = chat_agent_store();
    let agent = make_local_agent(&store, &project.id, "auto");
    let task = store
        .create_task(
            &project.id,
            TaskCreate {
                assignee_group_source_id: None,
                milestone_id: None,
                title: "Recover me".to_owned(),
                description: String::new(),
                status: "inbox".to_owned(),
                priority: "none".to_owned(),
                parent_id: None,
                tags: vec![],
                assignee_user_id: None,
                assignee_agent_id: None,
                assignee_group_id: None,
                workflow: None,
            },
        )
        .unwrap();
    let execution = store
        .enqueue_execution(
            &project.id,
            &task.id,
            &agent.id,
            json!({"text": "run"}),
            None,
        )
        .unwrap();
    let claim = LocalExecutionClaim {
        execution_device_id: Some("local-device".to_owned()),
        runtime_instance_id: "runtime-1".to_owned(),
        device_capacity: 5,
        runtime_active: 0,
        runtime_active_task_ids: vec![],
        lease_seconds: 300,
    };
    let claimed = store
        .claim_next_local_execution(&claim)
        .unwrap()
        .expect("run must be claimable");
    assert_eq!(claimed.id, execution.id);

    // Expire the lease out-of-band, as if the app crashed mid-run.
    let connection = rusqlite::Connection::open(directory.path().join("tasks.sqlite")).unwrap();
    connection
        .execute(
            "UPDATE loop_item_executions
             SET lease_expires_at = '2000-01-01T00:00:00+00:00'
             WHERE id = ?1",
            params![execution.id],
        )
        .unwrap();
    drop(connection);

    let (requeued, unknown) = store.recover_stale_local_executions().unwrap();
    assert_eq!(requeued, 1);
    assert_eq!(unknown, 0);
    let recovered = store
        .list_executions(&project.id, None, None, false)
        .unwrap();
    assert_eq!(recovered[0].status, "queued");
    assert_eq!(recovered[0].retry_attempt, 0);
}

#[test]
fn local_reconciliation_uses_runtime_turn_truth() {
    let (directory, store, project) = chat_agent_store();
    let agent = make_local_agent(&store, &project.id, "auto");
    let task = store
        .create_task(
            &project.id,
            TaskCreate {
                assignee_group_source_id: None,
                milestone_id: None,
                title: "Reconcile me".to_owned(),
                description: String::new(),
                status: "inbox".to_owned(),
                priority: "none".to_owned(),
                parent_id: None,
                tags: vec![],
                assignee_user_id: None,
                assignee_agent_id: None,
                assignee_group_id: None,
                workflow: None,
            },
        )
        .unwrap();
    store
        .enqueue_execution(
            &project.id,
            &task.id,
            &agent.id,
            json!({"message": "run"}),
            None,
        )
        .unwrap();
    let claimed = store
        .claim_next_local_execution(&LocalExecutionClaim {
            execution_device_id: Some("local-device".to_owned()),
            runtime_instance_id: "runtime-1".to_owned(),
            device_capacity: 5,
            runtime_active: 0,
            runtime_active_task_ids: vec![],
            lease_seconds: 300,
        })
        .unwrap()
        .expect("run must be claimed");
    let device_id = claimed.runtime_device_id.as_deref().unwrap();
    let task_id = claimed.runtime_task_id.as_deref().unwrap();
    store
        .request_runtime_start(claimed.id, device_id, task_id, 300)
        .unwrap();
    store
        .update_execution_binding_runtime(
            claimed.id,
            Some(&json!({
                "runtime": "codex",
                "threadId": "thread-1",
                "workspacePath": "/tmp/wegent/worktrees/codex-queue-1",
                "workspaceKind": "worktree",
                "worktreeId": "codex-queue-1",
            })),
            Some(&json!({
                "modelName": "gpt-5.6-sol",
                "modelType": "runtime",
                "options": {
                    "codexProviderType": "official"
                }
            })),
        )
        .unwrap();
    let binding = store
        .list_task_bindings(&task.id)
        .unwrap()
        .into_iter()
        .next()
        .expect("Runtime start must create an Issue task binding");
    assert_eq!(
        binding.execution_context,
        Some(json!({
            "runtime": "codex",
            "threadId": "thread-1",
            "workspacePath": "/tmp/wegent/worktrees/codex-queue-1",
            "workspaceKind": "worktree",
            "worktreeId": "codex-queue-1",
        }))
    );
    assert_eq!(
        binding.model_selection,
        Some(json!({
            "modelName": "gpt-5.6-sol",
            "modelType": "runtime",
            "options": {
                "codexProviderType": "official"
            }
        }))
    );

    let connection = rusqlite::Connection::open(directory.path().join("tasks.sqlite")).unwrap();
    connection
        .execute(
            "UPDATE loop_item_executions
             SET sync_state = 'stale', error_message = 'lost event'
             WHERE id = ?1",
            params![claimed.id],
        )
        .unwrap();
    drop(connection);
    assert_eq!(store.stale_local_executions().unwrap().len(), 1);

    let accepted = store
        .reconcile_execution_snapshot(claimed.id, "queued", false, None)
        .unwrap()
        .expect("queued Runtime task must reconcile");
    assert_eq!(accepted.status, "claimed");
    assert_eq!(accepted.observed_state, "accepted");
    assert_eq!(accepted.sync_state, "in_sync");
    assert_eq!(accepted.display_state, "starting");
    assert!(accepted.started_at.is_none());
    assert!(accepted.error_message.is_empty());

    let completed = store
        .reconcile_execution_snapshot(claimed.id, "active", false, Some("completed"))
        .unwrap()
        .expect("completed Runtime turn must terminalize the run");
    assert_eq!(completed.status, "completed");
    assert_eq!(completed.observed_state, "succeeded");
    assert_eq!(completed.display_state, "succeeded");
}

#[test]
fn local_cancel_terminalizes_only_before_runtime_delivery() {
    let (directory, store, project) = chat_agent_store();
    let _ = directory;
    let agent = make_local_agent(&store, &project.id, "auto");
    let create_run = |title: &str| {
        let task = store
            .create_task(
                &project.id,
                TaskCreate {
                    assignee_group_source_id: None,
                    milestone_id: None,
                    title: title.to_owned(),
                    description: String::new(),
                    status: "inbox".to_owned(),
                    priority: "none".to_owned(),
                    parent_id: None,
                    tags: vec![],
                    assignee_user_id: None,
                    assignee_agent_id: None,
                    assignee_group_id: None,
                    workflow: None,
                },
            )
            .unwrap();
        let execution = store
            .enqueue_execution(
                &project.id,
                &task.id,
                &agent.id,
                json!({"text": "run"}),
                None,
            )
            .unwrap();
        (task, execution)
    };

    let (queued_task, queued) = create_run("Cancel before delivery");
    let cancelled = store
        .cancel_execution(queued.id, Some("stopped before start"))
        .unwrap();
    assert_eq!(cancelled.status, "cancelled");
    assert_eq!(cancelled.observed_state, "cancelled");
    assert_eq!(cancelled.termination_reason, "cancelled_before_start");
    let queued_comment = store
        .list_comments(&project.id, &queued_task.id, 0)
        .unwrap()
        .into_iter()
        .find(|comment| comment.sender_type == "agent")
        .unwrap();
    assert_eq!(queued_comment.status, "cancelled");

    let (_delivered_task, delivered) = create_run("Cancel after delivery");
    let claimed = store
        .claim_next_local_execution(&LocalExecutionClaim {
            execution_device_id: Some("local-device".to_owned()),
            runtime_instance_id: "runtime-1".to_owned(),
            device_capacity: 5,
            runtime_active: 0,
            runtime_active_task_ids: vec![],
            lease_seconds: 300,
        })
        .unwrap()
        .unwrap();
    assert_eq!(claimed.id, delivered.id);
    store
        .request_runtime_start(
            claimed.id,
            claimed.runtime_device_id.as_deref().unwrap(),
            claimed.runtime_task_id.as_deref().unwrap(),
            300,
        )
        .unwrap()
        .unwrap();

    let cancelling = store
        .cancel_execution(claimed.id, Some("please stop"))
        .unwrap();
    assert_eq!(cancelling.status, "cancel_requested");
    assert_eq!(cancelling.display_state, "cancelling");
    assert_eq!(cancelling.sync_state, "pending");
    assert!(cancelling.completed_at.is_none());

    let observed = store
        .cancel_execution_observed(claimed.id, Some("Runtime stopped"))
        .unwrap()
        .unwrap();
    assert_eq!(observed.status, "cancelled");
    assert_eq!(observed.observed_state, "cancelled");
    assert_eq!(observed.termination_reason, "runtime_cancelled");
}

#[test]
fn local_recovery_terminalizes_missing_runtime_and_unblocks_agent_queue() {
    let (directory, store, project) = chat_agent_store();
    let agent = make_local_agent(&store, &project.id, "auto");
    let stale_task = store
        .create_task(
            &project.id,
            TaskCreate {
                assignee_group_source_id: None,
                milestone_id: None,
                title: "Reconcile me".to_owned(),
                description: String::new(),
                status: "inbox".to_owned(),
                priority: "none".to_owned(),
                parent_id: None,
                tags: vec![],
                assignee_user_id: None,
                assignee_agent_id: None,
                assignee_group_id: None,
                workflow: None,
            },
        )
        .unwrap();
    store
        .enqueue_execution(
            &project.id,
            &stale_task.id,
            &agent.id,
            json!({"text": "run"}),
            None,
        )
        .unwrap();
    let next_task = store
        .create_task(
            &project.id,
            TaskCreate {
                assignee_group_source_id: None,
                milestone_id: None,
                title: "Run after recovery".to_owned(),
                description: String::new(),
                status: "inbox".to_owned(),
                priority: "none".to_owned(),
                parent_id: None,
                tags: vec![],
                assignee_user_id: None,
                assignee_agent_id: None,
                assignee_group_id: None,
                workflow: None,
            },
        )
        .unwrap();
    let next_execution = store
        .enqueue_execution(
            &project.id,
            &next_task.id,
            &agent.id,
            json!({"text": "next"}),
            None,
        )
        .unwrap();
    let claimed = store
        .claim_next_local_execution(&LocalExecutionClaim {
            execution_device_id: Some("local-device".to_owned()),
            runtime_instance_id: "runtime-1".to_owned(),
            device_capacity: 5,
            runtime_active: 0,
            runtime_active_task_ids: vec![],
            lease_seconds: 300,
        })
        .unwrap()
        .unwrap();
    accept_and_start(&store, &claimed);
    let connection = rusqlite::Connection::open(directory.path().join("tasks.sqlite")).unwrap();
    connection
        .execute(
            "UPDATE loop_item_executions
             SET lease_expires_at = '2000-01-01T00:00:00+00:00'
             WHERE id = ?1",
            params![claimed.id],
        )
        .unwrap();
    drop(connection);

    let (requeued, unknown) = store.recover_stale_local_executions().unwrap();
    assert_eq!((requeued, unknown), (0, 1));
    let execution = store
        .list_executions(&project.id, None, None, false)
        .unwrap()
        .remove(0);
    assert_eq!(execution.id, claimed.id);
    assert_eq!(execution.status, "running");
    assert_eq!(execution.display_state, "unknown");
    assert_eq!(execution.sync_state, "stale");
    let reconciled = store
        .reconcile_execution_snapshot(claimed.id, "missing", false, None)
        .unwrap()
        .unwrap();
    assert_eq!(reconciled.status, "queued");
    assert_eq!(reconciled.previous_execution_id, Some(claimed.id));
    let failed = execution_row(&store.connection().unwrap(), claimed.id).unwrap();
    assert_eq!(failed.status, "failed");
    assert_eq!(failed.observed_state, "failed");
    assert_eq!(failed.sync_state, "in_sync");

    let claimed_next = store
        .claim_next_local_execution(&LocalExecutionClaim {
            execution_device_id: Some("local-device".to_owned()),
            runtime_instance_id: "runtime-1".to_owned(),
            device_capacity: 5,
            runtime_active: 0,
            runtime_active_task_ids: vec![],
            lease_seconds: 300,
        })
        .unwrap()
        .unwrap();
    assert_eq!(claimed_next.id, next_execution.id);
}

#[test]
fn local_recovery_retries_a_delivered_run_missing_from_runtime() {
    let (directory, store, project) = chat_agent_store();
    let agent = make_local_agent(&store, &project.id, "auto");
    let task = store
        .create_task(
            &project.id,
            TaskCreate {
                assignee_group_source_id: None,
                milestone_id: None,
                title: "Retry missing runtime task".to_owned(),
                description: String::new(),
                status: "inbox".to_owned(),
                priority: "none".to_owned(),
                parent_id: None,
                tags: vec![],
                assignee_user_id: None,
                assignee_agent_id: None,
                assignee_group_id: None,
                workflow: None,
            },
        )
        .unwrap();
    store
        .enqueue_execution(
            &project.id,
            &task.id,
            &agent.id,
            json!({"text": "run"}),
            None,
        )
        .unwrap();
    let claim = LocalExecutionClaim {
        execution_device_id: Some("local-device".to_owned()),
        runtime_instance_id: "runtime-1".to_owned(),
        device_capacity: 5,
        runtime_active: 0,
        runtime_active_task_ids: vec![],
        lease_seconds: 300,
    };
    let first = store.claim_next_local_execution(&claim).unwrap().unwrap();
    let device_id = first.runtime_device_id.as_deref().unwrap();
    let task_id = first.runtime_task_id.as_deref().unwrap();
    store
        .request_runtime_start(first.id, device_id, task_id, 300)
        .unwrap()
        .expect("start intent must be fenced");
    store
        .mark_runtime_dispatch_unknown(
            first.id,
            device_id,
            task_id,
            "invalid type: null, expected a map",
        )
        .unwrap();
    let connection = rusqlite::Connection::open(directory.path().join("tasks.sqlite")).unwrap();
    connection
        .execute(
            "UPDATE loop_item_executions
             SET lease_expires_at = '2000-01-01T00:00:00+00:00'
             WHERE id = ?1",
            params![first.id],
        )
        .unwrap();
    drop(connection);

    assert_eq!(store.recover_stale_local_executions().unwrap(), (0, 1));
    let retry = store
        .reconcile_execution_snapshot(first.id, "missing", false, None)
        .unwrap()
        .unwrap();

    assert_ne!(retry.id, first.id);
    assert_eq!(retry.status, "queued");
    assert_eq!(retry.previous_execution_id, Some(first.id));
    let previous = execution_row(&store.connection().unwrap(), first.id).unwrap();
    assert_eq!(previous.status, "failed");
    assert_eq!(previous.termination_reason, "runtime_failed");
    assert_eq!(previous.error_message, "invalid type: null, expected a map");
    assert_eq!(
        store
            .claim_next_local_execution(&claim)
            .unwrap()
            .unwrap()
            .id,
        retry.id
    );
}

#[test]
fn local_runtime_failure_creates_a_new_attempt_with_a_new_identity() {
    let (_directory, store, project) = chat_agent_store();
    let agent = make_local_agent(&store, &project.id, "auto");
    let task = store
        .create_task(
            &project.id,
            TaskCreate {
                assignee_group_source_id: None,
                milestone_id: None,
                title: "Retry me".to_owned(),
                description: String::new(),
                status: "inbox".to_owned(),
                priority: "none".to_owned(),
                parent_id: None,
                tags: vec![],
                assignee_user_id: None,
                assignee_agent_id: None,
                assignee_group_id: None,
                workflow: None,
            },
        )
        .unwrap();
    store
        .enqueue_execution(
            &project.id,
            &task.id,
            &agent.id,
            json!({"text": "run"}),
            None,
        )
        .unwrap();
    let claim = LocalExecutionClaim {
        execution_device_id: Some("local-device".to_owned()),
        runtime_instance_id: "runtime-1".to_owned(),
        device_capacity: 5,
        runtime_active: 0,
        runtime_active_task_ids: vec![],
        lease_seconds: 300,
    };
    let first = store.claim_next_local_execution(&claim).unwrap().unwrap();
    accept_and_start(&store, &first);

    let retry = store
        .fail_execution(first.id, "Runtime failed", true)
        .unwrap()
        .unwrap();
    assert_ne!(retry.id, first.id);
    assert_eq!(retry.status, "queued");
    assert_eq!(retry.attempt_no, 2);
    assert_eq!(retry.previous_execution_id, Some(first.id));
    let previous = execution_row(&store.connection().unwrap(), first.id).unwrap();
    assert_eq!(previous.status, "failed");
    assert_eq!(previous.runtime_task_id, first.runtime_task_id);

    let second = store.claim_next_local_execution(&claim).unwrap().unwrap();
    assert_ne!(second.runtime_task_id, first.runtime_task_id);
    assert_eq!(
        second.runtime_task_id,
        Some(format!("codex-queue-{}", second.id))
    );
}

#[test]
fn migrates_legacy_schema_without_assignee_agent_id() {
    let directory = tempfile::tempdir().unwrap();
    let db_path = directory.path().join("tasks.sqlite");
    // A pre-robot database: loop_items exists without assignee_agent_id and
    // loop_item_executions does not exist yet. The migrate() step must add
    // the column before creating the index, otherwise TaskRuntime fails to
    // open and the wework_space MCP server dies during startup.
    let legacy = rusqlite::Connection::open(&db_path).unwrap();
    legacy
        .execute_batch(
            "CREATE TABLE schema_migrations (
                version INTEGER PRIMARY KEY,
                applied_at TEXT NOT NULL
            );
            CREATE TABLE loop_items (
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
                deleted_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_loop_items_project_type
                ON loop_items(cloud_project_id, resource_type);
            CREATE INDEX IF NOT EXISTS ix_loop_items_resource_type
                ON loop_items(resource_type);
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
            );
            INSERT INTO schema_migrations(version, applied_at) VALUES (3, '2026-08-01T00:00:00+00:00');",
        )
        .unwrap();
    drop(legacy);

    let store = LocalTaskStore::open(&db_path).unwrap();
    let connection = store.connection().unwrap();
    let columns = connection
        .prepare("PRAGMA table_info(loop_items)")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert!(columns.iter().any(|column| column == "assignee_agent_id"));
    let tables = connection
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert!(tables.iter().any(|table| table == "loop_item_executions"));
    let index_exists = connection
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'ix_loop_items_assignee_agent_id'")
        .unwrap()
        .query_row([], |_| Ok(()))
        .optional()
        .unwrap()
        .is_some();
    assert!(index_exists);
    drop(connection);

    // The migrated store is fully usable: robots and executions work.
    let project = store
        .create_project(ProjectCreate {
            name: "Migrated project".to_owned(),
            project_key: Some("MIG".to_owned()),
            description: String::new(),
            task_provider: TaskProviderKind::Local,
            provider_config: json!({}),
        })
        .unwrap();
    let agent = store
        .create_chat_agent(
            &project.id,
            ChatAgentCreate {
                execution_policy: None,
                model_policy: None,
                name: "Migrated Bot".to_owned(),
                display_name: None,
                namespace: None,
                runtime: "codex".to_owned(),
                model: None,
                model_type: None,
                model_namespace: None,
                allowed_models: Some(Vec::new()),
                capability_description: None,
                capability_mode: Some("follow_device".to_owned()),
                system_prompt: None,
                visibility: None,
                execution_environment: Some("local".to_owned()),
                execution_mode: Some("auto".to_owned()),
                execution_device_id: Some("local-device".to_owned()),
                max_concurrent_executions: 1,
                workspace_policy: "project".to_owned(),
                local_project_id: None,
                created_by_user_id: None,
                plugins: Vec::new(),
                additional_skills: Vec::new(),
                mcp_servers: json!({}),
            },
        )
        .unwrap();
    let task = store
        .create_task(
            &project.id,
            TaskCreate {
                assignee_group_source_id: None,
                milestone_id: None,
                title: "After migration".to_owned(),
                description: String::new(),
                status: "inbox".to_owned(),
                priority: "none".to_owned(),
                parent_id: None,
                tags: vec![],
                assignee_user_id: None,
                assignee_agent_id: None,
                assignee_group_id: None,
                workflow: None,
            },
        )
        .unwrap();
    store
        .update_task(
            &project.id,
            &task.id,
            TaskUpdate {
                assignee_group_source_id: None,
                milestone_id: None,
                position: None,
                assignee_group_id: None,
                assignee_user_id: None,
                version: task.version,
                title: None,
                description: None,
                status: None,
                priority: None,
                parent_id: None,
                tags: None,
                assignee_agent_id: Some(Some(agent.id.clone())),
                execution_payload: Some(json!({"message": "run"})),
                workflow: None,
            },
        )
        .unwrap();
    let executions = store
        .list_executions(&project.id, None, None, false)
        .unwrap();
    assert_eq!(executions.len(), 1);
    assert_eq!(executions[0].status, "queued");
}

#[test]
fn local_task_status_history_records_creation_and_all_status_updates() {
    let (_directory, store) = store();
    let project = local_project(&store);
    let created = store
        .create_task(
            &project.id,
            TaskCreate {
                assignee_group_source_id: None,
                milestone_id: None,
                title: "Track status".to_owned(),
                description: String::new(),
                status: "pending".to_owned(),
                priority: "none".to_owned(),
                parent_id: None,
                tags: Vec::new(),
                assignee_user_id: None,
                assignee_agent_id: None,
                assignee_group_id: None,
                workflow: None,
            },
        )
        .unwrap();
    assert_eq!(created.metadata["status_history"][0]["trigger"], "create");
    assert_eq!(
        created.metadata["status_history"][0]["to_status_name"],
        "待开始"
    );

    let updated = store
        .update_task(
            &project.id,
            &created.id,
            TaskUpdate {
                version: created.version,
                status: Some("in_progress".to_owned()),
                ..TaskUpdate::default()
            },
        )
        .unwrap();
    assert_eq!(
        updated.metadata["status_history"].as_array().unwrap().len(),
        2
    );
    assert_eq!(
        updated.metadata["status_history"][1]["from_status_name"],
        "待开始"
    );
    assert_eq!(
        updated.metadata["status_history"][1]["to_status_name"],
        "进行中"
    );

    {
        let connection = store.connection().unwrap();
        connection
            .execute(
                "UPDATE loop_items SET status = 'in_review', updated_at = ?1 WHERE id = ?2",
                params![now(), created.id],
            )
            .unwrap();
    }
    let reviewed = store.get_task(&project.id, &created.id).unwrap();
    assert_eq!(
        reviewed.metadata["status_history"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    assert_eq!(
        reviewed.metadata["status_history"][2]["to_status_name"],
        "待确认"
    );

    let workflow_task = store
        .create_task(
            &project.id,
            TaskCreate {
                assignee_group_source_id: None,
                milestone_id: None,
                title: "Workflow status".to_owned(),
                description: String::new(),
                status: "pending".to_owned(),
                priority: "none".to_owned(),
                parent_id: None,
                tags: Vec::new(),
                assignee_user_id: None,
                assignee_agent_id: None,
                assignee_group_id: None,
                workflow: Some(json!({ "nodes": [] })),
            },
        )
        .unwrap();
    assert_eq!(
        workflow_task.metadata["status_history"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}
