use super::*;

#[test]
fn local_execution_writeback_creates_missing_agent_comment() {
    let (directory, store, project) = chat_agent_store();
    let _ = directory;
    let agent = make_local_agent(&store, &project.id, "auto");
    let task = store
        .create_task(
            &project.id,
            TaskCreate {
                milestone_id: None,
                title: "Legacy run".to_owned(),
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
    // Simulate a pre-fix run whose optimistic comment row is missing.
    store
        .connection()
        .unwrap()
        .execute(
            "DELETE FROM loop_item_comments WHERE task_id = ?1",
            params![task.id],
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
    accept_and_start(&store, &claimed);
    store.complete_execution(execution.id, None).unwrap();

    let created = store
        .update_agent_comment_for_execution(execution.id, "completed", "修复完成")
        .unwrap()
        .expect("missing comment must be created");
    assert_eq!(created.sender_type, "agent");
    assert_eq!(created.sender_id, agent.id);
    assert_eq!(created.status, "completed");
    assert_eq!(created.content, "修复完成");
    assert_eq!(
        created.metadata["runtime_address"],
        json!({"deviceId": "local-device", "taskId": claimed.runtime_task_id.unwrap()})
    );
    let comments = store.list_comments(&project.id, &task.id, 0).unwrap();
    assert_eq!(comments.len(), 1);
    assert_eq!(comments[0].message_id, created.message_id);
}

#[test]
fn local_read_cursor_persists_the_visible_activity_sequence() {
    let (directory, store, project) = chat_agent_store();
    let _ = directory;
    let task = store
        .create_task(
            &project.id,
            TaskCreate {
                milestone_id: None,
                title: "Unread activity".to_owned(),
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

    let updated = store
        .mark_task_read(&project.id, &task.id, Some(17), None)
        .unwrap();

    assert_eq!(updated.metadata["activity_read_sequence"], json!(17));
    assert_eq!(updated.metadata["is_unread"], json!(false));
}

#[test]
fn local_direct_execution_completion_moves_issue_to_review() {
    let (directory, store, project) = chat_agent_store();
    let _ = directory;
    let agent = make_local_agent(&store, &project.id, "auto");
    let task = store
        .create_task(
            &project.id,
            TaskCreate {
                milestone_id: None,
                title: "Review me".to_owned(),
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
    store.complete_execution(claimed.id, Some("done")).unwrap();

    let updated = store.get_task(&project.id, &task.id).unwrap();
    assert_eq!(updated.status.as_deref(), Some("in_review"));
    assert_eq!(updated.execution_state.as_deref(), Some("succeeded"));
    assert_eq!(updated.metadata["is_unread"], json!(true));
    let delayed_read = store.mark_task_read(&project.id, &task.id, Some(0), Some(task.version)).unwrap();
    assert_eq!(delayed_read.metadata["is_unread"], json!(true));
    assert_eq!(delayed_read.version, updated.version);
    store.mark_task_read(&project.id, &task.id, None, None).unwrap();
    store
        .complete_execution(claimed.id, Some("duplicate"))
        .unwrap();
    assert_eq!(
        store.get_task(&project.id, &task.id).unwrap().metadata["is_unread"],
        json!(false)
    );
    // Completion also preserves an Issue that was already in review.
    let second = store
        .create_task(
            &project.id,
            TaskCreate {
                milestone_id: None,
                title: "Already reviewed".to_owned(),
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
        .update_task(
            &project.id,
            &second.id,
            TaskUpdate {
                milestone_id: None,
                position: None,
                assignee_group_id: None,
                assignee_user_id: None,
                version: second.version,
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
    let claimed_second = store
        .claim_next_local_execution(&claim)
        .unwrap()
        .expect("second run must be claimable");
    store.mark_task_read(&project.id, &second.id, None, None).unwrap();
    store.complete_execution(claimed_second.id, None).unwrap();
    let second_after = store.get_task(&project.id, &second.id).unwrap();
    assert_eq!(second_after.status.as_deref(), Some("in_review"));
    assert_eq!(second_after.metadata["is_unread"], json!(true));
}

#[test]
fn collaboration_group_round_runs_members_through_executor_then_restarts_manager() {
    assert_collaboration_round_completion(true, false, false);
}

#[test]
fn agent_only_collaboration_round_restarts_manager_for_review() {
    assert_collaboration_round_completion(false, false, false);
}

#[test]
fn agent_only_collaboration_round_accepts_successful_member_retry() {
    assert_collaboration_round_completion(false, true, false);
}

#[test]
fn collaboration_round_uses_canonical_robot_identity_for_team_alias() {
    assert_collaboration_round_completion(false, false, true);
}

#[test]
fn human_assignment_delivery_from_the_issue_settles_the_round() {
    let (directory, store, project) = chat_agent_store();
    let _ = directory;
    let leader = make_local_agent(&store, DEFAULT_WORK_ITEM_PROJECT_ID, "auto");
    let project = store
        .update_project(
            &project.id,
            ProjectUpdate {
                version: project.version,
                collaboration_groups: Some(json!([{
                    "id": "squad-human",
                    "name": "开发",
                    "instructions": "不管什么事都找 @admin",
                    "leader": {
                        "kind": "agent",
                        "id": leader.id,
                        "responsibility": "Plan and review."
                    },
                    "members": [{
                        "kind": "human",
                        "id": "42",
                        "name": "admin",
                        "responsibility": "Confirm the observed behavior."
                    }],
                    "stages": []
                }])),
                ..ProjectUpdate::default()
            },
        )
        .unwrap();
    let issue = store
        .create_task(
            &project.id,
            TaskCreate {
                milestone_id: None,
                title: "看下cpu占用".to_owned(),
                description: String::new(),
                status: "inbox".to_owned(),
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
    let dispatched = store
        .update_task(
            &project.id,
            &issue.id,
            TaskUpdate {
                version: issue.version,
                assignee_group_id: Some(Some("squad-human".to_owned())),
                execution_payload: Some(json!({
                    "managerRuntimeRequest": {
                        "taskId": "manager-template",
                        "runtime": "codex",
                        "executionRequest": {
                            "task_id": "manager-template",
                            "subtask_id": "manager-template-initial",
                            "bot": [{
                                "id": leader.id,
                                "name": "Manager",
                                "shell_type": "Codex"
                            }],
                            "model_config": {
                                "model": "openai",
                                "model_id": "gpt-6-sol"
                            }
                        }
                    },
                    "memberRuntimeProfiles": []
                })),
                ..TaskUpdate::default()
            },
        )
        .unwrap();
    assert_eq!(dispatched.status.as_deref(), Some("in_progress"));
    let claimed = store
        .claim_next_local_execution(&LocalExecutionClaim {
            execution_device_id: Some("local-device".to_owned()),
            runtime_instance_id: "runtime-1".to_owned(),
            device_capacity: 1,
            runtime_active: 0,
            runtime_active_task_ids: Vec::new(),
            lease_seconds: 300,
        })
        .unwrap()
        .expect("manager execution must be queued");
    accept_and_start(&store, &claimed);
    let runtime_task_id = claimed
        .runtime_task_id
        .as_deref()
        .expect("manager execution must have a Runtime task id")
        .to_owned();
    assert!(store
        .assignment_receipts(&project.id, &issue.id)
        .unwrap()
        .is_empty());
    let round = store
        .submit_collaboration_round(
            &runtime_task_id,
            &json!({
                "round_id": "cpu-review-round-1",
                "items": [{
                    "assignment_id": "cpu-review-admin",
                    "title": "请 @admin 检查 CPU 占用",
                    "instructions": "Check the CPU load and deliver evidence.",
                    "assignee_type": "human",
                    "assignee_id": "42",
                }],
            }),
        )
        .unwrap();
    assert_eq!(round["state"], "dispatched");
    assert_eq!(round["assignments"][0]["human_user_id"], "42");
    assert_eq!(round["assignments"][0]["human_user_name"], "admin");
    assert_eq!(
        round["assignments"][0]["instructions"],
        "Check the CPU load and deliver evidence."
    );
    let human_task_id = round["assignments"][0]["human_assignment_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let issue_after_dispatch = store.get_task(&project.id, &issue.id).unwrap();
    assert_eq!(issue_after_dispatch.assignee_user_id, Some(42));
    assert_eq!(
        issue_after_dispatch.metadata["assignee_label"],
        json!("admin")
    );
    assert!(issue_after_dispatch.metadata["collaboration_group"].is_null());
    let receipts = store.assignment_receipts(&project.id, &issue.id).unwrap();
    assert_eq!(receipts.len(), 1);
    let assignment_id = format!(
        "{}-{}",
        issue.id,
        issue_after_dispatch.metadata["assignment_history"]
            .as_array()
            .unwrap()
            .len()
    );
    assert_eq!(receipts[0]["id"], assignment_id);
    assert_eq!(receipts[0]["target_id"], "42");
    assert_eq!(receipts[0]["receipt_tracking"], true);
    store
        .acknowledge_assignment(&project.id, &issue.id, &assignment_id, 42, true)
        .unwrap();
    let received = store.assignment_receipts(&project.id, &issue.id).unwrap();
    assert!(received[0]["stand_in_received_at"].is_string());
    assert!(received[0]["human_read_at"].is_null());
    store
        .acknowledge_assignment(&project.id, &issue.id, &assignment_id, 42, false)
        .unwrap();
    let read = store.assignment_receipts(&project.id, &issue.id).unwrap();
    assert_eq!(
        read[0]["stand_in_received_at"],
        received[0]["stand_in_received_at"]
    );
    assert!(read[0]["human_read_at"].is_string());
    assert_eq!(
        LocalTaskStore::open(directory.path().join("tasks.sqlite"))
            .unwrap()
            .assignment_receipts(&project.id, &issue.id)
            .unwrap(),
        read
    );
    let human_task = store.get_task(&project.id, &human_task_id).unwrap();
    assert_eq!(
        human_task.metadata["collaboration_assignment"]["dispatch_id"],
        json!(issue.id)
    );

    let address = RuntimeTaskAddress {
        device_id: "local-device".to_owned(),
        task_id: "runtime-human-1".to_owned(),
        task_title: Some("请 @admin 检查 CPU 占用".to_owned()),
        backend_task_id: None,
        model_selection: None,
        execution_context: None,
        workflow_node_id: None,
    };
    let binding = store
        .bind_task(
            &project.id,
            Some(&issue.id),
            None,
            address.clone(),
            Some(&json!({
                "humanAssignmentId": human_task_id,
                "dispatchId": issue.id,
                "dispatchRoundId": "cpu-review-round-1",
                "assignmentId": "cpu-review-admin",
            })),
        )
        .unwrap();
    assert_eq!(
        binding.human_assignment_id.as_deref(),
        Some(human_task_id.as_str())
    );
    assert_eq!(
        binding.dispatch_round_id.as_deref(),
        Some("cpu-review-round-1")
    );

    let delivery = store
        .create_delivery(
            &project.id,
            &issue.id,
            true,
            DeliveryCreate {
                title: String::new(),
                markdown: "CPU load confirmed at 42%.".to_owned(),
                chat: None,
                source_task: Some(address),
            },
        )
        .unwrap();
    store
        .finalize_delivery(&issue.id, &delivery.id, DeliveryFinalize::default())
        .unwrap();
    let settled_human_task = store.get_task(&project.id, &human_task_id).unwrap();
    assert_eq!(settled_human_task.status.as_deref(), Some("completed"));
    assert_eq!(
        settled_human_task.current_delivery_id.as_deref(),
        Some(delivery.id.as_str())
    );
    let resumed_manager = store
        .claim_next_local_execution(&LocalExecutionClaim {
            execution_device_id: Some("local-device".to_owned()),
            runtime_instance_id: "runtime-1".to_owned(),
            device_capacity: 1,
            runtime_active: 0,
            runtime_active_task_ids: Vec::new(),
            lease_seconds: 300,
        })
        .unwrap()
        .expect("manager must restart after the human delivery");
    assert_eq!(resumed_manager.agent_id, leader.id);
    assert_eq!(
        resumed_manager.execution_payload.as_ref().unwrap()["origin"]["dispatchRole"],
        "manager"
    );
    assert!(
        resumed_manager.execution_payload.as_ref().unwrap()["message"]
            .as_str()
            .unwrap()
            .contains("CPU load confirmed at 42%.")
    );
    accept_and_start(&store, &resumed_manager);
    let second_plan = json!({
        "round_id": "cpu-review-round-2",
        "items": [{
            "assignment_id": "cpu-review-admin-again",
            "title": "Confirm the CPU load again",
            "instructions": "Check the load after the fix.",
            "assignee_type": "human",
            "assignee_id": "42",
        }],
    });
    let resumed_runtime_id = resumed_manager.runtime_task_id.as_deref().unwrap();
    assert_eq!(
        store
            .submit_collaboration_round(
                resumed_runtime_id,
                &json!({
                    "round_id": "cpu-review-round-1",
                    "items": second_plan["items"],
                }),
            )
            .unwrap()["state"],
        "already_dispatched"
    );
    assert_eq!(
        store.assignment_receipts(&project.id, &issue.id).unwrap(),
        read
    );
    let second_round = store
        .submit_collaboration_round(resumed_runtime_id, &second_plan)
        .unwrap();
    assert_eq!(second_round["state"], "dispatched");
    let issue_after_second_round = store.get_task(&project.id, &issue.id).unwrap();
    assert_eq!(issue_after_second_round.assignee_user_id, Some(42));
    let second_assignment_id = format!(
        "{}-{}",
        issue.id,
        issue_after_second_round.metadata["assignment_history"]
            .as_array()
            .unwrap()
            .len()
    );
    assert_ne!(second_assignment_id, assignment_id);
    let second_receipts = store.assignment_receipts(&project.id, &issue.id).unwrap();
    assert_eq!(second_receipts.len(), 1);
    let fresh = second_receipts
        .iter()
        .find(|receipt| receipt["id"] == second_assignment_id)
        .unwrap();
    assert_eq!(fresh["target_id"], "42");
    assert!(fresh["stand_in_received_at"].is_null());
    assert!(fresh["human_read_at"].is_null());
    assert!(store
        .acknowledge_assignment(&project.id, &issue.id, &assignment_id, 42, true)
        .is_err());
    assert_eq!(
        LocalTaskStore::open(directory.path().join("tasks.sqlite"))
            .unwrap()
            .assignment_receipts(&project.id, &issue.id)
            .unwrap(),
        second_receipts
    );
}

#[test]
fn manual_approval_flow_and_claim_runs_once() {
    let (directory, store, project) = chat_agent_store();
    let _ = directory;
    let agent = make_local_agent(&store, &project.id, "manual_approval");
    let task = store
        .create_task(
            &project.id,
            TaskCreate {
                milestone_id: None,
                title: "Approve me".to_owned(),
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
                execution_payload: Some(json!({"message": "run it"})),
                workflow: None,
            },
        )
        .unwrap();
    let executions = store
        .list_executions(&project.id, None, None, false)
        .unwrap();
    assert_eq!(executions[0].status, "pending_approval");
    assert_eq!(executions[0].approval_status.as_deref(), Some("pending"));

    // Not approved -> not claimable.
    let claim = LocalExecutionClaim {
        execution_device_id: Some("local-device".to_owned()),
        runtime_instance_id: "runtime-1".to_owned(),
        device_capacity: 1,
        runtime_active: 0,
        runtime_active_task_ids: vec![],
        lease_seconds: 300,
    };
    assert!(store.claim_next_local_execution(&claim).unwrap().is_none());

    store.approve_execution(executions[0].id).unwrap();
    let claimed = store.claim_next_local_execution(&claim).unwrap().unwrap();
    assert_eq!(claimed.status, "claimed");
    assert!(claimed.lease_expires_at.is_some());
    // Only one run at a time.
    assert!(store.claim_next_local_execution(&claim).unwrap().is_none());

    accept_and_start(&store, &claimed);
    let done = store.complete_execution(claimed.id, None).unwrap().unwrap();
    assert_eq!(done.status, "completed");
}

#[test]
fn local_task_responses_carry_execution_state() {
    let (directory, store, project) = chat_agent_store();
    let _ = directory;
    let agent = make_local_agent(&store, &project.id, "manual_approval");
    let task = store
        .create_task(
            &project.id,
            TaskCreate {
                milestone_id: None,
                title: "Approve me".to_owned(),
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
                execution_payload: None,
                workflow: None,
            },
        )
        .unwrap();
    assert_eq!(updated.execution_state.as_deref(), Some("waiting_approval"));
    assert!(updated.execution_id.is_some());

    let fetched = store.get_task(&project.id, &task.id).unwrap();
    assert_eq!(fetched.execution_state.as_deref(), Some("waiting_approval"));

    let listed = store.list_tasks(&project.id).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(
        listed[0].execution_state.as_deref(),
        Some("waiting_approval")
    );

    let executions = store
        .list_executions(&project.id, None, None, false)
        .unwrap();
    store.approve_execution(executions[0].id).unwrap();
    let after = store.get_task(&project.id, &task.id).unwrap();
    assert_eq!(after.execution_state.as_deref(), Some("queued"));
}

#[test]
fn chat_agent_persists_creator_id() {
    let (directory, store, project) = chat_agent_store();
    let _ = directory;
    let agent = store
        .create_chat_agent(
            &project.id,
            ChatAgentCreate {
                execution_policy: None,
                model_policy: None,
                name: "Creator Bot".to_owned(),
                display_name: None,
                namespace: None,
                runtime: "codex".to_owned(),
                model: None,
                model_type: None,
                model_namespace: None,
                allowed_models: Some(Vec::new()),
                capability_description: None,
                capability_mode: Some("manual".to_owned()),
                system_prompt: None,
                visibility: None,
                execution_environment: Some("local".to_owned()),
                execution_mode: Some("manual_approval".to_owned()),
                execution_device_id: Some("local-device".to_owned()),
                max_concurrent_executions: 1,
                workspace_policy: "project".to_owned(),
                local_project_id: None,
                created_by_user_id: Some(42),
                plugins: vec![json!({
                    "id": "github@openai",
                    "pluginName": "github",
                    "marketplaceId": "openai",
                    "displayName": "GitHub",
                })],
                additional_skills: Vec::new(),
                mcp_servers: json!({}),
            },
        )
        .unwrap();
    assert_eq!(agent.created_by_user_id, 42);
    assert_eq!(agent.plugins[0]["id"], "github@openai");
    let listed = store.list_chat_agents(&project.id).unwrap();
    assert_eq!(listed[0].created_by_user_id, 42);
    assert_eq!(listed[0].plugins[0]["id"], "github@openai");
}
