use super::*;

#[test]
fn chat_agent_runtime_and_capabilities_round_trip_into_claim_payload() {
    let (directory, store, project) = chat_agent_store();
    let _ = directory;
    let create: ChatAgentCreate = serde_json::from_value(json!({
        "name": "Claude implementer",
        "display_name": "Claude Implementer",
        "namespace": "default",
        "runtime": "claude_code",
        "model": "claude-sonnet-4-5",
        "model_type": "public",
        "model_namespace": "default",
        "capability_description": "Implements and reviews code",
        "system_prompt": "Use the configured capabilities.",
        "execution_environment": "local",
        "execution_mode": "auto",
        "max_concurrent_executions": 1,
        "workspace_policy": "project",
        "created_by_user_id": 7,
        "plugins": [{"id": "code-review@openai"}],
        "additional_skills": [{
            "name": "architecture-review",
            "namespace": "default",
        }],
        "mcp_servers": {
            "github": {
                "command": "github-mcp-server",
                "args": ["stdio"],
            },
        },
    }))
    .unwrap();
    let agent = store.create_chat_agent(&project.id, create).unwrap();

    assert_eq!(agent.display_name, "Claude Implementer");
    assert_eq!(agent.namespace, "default");
    assert_eq!(agent.runtime, "claude_code");
    assert_eq!(agent.model_type.as_deref(), Some("public"));
    assert_eq!(agent.model_namespace, "default");
    assert_eq!(agent.capability_mode, "manual");
    assert_eq!(agent.additional_skills[0]["name"], "architecture-review");
    assert_eq!(agent.mcp_servers["github"]["command"], "github-mcp-server");
    let listed = store.list_chat_agents(&project.id).unwrap();
    assert_eq!(listed[0].runtime, "claude_code");
    assert_eq!(listed[0].display_name, "Claude Implementer");
    assert_eq!(listed[0].additional_skills, agent.additional_skills);
    assert_eq!(listed[0].mcp_servers, agent.mcp_servers);

    let task = store
        .create_task(
            &project.id,
            TaskCreate {
                milestone_id: None,
                title: "Implement runtime contract".to_owned(),
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
    let claim = store
        .claim_next_local_execution(&LocalExecutionClaim {
            execution_device_id: Some("local-device".to_owned()),
            runtime_instance_id: "runtime-instance".to_owned(),
            device_capacity: 1,
            runtime_active: 0,
            runtime_active_task_ids: vec![],
            lease_seconds: 300,
        })
        .unwrap()
        .expect("Claude Code execution should be claimable");
    let payload = claim.execution_payload.unwrap();
    assert_eq!(payload["runtime"], "claude_code");
    assert_eq!(payload["bot"][0]["shell_type"], "ClaudeCode");
    assert_eq!(
        payload["additionalSkills"][0]["name"],
        "architecture-review"
    );
    assert_eq!(
        payload["bot"][0]["mcp_servers"]["github"]["command"],
        "github-mcp-server"
    );
    assert_eq!(payload["projectPlugins"][0]["id"], "code-review@openai");

    let update: ChatAgentUpdate = serde_json::from_value(json!({
        "version": agent.version,
        "runtime": "codex",
        "additional_skills": [{"name": "release-check"}],
        "mcp_servers": {"linear": {"url": "https://mcp.invalid"}},
    }))
    .unwrap();
    let updated = store
        .update_chat_agent(&project.id, &agent.id, update)
        .unwrap();
    assert_eq!(updated.runtime, "codex");
    assert_eq!(updated.additional_skills[0]["name"], "release-check");
    assert_eq!(updated.mcp_servers["linear"]["url"], "https://mcp.invalid");
}

#[test]
fn chat_agent_persists_local_project_binding() {
    let (directory, store, project) = chat_agent_store();
    let _ = directory;
    let agent = store
        .create_chat_agent(
            &project.id,
            ChatAgentCreate {
                execution_policy: None,
                model_policy: None,
                name: "Bound Bot".to_owned(),
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
                local_project_id: Some(7),
                created_by_user_id: Some(7),
                plugins: Vec::new(),
                additional_skills: Vec::new(),
                mcp_servers: json!({}),
            },
        )
        .unwrap();
    assert_eq!(agent.local_project_id, Some(7));
    let listed = store.list_chat_agents(&project.id).unwrap();
    assert_eq!(listed[0].local_project_id, Some(7));

    let updated = store
        .update_chat_agent(
            &project.id,
            &agent.id,
            ChatAgentUpdate {
                execution_policy: None,
                model_policy: None,
                version: agent.version,
                name: None,
                display_name: None,
                namespace: None,
                runtime: None,
                model: None,
                model_type: None,
                model_namespace: None,
                allowed_models: None,
                capability_description: None,
                capability_mode: None,
                system_prompt: None,
                status: None,
                visibility: None,
                execution_environment: None,
                execution_mode: None,
                execution_device_id: None,
                max_concurrent_executions: None,
                workspace_policy: None,
                local_project_id: Some(Some(9)),
                plugins: None,
                additional_skills: None,
                mcp_servers: None,
            },
        )
        .unwrap();
    assert_eq!(updated.local_project_id, Some(9));

    let cleared = store
        .update_chat_agent(
            &project.id,
            &agent.id,
            ChatAgentUpdate {
                execution_policy: None,
                model_policy: None,
                version: updated.version,
                name: None,
                display_name: None,
                namespace: None,
                runtime: None,
                model: None,
                model_type: None,
                model_namespace: None,
                allowed_models: None,
                capability_description: None,
                capability_mode: None,
                system_prompt: None,
                status: None,
                visibility: None,
                execution_environment: None,
                execution_mode: None,
                execution_device_id: None,
                max_concurrent_executions: None,
                workspace_policy: None,
                local_project_id: Some(None),
                plugins: None,
                additional_skills: None,
                mcp_servers: None,
            },
        )
        .unwrap();
    assert_eq!(cleared.local_project_id, None);
}

#[test]
fn local_claim_is_not_gated_by_reported_device_capacity() {
    let (directory, store, project) = chat_agent_store();
    let _ = directory;
    let agent_a = store
        .create_chat_agent(
            &project.id,
            ChatAgentCreate {
                execution_policy: None,
                model_policy: None,
                name: "Bot A".to_owned(),
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
                max_concurrent_executions: 20,
                workspace_policy: "project".to_owned(),
                local_project_id: None,
                created_by_user_id: None,
                plugins: Vec::new(),
                additional_skills: Vec::new(),
                mcp_servers: json!({}),
            },
        )
        .unwrap();
    let agent_b = store
        .create_chat_agent(
            &project.id,
            ChatAgentCreate {
                execution_policy: None,
                model_policy: None,
                name: "Bot B".to_owned(),
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
    for (agent, title) in [(agent_a.clone(), "A1"), (agent_a, "A2"), (agent_b, "B")] {
        let task = store
            .create_task(
                &project.id,
                TaskCreate {
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
                    execution_payload: Some(json!({"message": title})),
                    workflow: None,
                },
            )
            .unwrap();
    }
    let claim = LocalExecutionClaim {
        execution_device_id: Some("local-device".to_owned()),
        runtime_instance_id: "runtime-1".to_owned(),
        device_capacity: 1,
        runtime_active: 0,
        runtime_active_task_ids: vec![],
        lease_seconds: 300,
    };
    let first = store
        .claim_next_local_execution(&claim)
        .unwrap()
        .expect("first robot should claim");
    let second = store
        .claim_next_local_execution(&claim)
        .unwrap()
        .expect("Executor owns its free slots and may claim another run");

    let manual_process = LocalExecutionClaim {
        device_capacity: 2,
        runtime_active: 1,
        runtime_active_task_ids: vec!["manual-task".to_owned()],
        ..claim.clone()
    };
    assert!(store
        .claim_next_local_execution(&manual_process)
        .unwrap()
        .is_some());

    let observed_first = LocalExecutionClaim {
        device_capacity: 2,
        runtime_active: 1,
        runtime_active_task_ids: vec![
            first.runtime_task_id.unwrap(),
            second.runtime_task_id.unwrap(),
        ],
        ..claim
    };
    assert!(store
        .claim_next_local_execution(&observed_first)
        .unwrap()
        .is_none());
}

#[test]
fn local_claim_does_not_apply_agent_parallelism_limits() {
    let (directory, store, project) = chat_agent_store();
    let _ = directory;
    let agent = store
        .create_chat_agent(
            &project.id,
            ChatAgentCreate {
                execution_policy: None,
                model_policy: None,
                name: "Parallel Bot".to_owned(),
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
                max_concurrent_executions: 2,
                workspace_policy: "project".to_owned(),
                local_project_id: None,
                created_by_user_id: Some(7),
                plugins: Vec::new(),
                additional_skills: Vec::new(),
                mcp_servers: json!({}),
            },
        )
        .unwrap();
    for index in 0..3 {
        let task = store
            .create_task(
                &project.id,
                TaskCreate {
                    milestone_id: None,
                    title: format!("Parallel {index}"),
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
                    execution_payload: Some(json!({"message": "run"})),
                    workflow: None,
                },
            )
            .unwrap();
    }
    let claim = LocalExecutionClaim {
        execution_device_id: Some("local-device".to_owned()),
        runtime_instance_id: "runtime-1".to_owned(),
        device_capacity: 4,
        runtime_active: 0,
        runtime_active_task_ids: vec![],
        lease_seconds: 300,
    };

    assert!(store.claim_next_local_execution(&claim).unwrap().is_some());
    assert!(store.claim_next_local_execution(&claim).unwrap().is_some());
    assert!(store.claim_next_local_execution(&claim).unwrap().is_some());
    assert!(store.claim_next_local_execution(&claim).unwrap().is_none());
}

#[test]
fn local_claim_binds_unbound_execution_to_claiming_device() {
    let (directory, store, project) = chat_agent_store();
    let _ = directory;
    let agent = store
        .create_chat_agent(
            &project.id,
            ChatAgentCreate {
                execution_policy: None,
                model_policy: None,
                name: "Unbound Bot".to_owned(),
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
                // Robots created before device binding have no device.
                execution_device_id: None,
                max_concurrent_executions: 1,
                workspace_policy: "project".to_owned(),
                local_project_id: None,
                created_by_user_id: Some(7),
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
                milestone_id: None,
                title: "Run unbound".to_owned(),
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
                execution_payload: Some(json!({"message": "go"})),
                workflow: None,
            },
        )
        .unwrap();
    let executions = store
        .list_executions(&project.id, None, None, false)
        .unwrap();
    assert_eq!(executions[0].execution_device_id, None);

    let claim = LocalExecutionClaim {
        execution_device_id: Some("local-device".to_owned()),
        runtime_instance_id: "runtime-1".to_owned(),
        device_capacity: 1,
        runtime_active: 0,
        runtime_active_task_ids: vec![],
        lease_seconds: 300,
    };
    let claimed = store
        .claim_next_local_execution(&claim)
        .unwrap()
        .expect("unbound local run must be claimable");
    assert_eq!(claimed.status, "claimed");
    assert_eq!(claimed.execution_device_id.as_deref(), Some("local-device"));
}

#[test]
fn claimed_execution_fails_when_project_was_archived() {
    let (_directory, store, project) = chat_agent_store();
    let agent = make_local_agent(&store, &project.id, "auto");
    let task = store
        .create_task(
            &project.id,
            TaskCreate {
                milestone_id: None,
                title: "Archived project".to_owned(),
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
    let execution = store
        .list_executions(&project.id, None, None, false)
        .unwrap()
        .remove(0);
    store.archive_project(&project.id, project.version).unwrap();
    assert!(store
        .claim_next_execution_for_runtime(Some("local-device"), "runtime-1", 300)
        .is_err());
    let connection = store.connection().unwrap();
    let failed = execution_row(&connection, execution.id).unwrap();
    assert_eq!(failed.status, "failed");
    assert_eq!(failed.termination_reason, "runtime_preflight_failed");
    assert!(failed.lease_expires_at.is_none());
}

#[test]
fn local_fail_and_reject_close_agent_comment() {
    let (directory, store, project) = chat_agent_store();
    let _ = directory;

    // Auto robot: enqueue -> queued -> claim -> terminal fail.
    let auto_agent = make_local_agent(&store, &project.id, "auto");
    let auto_task = store
        .create_task(
            &project.id,
            TaskCreate {
                milestone_id: None,
                title: "Fail me".to_owned(),
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
            &auto_task.id,
            &auto_agent.id,
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
        .expect("auto run must be claimable");
    accept_and_start(&store, &claimed);
    store
        .fail_execution(claimed.id, "model exploded", false)
        .unwrap();
    let comments = store.list_comments(&project.id, &auto_task.id, 0).unwrap();
    let agent_comment = comments
        .iter()
        .find(|comment| comment.sender_type == "agent")
        .unwrap();
    assert_eq!(agent_comment.status, "failed");
    assert_eq!(agent_comment.content, "model exploded");

    // Manual robot: enqueue -> pending_approval -> reject cancels the run
    // and must close the optimistic comment too.
    let manual_agent = store
        .create_chat_agent(
            &project.id,
            ChatAgentCreate {
                execution_policy: None,
                model_policy: None,
                name: "Manual Bot".to_owned(),
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
                execution_mode: Some("manual_approval".to_owned()),
                execution_device_id: Some("local-device".to_owned()),
                max_concurrent_executions: 1,
                workspace_policy: "project".to_owned(),
                local_project_id: None,
                created_by_user_id: Some(7),
                plugins: Vec::new(),
                additional_skills: Vec::new(),
                mcp_servers: json!({}),
            },
        )
        .unwrap();
    let manual_task = store
        .create_task(
            &project.id,
            TaskCreate {
                milestone_id: None,
                title: "Reject me".to_owned(),
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
    let manual_run = store
        .enqueue_execution(
            &project.id,
            &manual_task.id,
            &manual_agent.id,
            json!({"text": "run"}),
            None,
        )
        .unwrap();
    assert_eq!(manual_run.status, "pending_approval");
    store
        .reject_execution(manual_run.id, Some("not now".to_owned()))
        .unwrap();
    let comments = store
        .list_comments(&project.id, &manual_task.id, 0)
        .unwrap();
    let agent_comment = comments
        .iter()
        .find(|comment| comment.sender_type == "agent")
        .unwrap();
    assert_eq!(agent_comment.status, "cancelled");
    assert_eq!(agent_comment.content, "not now");
}

#[test]
fn local_executions_list_filters_by_status_without_agent() {
    let (directory, store, project) = chat_agent_store();
    let _ = directory;
    let agent = store
        .create_chat_agent(
            &project.id,
            ChatAgentCreate {
                execution_policy: None,
                model_policy: None,
                name: "Status Filter Bot".to_owned(),
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
                execution_mode: Some("manual_approval".to_owned()),
                execution_device_id: Some("local-device".to_owned()),
                max_concurrent_executions: 1,
                workspace_policy: "project".to_owned(),
                local_project_id: None,
                created_by_user_id: Some(7),
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
                milestone_id: None,
                title: "Approval task".to_owned(),
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
                execution_payload: Some(json!({"message": "run"})),
                workflow: None,
            },
        )
        .unwrap();
    // Regression: status-only listing must not fail the placeholder count.
    let pending = store
        .list_executions(&project.id, None, Some("pending_approval"), false)
        .unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].status, "pending_approval");
    let running = store
        .list_executions(&project.id, None, Some("running"), false)
        .unwrap();
    assert!(running.is_empty());
}
