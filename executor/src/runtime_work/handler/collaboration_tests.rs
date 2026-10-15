// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

use axum::{extract::State, http::StatusCode, routing::post, Json, Router};

async fn assignment_report_backend() -> (String, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
    let reports = Arc::new(AtomicUsize::new(0));
    let router = Router::new()
        .route(
            "/api/v1/cloud-projects/7/executions/assignment-status",
            post(
                |State(reports): State<Arc<AtomicUsize>>, Json(_payload): Json<Value>| async move {
                    if reports.fetch_add(1, Ordering::SeqCst) == 0 {
                        StatusCode::SERVICE_UNAVAILABLE
                    } else {
                        StatusCode::OK
                    }
                },
            ),
        )
        .with_state(reports.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    (format!("http://{address}"), reports, server)
}

fn round_handler(root: &std::path::Path, backend_url: &str) -> RuntimeWorkRpcHandler {
    let mut handler = RuntimeWorkRpcHandler::new("device-1", "unused-runner")
        .with_backend_connection(Arc::new(Mutex::new(Some(ConnectionConfig {
            backend_url: backend_url.to_owned(),
            auth_token: "test-session".to_owned(),
            ..ConnectionConfig::default()
        }))));
    handler.store = RuntimeWorkStore::new(root.join("index.json"));
    handler
}

fn store_completed_member(
    handler: &RuntimeWorkRpcHandler,
    command: &CloudCollaborationRoundCommand,
) {
    let member_id =
        collaboration_member_task_id("dispatch-task-1", command, &command.assignments[0]).unwrap();
    handler.store.upsert_task(RuntimeTaskLink {
        local_task_id: member_id,
        runtime: "claude_code".to_owned(),
        status: "completed".to_owned(),
        turn_status: Some("completed".to_owned()),
        ..RuntimeTaskLink::default()
    });
}

#[tokio::test]
async fn terminal_report_failure_keeps_round_until_backend_acknowledges_it() {
    let root = tempfile::tempdir().unwrap();
    let (backend_url, reports, server) = assignment_report_backend().await;
    let handler = round_handler(root.path(), &backend_url);
    let mut command = command();
    command.human_assignment_ids.clear();
    handler.store.upsert_task(source_link());
    store_completed_member(&handler, &command);
    handler.persist_cloud_collaboration_round(&command).unwrap();

    let mut monitor = tokio::spawn({
        let handler = handler.clone();
        let command = command.clone();
        async move { handler.monitor_cloud_collaboration_round(command).await }
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        while reports.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(50), &mut monitor)
            .await
            .is_err()
    );
    assert!(handler
        .local_task_link(&command.manager_runtime_task_id)
        .unwrap()
        .runtime_handle
        .get(CLOUD_COLLABORATION_ROUND_KEY)
        .is_some());

    tokio::time::timeout(Duration::from_secs(5), monitor)
        .await
        .unwrap()
        .unwrap();

    assert_eq!(reports.load(Ordering::SeqCst), 2);
    assert!(handler
        .local_task_link(&command.manager_runtime_task_id)
        .unwrap()
        .runtime_handle
        .get(CLOUD_COLLABORATION_ROUND_KEY)
        .is_none());
    server.abort();
}

#[tokio::test]
async fn persisted_round_retries_unacknowledged_terminal_report_after_restart() {
    let root = tempfile::tempdir().unwrap();
    let (backend_url, reports, server) = assignment_report_backend().await;
    let handler = round_handler(root.path(), &backend_url);
    let mut command = command();
    command.human_assignment_ids.clear();
    handler.store.upsert_task(source_link());
    store_completed_member(&handler, &command);
    handler.persist_cloud_collaboration_round(&command).unwrap();
    let member_id =
        collaboration_member_task_id("dispatch-task-1", &command, &command.assignments[0]).unwrap();
    assert!(handler
        .report_cloud_collaboration_assignment(
            &command,
            &command.assignments[0],
            &member_id,
            "completed",
            "done",
            "",
        )
        .await
        .is_err());
    assert_eq!(reports.load(Ordering::SeqCst), 1);

    let restarted = round_handler(root.path(), &backend_url);
    let restored = restarted
        .local_task_link(&command.manager_runtime_task_id)
        .unwrap()
        .runtime_handle[CLOUD_COLLABORATION_ROUND_KEY]
        .clone();
    let restored: CloudCollaborationRoundCommand = serde_json::from_value(restored).unwrap();
    tokio::time::timeout(
        Duration::from_secs(5),
        restarted.monitor_cloud_collaboration_round(restored.clone()),
    )
    .await
    .unwrap();
    assert_eq!(reports.load(Ordering::SeqCst), 2);
    assert!(restarted
        .local_task_link(&restored.manager_runtime_task_id)
        .unwrap()
        .runtime_handle
        .get(CLOUD_COLLABORATION_ROUND_KEY)
        .is_none());
    server.abort();
}

#[tokio::test]
async fn unstarted_member_terminal_failure_is_retried_until_acknowledged() {
    let root = tempfile::tempdir().unwrap();
    let (backend_url, reports, server) = assignment_report_backend().await;
    let handler = round_handler(root.path(), &backend_url);
    let mut command = command();
    command.human_assignment_ids.clear();
    handler.store.upsert_task(source_link());
    handler.persist_cloud_collaboration_round(&command).unwrap();
    let failure = json!({
        "assignee_type": "agent",
        "assignment_id": "member-1",
        "runtime_task_id": "unstarted-member",
        "status": "failed",
        "error": "Member launch failed",
    });

    let outcomes = tokio::time::timeout(
        Duration::from_secs(5),
        handler.wait_for_cloud_collaboration_round(&command, &[failure]),
    )
    .await
    .unwrap()
    .unwrap();

    assert_eq!(reports.load(Ordering::SeqCst), 2);
    assert_eq!(outcomes[0]["status"], "failed");
    server.abort();
}

#[tokio::test]
async fn agent_only_round_finishes_without_starting_another_manager() {
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.store = RuntimeWorkStore::new(root.path().join("index.json"));
    let mut command = command();
    command.human_assignment_ids.clear();
    handler.store.upsert_task(source_link());
    handler.persist_cloud_collaboration_round(&command).unwrap();

    handler
        .finish_cloud_collaboration_round(&command, vec![])
        .await
        .unwrap();

    assert!(handler
        .local_task_link(&command.manager_runtime_task_id)
        .unwrap()
        .runtime_handle
        .get(CLOUD_COLLABORATION_ROUND_KEY)
        .is_none());
    assert!(handler
        .local_task_link(&fresh_cloud_manager_task_id(&command))
        .is_none());
    assert_eq!(handler.store.list_task_summaries(true).len(), 1);
}

#[tokio::test]
async fn unavailable_human_status_keeps_the_manager_round_pending() {
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.store = RuntimeWorkStore::new(root.path().join("index.json"));
    let mut command = command();
    command.assignments.clear();
    handler.store.upsert_task(source_link());
    handler.persist_cloud_collaboration_round(&command).unwrap();

    let monitored = tokio::time::timeout(
        Duration::from_millis(20),
        handler.monitor_cloud_collaboration_round(command.clone()),
    )
    .await;

    assert!(monitored.is_err(), "an unavailable human status must wait");
    assert!(handler
        .local_task_link(&command.manager_runtime_task_id)
        .unwrap()
        .runtime_handle
        .get(CLOUD_COLLABORATION_ROUND_KEY)
        .is_some());
    assert!(handler
        .local_task_link(&fresh_cloud_manager_task_id(&command))
        .is_none());
}

#[test]
fn round_barrier_requires_every_assigned_member_and_human_delivery() {
    let command = command();
    let member = json!({
        "assignee_type": "agent",
        "assignment_id": "member-1",
        "status": "completed",
    });
    let mut human = json!({
        "assignee_type": "human",
        "human_assignment_id": "human-assignment-1",
        "status": "queued",
    });

    assert!(!cloud_collaboration_round_is_complete(&command, &[]));
    assert!(!cloud_collaboration_round_is_complete(
        &command,
        std::slice::from_ref(&member)
    ));
    assert!(!cloud_collaboration_round_is_complete(
        &command,
        &[member.clone(), human.clone()]
    ));

    human["status"] = json!("completed");
    assert!(!cloud_collaboration_round_is_complete(
        &command,
        std::slice::from_ref(&human)
    ));
    assert!(cloud_collaboration_round_is_complete(
        &command,
        &[member.clone(), human.clone()]
    ));

    human["human_assignment_id"] = json!("another-human-assignment");
    assert!(!cloud_collaboration_round_is_complete(
        &command,
        &[member, human]
    ));
}

fn command() -> CloudCollaborationRoundCommand {
    CloudCollaborationRoundCommand {
        manager_runtime_task_id: "manager-task-1".to_owned(),
        project_id: "7".to_owned(),
        item_id: "issue-1".to_owned(),
        dispatch_id: "dispatch-1".to_owned(),
        round_id: "round-1".to_owned(),
        assignments: vec![json!({
            "assignee_type": "agent",
            "assignment_id": "member-1",
            "assignee_id": "agent-2",
            "agent_id": "agent-2",
            "task_title": "Collect evidence",
            "instructions": "Collect CPU evidence",
        })],
        human_assignment_ids: vec!["human-assignment-1".to_owned()],
    }
}

fn source_link() -> RuntimeTaskLink {
    let mut link = RuntimeTaskLink::new_pending_with_runtime(
        "manager-task-1".to_owned(),
        "/tmp/project".to_owned(),
        "Issue manager".to_owned(),
        "codex",
    );
    link.runtime_handle = json!({
        "collaborationManagerContext": "Issue: 根 Issue 标题\n\n项目协作规则：每轮独立验收。",
        "collaborationDispatchTaskId": "dispatch-task-1",
        "modelSelection": {
            "modelName": "gpt-6-sol",
            "modelType": "runtime",
        },
        "collaborationMemberRuntimeProfiles": [{
            "memberIds": ["agent-2"],
            "runtimePayload": {
                "taskId": "member-template",
                "runtime": "codex"
            }
        }],
        "executionRequest": {
            "system_prompt": "manager system instructions",
            "mcp_servers": [{"name": "wework_space"}],
            "extra": {
                "origin": {
                    "cloudProjectId": 7,
                    "loopItemId": "issue-1",
                    "dispatchId": "dispatch-1",
                    "dispatchRole": "manager",
                    "managerAgentId": "agent-1"
                }
            }
        },
        "origin": {
            "cloudProjectId": 7,
            "loopItemId": "issue-1",
            "dispatchId": "dispatch-1",
            "dispatchRole": "manager",
            "managerAgentId": "agent-1"
        }
    });
    link
}

#[test]
fn fresh_manager_preserves_direct_runtime_home_classification() {
    let mut source = source_link();
    let request: ExecutionRequest = serde_json::from_value(json!({
        "team_id": 0,
        "user_id":7,
        "user_name":"synthetic",
        "team_name":"agent",
        "team_namespace":"default",
        "collaboration_model":"pipeline",
        "bot": [{"id": 31, "shell_type": "Codex"}],
        "auth_token": "synthetic-secret",
        "runtime_auth_token": "synthetic-runtime-secret"
    }))
    .unwrap();
    store_runtime_execution_request(&mut source.runtime_handle, &request);
    let (resumed, _) = fresh_cloud_manager_payload(&source, &command(), &[]).unwrap();
    assert_eq!(resumed.extra["team_id"], 0);
    assert_eq!(resumed.extra["user_id"], 7);
    assert_eq!(resumed.extra["team_name"], "agent");
    assert_eq!(resumed.extra["collaboration_model"], "pipeline");
    assert_eq!(resumed.user_name.as_deref(), Some("synthetic"));
    assert_eq!(resumed.team_namespace.as_deref(), Some("default"));
    assert_eq!(resumed.bot[0]["id"], 31);
    assert!(resumed.auth_token.is_none());
    assert!(resumed.runtime_auth_token.is_none());
}

#[test]
fn fresh_cloud_manager_payload_starts_new_session() {
    let command = command();
    let mut source = source_link();
    source.runtime_handle["executionRequest"]["extra"]["origin"]["executionId"] = json!(91);
    let outcomes = vec![json!({
        "execution_id": "execution-1",
        "status": "completed",
        "result": "done",
    })];

    let (request, payload) = fresh_cloud_manager_payload(&source, &command, &outcomes).unwrap();

    assert_eq!(request.task_id, "manager-task-1-manager-after-round-1");
    assert_eq!(
        request.subtask_id,
        "manager-task-1-manager-after-round-1-initial"
    );
    assert!(request.new_session);
    assert!(request.history.is_empty());
    assert_eq!(request.message_id, None);
    assert!(request.extra["origin"].get("executionId").is_none());
    assert!(payload["origin"].get("executionId").is_none());
    assert_eq!(request.system_prompt, "manager system instructions");
    assert_eq!(request.mcp_servers, vec![json!({"name": "wework_space"})]);
    assert_eq!(
        request.extra["origin"]["dispatchRole"],
        Value::String("manager".to_owned())
    );
    assert!(request
        .prompt
        .as_str()
        .is_some_and(|prompt| prompt.contains("Issue: 根 Issue 标题")
            && prompt.contains("项目协作规则：每轮独立验收。")
            && prompt.contains("\"result\": \"done\"")));
    assert_eq!(payload["runtime"], "codex");
    assert_eq!(payload["workspacePath"], "/tmp/project");
    assert_eq!(
        payload["modelSelection"]["modelName"],
        Value::String("gpt-6-sol".to_owned())
    );
    assert_eq!(
        payload["origin"]["managerAgentId"],
        Value::String("agent-1".to_owned())
    );
    assert_eq!(
        payload["runtimeHandle"]["collaborationDispatchTaskId"],
        "dispatch-task-1"
    );
    assert_eq!(
        payload["runtimeHandle"]["collaborationMemberRuntimeProfiles"],
        source.runtime_handle["collaborationMemberRuntimeProfiles"]
    );
}

#[test]
fn fresh_cloud_manager_payload_keeps_single_collaboration_mode() {
    let (mut request, payload) =
        fresh_cloud_manager_payload(&source_link(), &command(), &[]).unwrap();

    apply_runtime_payload_metadata(&mut request, &payload);

    assert_eq!(payload["collaboration_model"], "single");
    assert_eq!(request.extra["collaborationMode"], "single");
}

#[test]
fn executor_materializes_member_task_from_root_profile() {
    let command = command();
    let assignment = &command.assignments[0];
    let mut payload = json!({
        "taskId": "root-member-profile",
        "title": "placeholder",
        "message": "placeholder",
        "projectInstructions": "member system instructions",
        "origin": {
            "executionId": 91,
            "dispatchRole": "member"
        },
        "executionRequest": {
            "task_id": "root-member-profile",
            "subtask_id": "root-member-profile-initial",
            "system_prompt": "manager system instructions",
            "prompt": "placeholder",
            "extra": {
                "origin": {
                    "executionId": 91,
                    "dispatchRole": "member"
                }
            }
        }
    });

    materialize_collaboration_member_payload(
        &mut payload,
        "dispatch-task-1-member-round-1-member-1",
        &command,
        assignment,
    )
    .unwrap();

    assert_eq!(payload["taskId"], "dispatch-task-1-member-round-1-member-1");
    assert_eq!(payload["title"], "Collect evidence");
    assert_eq!(
        payload["message"],
        "任务标题：Collect evidence\n\n执行要求：Collect CPU evidence"
    );
    assert!(payload["origin"].get("executionId").is_none());
    assert_eq!(payload["origin"]["assignmentId"], "member-1");
    assert_eq!(
        payload["executionRequest"]["extra"]["origin"]["coordinationRoundId"],
        "round-1"
    );
    let system_prompt = payload["executionRequest"]["system_prompt"]
        .as_str()
        .expect("member system prompt");
    assert!(system_prompt.starts_with("member system instructions"));
    assert!(!system_prompt.contains("manager system instructions"));
    assert!(system_prompt.contains("Executor 自动记录到当前 Issue 动态"));
    assert!(system_prompt.contains("不要调用 add_board_item_comment"));
    assert!(system_prompt.contains("必须调用 upload_item_attachment"));
}

#[test]
fn fresh_cloud_manager_reuses_the_in_memory_runtime_model_config() {
    let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    let source = source_link();
    let command = command();
    let model_config = json!({
        "model_id": "cloud-model",
        "base_url": "https://models.example.com/v1",
        "api_key": "runtime-secret",
    });
    handler.retain_runtime_model_config(&source.local_task_id, &model_config);

    let (mut request, _) = fresh_cloud_manager_payload(&source, &command, &[]).unwrap();
    request.model_config = handler
        .runtime_model_config(&source.local_task_id)
        .expect("source Runtime model config should stay available in memory");

    assert_eq!(request.model_config, model_config);
    assert!(source.runtime_handle["executionRequest"]["model_config"].is_null());
}

#[test]
fn fresh_cloud_manager_identity_is_stable_per_round() {
    let command = command();

    assert_eq!(
        fresh_cloud_manager_task_id(&command),
        fresh_cloud_manager_task_id(&command)
    );
    assert_ne!(
        fresh_cloud_manager_task_id(&command),
        command.manager_runtime_task_id
    );
}

#[test]
fn fresh_cloud_manager_is_started_only_after_runtime_acceptance() {
    let pending = RuntimeTaskLink::new_pending(
        "manager-task-1-manager-after-round-1".to_owned(),
        "/tmp/project".to_owned(),
        "Issue manager".to_owned(),
    );
    assert!(!fresh_cloud_manager_task_started(&pending));

    let mut started = pending;
    started.thread_id = Some("thread-1".to_owned());
    assert!(fresh_cloud_manager_task_started(&started));
}
