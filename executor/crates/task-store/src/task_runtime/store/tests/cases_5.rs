use super::*;

#[test]
fn creates_same_named_projects_with_distinct_generated_keys() {
    let (_directory, store) = store();
    let create = || {
        store
            .create_project(ProjectCreate {
                name: "Shared project".to_owned(),
                project_key: None,
                description: String::new(),
                task_provider: TaskProviderKind::Local,
                provider_config: json!({}),
            })
            .unwrap()
    };

    let first = create();
    let second = create();

    assert_ne!(first.id, second.id);
    assert_ne!(first.project_key, second.project_key);
    assert_eq!(first.project_key.as_deref(), Some("SHAREDPR"));
    assert_eq!(second.project_key.as_deref(), Some("SHAREDPR2"));
}

#[test]
fn rejects_duplicate_explicit_project_keys() {
    let (_directory, store) = store();
    let create = || {
        store.create_project(ProjectCreate {
            name: "Explicit project".to_owned(),
            project_key: Some("EXPLICIT".to_owned()),
            description: String::new(),
            task_provider: TaskProviderKind::Local,
            provider_config: json!({}),
        })
    };

    create().unwrap();
    let error = create().unwrap_err();

    assert!(matches!(
        error,
        TaskRuntimeError::Database(rusqlite::Error::SqliteFailure(_, _))
    ));
}

#[test]
fn create_task_persists_the_initial_human_assignee() {
    let (_directory, store) = store();
    let project = local_project(&store);
    let project = store
        .update_project(
            &project.id,
            ProjectUpdate {
                version: project.version,
                automatic_processing_rules: Some(json!([{
                    "id": "assign-another-human",
                    "enabled": true,
                    "triggerType": "event",
                    "eventType": "task.created",
                    "targetKind": "human",
                    "targetId": "8"
                }])),
                ..ProjectUpdate::default()
            },
        )
        .unwrap();
    let input: TaskCreate = serde_json::from_value(json!({
        "title": "Human-owned issue",
        "status": "inbox",
        "priority": "none",
        "parent_id": null,
        "assignee_user_id": 9001
    }))
    .unwrap();

    let created = store.create_task(&project.id, input).unwrap();
    let persisted = store.get_task(&project.id, &created.id).unwrap();

    assert_eq!(created.assignee_user_id, Some(9001));
    assert_eq!(persisted.assignee_user_id, Some(9001));
}

#[test]
fn creates_the_backend_compatible_single_table_schema() {
    let (_directory, store) = store();
    let connection = store.connection().unwrap();
    let columns = connection
        .prepare("PRAGMA table_info(loop_items)")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();

    for required in [
        "id",
        "resource_type",
        "cloud_project_id",
        "parent_id",
        "loop_item_id",
        "delivery_id",
        "metadata",
        "version",
        "deleted_at",
    ] {
        assert!(columns.iter().any(|column| column == required));
    }
}

#[test]
fn creates_the_default_work_item_project_once() {
    let directory = tempfile::tempdir().unwrap();
    let db_path = directory.path().join("tasks.sqlite");

    let first_store = LocalTaskStore::open(&db_path).unwrap();
    let first_projects = first_store.list_projects().unwrap();
    let default_board = first_projects
        .iter()
        .find(|project| project.project_key.as_deref() == Some(DEFAULT_WORK_ITEM_PROJECT_KEY))
        .expect("the default work-item project must exist");
    assert_eq!(default_board.id, DEFAULT_WORK_ITEM_PROJECT_ID);
    assert_eq!(default_board.name.as_deref(), Some("我的任务"));
    assert_eq!(
        default_board.metadata["system_kind"],
        json!("default_work_items")
    );
    drop(first_store);

    let reopened_store = LocalTaskStore::open(&db_path).unwrap();
    let default_board_count = reopened_store
        .list_projects()
        .unwrap()
        .into_iter()
        .filter(|project| project.project_key.as_deref() == Some(DEFAULT_WORK_ITEM_PROJECT_KEY))
        .count();
    assert_eq!(default_board_count, 1);
}

#[test]
fn initializes_a_new_store_once_across_concurrent_openers() {
    let directory = tempfile::tempdir().unwrap();
    let db_path = Arc::new(directory.path().join("tasks.sqlite"));
    let barrier = Arc::new(Barrier::new(8));
    let openers = (0..8)
        .map(|_| {
            let db_path = Arc::clone(&db_path);
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                let store = LocalTaskStore::open(db_path.as_ref())
                    .expect("concurrent first open must succeed");
                store
                    .get_project(DEFAULT_WORK_ITEM_PROJECT_ID)
                    .expect("default project must exist")
            })
        })
        .collect::<Vec<_>>();

    for opener in openers {
        assert_eq!(
            opener.join().expect("store opener must not panic").id,
            DEFAULT_WORK_ITEM_PROJECT_ID
        );
    }
}

#[test]
fn opens_current_schema_while_another_connection_is_writing() {
    let directory = tempfile::tempdir().unwrap();
    let db_path = directory.path().join("tasks.sqlite");
    let _store = LocalTaskStore::open(&db_path).unwrap();
    let mut writer = rusqlite::Connection::open(&db_path).unwrap();
    let transaction = writer
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .unwrap();

    let reopened_store = LocalTaskStore::open(&db_path)
        .expect("opening a current schema must not require the SQLite write lock");

    assert!(reopened_store
        .get_project(DEFAULT_WORK_ITEM_PROJECT_ID)
        .is_ok());
    transaction.rollback().unwrap();
}

#[test]
fn restores_the_default_work_item_project_after_it_is_deleted() {
    let directory = tempfile::tempdir().unwrap();
    let db_path = directory.path().join("tasks.sqlite");
    let store = LocalTaskStore::open(&db_path).unwrap();
    {
        let connection = store.connection().unwrap();
        connection
            .execute(
                "DELETE FROM loop_items WHERE id = ?1",
                [DEFAULT_WORK_ITEM_PROJECT_ID],
            )
            .unwrap();
    }
    drop(store);

    let reopened_store = LocalTaskStore::open(&db_path).unwrap();
    let restored_project = reopened_store
        .get_project(DEFAULT_WORK_ITEM_PROJECT_ID)
        .expect("the default work-item project should be restored");
    assert_eq!(
        restored_project.project_key.as_deref(),
        Some(DEFAULT_WORK_ITEM_PROJECT_KEY)
    );
    assert_eq!(
        restored_project.metadata["system_kind"],
        json!("default_work_items")
    );
}

#[test]
fn migration_reserves_the_default_work_item_project_key() {
    let directory = tempfile::tempdir().unwrap();
    let db_path = directory.path().join("tasks.sqlite");
    let store = LocalTaskStore::open(&db_path).unwrap();
    let legacy_project = store
        .create_project(ProjectCreate {
            name: "Existing work board".to_owned(),
            project_key: Some("LEGACY".to_owned()),
            description: String::new(),
            task_provider: TaskProviderKind::Local,
            provider_config: json!({}),
        })
        .unwrap();
    {
        let connection = store.connection().unwrap();
        connection
            .execute(
                "DELETE FROM loop_items WHERE id = ?1",
                [DEFAULT_WORK_ITEM_PROJECT_ID],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE loop_items SET project_key = ?1 WHERE id = ?2",
                params![DEFAULT_WORK_ITEM_PROJECT_KEY, legacy_project.id],
            )
            .unwrap();
        connection
            .execute(
                "DELETE FROM schema_migrations WHERE version = ?1",
                [LOCAL_SCHEMA_VERSION],
            )
            .unwrap();
    }
    drop(store);

    let migrated = LocalTaskStore::open(&db_path).unwrap();
    let projects = migrated.list_projects().unwrap();
    let default_project = projects
        .iter()
        .find(|project| project.id == DEFAULT_WORK_ITEM_PROJECT_ID)
        .expect("the canonical default project should be created");
    assert_eq!(
        default_project.project_key.as_deref(),
        Some(DEFAULT_WORK_ITEM_PROJECT_KEY)
    );
    assert_eq!(
        default_project.metadata["system_kind"],
        json!("default_work_items")
    );
    let preserved_legacy_project = projects
        .iter()
        .find(|project| project.id == legacy_project.id)
        .expect("the existing project should be preserved");
    assert_ne!(
        preserved_legacy_project.project_key.as_deref(),
        Some(DEFAULT_WORK_ITEM_PROJECT_KEY)
    );
}

#[test]
fn caches_backend_external_projects_without_exposing_credentials() {
    let (_directory, store) = store();
    let configured = store
        .configure_external_project(ProjectDescriptor {
            id: "cloud-1".to_owned(),
            public_id: Some("public-1".to_owned()),
            project_key: "CLOUD".to_owned(),
            name: "Cloud GitHub board".to_owned(),
            description: String::new(),
            project_store: ProjectStoreKind::Backend,
            task_provider: TaskProviderKind::Github,
            provider_config: json!({
                "repository": "acme/repo",
                "token": "local-secret",
            }),
            version: 1,
        })
        .unwrap();

    assert_eq!(configured.id, "cloud-1");
    let projects = store.list_projects().unwrap();
    let cached_project = projects
        .iter()
        .find(|project| project.id == "cloud-1")
        .expect("cached project must be listed");
    assert_eq!(
        cached_project.metadata["task_provider"],
        json!(TaskProviderKind::Github)
    );
    let serialized = store
        .connection()
        .unwrap()
        .query_row(
            "SELECT provider_config FROM project_provider_credentials
             WHERE project_store = 'backend' AND project_id = 'cloud-1'",
            [],
            |row| row.get::<_, String>(0),
        )
        .unwrap();
    assert!(!serialized.contains("local-secret"));
    let descriptor = store
        .connection()
        .unwrap()
        .query_row(
            "SELECT descriptor FROM external_project_catalog
             WHERE project_store = 'backend' AND project_id = 'cloud-1'",
            [],
            |row| row.get::<_, String>(0),
        )
        .unwrap();
    assert!(!descriptor.contains("local-secret"));
    assert_eq!(
        configured.metadata["project_store"],
        json!(ProjectStoreKind::Backend)
    );
    assert_eq!(
        store.get_project("cloud-1").unwrap().name.as_deref(),
        Some("Cloud GitHub board")
    );
}

#[test]
fn incompatible_cached_external_project_does_not_hide_local_projects() {
    let (_directory, store) = store();
    let local = local_project(&store);
    store
        .connection()
        .unwrap()
        .execute(
            "INSERT INTO external_project_catalog (
                project_store, project_id, descriptor, updated_at
             ) VALUES ('backend', 'future-1', ?1, ?2)",
            params![
                json!({
                    "id": "future-1",
                    "project_key": "FUTURE",
                    "name": "Future provider",
                    "project_store": "backend",
                    "task_provider": "provider_from_newer_branch",
                })
                .to_string(),
                now(),
            ],
        )
        .unwrap();

    let projects = store.list_projects().unwrap();

    assert!(projects.iter().any(|project| project.id == local.id));
    assert!(projects.iter().all(|project| project.id != "future-1"));
}

#[test]
fn caches_backend_dingtalk_aitable_projects() {
    let (_directory, store) = store();
    let configured = store
        .configure_external_project(ProjectDescriptor {
            id: "aitable-cloud-1".to_owned(),
            public_id: Some("aitable-public-1".to_owned()),
            project_key: "AITABLE".to_owned(),
            name: "DingTalk AI Table".to_owned(),
            description: String::new(),
            project_store: ProjectStoreKind::Backend,
            task_provider: TaskProviderKind::DingtalkAitable,
            provider_config: json!({
                "base_id": "base-1",
                "table_id": "table-1",
                "source_url": "https://alidocs.dingtalk.com/i/nodes/base-1",
            }),
            version: 1,
        })
        .unwrap();

    assert_eq!(
        configured.metadata["task_provider"],
        json!(TaskProviderKind::DingtalkAitable)
    );
    assert_eq!(
        configured.metadata["provider_config"]["base_id"],
        json!("base-1")
    );
    assert_eq!(
        store
            .get_project("aitable-cloud-1")
            .unwrap()
            .name
            .as_deref(),
        Some("DingTalk AI Table")
    );
}

#[test]
fn removes_backend_external_project_credentials_and_catalog_entry() {
    let directory = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
    let project = ProjectDescriptor {
        id: "cloud-public".to_owned(),
        public_id: Some("public-id".to_owned()),
        project_key: "PUBLIC".to_owned(),
        name: "Public GitHub".to_owned(),
        description: String::new(),
        project_store: ProjectStoreKind::Backend,
        task_provider: TaskProviderKind::Github,
        provider_config: json!({
            "repository": "acme/public",
            "token": "sensitive-token"
        }),
        version: 1,
    };
    store.configure_external_project(project).unwrap();

    store.remove_external_project("cloud-public").unwrap();

    assert!(store
        .list_projects()
        .unwrap()
        .iter()
        .all(|candidate| candidate.id != "cloud-public"));
    let connection = store.connection().unwrap();
    let credential_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM project_provider_credentials
             WHERE project_store = 'backend' AND project_id = 'cloud-public'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(credential_count, 0);
}

#[test]
fn retains_only_current_accounts_backend_external_projects() {
    let directory = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
    for id in ["account-a", "account-b"] {
        store
            .configure_external_project(ProjectDescriptor {
                id: id.to_owned(),
                public_id: None,
                project_key: id.to_uppercase(),
                name: id.to_owned(),
                description: String::new(),
                project_store: ProjectStoreKind::Backend,
                task_provider: TaskProviderKind::Github,
                provider_config: json!({
                    "repository": format!("acme/{id}"),
                    "token": format!("{id}-token")
                }),
                version: 1,
            })
            .unwrap();
    }

    store
        .retain_external_projects(&["account-b".to_owned()])
        .unwrap();

    let project_ids = store
        .list_projects()
        .unwrap()
        .into_iter()
        .filter(|project| project.project_key.as_deref() != Some(DEFAULT_WORK_ITEM_PROJECT_KEY))
        .map(|project| project.id)
        .collect::<Vec<_>>();
    assert_eq!(project_ids, vec!["account-b"]);
}

#[test]
fn creates_nested_tasks_and_rejects_cycles() {
    let (_directory, store) = store();
    let project = local_project(&store);
    let parent = store
        .create_task(
            &project.id,
            TaskCreate {
                assignee_group_source_id: None,
                milestone_id: None,
                title: "Parent".to_owned(),
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
    assert_eq!(
        store.get_project(&project.id).unwrap().version,
        project.version
    );
    let child = store
        .create_task(
            &project.id,
            TaskCreate {
                assignee_group_source_id: None,
                milestone_id: None,
                title: "Child".to_owned(),
                description: String::new(),
                status: "pending".to_owned(),
                priority: "high".to_owned(),
                parent_id: Some(parent.id.clone()),
                tags: vec!["nested".to_owned()],
                assignee_user_id: None,
                assignee_agent_id: None,
                assignee_group_id: None,
                workflow: None,
            },
        )
        .unwrap();

    assert_eq!(child.parent_id.as_deref(), Some(parent.id.as_str()));
    let error = store
        .update_task(
            &project.id,
            &parent.id,
            TaskUpdate {
                assignee_group_id: None,
                assignee_user_id: None,
                version: parent.version,
                parent_id: Some(Some(child.id)),
                ..TaskUpdate::default()
            },
        )
        .unwrap_err();
    assert!(matches!(error, TaskRuntimeError::Invalid(_)));
}

#[test]
fn reorders_one_local_board_lane() {
    let (_directory, store) = store();
    let project = local_project(&store);
    let first = store
        .create_task(
            &project.id,
            TaskCreate {
                assignee_group_source_id: None,
                milestone_id: None,
                title: "First".to_owned(),
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
    let second = store
        .create_task(
            &project.id,
            TaskCreate {
                assignee_group_source_id: None,
                milestone_id: None,
                title: "Second".to_owned(),
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

    let reordered = store
        .reorder_tasks(
            &project.id,
            TaskReorder {
                parent_id: None,
                status: Some("inbox".to_owned()),
                item_ids: vec![second.id.clone(), first.id.clone()],
            },
        )
        .unwrap();

    assert_eq!(
        reordered
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>(),
        vec![second.id.as_str(), first.id.as_str()]
    );
    assert_eq!(reordered[0].sort_order, 0);
    assert_eq!(reordered[1].sort_order, 1);
}

#[test]
fn reorders_local_siblings_across_statuses_without_touching_children() {
    let (_directory, store) = store();
    let project = local_project(&store);
    let create = |title: &str, status: &str, parent_id: Option<String>| {
        store
            .create_task(
                &project.id,
                serde_json::from_value::<TaskCreate>(serde_json::json!({
                    "title": title, "status": status, "parent_id": parent_id
                }))
                .unwrap(),
            )
            .unwrap()
    };
    let first = create("First", "inbox", None);
    let second = create("Second", "completed", None);
    let child = create("Child", "inbox", Some(first.id.clone()));
    let reordered = store
        .reorder_tasks(
            &project.id,
            TaskReorder {
                parent_id: None,
                status: None,
                item_ids: vec![second.id.clone(), first.id.clone(), child.id.clone()],
            },
        )
        .unwrap();
    assert_eq!(
        reordered
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>(),
        vec![second.id.as_str(), first.id.as_str()]
    );
    assert_eq!(reordered[0].status.as_deref(), Some("completed"));
    assert_eq!(reordered[0].sort_order, 0);
    assert_eq!(reordered[1].sort_order, 1);
    assert_eq!(
        store.get_task(&project.id, &child.id).unwrap().sort_order,
        child.sort_order
    );
    assert_eq!(
        store.get_task(&project.id, &child.id).unwrap().version,
        child.version
    );
}

#[test]
fn binds_and_unbinds_a_runtime_task() {
    let (_directory, store) = store();
    let project = local_project(&store);
    let task = store
        .create_task(
            &project.id,
            TaskCreate {
                assignee_group_source_id: None,
                milestone_id: None,
                title: "Bound task".to_owned(),
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

    let binding = store
        .bind_task(
            &project.id,
            Some(&task.id),
            None,
            RuntimeTaskAddress {
                device_id: "local-device".to_owned(),
                task_id: "runtime-1".to_owned(),
                task_title: Some("Runtime".to_owned()),
                backend_task_id: None,
                model_selection: Some(json!({
                    "modelName": "gpt-5.6-sol",
                    "modelType": "public",
                    "options": {"reasoning": "high"},
                })),
                execution_context: Some(json!({
                    "workspacePath": "/tmp/wegent",
                    "workspaceKind": "worktree",
                    "worktreeId": "runtime-1",
                })),
                workflow_node_id: None,
            },
            None,
        )
        .unwrap();

    assert_eq!(binding.loop_item_id.as_deref(), Some(task.id.as_str()));
    assert_eq!(
        binding.model_selection,
        Some(json!({
            "modelName": "gpt-5.6-sol",
            "modelType": "public",
            "options": {"reasoning": "high"},
        }))
    );
    assert_eq!(
        binding.execution_context,
        Some(json!({
            "workspacePath": "/tmp/wegent",
            "workspaceKind": "worktree",
            "worktreeId": "runtime-1",
        }))
    );
    assert_eq!(store.list_task_bindings(&task.id).unwrap().len(), 1);
    assert_eq!(
        store
            .get_task(&project.id, &task.id)
            .unwrap()
            .status
            .as_deref(),
        Some("inbox")
    );
    store
        .unbind_task("local-device", "runtime-1", Some(&task.id))
        .unwrap();
    assert!(matches!(
        store.find_task_binding("local-device", "runtime-1"),
        Err(TaskRuntimeError::TaskNotFound)
    ));
}

#[test]
fn projects_runtime_status_to_bound_issue_without_renderer_writeback() {
    let (_directory, store) = store();
    let task = store
        .create_task(
            DEFAULT_WORK_ITEM_PROJECT_ID,
            TaskCreate {
                assignee_group_source_id: None,
                milestone_id: None,
                title: "Runtime-owned status".to_owned(),
                description: String::new(),
                status: "in_review".to_owned(),
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
        .bind_task(
            DEFAULT_WORK_ITEM_PROJECT_ID,
            Some(&task.id),
            None,
            RuntimeTaskAddress {
                device_id: "local-device".to_owned(),
                task_id: "runtime-status-1".to_owned(),
                task_title: task.title.clone(),
                backend_task_id: None,
                model_selection: None,
                execution_context: None,
                workflow_node_id: None,
            },
            None,
        )
        .unwrap();

    assert_eq!(
        store
            .project_bound_task_status("local-device", "runtime-status-1", "running", 100)
            .unwrap(),
        1
    );
    assert_eq!(
        store
            .get_task(DEFAULT_WORK_ITEM_PROJECT_ID, &task.id)
            .unwrap()
            .status
            .as_deref(),
        Some("in_progress")
    );

    assert_eq!(
        store
            .project_bound_task_status("local-device", "runtime-status-1", "succeeded", 200)
            .unwrap(),
        1
    );
    assert_eq!(
        store
            .get_task(DEFAULT_WORK_ITEM_PROJECT_ID, &task.id)
            .unwrap()
            .status
            .as_deref(),
        Some("in_review")
    );

    assert_eq!(
        store
            .project_bound_task_status("local-device", "runtime-status-1", "running", 150)
            .unwrap(),
        0
    );
    assert_eq!(
        store
            .get_task(DEFAULT_WORK_ITEM_PROJECT_ID, &task.id)
            .unwrap()
            .status
            .as_deref(),
        Some("in_review")
    );

    assert_eq!(
        store
            .project_bound_task_status("local-device", "runtime-status-1", "running", 300)
            .unwrap(),
        1
    );
    assert_eq!(
        store
            .project_bound_task_status("local-device", "runtime-status-1", "archived", 400)
            .unwrap(),
        1
    );
    assert_eq!(
        store
            .get_task(DEFAULT_WORK_ITEM_PROJECT_ID, &task.id)
            .unwrap()
            .status
            .as_deref(),
        Some("completed")
    );
}

#[test]
fn creates_and_reuses_default_work_item_binding_atomically() {
    let (_directory, store) = store();

    let first = store
        .ensure_default_work_item_binding(
            "local-device",
            "runtime-default-1",
            "Create from executor",
            "Track after runtime creation",
        )
        .unwrap();
    let second = store
        .ensure_default_work_item_binding(
            "local-device",
            "runtime-default-1",
            "Updated runtime title",
            "Ignored duplicate description",
        )
        .unwrap();

    assert_eq!(second.id, first.id);
    assert_eq!(second.loop_item_id, first.loop_item_id);
    assert_eq!(second.task_title.as_deref(), Some("Updated runtime title"));
    let items = store.list_tasks(DEFAULT_WORK_ITEM_PROJECT_ID).unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].title.as_deref(), Some("Create from executor"));
    assert_eq!(items[0].description, "Track after runtime creation");
    assert_eq!(items[0].metadata["has_additional_context"], json!(false));
    assert_eq!(
        items[0].metadata[RUNTIME_PROJECTION_METADATA_KEY],
        json!({
            "source_title": "Create from executor",
            "source_description": "Track after runtime creation",
        })
    );
}
