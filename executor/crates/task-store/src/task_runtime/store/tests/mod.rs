use std::sync::{Arc, Barrier};

use serde_json::json;
use tempfile::TempDir;

use super::*;
use crate::task_runtime::{BinaryInput, DeliveryCreate, DeliveryFinalize};

fn chat_agent_store() -> (TempDir, LocalTaskStore, LoopItem) {
    let directory = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
    let project = store
        .create_project(ProjectCreate {
            name: "Robot project".to_owned(),
            project_key: Some("RBOT".to_owned()),
            description: String::new(),
            task_provider: TaskProviderKind::Local,
            provider_config: json!({}),
        })
        .unwrap();
    (directory, store, project)
}

fn make_local_agent(store: &LocalTaskStore, project_id: &str, mode: &str) -> ChatAgent {
    store
        .create_chat_agent(
            project_id,
            ChatAgentCreate {
                execution_policy: None,
                model_policy: None,
                name: "Local Bot".to_owned(),
                display_name: None,
                namespace: None,
                runtime: "codex".to_owned(),
                model: None,
                model_type: None,
                model_namespace: None,
                allowed_models: Some(Vec::new()),
                capability_description: None,
                capability_mode: Some("follow_device".to_owned()),
                system_prompt: Some("Be careful.".to_owned()),
                visibility: Some("creator_admin".to_owned()),
                execution_environment: Some("local".to_owned()),
                execution_mode: Some(mode.to_owned()),
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
        .unwrap()
}

fn default_chat_agent_input() -> ChatAgentCreate {
    ChatAgentCreate {
        execution_policy: None,
        model_policy: None,
        name: "current-device-assistant".to_owned(),
        display_name: Some("Current device assistant".to_owned()),
        namespace: Some("default".to_owned()),
        runtime: "codex".to_owned(),
        model: Some("gpt-5".to_owned()),
        model_type: Some("public".to_owned()),
        model_namespace: Some("default".to_owned()),
        allowed_models: Some(Vec::new()),
        capability_description: None,
        capability_mode: Some("follow_device".to_owned()),
        system_prompt: Some(String::new()),
        visibility: Some("creator_admin".to_owned()),
        execution_environment: Some("local".to_owned()),
        execution_mode: Some("auto".to_owned()),
        execution_device_id: None,
        max_concurrent_executions: 1,
        workspace_policy: "project".to_owned(),
        local_project_id: None,
        created_by_user_id: Some(7),
        plugins: Vec::new(),
        additional_skills: Vec::new(),
        mcp_servers: json!({}),
    }
}

fn accept_and_start(store: &LocalTaskStore, claimed: &LocalExecution) -> LocalExecution {
    let device_id = claimed.runtime_device_id.as_deref().unwrap();
    let task_id = claimed.runtime_task_id.as_deref().unwrap();
    store
        .request_runtime_start(claimed.id, device_id, task_id, 300)
        .unwrap()
        .expect("start intent must be fenced");
    store
        .confirm_runtime_accepted(claimed.id, device_id, task_id, 300)
        .unwrap()
        .expect("Runtime acceptance must be recorded");
    store
        .mark_runtime_running(task_id)
        .unwrap()
        .expect("first Runtime event must prove running")
}

fn assert_collaboration_round_completion(has_human: bool, retry_member: bool, team_alias: bool) {
    let (directory, store, project) = chat_agent_store();
    let _ = directory;
    let leader = make_local_agent(&store, DEFAULT_WORK_ITEM_PROJECT_ID, "auto");
    let member = store
        .create_chat_agent(
            DEFAULT_WORK_ITEM_PROJECT_ID,
            ChatAgentCreate {
                execution_policy: None,
                model_policy: None,
                name: "Evidence Bot".to_owned(),
                display_name: Some("Evidence Bot".to_owned()),
                namespace: None,
                runtime: "codex".to_owned(),
                model: Some("gpt-6-mini".to_owned()),
                model_type: Some("runtime".to_owned()),
                model_namespace: None,
                allowed_models: Some(Vec::new()),
                capability_description: Some("Collect evidence".to_owned()),
                capability_mode: Some("follow_device".to_owned()),
                system_prompt: Some("Only collect verifiable evidence.".to_owned()),
                visibility: Some("creator_admin".to_owned()),
                execution_environment: Some("local".to_owned()),
                execution_mode: Some("auto".to_owned()),
                execution_device_id: Some("local-device".to_owned()),
                max_concurrent_executions: 1,
                workspace_policy: "project".to_owned(),
                local_project_id: None,
                created_by_user_id: Some(7),
                plugins: Vec::new(),
                additional_skills: Vec::new(),
                mcp_servers: json!({
                    "evidence": {
                        "command": "evidence-mcp",
                        "args": ["--read-only"]
                    }
                }),
            },
        )
        .unwrap();
    let member_assignment_id = if team_alias {
        store.connection().unwrap().execute(
                "UPDATE loop_items SET metadata = json_set(metadata, '$.wegent_team_id', 42) WHERE id = ?1",
                [&member.id],
            ).unwrap();
        "42".to_owned()
    } else {
        member.id.clone()
    };
    let reviewer = store
        .create_chat_agent(
            DEFAULT_WORK_ITEM_PROJECT_ID,
            ChatAgentCreate {
                execution_policy: None,
                model_policy: None,
                name: "Review Bot".to_owned(),
                display_name: Some("Review Bot".to_owned()),
                namespace: None,
                runtime: "codex".to_owned(),
                model: Some("gpt-6-mini".to_owned()),
                model_type: Some("runtime".to_owned()),
                model_namespace: None,
                allowed_models: Some(Vec::new()),
                capability_description: Some("Review evidence".to_owned()),
                capability_mode: Some("follow_device".to_owned()),
                system_prompt: Some("Only review submitted evidence.".to_owned()),
                visibility: Some("creator_admin".to_owned()),
                execution_environment: Some("local".to_owned()),
                execution_mode: Some("auto".to_owned()),
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
    let project = store
        .update_project(
            &project.id,
            ProjectUpdate {
                version: project.version,
                workflow_definition: Some(json!({
                    "stages": [{
                        "id": "evidence",
                        "name": "Evidence",
                        "acceptance": "Reproducible observations"
                    }]
                })),
                collaboration_groups: Some(json!([{
                    "id": "squad-1",
                    "name": "Diagnostics",
                    "instructions": "Use read-only diagnostics and cite evidence.",
                    "leader": {
                        "kind": "agent",
                        "id": leader.id,
                        "responsibility": "Plan, delegate, and review."
                    },
                    "members": [{
                        "kind": "agent",
                        "id": member_assignment_id,
                        "responsibility": "Collect CPU evidence."
                    }, {
                        "kind": "agent",
                        "id": reviewer.id,
                        "responsibility": "Review the collected evidence."
                    }, {
                        "kind": "human",
                        "id": "42",
                        "name": "Human reviewer",
                        "responsibility": "Confirm the observed behavior."
                    }],
                    "stages": [{
                        "id": "diagnosis",
                        "name": "Diagnosis",
                        "description": "Gather evidence",
                        "assignee": null
                    }]
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
                title: "Investigate CPU".to_owned(),
                description: "Determine whether load is sustained.".to_owned(),
                status: "inbox".to_owned(),
                priority: "high".to_owned(),
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
                assignee_group_id: Some(Some("squad-1".to_owned())),
                execution_payload: Some(json!({
                    "managerRuntimeRequest": {
                        "taskId": "manager-template",
                        "runtime": "codex",
                        "executionRequest": {
                            "task_id": "manager-template",
                            "subtask_id": "manager-template-initial",
                            "system_prompt": "Stale manager request instructions.",
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
                    "memberRuntimeProfiles": [{
                        "memberIds": [leader.id],
                        "runtimePayload": {
                            "taskId": "leader-template",
                            "runtime": "codex",
                            "executionRequest": {
                                "task_id": "leader-template",
                                "subtask_id": "leader-template-initial",
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
                        }
                    }, {
                        "memberIds": [reviewer.id],
                        "runtimePayload": {
                            "taskId": "reviewer-template",
                            "runtime": "codex",
                            "executionRequest": {
                                "task_id": "reviewer-template",
                                "subtask_id": "reviewer-template-initial",
                                "bot": [{
                                    "id": reviewer.id,
                                    "name": "Reviewer",
                                    "shell_type": "Codex"
                                }],
                                "model_config": {
                                    "model": "openai",
                                    "model_id": "gpt-6-sol"
                                }
                            }
                        }
                    }, {
                        "memberIds": [member.id, member_assignment_id],
                        "runtimePayload": {
                            "taskId": "member-template",
                            "runtime": "codex",
                            "executionRequest": {
                                "task_id": "member-template",
                                "subtask_id": "member-template-initial",
                                "bot": [{
                                    "id": member.id,
                                    "name": "Collector",
                                    "shell_type": "Codex",
                                    "mcp_servers": {
                                        "evidence": {
                                            "command": "evidence-mcp"
                                        }
                                    }
                                }],
                                "model_config": {
                                    "model": "openai",
                                    "model_id": "gpt-6-sol"
                                }
                            }
                        }
                    }]
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
    let payload = claimed.execution_payload.as_ref().unwrap();
    assert_eq!(claimed.agent_id, leader.id);
    assert_eq!(
        payload["executionRequest"]["bot"].as_array().unwrap().len(),
        1
    );
    assert_eq!(payload["executionRequest"]["bot"][0]["id"], leader.id);
    assert_eq!(payload["origin"]["dispatchRole"], "manager");
    assert_eq!(payload["origin"]["dispatchId"], issue.id);
    assert_eq!(payload["collaboration_model"], "single");
    assert_eq!(
        payload["runtimeHandle"]["collaborationMemberRuntimeProfiles"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    assert!(payload["message"]
        .as_str()
        .unwrap()
        .contains("Issue 状态：in_progress"));
    assert!(payload["message"]
        .as_str()
        .unwrap()
        .contains("Use read-only diagnostics and cite evidence."));
    assert!(payload["message"]
        .as_str()
        .unwrap()
        .contains("Human reviewer"));
    assert!(payload["message"]
        .as_str()
        .unwrap()
        .contains("Reproducible observations"));
    assert!(payload["projectInstructions"]
        .as_str()
        .unwrap()
        .contains("Be careful."));
    assert!(payload["projectInstructions"]
        .as_str()
        .unwrap()
        .contains("Do not execute member work yourself"));
    let request: crate::protocol::ExecutionRequest =
        serde_json::from_value(payload["executionRequest"].clone()).unwrap();
    assert_eq!(
        request.system_prompt,
        payload["projectInstructions"].as_str().unwrap(),
        "The Runtime consumes the nested request, including the leader prompt and manager rules"
    );
    let runtime_task_id = claimed
        .runtime_task_id
        .as_deref()
        .expect("manager execution must have a Runtime task id");
    accept_and_start(&store, &claimed);
    assert_eq!(
        store
            .project_bound_task_status("local-device", runtime_task_id, "succeeded", 100,)
            .unwrap(),
        0
    );
    assert_eq!(
        store
            .get_task(&project.id, &issue.id)
            .unwrap()
            .status
            .as_deref(),
        Some("in_progress")
    );
    let leader_assignment_error = store
        .submit_collaboration_round(
            runtime_task_id,
            &json!({
                "round_id": "leader-round",
                "items": [{
                    "assignment_id": "manager-cannot-execute",
                    "title": "负责人不得执行",
                    "instructions": "This assignment must be rejected.",
                    "assignee_type": "agent",
                    "assignee_id": leader.id,
                }],
            }),
        )
        .unwrap_err();
    assert!(leader_assignment_error.to_string().contains(
        "collaboration group leader coordinates work and cannot be an assignment target"
    ));
    let mut plan = json!({
        "round_id": "round-1",
        "items": [{
            "assignment_id": "collect",
            "title": "采集运行证据",
            "instructions": "Collect verifiable evidence.",
            "assignee_type": "agent",
            "assignee_id": member_assignment_id,
            "workflow_stage_id": "diagnosis",
        }, {
            "assignment_id": "review-agent",
            "title": "独立复核证据",
            "instructions": "Review the evidence independently.",
            "assignee_type": "agent",
            "assignee_id": reviewer.id,
            "workflow_stage_id": "diagnosis",
        }, {
            "assignment_id": "review-human",
            "title": "人工确认诊断",
            "instructions": "Deliver a human review of the evidence.",
            "assignee_type": "human",
            "assignee_id": "42",
            "workflow_stage_id": "diagnosis",
        }],
    });
    if !has_human {
        plan["items"].as_array_mut().unwrap().truncate(2);
    }
    let round = store
        .submit_collaboration_round(runtime_task_id, &plan)
        .unwrap();
    assert_eq!(round["state"], "dispatched");
    assert_eq!(round["assignments"][0]["agent_name"], "Evidence Bot");
    assert_eq!(round["assignments"][1]["agent_name"], "Review Bot");
    let human_task_id = round["assignments"][2]["human_assignment_id"]
        .as_str()
        .map(ToOwned::to_owned);
    if let Some(human_task_id) = human_task_id.as_deref() {
        assert_eq!(round["assignments"][2]["human_user_name"], "Human reviewer");
        assert_eq!(round["assignments"][2]["human_user_id"], "42");
        let human_task = store.get_task(&project.id, human_task_id).unwrap();
        assert_eq!(human_task.parent_id.as_deref(), Some(issue.id.as_str()));
        assert_eq!(human_task.assignee_user_id, Some(42));
        assert_eq!(human_task.title.as_deref(), Some("人工确认诊断"));
        assert_eq!(
            human_task.metadata["collaboration_assignment"]["round_id"],
            "round-1"
        );
    }
    let comments = store.list_comments(&project.id, &issue.id, 0).unwrap();
    let manager = comments
        .iter()
        .find(|comment| comment.metadata["dispatch_role"] == "manager")
        .expect("manager activity must exist");
    assert_eq!(
        manager.metadata["dispatch_assignments"][0]["task_title"],
        "采集运行证据"
    );
    assert_eq!(
        manager.metadata["dispatch_assignments"][0]["agent_name"],
        "Evidence Bot"
    );
    assert_eq!(manager.metadata["dispatch_id"], issue.id);
    assert_eq!(manager.metadata["activity_type"], "manager_assignment");
    if has_human {
        assert_eq!(
            manager.metadata["dispatch_assignments"][2]["human_user_id"],
            "42"
        );
    }
    let issue_after_dispatch = store.get_task(&project.id, &issue.id).unwrap();
    assert_eq!(
        issue_after_dispatch.assignee_user_id,
        has_human.then_some(42)
    );
    assert_eq!(
        issue_after_dispatch.assignee_agent_id,
        (!has_human).then_some(member.id.clone())
    );
    let member_activity = comments
        .iter()
        .find(|comment| comment.metadata["dispatch_role"] == "member")
        .expect("member activity must exist");
    assert_ne!(member_activity.metadata["execution_id"], claimed.id);
    assert_eq!(
        member_activity.metadata["workflow_task_title"],
        "采集运行证据"
    );
    let connection = store.connection().unwrap();
    let settled_manager = execution_row(&connection, claimed.id).unwrap();
    assert_eq!(settled_manager.status, "completed");
    assert_eq!(
        settled_manager.termination_reason,
        "collaboration_round_dispatched"
    );
    drop(connection);

    let first_member_execution = store
        .claim_next_local_execution(&LocalExecutionClaim {
            execution_device_id: Some("local-device".to_owned()),
            runtime_instance_id: "runtime-1".to_owned(),
            device_capacity: 2,
            runtime_active: 0,
            runtime_active_task_ids: Vec::new(),
            lease_seconds: 300,
        })
        .unwrap()
        .expect("first member execution must be queued");
    assert_eq!(first_member_execution.agent_id, member.id);
    assert_eq!(
        first_member_execution.execution_payload.as_ref().unwrap()["title"],
        "采集运行证据"
    );
    assert_eq!(
        first_member_execution.execution_payload.as_ref().unwrap()["message"],
        "任务标题：采集运行证据\n\n执行要求：Collect verifiable evidence."
    );
    assert_eq!(
        first_member_execution.execution_payload.as_ref().unwrap()["collaboration_model"],
        "single"
    );
    let member_system_prompt = first_member_execution.execution_payload.as_ref().unwrap()
        ["executionRequest"]["system_prompt"]
        .as_str()
        .expect("member system prompt");
    assert!(member_system_prompt.contains("Executor 自动记录到当前 Issue 动态"));
    assert!(member_system_prompt.contains("不要调用 add_board_item_comment"));
    assert!(member_system_prompt.contains("必须调用 upload_item_attachment"));
    assert_eq!(
        first_member_execution.execution_payload.as_ref().unwrap()["executionRequest"]["bot"][0]
            ["id"],
        member.id
    );
    assert_eq!(
        first_member_execution.execution_payload.as_ref().unwrap()["executionRequest"]["bot"][0]
            ["mcp_servers"]["evidence"]["command"],
        "evidence-mcp"
    );
    assert_eq!(first_member_execution.execution_scope, "");

    let second_member_execution = store
        .claim_next_local_execution(&LocalExecutionClaim {
            execution_device_id: Some("local-device".to_owned()),
            runtime_instance_id: "runtime-1".to_owned(),
            device_capacity: 2,
            runtime_active: 1,
            runtime_active_task_ids: vec![first_member_execution
                .runtime_task_id
                .clone()
                .expect("first member must have a Runtime task id")],
            lease_seconds: 300,
        })
        .unwrap()
        .expect("second member execution must be claimable concurrently");
    assert_eq!(second_member_execution.agent_id, reviewer.id);
    assert_eq!(
        second_member_execution.execution_payload.as_ref().unwrap()["title"],
        "独立复核证据"
    );
    assert_eq!(second_member_execution.execution_scope, "");

    let completed_member_id = if retry_member {
        accept_and_start(&store, &first_member_execution);
        let retry = store
            .fail_execution(first_member_execution.id, "Runtime interrupted", true)
            .unwrap()
            .unwrap();
        assert_eq!(retry.previous_execution_id, Some(first_member_execution.id));
        let claimed_retry = store
            .claim_next_local_execution(&LocalExecutionClaim {
                execution_device_id: Some("local-device".to_owned()),
                runtime_instance_id: "runtime-1".to_owned(),
                device_capacity: 2,
                runtime_active: 1,
                runtime_active_task_ids: vec![second_member_execution
                    .runtime_task_id
                    .clone()
                    .unwrap()],
                lease_seconds: 300,
            })
            .unwrap()
            .expect("retry must be claimable");
        assert_eq!(claimed_retry.id, retry.id);
        accept_and_start(&store, &claimed_retry);
        retry.id
    } else {
        first_member_execution.id
    };
    store
        .complete_execution(completed_member_id, Some("Evidence collected."))
        .unwrap();
    assert!(store
        .claim_next_local_execution(&LocalExecutionClaim {
            execution_device_id: Some("local-device".to_owned()),
            runtime_instance_id: "runtime-1".to_owned(),
            device_capacity: 2,
            runtime_active: 1,
            runtime_active_task_ids: vec![second_member_execution
                .runtime_task_id
                .clone()
                .expect("second member must have a Runtime task id")],
            lease_seconds: 300,
        })
        .unwrap()
        .is_none());
    store
        .complete_execution(
            second_member_execution.id,
            Some("Evidence independently reviewed."),
        )
        .unwrap();
    if has_human {
        assert!(store
            .claim_next_local_execution(&LocalExecutionClaim {
                execution_device_id: Some("local-device".to_owned()),
                runtime_instance_id: "runtime-1".to_owned(),
                device_capacity: 1,
                runtime_active: 0,
                runtime_active_task_ids: Vec::new(),
                lease_seconds: 300,
            })
            .unwrap()
            .is_none());

        let human_task_id = human_task_id.unwrap();
        let delivery = store
            .create_delivery(
                &project.id,
                &human_task_id,
                true,
                DeliveryCreate {
                    title: String::new(),
                    markdown: "Human review confirms the evidence.".to_owned(),
                    chat: None,
                    source_task: None,
                },
            )
            .unwrap();
        store
            .finalize_delivery(
                &human_task_id,
                &delivery.id,
                crate::task_runtime::DeliveryFinalize::default(),
            )
            .unwrap();
        let delivered_human_task = store.get_task(&project.id, &human_task_id).unwrap();
        assert_eq!(delivered_human_task.status.as_deref(), Some("completed"));
        assert_eq!(
            delivered_human_task.current_delivery_id.as_deref(),
            Some(delivery.id.as_str())
        );
    }

    let comments = store.list_comments(&project.id, &issue.id, 0).unwrap();
    let member_activity = comments
        .iter()
        .find(|comment| {
            comment.metadata["dispatch_role"] == "member"
                && comment.content == "Evidence collected."
        })
        .expect("member activity must remain present");
    assert_eq!(member_activity.status, "completed");
    assert_eq!(member_activity.content, "Evidence collected.");

    let resumed_manager = store
        .claim_next_local_execution(&LocalExecutionClaim {
            execution_device_id: Some("local-device".to_owned()),
            runtime_instance_id: "runtime-1".to_owned(),
            device_capacity: 1,
            runtime_active: 0,
            runtime_active_task_ids: Vec::new(),
            lease_seconds: 300,
        })
        .unwrap();
    let resumed_manager = resumed_manager.expect("manager must restart after the batch");
    assert_eq!(resumed_manager.agent_id, leader.id);
    let resumed_request: crate::protocol::ExecutionRequest = serde_json::from_value(
        resumed_manager.execution_payload.as_ref().unwrap()["executionRequest"].clone(),
    )
    .unwrap();
    assert_eq!(resumed_request.system_prompt, request.system_prompt);
    assert_eq!(
        resumed_manager.execution_payload.as_ref().unwrap()["origin"]["dispatchRole"],
        "manager"
    );
    assert_eq!(
        resumed_manager.execution_payload.as_ref().unwrap()["collaboration_model"],
        "single"
    );
    assert!(
        resumed_manager.execution_payload.as_ref().unwrap()["message"]
            .as_str()
            .unwrap()
            .contains("Evidence collected.")
    );
    if has_human {
        assert!(
            resumed_manager.execution_payload.as_ref().unwrap()["message"]
                .as_str()
                .unwrap()
                .contains("Human review confirms the evidence.")
        );
    }
    assert!(
        resumed_manager.execution_payload.as_ref().unwrap()["message"]
            .as_str()
            .unwrap()
            .contains("Use read-only diagnostics and cite evidence.")
    );
    assert!(
        resumed_manager.execution_payload.as_ref().unwrap()["message"]
            .as_str()
            .unwrap()
            .contains("Reproducible observations")
    );
    assert_eq!(
        store
            .get_task(&project.id, &issue.id)
            .unwrap()
            .status
            .as_deref(),
        Some("in_progress")
    );
}

fn store() -> (TempDir, LocalTaskStore) {
    let directory = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
    (directory, store)
}

fn local_project(store: &LocalTaskStore) -> LoopItem {
    store
        .create_project(ProjectCreate {
            name: "Local board".to_owned(),
            project_key: Some("LOCAL".to_owned()),
            description: "Local project".to_owned(),
            task_provider: TaskProviderKind::Local,
            provider_config: json!({}),
        })
        .unwrap()
}

mod cases_1;

mod cases_2;

mod cases_3;

mod cases_4;

mod cases_5;

mod cases_6;

mod project_migration;
