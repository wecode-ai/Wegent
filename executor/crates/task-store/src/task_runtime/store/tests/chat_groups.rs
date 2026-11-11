use super::*;

#[test]
fn group_board_order_preserves_group_scope_and_rejects_archived_writes() {
    let (_directory, store) = store();
    let group = store
        .chat_group_request("create", json!({"name":"Board"}))
        .unwrap();
    let owner = group["group"]["id"].as_str().unwrap();
    let mut ids = Vec::new();
    for title in ["First", "Second"] {
        ids.push(
            store
                .create_task(
                    owner,
                    serde_json::from_value(json!({"title":title})).unwrap(),
                )
                .unwrap()
                .id,
        );
    }
    ids.reverse();
    let input = TaskReorder {
        parent_id: None,
        status: Some("inbox".into()),
        item_ids: ids.clone(),
    };
    let ordered = store.reorder_tasks(owner, input.clone()).unwrap();
    assert_eq!(
        ordered
            .iter()
            .map(|item| item.id.clone())
            .collect::<Vec<_>>(),
        ids
    );
    assert!(ordered
        .iter()
        .all(|item| item.cloud_project_id.as_deref() == Some(owner)));
    store
        .chat_group_request(
            "update",
            json!({"group_id":owner,"name":"Board","status":"archived","version":1}),
        )
        .unwrap();
    assert!(store.reorder_tasks(owner, input).is_err());
    assert!(store.archive_task(owner, &ids[0]).is_err());
    assert_eq!(store.list_tasks(owner).unwrap().len(), 2);
}

#[test]
fn project_milestones_include_classified_threads_and_clear_archived_references() {
    let (_directory, store) = store();
    let project = store
        .create_project(serde_json::from_value(json!({"name":"Release"})).unwrap())
        .unwrap();
    let milestone = store
        .save_milestone(
            &project.id,
            None,
            serde_json::from_value(json!({"title":"v1"})).unwrap(),
        )
        .unwrap();
    let milestone_id = milestone["id"].as_str().unwrap();
    let mut threads = Vec::new();
    for name in ["Design", "Engineering"] {
        let group = store
            .chat_group_request("create", json!({"name":name}))
            .unwrap();
        let owner = group["group"]["id"].as_str().unwrap();
        let thread = store
            .create_task_with_context(
                owner,
                serde_json::from_value(json!({"title":name,"milestone_id":milestone_id})).unwrap(),
                None,
                None,
                Some(project.id.clone()),
            )
            .unwrap();
        threads.push((owner.to_owned(), thread));
    }
    assert_eq!(store.list_tasks(&project.id).unwrap().len(), 2);
    assert_eq!(
        store.list_milestones(&project.id).unwrap()[0]["open_issues"],
        2
    );
    let (owner, thread) = &threads[0];
    store
        .update_task(
            owner,
            &thread.id,
            TaskUpdate {
                version: thread.version,
                status: Some("completed".into()),
                ..Default::default()
            },
        )
        .unwrap();
    store.archive_task(owner, &thread.id).unwrap();
    let counts = &store.list_milestones(&project.id).unwrap()[0];
    assert_eq!(counts["open_issues"], 1);
    assert_eq!(counts["closed_issues"], 1);
    assert_eq!(counts["archived_issues"], 1);
    assert_eq!(store.list_tasks(&project.id).unwrap().len(), 1);
    for container in [&project.id, owner] {
        let archived = store.list_archived_tasks(container, 0, 50).unwrap();
        assert_eq!(archived.items.len(), 1);
        assert_eq!(archived.items[0].item.id, thread.id);
        assert_eq!(
            archived.items[0].item.cloud_project_id.as_deref(),
            Some(owner.as_str())
        );
        assert!(archived.items[0].item.thread_context.is_some());
    }
    store
        .delete_milestone(
            &project.id,
            milestone_id,
            milestone["version"].as_i64().unwrap(),
        )
        .unwrap();
    for (owner, thread) in &threads {
        if thread.id == threads[0].1.id {
            store.restore_task(owner, &thread.id).unwrap();
        }
        let kept = store.get_task(owner, &thread.id).unwrap();
        assert!(kept.metadata["milestone_id"].is_null());
        assert_eq!(kept.cloud_project_id.as_deref(), Some(owner.as_str()));
        assert_eq!(
            store
                .chat_group_request("project_link.get", json!({"thread_id":thread.id}))
                .unwrap()["project"]["id"],
            project.id
        );
    }
}

#[test]
fn thread_states_are_shared_and_tags_do_not_require_a_registry() {
    let (_directory, store) = store();
    let group = store
        .chat_group_request("create", json!({"name":"Unified"}))
        .unwrap();
    let id = group["group"]["id"].as_str().unwrap();
    store.chat_group_request("update",json!({"group_id":id,"name":"Unified","status":"active","version":1,"configuration":{"board_config":{"group_by":"tag","statuses":[{"id":"custom","name":"Custom","color":"gray"}]}}})).unwrap();
    let thread = store
        .create_task(
            id,
            serde_json::from_value(
                json!({"title":"Shared states","status":"in_review","tags":["自由新标签"]}),
            )
            .unwrap(),
        )
        .unwrap();
    assert_eq!(thread.status.as_deref(), Some("in_review"));
    assert_eq!(thread.metadata["tags"], json!(["自由新标签"]));
    for status in ["", "custom"] {
        assert!(store
            .update_task(
                id,
                &thread.id,
                TaskUpdate {
                    version: thread.version,
                    status: Some(status.into()),
                    ..Default::default()
                }
            )
            .is_err());
        assert_eq!(
            store.get_task(id, &thread.id).unwrap().version,
            thread.version
        );
    }
    store
        .connection()
        .unwrap()
        .execute(
            "UPDATE loop_items SET status='historical_custom' WHERE id=?1",
            [&thread.id],
        )
        .unwrap();
    assert_eq!(
        store.get_task(id, &thread.id).unwrap().status.as_deref(),
        Some("historical_custom")
    );
}

#[test]
fn local_participation_preserves_preferences_and_rejects_identity_collisions() {
    let (_directory, store) = store();
    let group = store
        .chat_group_request("create", json!({"name":"Preferences"}))
        .unwrap();
    let group_id = group["group"]["id"].as_str().unwrap();
    let thread = store
        .create_task(
            group_id,
            serde_json::from_value(json!({"title":"Review"})).unwrap(),
        )
        .unwrap();
    let key = format!("thread-participant:{}:0", thread.id);
    store
        .connection()
        .unwrap()
        .execute(
            "UPDATE loop_items SET metadata=?1 WHERE id=?2",
            params![
                json!({"notifications":"muted","keep":"private"}).to_string(),
                key
            ],
        )
        .unwrap();
    let update = |extra: Value| {
        let mut input = json!({"thread_id":thread.id});
        input
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        store.chat_group_request("participation.update", input)
    };
    update(json!({"joined":false})).unwrap();
    assert_eq!(
        update(json!({"joined":true})).unwrap()["participants"][0]["notifications"],
        "muted"
    );
    update(json!({"joined":false})).unwrap();
    assert_eq!(
        store
            .chat_group_request(
                "participants.invite",
                json!({"thread_id":thread.id,"user_ids":[0]})
            )
            .unwrap()["participants"][0]["notifications"],
        "muted"
    );
    assert!(update(json!({"joined":true,"notifications":"invalid"})).is_err());
    assert!(update(json!({"joined":true,"notifications":7})).is_err());
    assert_eq!(
        update(json!({"joined":true,"notifications":"all"})).unwrap()["participants"][0]
            ["notifications"],
        "all"
    );
    let metadata: String = store
        .connection()
        .unwrap()
        .query_row(
            "SELECT metadata FROM loop_items WHERE id=?1",
            [&key],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&metadata).unwrap()["keep"],
        "private"
    );
    for (kind, parent, user) in [
        ("task", thread.id.as_str(), 0),
        ("thread_participant", group_id, 0),
        ("thread_participant", thread.id.as_str(), 7),
    ] {
        store
            .connection()
            .unwrap()
            .execute(
                "UPDATE loop_items SET resource_type=?1,parent_id=?2,user_id=?3 WHERE id=?4",
                params![kind, parent, user, key],
            )
            .unwrap();
        assert!(update(json!({"joined":false})).is_err());
        let unchanged: String = store
            .connection()
            .unwrap()
            .query_row(
                "SELECT metadata FROM loop_items WHERE id=?1",
                [&key],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(unchanged, metadata);
    }
}

#[test]
fn archived_group_keeps_readable_participation_without_sidebar_or_posting() {
    let (_directory, store) = store();
    let group = store
        .chat_group_request("create", json!({"name":"Archive"}))
        .unwrap();
    let group_id = group["group"]["id"].as_str().unwrap();
    let thread = store
        .create_task(
            group_id,
            serde_json::from_value(json!({"title":"Retained"})).unwrap(),
        )
        .unwrap();
    store
        .chat_group_request(
            "update",
            json!({"group_id":group_id,"name":"Archive","status":"archived","version":1}),
        )
        .unwrap();
    let participation = store
        .chat_group_request("participation.get", json!({"thread_id":thread.id}))
        .unwrap();
    assert_eq!(participation["joined"], true);
    assert_eq!(participation["can_comment"], false);
    assert_eq!(participation["show_in_sidebar"], false);
    assert!(store.get_task(group_id, &thread.id).is_ok());
    assert!(
        store.chat_group_request("navigation", json!({})).unwrap()["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn task_owner_uses_storage_after_rehoming_instead_of_the_original_key() {
    let (_directory, store) = store();
    let project = store
        .create_project(serde_json::from_value(json!({"name":"Original"})).unwrap())
        .unwrap();
    let task = store
        .create_task(
            &project.id,
            serde_json::from_value(json!({"title":"Retained ID"})).unwrap(),
        )
        .unwrap();
    let group = store
        .chat_group_request("create", json!({"name":"Owning group"}))
        .unwrap();
    let owner = group["group"]["id"].as_str().unwrap();
    let connection = store.connection().unwrap();
    connection
        .execute(
            "UPDATE loop_items SET cloud_project_id=?1 WHERE id=?2",
            params![owner, task.id],
        )
        .unwrap();
    drop(connection);
    assert_eq!(store.task_owner(&task.id).unwrap().as_deref(), Some(owner));
    assert_eq!(store.task_owner("unknown").unwrap(), None);
    store
        .connection()
        .unwrap()
        .execute(
            "UPDATE loop_items SET deleted_at='2026-11-11' WHERE id=?1",
            [&task.id],
        )
        .unwrap();
    assert!(store.task_owner(&task.id).is_err());
    store
        .connection()
        .unwrap()
        .execute(
            "UPDATE loop_items SET deleted_at=NULL WHERE id=?1",
            [&task.id],
        )
        .unwrap();
    store
        .connection()
        .unwrap()
        .execute(
            "UPDATE loop_items SET deleted_at='2026-11-11' WHERE id=?1",
            [owner],
        )
        .unwrap();
    assert!(store.task_owner(&task.id).is_err());
    assert!(store.get_task(owner, &task.id).is_err());
}

#[test]
fn classified_thread_creation_is_atomic_and_validates_its_target() {
    let (_directory, store) = store();
    let created = store
        .chat_group_request("create", json!({"name":"Design"}))
        .unwrap();
    let group = created["group"]["id"].as_str().unwrap();
    let project = store
        .create_project(serde_json::from_value(json!({"name":"Plan"})).unwrap())
        .unwrap();
    let input = || serde_json::from_value(json!({"title":"Atomic Thread"})).unwrap();
    assert!(store
        .create_task_with_context(group, input(), None, None, Some("missing-project".into()))
        .is_err());
    assert!(store.list_tasks(group).unwrap().is_empty());
    let current = store.get_work_container(group).unwrap();
    assert_eq!(current.next_item_number, Some(1));
    assert!(store
        .create_task_with_context(&project.id, input(), None, None, Some(project.id.clone()))
        .is_err());
    assert!(store.list_tasks(&project.id).unwrap().is_empty());
    let thread = store
        .create_task_with_context(group, input(), None, None, Some(project.id.clone()))
        .unwrap();
    assert_eq!(thread.cloud_project_id.as_deref(), Some(group));
    assert_eq!(thread.thread_context.as_ref().unwrap().group_id, group);
    assert_eq!(thread.version, 1);
    assert_eq!(store.list_tasks(&project.id).unwrap()[0].id, thread.id);
    assert_eq!(
        store
            .chat_group_request("project_link.get", json!({"thread_id":thread.id}))
            .unwrap()["project"]["id"],
        project.id
    );
}

#[test]
fn project_aggregation_preserves_thread_scope_participation_and_unlinking() {
    let (_directory, store) = store();
    let group = store
        .chat_group_request("create", json!({"name":"Group"}))
        .unwrap();
    let group_id = group["group"]["id"].as_str().unwrap();
    let project = store
        .create_project(serde_json::from_value(json!({"name":"Plan"})).unwrap())
        .unwrap();
    let thread = store
        .create_task(
            group_id,
            serde_json::from_value(json!({"title":"Thread"})).unwrap(),
        )
        .unwrap();
    assert!(store.list_tasks(&project.id).unwrap().is_empty());
    store
        .chat_group_request(
            "project_link.update",
            json!({
                "thread_id":thread.id,"project_id":project.id,"version":thread.version
            }),
        )
        .unwrap();
    let items = store.list_tasks(&project.id).unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].cloud_project_id.as_deref(), Some(group_id));
    assert_eq!(items[0].thread_context.as_ref().unwrap().group_id, group_id);
    assert!(items[0].thread_context.as_ref().unwrap().joined);
    assert!(store.get_task(&project.id, &thread.id).is_err());
    store
        .chat_group_request(
            "participation.update",
            json!({"thread_id":thread.id,"joined":false}),
        )
        .unwrap();
    let items = store.list_tasks(&project.id).unwrap();
    assert!(!items[0].thread_context.as_ref().unwrap().joined);
    assert!(items[0].thread_context.as_ref().unwrap().can_join);
    let current = store.get_task(group_id, &thread.id).unwrap();
    store
        .chat_group_request(
            "project_link.update",
            json!({
                "thread_id":thread.id,"project_id":null,"version":current.version
            }),
        )
        .unwrap();
    assert!(store.list_tasks(&project.id).unwrap().is_empty());
    assert_eq!(store.list_tasks(group_id).unwrap().len(), 1);
}

#[test]
fn group_files_and_thread_deliveries_follow_content_authority() {
    let (_directory, store) = store();
    let created = store
        .chat_group_request("create", json!({"name":"Design"}))
        .unwrap();
    let group = created["group"]["id"].as_str().unwrap();
    let thread = store
        .create_task(
            group,
            serde_json::from_value(json!({"title":"Review"})).unwrap(),
        )
        .unwrap();
    assert_eq!(
        store
            .chat_group_request("participation.get", json!({"thread_id":thread.id}))
            .unwrap()["current_user_id"],
        0
    );
    let input = || BinaryInput {
        display_name: "notes.txt".into(),
        content_type: Some("text/plain".into()),
        base64: "bm90ZXM=".into(),
    };
    store.create_project_folder(group, "Design").unwrap();
    let file = store
        .upload_project_file(group, Some("Design/notes.txt"), input())
        .unwrap();
    assert_eq!(store.list_project_files(group).unwrap().len(), 2);
    assert_eq!(
        std::fs::read(store.project_file_path(&file.id).unwrap()).unwrap(),
        b"notes"
    );
    let file = store
        .move_project_file(&file.id, "Design/review.txt", file.version)
        .unwrap();
    let attachment = store
        .add_task_attachment(group, &thread.id, true, input())
        .unwrap();
    let delivery = store
        .create_delivery(
            group,
            &thread.id,
            true,
            serde_json::from_value(json!({"title":"Review","markdown":"Ready"})).unwrap(),
        )
        .unwrap();
    store
        .add_delivery_asset(&delivery.id, "notes.txt", input())
        .unwrap();
    store
        .chat_group_request(
            "participation.update",
            json!({"thread_id":thread.id,"joined":false}),
        )
        .unwrap();
    assert_eq!(store.list_task_attachments(&thread.id).unwrap().len(), 1);
    assert_eq!(
        store.delivery_detail(&delivery.id).unwrap().markdown,
        "Ready"
    );
    assert!(store
        .add_task_attachment(group, &thread.id, true, input())
        .is_err());
    assert!(store.delete_task_attachment(&attachment.id).is_err());
    assert!(store
        .add_delivery_asset(&delivery.id, "extra.txt", input())
        .is_err());
    assert!(store
        .finalize_delivery(&thread.id, &delivery.id, DeliveryFinalize::default())
        .is_err());
    assert!(store.discard_delivery(&delivery.id).is_err());
    store
        .chat_group_request(
            "participation.update",
            json!({"thread_id":thread.id,"joined":true}),
        )
        .unwrap();
    store
        .finalize_delivery(&thread.id, &delivery.id, DeliveryFinalize::default())
        .unwrap();
    assert_eq!(store.list_project_delivery_files(group).unwrap().len(), 1);
    let version = store
        .chat_group_request("get", json!({"group_id":group}))
        .unwrap()["group"]["version"]
        .as_i64()
        .unwrap();
    store
        .chat_group_request(
            "update",
            json!({"group_id":group,"name":"Design","version":version,"status":"archived"}),
        )
        .unwrap();
    assert_eq!(store.list_project_files(group).unwrap().len(), 2);
    assert!(store.create_project_folder(group, "Blocked").is_err());
    assert!(store.upload_project_file(group, None, input()).is_err());
    assert!(store
        .move_project_file(&file.id, "Blocked.txt", file.version)
        .is_err());
    assert!(store.delete_project_file(&file.id, false).is_err());
}

#[test]
fn group_threads_keep_participation_and_separate_lifecycle_from_chat() {
    let (_directory, store) = store();
    let created = store
        .chat_group_request("create", json!({"name":"Design"}))
        .unwrap();
    let group = created["group"]["id"].as_str().unwrap();
    assert!(!store
        .list_projects()
        .unwrap()
        .iter()
        .any(|project| project.id == group));
    assert!(store.get_project(group).is_err());
    let input: TaskCreate = serde_json::from_value(json!({"title":"Review design"})).unwrap();
    let thread = store.create_task(group, input).unwrap();
    let participation = |extra: Value| {
        let mut input = json!({"thread_id":thread.id});
        input
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        store
            .chat_group_request("participation.update", input)
            .unwrap()
    };
    assert_eq!(
        store
            .chat_group_request("participation.get", json!({"thread_id":thread.id}))
            .unwrap()["show_in_sidebar"],
        true
    );
    assert_eq!(
        participation(json!({"joined":true,"notifications":"muted"}))["participants"][0]
            ["notifications"],
        "muted"
    );
    assert_eq!(
        participation(json!({"joined":false}))["show_in_sidebar"],
        false
    );
    let message = LocalCommentCreate {
        project_id: group.into(),
        task_id: thread.id.clone(),
        client_message_id: Some("discussion".into()),
        sender_type: "user".into(),
        sender_id: "0".into(),
        sender_name: "Me".into(),
        content: "Ready to review".into(),
        metadata: json!({}),
        reply_to_message_id: None,
    };
    assert!(store.create_comment(&message).is_err());
    participation(json!({"joined":true}));
    store.create_comment(&message).unwrap();
    let finished = store
        .update_task(
            group,
            &thread.id,
            TaskUpdate {
                version: thread.version,
                status: Some("completed".into()),
                ..Default::default()
            },
        )
        .unwrap();
    let completed = store
        .chat_group_request("participation.get", json!({"thread_id":thread.id}))
        .unwrap();
    assert_eq!(completed["joined"], true);
    assert_eq!(completed["show_in_sidebar"], false);
    let reopened = store
        .update_task(
            group,
            &thread.id,
            TaskUpdate {
                version: finished.version,
                status: Some("pending".into()),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(
        store
            .chat_group_request("participation.get", json!({"thread_id":thread.id}))
            .unwrap()["show_in_sidebar"],
        true
    );
    assert_eq!(reopened.status.as_deref(), Some("pending"));
    let main = store.list_comments(group, "", 0).unwrap();
    assert_eq!(main.len(), 3);
    assert!(main.iter().all(|message| message.sender_type == "system"));
    assert!(main
        .iter()
        .all(|message| message.content != "Ready to review"));
    assert_eq!(store.list_comments(group, &thread.id, 0).unwrap().len(), 1);
}

#[test]
fn local_groups_do_not_create_cloud_grants_and_archive_blocks_writes() {
    let (_directory, store) = store();
    assert!(store
        .chat_group_request("create", json!({"name":"Shared","member_ids":[7]}))
        .is_err());
    let created = store
        .chat_group_request("create", json!({"name":"Private"}))
        .unwrap();
    let group = created["group"]["id"].as_str().unwrap();
    store
        .chat_group_request(
            "update",
            json!({"group_id":group,"name":"Private","version":1,"status":"archived"}),
        )
        .unwrap();
    assert!(store
        .create_task(
            group,
            serde_json::from_value(json!({"title":"Cannot create"})).unwrap()
        )
        .is_err());
    assert_eq!(
        store
            .chat_group_request("get", json!({"group_id":group}))
            .unwrap()["group"]["status"],
        "archived"
    );
}

#[test]
fn optional_project_classification_preserves_group_ownership_and_versions() {
    let (_directory, store) = store();
    let group = store
        .chat_group_request("create", json!({"name":"Group"}))
        .unwrap();
    let group_id = group["group"]["id"].as_str().unwrap();
    let project = store
        .create_project(ProjectCreate {
            name: "Project".into(),
            project_key: Some("PLAN".into()),
            description: String::new(),
            task_provider: TaskProviderKind::Local,
            provider_config: json!({}),
        })
        .unwrap();
    let thread = store
        .create_task(
            group_id,
            serde_json::from_value(json!({"title":"Classified Thread"})).unwrap(),
        )
        .unwrap();
    let linked = store
        .chat_group_request(
            "project_link.update",
            json!({"thread_id":thread.id,"project_id":project.id,"version":thread.version}),
        )
        .unwrap();
    assert_eq!(linked["project"]["id"], project.id);
    let current = store.get_task(group_id, &thread.id).unwrap();
    assert_eq!(current.cloud_project_id.as_deref(), Some(group_id));
    assert_eq!(current.version, thread.version + 1);
    assert!(store
        .chat_group_request(
            "project_link.update",
            json!({"thread_id":thread.id,"project_id":null,"version":thread.version})
        )
        .is_err());
    assert_eq!(
        store
            .chat_group_request("project_link.get", json!({"thread_id":thread.id}))
            .unwrap()["project"]["id"],
        project.id
    );
    let milestone = store
        .save_milestone(
            &project.id,
            None,
            serde_json::from_value(json!({"title":"Release","state":"open"})).unwrap(),
        )
        .unwrap();
    let assigned = store
        .update_task(
            group_id,
            &thread.id,
            TaskUpdate {
                version: current.version,
                milestone_id: Some(Some(milestone["id"].as_str().unwrap().into())),
                ..Default::default()
            },
        )
        .unwrap();
    store
        .chat_group_request(
            "project_link.update",
            json!({"thread_id":thread.id,"project_id":project.id,"version":assigned.version}),
        )
        .unwrap();
    let unchanged = store.get_task(group_id, &thread.id).unwrap();
    assert_eq!(unchanged.version, assigned.version);
    assert_eq!(unchanged.metadata["milestone_id"], milestone["id"]);
    let detached = store
        .chat_group_request(
            "project_link.update",
            json!({"thread_id":thread.id,"project_id":null,"version":assigned.version}),
        )
        .unwrap();
    assert!(detached["project"].is_null());
    assert!(store.get_task(group_id, &thread.id).unwrap().metadata["milestone_id"].is_null());
    assert_eq!(
        store
            .get_task(group_id, &thread.id)
            .unwrap()
            .cloud_project_id
            .as_deref(),
        Some(group_id)
    );
    assert_eq!(
        store.chat_group_request("navigation", json!({})).unwrap()["items"][0]["id"],
        thread.id
    );
}

#[test]
fn group_board_preferences_round_trip_without_changing_resource_authority() {
    let (_directory, store) = store();
    let group = store
        .chat_group_request("create", json!({"name":"Group"}))
        .unwrap();
    let id = group["group"]["id"].as_str().unwrap();
    let config = json!({"board_views":{"schema_version":1,"default_view_id":"default","views":[]},"tags":["review"],"board_config":{"group_by":"status","statuses":[{"id":"pending","name":"Pending","color":"gray"}],"schedule_view":{"show_weekends":false}}});
    let updated=store.chat_group_request("update",json!({"group_id":id,"name":"Group","description":"","status":"active","version":1,"configuration":config})).unwrap();
    assert_eq!(
        updated["group"]["configuration"]["board_views"],
        config["board_views"]
    );
    assert_eq!(
        updated["group"]["configuration"]["board_config"],
        super::super::project_status::group_board_config(&config["board_config"]).unwrap()
    );
    assert!(store.chat_group_request("update",json!({"group_id":id,"name":"Group","status":"active","version":2,"configuration":{"provider_config":{"token":"forged"}}})).is_err());
    assert_eq!(
        store
            .chat_group_request("get", json!({"group_id":id}))
            .unwrap()["group"]["version"],
        2
    );
}
