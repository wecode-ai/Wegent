use super::*;

#[test]
fn tracks_additional_context_for_default_runtime_issues() {
    let (_directory, store) = store();
    let binding = store
        .ensure_default_work_item_binding(
            "local-device",
            "runtime-default-context",
            "Runtime title",
            "Runtime description",
        )
        .unwrap();
    let item_id = binding.loop_item_id.unwrap();
    let initial = store
        .get_task(DEFAULT_WORK_ITEM_PROJECT_ID, &item_id)
        .unwrap();

    let status_only = store
        .update_task(
            DEFAULT_WORK_ITEM_PROJECT_ID,
            &item_id,
            TaskUpdate {
                assignee_group_id: None,
                assignee_user_id: None,
                version: initial.version,
                status: Some("in_progress".to_owned()),
                ..TaskUpdate::default()
            },
        )
        .unwrap();
    assert_eq!(status_only.metadata["has_additional_context"], json!(false));

    let enriched = store
        .update_task(
            DEFAULT_WORK_ITEM_PROJECT_ID,
            &item_id,
            TaskUpdate {
                assignee_group_id: None,
                assignee_user_id: None,
                version: status_only.version,
                description: Some("Runtime description\n\nExtra Issue context".to_owned()),
                ..TaskUpdate::default()
            },
        )
        .unwrap();
    assert_eq!(enriched.metadata["has_additional_context"], json!(true));

    let reverted = store
        .update_task(
            DEFAULT_WORK_ITEM_PROJECT_ID,
            &item_id,
            TaskUpdate {
                assignee_group_id: None,
                assignee_user_id: None,
                version: enriched.version,
                description: Some("Runtime description".to_owned()),
                ..TaskUpdate::default()
            },
        )
        .unwrap();
    assert_eq!(reverted.metadata["has_additional_context"], json!(false));

    let attachment = store
        .add_task_attachment(
            DEFAULT_WORK_ITEM_PROJECT_ID,
            &item_id,
            true,
            crate::task_runtime::BinaryInput {
                display_name: "context.txt".to_owned(),
                content_type: Some("text/plain".to_owned()),
                base64: "Y29udGV4dA==".to_owned(),
            },
        )
        .unwrap();
    assert_eq!(
        store
            .get_task(DEFAULT_WORK_ITEM_PROJECT_ID, &item_id)
            .unwrap()
            .metadata["has_additional_context"],
        json!(true)
    );

    store
        .delete_task_attachment(DEFAULT_WORK_ITEM_PROJECT_ID, &item_id, &attachment.id)
        .unwrap();
    assert_eq!(
        store
            .get_task(DEFAULT_WORK_ITEM_PROJECT_ID, &item_id)
            .unwrap()
            .metadata["has_additional_context"],
        json!(false)
    );

    store
        .create_comment(&LocalCommentCreate {
            project_id: DEFAULT_WORK_ITEM_PROJECT_ID.to_owned(),
            task_id: item_id.clone(),
            client_message_id: None,
            sender_type: "user".to_owned(),
            sender_id: "user-1".to_owned(),
            sender_name: "User".to_owned(),
            content: "Use the attached acceptance criteria".to_owned(),
            metadata: json!({}),
            reply_to_message_id: None,
        })
        .unwrap();
    assert_eq!(
        store
            .get_task(DEFAULT_WORK_ITEM_PROJECT_ID, &item_id)
            .unwrap()
            .metadata["has_additional_context"],
        json!(true)
    );

    let parent_binding = store
        .ensure_default_work_item_binding(
            "local-device",
            "runtime-default-parent",
            "Parent runtime title",
            "Parent runtime description",
        )
        .unwrap();
    let parent_id = parent_binding.loop_item_id.unwrap();
    let child = store
        .create_task(
            DEFAULT_WORK_ITEM_PROJECT_ID,
            TaskCreate {
                milestone_id: None,
                title: "Temporary child context".to_owned(),
                description: String::new(),
                status: "completed".to_owned(),
                priority: "none".to_owned(),
                parent_id: Some(parent_id.clone()),
                tags: vec![],
                assignee_user_id: None,
                assignee_agent_id: None,
                assignee_group_id: None,
                workflow: None,
            },
        )
        .unwrap();
    assert_eq!(
        store
            .get_task(DEFAULT_WORK_ITEM_PROJECT_ID, &parent_id)
            .unwrap()
            .metadata["has_additional_context"],
        json!(true)
    );

    store
        .archive_task(DEFAULT_WORK_ITEM_PROJECT_ID, &child.id)
        .unwrap();
    assert_eq!(
        store
            .get_task(DEFAULT_WORK_ITEM_PROJECT_ID, &parent_id)
            .unwrap()
            .metadata["has_additional_context"],
        json!(false)
    );

    let restored = store
        .restore_task(DEFAULT_WORK_ITEM_PROJECT_ID, &child.id)
        .unwrap();
    assert_eq!(
        restored
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>(),
        vec![child.id.as_str()]
    );
    assert_eq!(
        store
            .get_task(DEFAULT_WORK_ITEM_PROJECT_ID, &parent_id)
            .unwrap()
            .metadata["has_additional_context"],
        json!(true)
    );
}

#[test]
fn lists_task_bindings_for_multiple_items_in_one_query() {
    let (_directory, store) = store();
    let project = local_project(&store);
    let first = store
        .create_task(
            &project.id,
            TaskCreate {
                milestone_id: None,
                title: "First bound task".to_owned(),
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
                milestone_id: None,
                title: "Second bound task".to_owned(),
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
    for (item, runtime_task_id) in [(&first, "runtime-1"), (&second, "runtime-2")] {
        store
            .bind_task(
                &project.id,
                Some(&item.id),
                None,
                RuntimeTaskAddress {
                    device_id: "local-device".to_owned(),
                    task_id: runtime_task_id.to_owned(),
                    task_title: item.title.clone(),
                    backend_task_id: None,
                    model_selection: None,
                    execution_context: None,
                    workflow_node_id: None,
                },
                None,
            )
            .unwrap();
    }

    let bindings = store
        .list_task_bindings_batch(&[
            first.id.clone(),
            second.id.clone(),
            first.id.clone(),
            String::new(),
        ])
        .unwrap();
    let task_ids = bindings
        .iter()
        .map(|binding| binding.task_id.as_str())
        .collect::<HashSet<_>>();

    assert_eq!(bindings.len(), 2);
    assert_eq!(task_ids, HashSet::from(["runtime-1", "runtime-2"]));
    assert!(store.list_task_bindings_batch(&[]).unwrap().is_empty());
}

#[test]
fn keeps_one_system_binding_alongside_the_current_user_binding() {
    let (_directory, store) = store();
    let user_project = local_project(&store);
    let system_task = store
        .create_task(
            DEFAULT_WORK_ITEM_PROJECT_ID,
            TaskCreate {
                milestone_id: None,
                title: "System task".to_owned(),
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
    let user_task = store
        .create_task(
            &user_project.id,
            TaskCreate {
                milestone_id: None,
                title: "User issue".to_owned(),
                description: String::new(),
                status: "pending".to_owned(),
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
    let address = RuntimeTaskAddress {
        device_id: "local-device".to_owned(),
        task_id: "runtime-1".to_owned(),
        task_title: Some("Runtime".to_owned()),
        backend_task_id: None,
        model_selection: None,
        execution_context: None,
        workflow_node_id: None,
    };

    let system_binding = store
        .bind_task(
            DEFAULT_WORK_ITEM_PROJECT_ID,
            Some(&system_task.id),
            None,
            address.clone(),
            None,
        )
        .unwrap();
    let user_binding = store
        .bind_task(&user_project.id, Some(&user_task.id), None, address, None)
        .unwrap();

    assert_eq!(system_binding.binding_type, "system");
    assert_eq!(user_binding.binding_type, "user");
    assert_eq!(
        store
            .find_task_binding("local-device", "runtime-1")
            .unwrap()
            .id,
        user_binding.id
    );
    assert_eq!(
        store
            .find_system_task_binding("local-device", "runtime-1")
            .unwrap()
            .id,
        system_binding.id
    );
    assert_eq!(
        store
            .find_user_task_binding("local-device", "runtime-1")
            .unwrap()
            .id,
        user_binding.id
    );

    store
        .unbind_task("local-device", "runtime-1", Some(&user_task.id))
        .unwrap();
    assert_eq!(
        store
            .find_task_binding("local-device", "runtime-1")
            .unwrap()
            .id,
        system_binding.id
    );
    store
        .unbind_task("local-device", "runtime-1", Some(&system_task.id))
        .unwrap();
    assert_eq!(
        store
            .find_system_task_binding("local-device", "runtime-1")
            .unwrap()
            .id,
        system_binding.id
    );
}

#[test]
fn attachment_access_requires_matching_project_task_and_attachment() {
    let (_directory, store) = store();
    let first = local_project(&store);
    let second = store
        .create_project(ProjectCreate {
            name: "Other board".into(),
            project_key: Some("OTHER".into()),
            description: String::new(),
            task_provider: TaskProviderKind::Github,
            provider_config: json!({}),
        })
        .unwrap();
    let input = || BinaryInput {
        display_name: "notes.txt".into(),
        content_type: Some("text/plain".into()),
        base64: "bm90ZXM=".into(),
    };
    // External issue identifiers can coincide across independent projects.
    let attachment = store
        .add_task_attachment(&first.id, "issue-1", false, input())
        .unwrap();
    let other = store
        .add_task_attachment(&second.id, "issue-1", false, input())
        .unwrap();
    let first_list = store.list_task_attachments(&first.id, "issue-1").unwrap();
    assert_eq!(first_list.len(), 1);
    assert_eq!(first_list[0].id, attachment.id);
    let second_list = store.list_task_attachments(&second.id, "issue-1").unwrap();
    assert_eq!(second_list.len(), 1);
    assert_eq!(second_list[0].id, other.id);
    for (project, task) in [(&second.id, "issue-1"), (&first.id, "issue-2")] {
        assert!(matches!(
            store.task_attachment_path(project, task, &attachment.id),
            Err(TaskRuntimeError::TaskNotFound)
        ));
        assert!(matches!(
            store.delete_task_attachment(project, task, &attachment.id),
            Err(TaskRuntimeError::TaskNotFound)
        ));
    }
    let path = store
        .task_attachment_path(&first.id, "issue-1", &attachment.id)
        .unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "notes");
    store
        .delete_task_attachment(&first.id, "issue-1", &attachment.id)
        .unwrap();
    assert!(!path.exists());
    assert!(store
        .list_task_attachments(&first.id, "issue-1")
        .unwrap()
        .is_empty());
    assert!(store
        .task_attachment_path(&first.id, "issue-1", &attachment.id)
        .is_err());
    assert!(store
        .task_attachment_path(&second.id, "issue-1", &other.id)
        .unwrap()
        .exists());
}

#[test]
fn stores_project_content_without_persisting_external_issues() {
    let (_directory, store) = store();
    let local_project = local_project(&store);
    let task = store
        .create_task(
            &local_project.id,
            TaskCreate {
                milestone_id: None,
                title: "Persisted".to_owned(),
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

    let file = store
        .upload_project_file(
            &local_project.id,
            Some("docs/readme.txt"),
            BinaryInput {
                display_name: "readme.txt".to_owned(),
                content_type: Some("text/plain".to_owned()),
                base64: "aGVsbG8=".to_owned(),
            },
        )
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(store.project_file_path(&file.id).unwrap()).unwrap(),
        "hello"
    );
    let object_key: String = store
        .connection()
        .unwrap()
        .query_row(
            "SELECT object_key FROM loop_items WHERE id = ?1",
            [&file.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(object_key, format!("files/{}/readme.txt", file.id));
    assert!(!std::path::Path::new(&object_key).is_absolute());
    let moved = store
        .move_project_file(&file.id, "docs/guides/readme.txt", file.version)
        .unwrap();
    assert_eq!(moved.path, "docs/guides/readme.txt");

    let attachment = store
        .add_task_attachment(
            &local_project.id,
            &task.id,
            true,
            BinaryInput {
                display_name: "notes.txt".to_owned(),
                content_type: None,
                base64: "bm90ZXM=".to_owned(),
            },
        )
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(
            store
                .task_attachment_path(&local_project.id, &task.id, &attachment.id)
                .unwrap()
        )
        .unwrap(),
        "notes"
    );

    let delivery = store
        .create_delivery(
            &local_project.id,
            &task.id,
            true,
            DeliveryCreate {
                title: String::new(),
                markdown: "# Done".to_owned(),
                chat: None,
                source_task: None,
            },
        )
        .unwrap();
    let asset = store
        .add_delivery_asset(
            &delivery.id,
            "assets/result.txt",
            BinaryInput {
                display_name: "result.txt".to_owned(),
                content_type: None,
                base64: "ZG9uZQ==".to_owned(),
            },
        )
        .unwrap();
    let finalized = store
        .finalize_delivery(
            &task.id,
            &delivery.id,
            crate::task_runtime::DeliveryFinalize::default(),
        )
        .unwrap();
    assert_eq!(finalized.status, "delivered");
    assert_eq!(
        std::fs::read_to_string(store.delivery_asset_path(&asset.id).unwrap()).unwrap(),
        "done"
    );
    assert_eq!(store.list_deliveries(&task.id).unwrap().len(), 1);

    let external_project = store
        .create_project(ProjectCreate {
            name: "GitHub board".to_owned(),
            project_key: Some("GH".to_owned()),
            description: String::new(),
            task_provider: TaskProviderKind::Github,
            provider_config: json!({"repository": "owner/repo"}),
        })
        .unwrap();
    store
        .add_task_attachment(
            &external_project.id,
            "github-42",
            false,
            BinaryInput {
                display_name: "issue.txt".to_owned(),
                content_type: None,
                base64: "aXNzdWU=".to_owned(),
            },
        )
        .unwrap();
    let external_delivery = store
        .create_delivery(
            &external_project.id,
            "42",
            false,
            DeliveryCreate {
                title: String::new(),
                markdown: "External result".to_owned(),
                chat: None,
                source_task: None,
            },
        )
        .unwrap();
    let external_asset = store
        .add_delivery_asset(
            &external_delivery.id,
            "result.txt",
            BinaryInput {
                display_name: "result.txt".to_owned(),
                content_type: None,
                base64: "ZG9uZQ==".to_owned(),
            },
        )
        .unwrap();
    let connection = store.connection().unwrap();
    let task_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM loop_items WHERE resource_type = 'task'
               AND cloud_project_id = ?1",
            [&external_project.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(task_count, 0);
    let (loop_item_id, external_item_id): (Option<String>, Option<String>) = connection
        .query_row(
            "SELECT loop_item_id, json_extract(metadata, '$.external_item_id')
             FROM loop_items WHERE id = ?1",
            [&external_asset.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(loop_item_id, None);
    assert_eq!(external_item_id.as_deref(), Some("42"));
}

#[test]
fn finalized_delivery_is_bound_to_the_source_workflow_node() {
    let (_directory, store) = store();
    let project = local_project(&store);
    let task = store
        .create_task(
            &project.id,
            TaskCreate {
                milestone_id: None,
                title: "Workflow delivery".to_owned(),
                description: String::new(),
                status: "pending".to_owned(),
                priority: "none".to_owned(),
                parent_id: None,
                tags: vec![],
                assignee_user_id: None,
                assignee_agent_id: None,
                assignee_group_id: None,
                workflow: Some(json!({
                    "version": 1,
                    "nodes": [{
                        "id": "develop",
                        "name": "Develop",
                        "kind": "my_task",
                        "status": "ready",
                        "depends_on": [],
                        "required": true,
                        "required_deliverables": ["result.txt"],
                        "delivery_ids": []
                    }]
                })),
            },
        )
        .unwrap();
    let address = RuntimeTaskAddress {
        device_id: "device-1".to_owned(),
        task_id: "runtime-1".to_owned(),
        task_title: Some("Implement".to_owned()),
        backend_task_id: None,
        model_selection: None,
        execution_context: None,
        workflow_node_id: Some("develop".to_owned()),
    };
    store
        .bind_task(&project.id, Some(&task.id), None, address.clone(), None)
        .unwrap();
    let delivery = store
        .create_delivery(
            &project.id,
            &task.id,
            true,
            DeliveryCreate {
                title: String::new(),
                markdown: "# Done".to_owned(),
                chat: Some(json!({"messages": [{"role": "assistant", "content": "done"}]})),
                source_task: Some(address),
            },
        )
        .unwrap();

    store
        .finalize_delivery(
            &task.id,
            &delivery.id,
            crate::task_runtime::DeliveryFinalize::default(),
        )
        .unwrap();

    let updated = store.get_task(&project.id, &task.id).unwrap();
    assert_eq!(
        updated.metadata["workflow"]["nodes"][0]["delivery_ids"],
        json!([delivery.id])
    );
    assert_eq!(
        store.delivery_detail(&delivery.id).unwrap().chat,
        Some(json!({"messages": [{"role": "assistant", "content": "done"}]}))
    );
}

#[test]
fn external_provider_projects_do_not_create_local_task_rows() {
    let (_directory, store) = store();
    let project = store
        .create_project(ProjectCreate {
            name: "GitHub board".to_owned(),
            project_key: Some("GH".to_owned()),
            description: String::new(),
            task_provider: TaskProviderKind::Github,
            provider_config: json!({"repository": "owner/repo"}),
        })
        .unwrap();

    let error = store.list_tasks(&project.id).unwrap_err();
    assert!(matches!(error, TaskRuntimeError::UnsupportedProvider(_)));
    let connection = store.connection().unwrap();
    let task_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM loop_items WHERE resource_type = 'task'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(task_count, 0);
}
