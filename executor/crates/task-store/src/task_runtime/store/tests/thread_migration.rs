use super::*;

fn fixture() -> (TempDir, LocalTaskStore, LoopItem, String, LoopItem) {
    let (directory, store) = store();
    let source = store
        .create_project(serde_json::from_value(json!({"name":"Legacy project"})).unwrap())
        .unwrap();
    let target = store
        .chat_group_request("create", json!({"name":"Explicit target"}))
        .unwrap();
    let target = target["group"]["id"].as_str().unwrap().to_owned();
    let thread = store
        .create_task(
            &source.id,
            serde_json::from_value(json!({"title":"Legacy Thread","status":"pending"})).unwrap(),
        )
        .unwrap();
    (directory, store, source, target, thread)
}

fn inspect(store: &LocalTaskStore, source: &str, target: &str) -> Value {
    store
        .chat_group_request(
            "migration.inspect",
            json!({"source_project_id":source,"target_group_id":target}),
        )
        .unwrap()["inventory"]
        .clone()
}

fn apply(
    store: &LocalTaskStore,
    inventory: &Value,
    retain: bool,
) -> Result<Value, TaskRuntimeError> {
    store.chat_group_request(
        "migration.apply",
        json!({"inventory":inventory,"retain_source_project":retain}),
    )
}

#[test]
fn native_thread_migration_preserves_history_blobs_private_binding_and_replay_choices() {
    let (_directory, store, source, target, thread) = fixture();
    let comment = store
        .create_comment(&LocalCommentCreate {
            project_id: source.id.clone(),
            task_id: thread.id.clone(),
            client_message_id: None,
            sender_type: "user".into(),
            sender_id: "0".into(),
            sender_name: "Me".into(),
            content: "Original public discussion".into(),
            metadata: json!({}),
            reply_to_message_id: None,
        })
        .unwrap();
    let binding = store
        .bind_task(
            &source.id,
            Some(&thread.id),
            None,
            serde_json::from_value(json!({
                "device_id":"owner-device","task_id":"private-original-session",
                "execution_context":{"workspacePath":"/private/original"}
            }))
            .unwrap(),
            None,
        )
        .unwrap();
    let attachment = store
        .add_task_attachment(
            &source.id,
            &thread.id,
            true,
            BinaryInput {
                display_name: "source.txt".into(),
                content_type: None,
                base64: "aGVsbG8=".into(),
            },
        )
        .unwrap();
    let path = store.task_attachment_path(&attachment.id).unwrap();
    let delivery = store
        .create_delivery(
            &source.id,
            &thread.id,
            true,
            DeliveryCreate {
                title: "Historical delivery".into(),
                markdown: "Published snapshot".into(),
                chat: None,
                source_task: None,
            },
        )
        .unwrap();
    store
        .finalize_delivery(&thread.id, &delivery.id, DeliveryFinalize::default())
        .unwrap();
    let before = store.get_task(&source.id, &thread.id).unwrap();
    let report = inspect(&store, &source.id, &target);
    assert!(!report.to_string().contains("private-original-session"));
    assert!(!report.to_string().contains("/private/original"));
    let result = apply(&store, &report, true).unwrap();
    assert_eq!(result["replayed"], false);
    let after = store.get_task(&target, &thread.id).unwrap();
    assert_eq!(after.id, before.id);
    assert_eq!(after.version, before.version + 1);
    assert_eq!(
        (&after.created_at, &after.updated_at, &after.completed_at),
        (&before.created_at, &before.updated_at, &before.completed_at)
    );
    assert_eq!(after.metadata, before.metadata);
    assert_eq!(after.cloud_project_id.as_deref(), Some(target.as_str()));
    assert!(after.thread_context.unwrap().joined);
    assert_eq!(
        store.task_owner(&thread.id).unwrap().as_deref(),
        Some(target.as_str())
    );
    let messages = store.list_comments(&target, &thread.id, 0).unwrap();
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].message_id, comment.message_id);
    assert_eq!(messages[0].content, comment.content);
    assert_eq!(messages[0].created_at, comment.created_at);
    assert!(store.list_comments(&target, "", 0).unwrap().is_empty());
    assert_eq!(store.task_attachment_path(&attachment.id).unwrap(), path);
    assert_eq!(std::fs::read(path).unwrap(), b"hello");
    assert_eq!(
        store.delivery_detail(&delivery.id).unwrap().markdown,
        "Published snapshot"
    );
    let bindings = store.list_task_bindings(&thread.id).unwrap();
    assert_eq!(bindings.len(), 1);
    assert_eq!(bindings[0].id, binding.id);
    assert_eq!(bindings[0].task_user_id, 0);
    assert_eq!(bindings[0].cloud_project_id, target);
    assert_eq!(bindings[0].task_id, binding.task_id);
    assert_eq!(bindings[0].execution_context, binding.execution_context);
    assert!(
        store
            .list_tasks(&source.id)
            .unwrap()
            .iter()
            .any(|row| row.id == thread.id
                && row.cloud_project_id.as_deref() == Some(target.as_str()))
    );
    store
        .update_task(
            &target,
            &thread.id,
            TaskUpdate {
                version: after.version,
                title: Some("Edited later".into()),
                ..Default::default()
            },
        )
        .unwrap();
    store
        .chat_group_request(
            "participation.update",
            json!({"thread_id":thread.id,"joined":false,"notifications":"muted"}),
        )
        .unwrap();
    let replay = apply(&store, &report, true).unwrap();
    assert_eq!(replay["replayed"], true);
    assert_eq!(replay["checkpoint_id"], result["checkpoint_id"]);
    assert_eq!(
        store
            .get_task(&target, &thread.id)
            .unwrap()
            .title
            .as_deref(),
        Some("Edited later")
    );
    let preferences = store
        .chat_group_request("participation.get", json!({"thread_id":thread.id}))
        .unwrap();
    assert_eq!(preferences["joined"], false);
    let rejoined = store
        .chat_group_request(
            "participation.update",
            json!({"thread_id":thread.id,"joined":true}),
        )
        .unwrap();
    assert_eq!(rejoined["participants"][0]["notifications"], "muted");
}

#[test]
fn native_thread_migration_rolls_back_prior_entries_and_resumes_after_collision() {
    let (_directory, store, source, target, first) = fixture();
    let second = store
        .create_task(
            &source.id,
            serde_json::from_value(json!({"title":"Second","parent_id":first.id})).unwrap(),
        )
        .unwrap();
    let collision = format!("thread-participant:{}:0", second.id);
    {
        let connection = store.connection().unwrap();
        connection.execute("INSERT INTO loop_items(id,resource_type,metadata,created_at,updated_at) VALUES(?1,'file','{}',?2,?2)",params![collision,now()]).unwrap();
    }
    let report = inspect(&store, &source.id, &target);
    assert!(apply(&store, &report, true).is_err());
    assert_eq!(
        store.get_task(&source.id, &first.id).unwrap().version,
        first.version
    );
    assert_eq!(
        store.get_task(&source.id, &second.id).unwrap().version,
        second.version
    );
    assert!(store.list_tasks(&target).unwrap().is_empty());
    {
        let connection = store.connection().unwrap();
        let count:i64=connection.query_row("SELECT count(*) FROM loop_items WHERE resource_type IN ('thread_participant','thread_project_link','thread_migration')",[],|row|row.get(0)).unwrap();
        assert_eq!(count, 0);
        connection
            .execute("DELETE FROM loop_items WHERE id=?1", [collision])
            .unwrap();
    }
    assert_eq!(apply(&store, &report, true).unwrap()["replayed"], false);
    assert_eq!(
        store
            .get_task(&target, &second.id)
            .unwrap()
            .parent_id
            .as_deref(),
        Some(first.id.as_str())
    );
}

#[test]
fn native_thread_migration_rejects_stale_inventory_active_work_and_incomplete_checkpoint() {
    for problem in ["stale", "active", "checkpoint", "archived", "counter"] {
        let (_directory, store, source, target, thread) = fixture();
        if problem == "counter" {
            store
                .connection()
                .unwrap()
                .execute(
                    "UPDATE loop_items SET next_item_number=?1 WHERE id=?2",
                    params![i64::MAX, target],
                )
                .unwrap();
        }
        let report = inspect(&store, &source.id, &target);
        let mut owner = source.id.clone();
        match problem {
            "stale" => {
                store
                    .update_task(
                        &source.id,
                        &thread.id,
                        TaskUpdate {
                            version: thread.version,
                            title: Some("Changed".into()),
                            ..Default::default()
                        },
                    )
                    .unwrap();
            }
            "active" => {
                store.connection().unwrap().execute("INSERT INTO loop_item_executions(loop_item_id,cloud_project_id,agent_id,status,created_at,updated_at) VALUES(?1,?2,'old-agent','queued',?3,?3)",params![thread.id,source.id,now()]).unwrap();
            }
            "checkpoint" => {
                let result = apply(&store, &report, true).unwrap();
                store
                    .connection()
                    .unwrap()
                    .execute(
                        "UPDATE loop_items SET status='failed' WHERE id=?1",
                        [result["checkpoint_id"].as_str().unwrap()],
                    )
                    .unwrap();
                owner = target.clone();
            }
            "archived" => {
                store.chat_group_request("update",json!({"group_id":target,"name":"Archived","status":"archived","version":1})).unwrap();
            }
            "counter" => {}
            _ => unreachable!(),
        }
        assert!(apply(&store, &report, true).is_err(), "{problem}");
        assert_eq!(
            store.task_owner(&thread.id).unwrap().as_deref(),
            Some(owner.as_str()),
            "{problem}"
        );
    }
}

#[test]
fn native_thread_migration_excludes_private_hierarchy_and_preserves_archived_completion() {
    let (_directory, store, source, target, parent) = fixture();
    let child = store
        .create_task(
            &source.id,
            serde_json::from_value(
                json!({"title":"Public child","parent_id":parent.id,"status":"completed"}),
            )
            .unwrap(),
        )
        .unwrap();
    let private_child = store
        .create_task(
            &source.id,
            serde_json::from_value(json!({"title":"Private child","parent_id":child.id})).unwrap(),
        )
        .unwrap();
    {
        let connection = store.connection().unwrap();
        for id in [&parent.id, &private_child.id] {
            connection.execute("UPDATE loop_items SET metadata=json_set(metadata,'$.security_level','related') WHERE id=?1",[id]).unwrap();
        }
    }
    store.archive_task(&source.id, &child.id).unwrap();
    let report = inspect(&store, &source.id, &target);
    assert_eq!(report["entries"].as_array().unwrap().len(), 1);
    assert_eq!(report["entries"][0]["target_parent"], Value::Null);
    assert_eq!(
        report["excluded_restricted_ids"].as_array().unwrap().len(),
        2
    );
    assert!(!report.to_string().contains("Private child"));
    apply(&store, &report, true).unwrap();
    assert_eq!(
        store.task_owner(&parent.id).unwrap().as_deref(),
        Some(source.id.as_str())
    );
    {
        let connection = store.connection().unwrap();
        let retained: (String, Option<String>, Option<String>) = connection
            .query_row(
                "SELECT cloud_project_id,parent_id,deleted_at FROM loop_items WHERE id=?1",
                [&private_child.id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(retained.0, source.id);
        assert_eq!(retained.1, None);
        assert!(retained.2.is_some());
    }
    assert!(
        store.chat_group_request("navigation", json!({})).unwrap()["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let connection = store.connection().unwrap();
    let state: (String, String, Option<String>) = connection
        .query_row(
            "SELECT cloud_project_id,status,deleted_at FROM loop_items WHERE id=?1",
            [child.id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(state.0, target);
    assert_eq!(state.1, "completed");
    assert!(state.2.is_some());
}

#[test]
fn native_thread_migration_maps_unset_status_without_guessing_participation() {
    let (_directory, store, source, target, thread) = fixture();
    store
        .connection()
        .unwrap()
        .execute(
            "UPDATE loop_items SET status=NULL,created_by_user_id=7 WHERE id=?1",
            [&thread.id],
        )
        .unwrap();
    let report = inspect(&store, &source.id, &target);
    assert!(apply(&store, &report, false).is_err());
    let report=store.chat_group_request("migration.inspect",json!({"source_project_id":source.id,"target_group_id":target,"status_map":{"":"pending"}})).unwrap()["inventory"].clone();
    apply(&store, &report, false).unwrap();
    let migrated = store.get_task(&target, &thread.id).unwrap();
    assert_eq!(migrated.status.as_deref(), Some("pending"));
    assert!(!migrated.thread_context.unwrap().joined);
    assert!(store.list_tasks(&source.id).unwrap().is_empty());
}

#[test]
fn native_thread_migration_requires_mapping_for_project_execution_crews() {
    let (_directory, store, source, target, thread) = fixture();
    store.connection().unwrap().execute("UPDATE loop_items SET metadata=json_set(metadata,'$.collaboration_group',json(?1)) WHERE id=?2",params![json!({"id":"source-only-execution-crew"}).to_string(),thread.id]).unwrap();
    let report = inspect(&store, &source.id, &target);
    assert_eq!(
        report["entries"][0]["blockers"],
        json!(["execution_resource_mapping_required"])
    );
    assert!(apply(&store, &report, true).is_err());
    assert_eq!(
        store.task_owner(&thread.id).unwrap().as_deref(),
        Some(source.id.as_str())
    );
}

#[test]
fn native_thread_migration_uses_exact_human_facts_and_keeps_existing_left_preferences() {
    let (_directory, store, source, target, observer) = fixture();
    let author = store
        .create_task(
            &source.id,
            serde_json::from_value(json!({"title":"Human author"})).unwrap(),
        )
        .unwrap();
    let left = store
        .create_task(
            &source.id,
            serde_json::from_value(json!({"title":"Previously left"})).unwrap(),
        )
        .unwrap();
    {
        let connection = store.connection().unwrap();
        for id in [&observer.id, &author.id] {
            connection
                .execute(
                    "UPDATE loop_items SET created_by_user_id=7 WHERE id=?1",
                    [id],
                )
                .unwrap();
        }
        connection.execute("INSERT INTO loop_items(id,resource_type,parent_id,user_id,status,metadata,created_at,updated_at) VALUES(?1,'thread_participant',?2,0,'left',?3,?4,?4)",params![format!("thread-participant:{}:0",left.id),left.id,json!({"notifications":"muted","other_preference":true}).to_string(),now()]).unwrap();
    }
    for (task, sender) in [(&observer.id, "00"), (&author.id, "0")] {
        store
            .create_comment(&LocalCommentCreate {
                project_id: source.id.clone(),
                task_id: task.clone(),
                client_message_id: None,
                sender_type: "user".into(),
                sender_id: sender.into(),
                sender_name: "Recorded author".into(),
                content: "Human discussion".into(),
                metadata: json!({}),
                reply_to_message_id: None,
            })
            .unwrap();
    }
    let report = inspect(&store, &source.id, &target);
    apply(&store, &report, false).unwrap();
    assert!(
        !store
            .get_task(&target, &observer.id)
            .unwrap()
            .thread_context
            .unwrap()
            .joined
    );
    assert!(
        store
            .get_task(&target, &author.id)
            .unwrap()
            .thread_context
            .unwrap()
            .joined
    );
    assert!(
        !store
            .get_task(&target, &left.id)
            .unwrap()
            .thread_context
            .unwrap()
            .joined
    );
    let navigation = store.chat_group_request("navigation", json!({})).unwrap();
    assert_eq!(navigation["items"].as_array().unwrap().len(), 1);
    assert_eq!(navigation["items"][0]["id"], author.id);
    let rejoined = store
        .chat_group_request(
            "participation.update",
            json!({"thread_id":left.id,"joined":true}),
        )
        .unwrap();
    assert_eq!(rejoined["participants"][0]["notifications"], "muted");
}

#[test]
fn native_thread_migration_rejects_system_backend_and_provider_scope() {
    for kind in [
        "system",
        "backend",
        "provider",
        "project_target",
        "backend_target",
    ] {
        let (_directory, store, source, target, thread) = fixture();
        let mut requested_source = source.id.clone();
        let mut requested_target = target.clone();
        match kind {
            "system" => requested_source = DEFAULT_WORK_ITEM_PROJECT_ID.into(),
            "project_target" => requested_target = source.id.clone(),
            "backend" | "provider" | "backend_target" => {
                let (id, key, value) = if kind == "backend_target" {
                    (&target, "project_store", "backend")
                } else if kind == "backend" {
                    (&source.id, "project_store", "backend")
                } else {
                    (&source.id, "task_provider", "github")
                };
                store
                    .connection()
                    .unwrap()
                    .execute(
                        "UPDATE loop_items SET metadata=json_set(metadata,?1,?2) WHERE id=?3",
                        params![format!("$.{key}"), value, id],
                    )
                    .unwrap();
            }
            _ => unreachable!(),
        }
        assert!(
            store
                .chat_group_request(
                    "migration.inspect",
                    json!({"source_project_id":requested_source,"target_group_id":requested_target})
                )
                .is_err(),
            "{kind}"
        );
        let connection = store.connection().unwrap();
        let owner: String = connection
            .query_row(
                "SELECT cloud_project_id FROM loop_items WHERE id=?1",
                [thread.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(owner, source.id, "{kind}");
    }
}
