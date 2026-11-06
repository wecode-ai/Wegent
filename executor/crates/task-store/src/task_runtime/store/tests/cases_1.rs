use super::*;

#[test]
fn schedule_validation_checks_each_supplied_date() {
    assert!(validate_schedule_range(Some("not-a-date"), None).is_err());
    assert!(validate_schedule_range(None, Some("not-a-date")).is_err());
    assert!(validate_schedule_range(Some("2026-10-11"), None).is_ok());
    assert!(validate_schedule_range(
        Some("2026-10-11T00:00:00.900Z"),
        Some("2026-10-11T00:00:00.100Z"),
    )
    .is_err());
}

#[test]
fn chat_agent_create_derives_allowed_models_only_when_omitted() {
    let (directory, store, project) = chat_agent_store();
    let _ = directory;
    let legacy_input: ChatAgentCreate = serde_json::from_value(json!({
        "name": "Legacy Bot",
        "model": "legacy-model",
        "model_type": "runtime",
        "model_namespace": "legacy"
    }))
    .unwrap();

    let legacy = store.create_chat_agent(&project.id, legacy_input).unwrap();
    assert_eq!(
        legacy.allowed_models,
        vec![json!({
            "name": "legacy-model",
            "type": "runtime",
            "namespace": "legacy",
        })]
    );

    let explicit_empty = store
        .create_chat_agent(
            &project.id,
            ChatAgentCreate {
                execution_policy: None,
                model_policy: None,
                name: "Explicit Empty Bot".to_owned(),
                model: Some("legacy-model".to_owned()),
                model_type: Some("runtime".to_owned()),
                model_namespace: Some("legacy".to_owned()),
                allowed_models: Some(Vec::new()),
                ..serde_json::from_value(json!({"name": "unused"})).unwrap()
            },
        )
        .unwrap();
    assert!(explicit_empty.allowed_models.is_empty());
}

#[test]
fn chat_agent_crud_and_task_assignment_create_execution() {
    let (directory, store, project) = chat_agent_store();
    let _ = directory;
    let agent = make_local_agent(&store, &project.id, "auto");
    let listed = store.list_chat_agents(&project.id).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].name, "Local Bot");
    assert_eq!(
        listed[0].execution_device_id.as_deref(),
        Some("local-device")
    );

    let task = store
        .create_task(
            &project.id,
            TaskCreate {
                milestone_id: None,
                title: "Do the thing".to_owned(),
                description: String::new(),
                status: "inbox".to_owned(),
                priority: "high".to_owned(),
                parent_id: None,
                tags: vec![],
                assignee_user_id: None,
                assignee_agent_id: None,
                assignee_group_id: None,
                workflow: None,
            },
        )
        .unwrap();
    let updated = store
        .update_task(
            &project.id,
            &task.id,
            TaskUpdate {
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
                execution_payload: Some(json!({"message": "run it"})),
                workflow: None,
            },
        )
        .unwrap();
    assert_eq!(
        updated.assignee_agent_id.as_deref(),
        Some(agent.id.as_str())
    );
    assert_eq!(updated.status.as_deref(), Some("in_progress"));

    let executions = store
        .list_executions(&project.id, None, None, false)
        .unwrap();
    assert_eq!(executions.len(), 1);
    assert_eq!(executions[0].agent_id, agent.id);
    assert_eq!(executions[0].status, "queued");
    assert_eq!(executions[0].priority_weight, 30);
    assert!(executions[0].execution_payload.is_some());

    // Assignment-started runs carry an optimistic agent comment so the
    // finished outcome has a row to write back into the task thread.
    let comments = store.list_comments(&project.id, &task.id, 0).unwrap();
    assert_eq!(comments.len(), 1);
    assert_eq!(comments[0].sender_type, "agent");
    assert_eq!(comments[0].sender_id, agent.id);
    assert_eq!(comments[0].status, "pending");
    assert_eq!(
        comments[0].metadata["execution_id"],
        json!(executions[0].id)
    );
}

#[test]
fn task_create_atomically_dispatches_to_agent() {
    let (directory, store, project) = chat_agent_store();
    let _ = directory;
    let agent = make_local_agent(&store, &project.id, "auto");

    let task = store
        .create_task(
            &project.id,
            TaskCreate {
                milestone_id: None,
                title: "Run immediately".to_owned(),
                description: "Do not require a second assignment update.".to_owned(),
                status: "inbox".to_owned(),
                priority: "high".to_owned(),
                parent_id: None,
                tags: vec![],
                assignee_user_id: None,
                assignee_agent_id: Some(agent.id.clone()),
                assignee_group_id: None,
                workflow: None,
            },
        )
        .unwrap();

    assert_eq!(task.status.as_deref(), Some("in_progress"));
    assert_eq!(task.assignee_agent_id.as_deref(), Some(agent.id.as_str()));
    assert_eq!(task.metadata["assignment_history"][0]["to_type"], "agent");
    assert_eq!(
        task.metadata["assignment_history"][0]["to_id"],
        agent.id.as_str()
    );
    let executions = store
        .list_executions(&project.id, None, None, false)
        .unwrap();
    assert_eq!(executions.len(), 1);
    assert_eq!(executions[0].loop_item_id, task.id);
    assert_eq!(executions[0].agent_id, agent.id);
}

#[test]
fn task_create_accepts_human_led_group_without_starting_manager_agent() {
    let (directory, store, project) = chat_agent_store();
    let _ = directory;
    let project = store
        .update_project(
            &project.id,
            ProjectUpdate {
                version: project.version,
                collaboration_groups: Some(json!([{
                    "id": "human-led",
                    "name": "Human-led team",
                    "instructions": "The human leader coordinates the work.",
                    "leader": {
                        "kind": "human",
                        "id": "7",
                        "name": "Project owner"
                    },
                    "members": [{
                        "kind": "human",
                        "id": "7",
                        "name": "Project owner"
                    }]
                }])),
                ..ProjectUpdate::default()
            },
        )
        .unwrap();

    let task = store
        .create_task(
            &project.id,
            TaskCreate {
                milestone_id: None,
                title: "Coordinate manually".to_owned(),
                description: "The human leader decides the next dispatch.".to_owned(),
                status: "inbox".to_owned(),
                priority: "medium".to_owned(),
                parent_id: None,
                tags: vec![],
                assignee_user_id: None,
                assignee_agent_id: None,
                assignee_group_id: Some("human-led".to_owned()),
                workflow: None,
            },
        )
        .unwrap();

    assert_eq!(task.status.as_deref(), Some("in_progress"));
    assert_eq!(
        task.metadata["collaboration_group"]["leader"]["kind"],
        "human"
    );
    assert_eq!(task.metadata["assignment_history"][0]["to_type"], "group");
    assert_eq!(task.metadata["assignment_history"][0]["to_id"], "human-led");
    assert_eq!(
        task.metadata["assignment_history"][0]["to_name"],
        "Human-led team"
    );
    assert!(store
        .list_executions(&project.id, None, None, false)
        .unwrap()
        .is_empty());
}

#[test]
fn collaboration_group_resolves_agents_by_wegent_team_id() {
    let (directory, store, project) = chat_agent_store();
    let _ = directory;
    let leader = make_local_agent(&store, DEFAULT_WORK_ITEM_PROJECT_ID, "auto");
    let connection = store.connection().unwrap();
    let mut metadata = get_item_from(&connection, &leader.id, "chat_agent")
        .unwrap()
        .unwrap()
        .metadata;
    metadata["wegent_team_id"] = json!(42);
    connection
        .execute(
            "UPDATE loop_items SET metadata = ?1 WHERE id = ?2",
            params![metadata.to_string(), leader.id],
        )
        .unwrap();
    drop(connection);
    let project = store
        .update_project(
            &project.id,
            ProjectUpdate {
                version: project.version,
                collaboration_groups: Some(json!([{
                    "id": "team-id-group",
                    "name": "Team ID group",
                    "leader": {
                        "kind": "agent",
                        "id": "42"
                    },
                    "members": [{
                        "kind": "agent",
                        "id": "42"
                    }]
                }])),
                ..ProjectUpdate::default()
            },
        )
        .unwrap();

    let task = store
        .create_task(
            &project.id,
            TaskCreate {
                milestone_id: None,
                title: "Resolve manager".to_owned(),
                description: String::new(),
                status: "inbox".to_owned(),
                priority: "medium".to_owned(),
                parent_id: None,
                tags: vec![],
                assignee_user_id: None,
                assignee_agent_id: None,
                assignee_group_id: Some("team-id-group".to_owned()),
                workflow: None,
            },
        )
        .unwrap();

    let executions = store
        .list_executions(&project.id, None, None, false)
        .unwrap();
    assert_eq!(executions.len(), 1);
    assert_eq!(executions[0].loop_item_id, task.id);
    assert_eq!(executions[0].agent_id, leader.id);
}

#[test]
fn default_chat_agent_is_created_once_and_reactivates_after_archive() {
    let (_directory, store, project) = chat_agent_store();
    let input = default_chat_agent_input();

    let created = store
        .ensure_default_chat_agent(&project.id, input.clone())
        .unwrap()
        .expect("the first initialization should create an agent");
    assert!(store
        .ensure_default_chat_agent(&project.id, input.clone())
        .unwrap()
        .is_none());

    store
        .archive_chat_agent(&project.id, &created.id, created.version)
        .unwrap();
    assert!(store.list_chat_agents(&project.id).unwrap().is_empty());
    let reactivated = store
        .ensure_default_chat_agent(&project.id, input)
        .unwrap()
        .expect("the archived default agent should be reactivated");
    assert_eq!(reactivated.id, created.id);
    assert_eq!(reactivated.status, "active");
    assert_eq!(store.list_chat_agents(&project.id).unwrap().len(), 1);
}

#[test]
fn default_chat_agent_is_created_when_custom_agents_already_exist() {
    let (_directory, store, project) = chat_agent_store();
    let mut custom = default_chat_agent_input();
    custom.name = "custom-agent".to_owned();
    store.create_chat_agent(&project.id, custom).unwrap();
    let default_input = default_chat_agent_input();
    let default_name = default_input.name.clone();

    let default_agent = store
        .ensure_default_chat_agent(&project.id, default_input)
        .unwrap()
        .expect("a custom agent must not suppress the default agent");

    assert_eq!(default_agent.name, default_name);
    assert_eq!(store.list_chat_agents(&project.id).unwrap().len(), 2);
}

#[test]
fn default_chat_agent_initialization_is_atomic_across_store_connections() {
    let (_directory, store, project) = chat_agent_store();
    let db_path = store.path.clone();
    drop(store);
    let barrier = Arc::new(Barrier::new(2));
    let initializers = (0..2)
        .map(|_| {
            let barrier = Arc::clone(&barrier);
            let db_path = db_path.clone();
            let project_id = project.id.clone();
            std::thread::spawn(move || {
                let store = LocalTaskStore::open(db_path).unwrap();
                barrier.wait();
                store
                    .ensure_default_chat_agent(&project_id, default_chat_agent_input())
                    .unwrap()
                    .is_some()
            })
        })
        .collect::<Vec<_>>();

    assert_eq!(
        initializers
            .into_iter()
            .map(|initializer| initializer.join().unwrap())
            .filter(|created| *created)
            .count(),
        1
    );
    assert_eq!(
        LocalTaskStore::open(db_path)
            .unwrap()
            .list_chat_agents(&project.id)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn local_comment_thread_and_enqueue_writeback() {
    let (directory, store, project) = chat_agent_store();
    let _ = directory;
    let agent = make_local_agent(&store, &project.id, "auto");
    let task = store
        .create_task(
            &project.id,
            TaskCreate {
                milestone_id: None,
                title: "Comment run".to_owned(),
                description: String::new(),
                status: "inbox".to_owned(),
                priority: "medium".to_owned(),
                parent_id: None,
                tags: vec![],
                assignee_user_id: None,
                assignee_agent_id: None,
                assignee_group_id: None,
                workflow: None,
            },
        )
        .unwrap();

    let user_comment = store
        .create_comment(&LocalCommentCreate {
            project_id: project.id.clone(),
            task_id: task.id.clone(),
            client_message_id: Some("cm-1".to_owned()),
            sender_type: "user".to_owned(),
            sender_id: "1".to_owned(),
            sender_name: "Ada".to_owned(),
            content: "@Local Bot 看一下".to_owned(),
            metadata: json!({
                "mentions": [{"type": "agent", "id": agent.id, "label": "Local Bot"}]
            }),
            reply_to_message_id: None,
        })
        .unwrap();
    assert_eq!(user_comment.sequence_number, 1);
    assert_eq!(
        user_comment.thread_root_message_id.as_deref(),
        Some(user_comment.message_id.as_str())
    );

    let execution = store
        .enqueue_execution(
            &project.id,
            &task.id,
            &agent.id,
            json!({"text": "@Local Bot 看一下"}),
            Some(&user_comment.message_id),
        )
        .unwrap();
    assert_eq!(execution.status, "queued");
    assert_eq!(execution.task_title, "Comment run");

    let comments = store.list_comments(&project.id, &task.id, 0).unwrap();
    assert_eq!(comments.len(), 2);
    let agent_comment = comments
        .iter()
        .find(|comment| comment.sender_type == "agent")
        .unwrap();
    assert_eq!(agent_comment.status, "pending");
    assert_eq!(
        agent_comment.reply_to_message_id.as_deref(),
        Some(user_comment.message_id.as_str())
    );
    assert_eq!(
        agent_comment.thread_root_message_id.as_deref(),
        Some(user_comment.message_id.as_str())
    );

    let updated = store
        .update_agent_comment_for_execution(execution.id, "completed", "搞定")
        .unwrap()
        .unwrap();
    store
        .connection()
        .unwrap()
        .execute(
            "UPDATE loop_item_executions SET status='completed' WHERE id=?1",
            params![execution.id],
        )
        .unwrap();
    assert_eq!(updated.status, "completed");
    assert_eq!(updated.content, "搞定");
    let task = store.get_task(&project.id, &task.id).unwrap();
    let task = store
        .update_task(
            &project.id,
            &task.id,
            TaskUpdate {
                milestone_id: None,
                position: None,
                assignee_group_id: None,
                assignee_user_id: None,
                version: task.version,
                title: None,
                description: None,
                status: Some("in_review".to_owned()),
                priority: None,
                parent_id: None,
                tags: None,
                assignee_agent_id: None,
                execution_payload: None,
                workflow: None,
            },
        )
        .unwrap();
    assert_eq!(task.status.as_deref(), Some("in_review"));

    let after = store
        .list_comments(&project.id, &task.id, user_comment.sequence_number)
        .unwrap();
    assert_eq!(after.len(), 1);
    assert_eq!(after[0].sender_type, "agent");

    let follow_up = store
        .create_comment(&LocalCommentCreate {
            project_id: project.id.clone(),
            task_id: task.id.clone(),
            client_message_id: Some("cm-2".to_owned()),
            sender_type: "user".to_owned(),
            sender_id: "1".to_owned(),
            sender_name: "Ada".to_owned(),
            content: "我之前说了什么".to_owned(),
            metadata: json!({}),
            reply_to_message_id: Some(user_comment.message_id.clone()),
        })
        .unwrap();
    let continuation = store
        .start_runtime_comment(&LocalRuntimeCommentStart {
            project_id: &project.id,
            task_id: &task.id,
            agent_id: &agent.id,
            trigger_message_id: &follow_up.message_id,
            runtime_device_id: "local-device",
            runtime_task_id: "session-1",
            prompt: Some("我之前说了什么"),
            model: None,
        })
        .unwrap();
    assert_eq!(continuation.status, "streaming");
    assert_eq!(
        store
            .get_task(&project.id, &task.id)
            .unwrap()
            .status
            .as_deref(),
        Some("in_progress")
    );
    assert_eq!(
        continuation.thread_root_message_id,
        user_comment.thread_root_message_id
    );
    store
        .update_execution_progress("session-1", "你之前让我看一下")
        .unwrap();
    store
        .finish_runtime_comment("session-1", "completed", "你之前让我看一下")
        .unwrap();
    let comments = store.list_comments(&project.id, &task.id, 0).unwrap();
    let continued = comments.last().unwrap();
    assert_eq!(continued.message_id, continuation.message_id);
    assert_eq!(continued.status, "completed");
    assert_eq!(continued.content, "你之前让我看一下");
    assert_eq!(continued.metadata["runtime_address"]["taskId"], "session-1");
    assert_eq!(
        store
            .get_task(&project.id, &task.id)
            .unwrap()
            .status
            .as_deref(),
        Some("in_review")
    );
    let duplicate = store
        .start_runtime_comment(&LocalRuntimeCommentStart {
            project_id: &project.id,
            task_id: &task.id,
            agent_id: &agent.id,
            trigger_message_id: &follow_up.message_id,
            runtime_device_id: "local-device",
            runtime_task_id: "session-1",
            prompt: Some("我之前说了什么"),
            model: None,
        })
        .unwrap();
    assert_eq!(duplicate.message_id, continuation.message_id);
    assert_eq!(duplicate.status, "completed");
    assert_eq!(
        store
            .get_task(&project.id, &task.id)
            .unwrap()
            .status
            .as_deref(),
        Some("in_review")
    );
}

#[test]
fn collaboration_runtime_comment_does_not_move_parent_issue_to_review() {
    let (directory, store, project) = chat_agent_store();
    let _ = directory;
    let task = store
        .create_task(
            &project.id,
            TaskCreate {
                milestone_id: None,
                title: "Coordinate work".to_owned(),
                description: String::new(),
                status: "in_progress".to_owned(),
                priority: "medium".to_owned(),
                parent_id: None,
                tags: vec![],
                assignee_user_id: None,
                assignee_agent_id: None,
                assignee_group_id: None,
                workflow: None,
            },
        )
        .unwrap();
    let comment = store
        .create_comment(&LocalCommentCreate {
            project_id: project.id.clone(),
            task_id: task.id.clone(),
            client_message_id: None,
            sender_type: "agent".to_owned(),
            sender_id: "manager-agent".to_owned(),
            sender_name: "Manager".to_owned(),
            content: String::new(),
            metadata: json!({
                "dispatch_role": "manager",
                "runtime_address": {
                    "deviceId": "local-device",
                    "taskId": "manager-runtime",
                },
            }),
            reply_to_message_id: None,
        })
        .unwrap();
    store
        .connection()
        .unwrap()
        .execute(
            "UPDATE loop_item_comments SET status='streaming' WHERE message_id=?1",
            params![comment.message_id],
        )
        .unwrap();

    store
        .finish_runtime_comment("manager-runtime", "completed", "Dispatched")
        .unwrap();

    assert_eq!(
        store
            .get_task(&project.id, &task.id)
            .unwrap()
            .status
            .as_deref(),
        Some("in_progress")
    );
}

#[test]
fn runtime_comment_keeps_issue_in_progress_while_followup_is_pending() {
    let (directory, store, project) = chat_agent_store();
    let _ = directory;
    let task = store
        .create_task(
            &project.id,
            TaskCreate {
                milestone_id: None,
                title: "Continue work".to_owned(),
                description: String::new(),
                status: "in_progress".to_owned(),
                priority: "medium".to_owned(),
                parent_id: None,
                tags: vec![],
                assignee_user_id: None,
                assignee_agent_id: None,
                assignee_group_id: None,
                workflow: None,
            },
        )
        .unwrap();
    for runtime_task_id in ["runtime-1", "runtime-2"] {
        let comment = store
            .create_comment(&LocalCommentCreate {
                project_id: project.id.clone(),
                task_id: task.id.clone(),
                client_message_id: None,
                sender_type: "agent".to_owned(),
                sender_id: "agent-1".to_owned(),
                sender_name: "Agent".to_owned(),
                content: String::new(),
                metadata: json!({
                    "runtime_address": {
                        "deviceId": "local-device",
                        "taskId": runtime_task_id,
                    },
                }),
                reply_to_message_id: None,
            })
            .unwrap();
        store
            .connection()
            .unwrap()
            .execute(
                "UPDATE loop_item_comments SET status='streaming' WHERE message_id=?1",
                params![comment.message_id],
            )
            .unwrap();
    }

    store
        .finish_runtime_comment("runtime-1", "completed", "First result")
        .unwrap();
    assert_eq!(
        store
            .get_task(&project.id, &task.id)
            .unwrap()
            .status
            .as_deref(),
        Some("in_progress")
    );

    store
        .finish_runtime_comment("runtime-2", "completed", "Follow-up result")
        .unwrap();
    assert_eq!(
        store
            .get_task(&project.id, &task.id)
            .unwrap()
            .status
            .as_deref(),
        Some("in_review")
    );
}

#[test]
fn local_assignment_execution_writeback_stamps_runtime_address() {
    let (directory, store, project) = chat_agent_store();
    let _ = directory;
    let agent = make_local_agent(&store, &project.id, "auto");
    let task = store
        .create_task(
            &project.id,
            TaskCreate {
                milestone_id: None,
                title: "Assigned run".to_owned(),
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
                execution_payload: None,
                workflow: None,
            },
        )
        .unwrap();
    let execution = store
        .list_executions(&project.id, None, None, false)
        .unwrap()
        .remove(0);
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
    assert!(store
        .heartbeat_execution(
            claimed.id,
            Some("local-device"),
            Some("different-runtime-task"),
            300,
        )
        .unwrap()
        .is_none());
    let unchanged = execution_row(&store.connection().unwrap(), claimed.id).unwrap();
    assert_eq!(unchanged.runtime_task_id, claimed.runtime_task_id);
    let running = accept_and_start(&store, &claimed);
    // The runtime address is stamped at dispatch time so the task thread
    // can open live execution details while the run is still streaming.
    let streaming_comments = store.list_comments(&project.id, &task.id, 0).unwrap();
    assert_eq!(streaming_comments.len(), 1);
    assert_eq!(streaming_comments[0].status, "streaming");
    assert_eq!(
        streaming_comments[0].metadata["runtime_address"],
        json!({"deviceId": "local-device", "taskId": running.runtime_task_id.unwrap()})
    );
    assert_eq!(
        store
            .project_bound_task_status(
                "local-device",
                claimed.runtime_task_id.as_deref().unwrap(),
                "succeeded",
                100,
            )
            .unwrap(),
        0
    );
    assert_eq!(
        store
            .get_task(&project.id, &task.id)
            .unwrap()
            .status
            .as_deref(),
        Some("in_progress")
    );
    store.complete_execution(execution.id, None).unwrap();

    let updated = store
        .update_agent_comment_for_execution(execution.id, "completed", "搞定")
        .unwrap()
        .expect("comment write-back must land");
    assert_eq!(updated.status, "completed");
    assert_eq!(updated.content, "搞定");
    assert_eq!(
        updated.metadata["runtime_address"],
        json!({"deviceId": "local-device", "taskId": claimed.runtime_task_id.unwrap()})
    );
    assert_eq!(
        store
            .get_task(&project.id, &task.id)
            .unwrap()
            .status
            .as_deref(),
        Some("in_review")
    );
}
