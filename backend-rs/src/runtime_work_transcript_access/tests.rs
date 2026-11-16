// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

fn execution(runtime_task_id: Option<&str>, payload: &str) -> ExecutionRow {
    ExecutionRow {
        id: 41,
        executor_owner_user_id: 86,
        agent_id: String::new(),
        team_id: 0,
        runtime_device_id: Some("device-1".to_string()),
        runtime_task_id: runtime_task_id.map(str::to_string),
        execution_payload: payload.to_string(),
    }
}

#[test]
fn candidate_task_ids_include_the_manager_base_identity() {
    assert_eq!(
        candidate_task_ids("runtime-1"),
        vec!["runtime-1".to_string()]
    );
    assert_eq!(
        candidate_task_ids("runtime-1-manager-initial"),
        vec![
            "runtime-1-manager-initial".to_string(),
            "runtime-1".to_string()
        ]
    );
}

#[test]
fn conversation_task_id_prefers_the_recorded_runtime_task() {
    let row = execution(Some("runtime-9"), "");
    assert_eq!(row.conversation_task_id(), "runtime-9");
    assert!(row.matches_local_task("runtime-9"));
    assert!(!row.matches_local_task("runtime-8"));
}

#[test]
fn conversation_task_id_falls_back_to_the_queue_identity() {
    let row = execution(
        None,
        "{\"origin_context\": {\"comment_continue_task_id\": \"task-7\"}}",
    );
    assert_eq!(row.conversation_task_id(), "task-7");
    let row = execution(None, "");
    assert_eq!(row.conversation_task_id(), "codex-queue-41");
}

#[test]
fn group_dispatch_sessions_expose_the_manager_identity() {
    let payload = "{\"runtime_selection\": {\"executor_kind\": \"collaboration_group_dispatch\"}}";
    let row = execution(Some("runtime-9"), payload);
    assert_eq!(row.executor_type(), "collaboration_group_dispatch");
    assert_eq!(row.conversation_task_id(), "runtime-9-manager-initial");
}

#[test]
fn executor_type_matches_the_source_selection_rules() {
    assert_eq!(execution(None, "").executor_type(), "generic_robot");
    let mut row = execution(None, "");
    row.agent_id = "agent-1".to_string();
    assert_eq!(row.executor_type(), "project_robot");
    let mut row = execution(None, "");
    row.team_id = 3;
    assert_eq!(row.executor_type(), "wegent_team");
    let row = execution(
        None,
        "{\"runtime_selection\": {\"executor_kind\": \"generic_robot\"}, \"agent_id\": \"a\"}",
    );
    assert_eq!(row.executor_type(), "generic_robot");
}

#[test]
fn personal_assistant_executor_type_does_not_fall_back_to_a_shared_robot() {
    for payload in [
        "{\"runtime_selection\":{\"executor_kind\":\"human_assistant\"}}",
        "{\"executor_kind\":\"human_assistant\"}",
    ] {
        let row = execution(Some("private-task"), payload);
        assert_eq!(row.executor_type(), "human_assistant");
        assert_eq!(row.conversation_task_id(), "private-task");
    }
}

#[tokio::test]
async fn session_lookup_retains_owned_alias_candidates_in_the_exact_issue_scope() {
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    assert!(
        session_executions(&mysql, 1001, "issue-1", &["private-task".into()])
            .await
            .unwrap()
            .is_empty()
    );
    let queries = mysql.queries();
    assert_eq!(queries.len(), 1);
    assert!(queries[0].sql.contains("cloud_project_id = ?"));
    assert!(queries[0].sql.contains("loop_item_id = ?"));
    assert!(queries[0].sql.contains("runtime_task_id IN (?)"));
    assert!(!queries[0].sql.contains("runtime_device_id = ?"));
    assert_eq!(queries[0].args, 3);
    assert!(mysql.writes().is_empty());
}

#[test]
fn project_visibility_does_not_grant_another_owners_assistant_transcript() {
    let row = execution(
        Some("private-task"),
        "{\"runtime_selection\":{\"executor_kind\":\"human_assistant\"}}",
    );
    assert!(require_execution_reader(86, 86, row.executor_type()).is_ok());
    assert_eq!(
        require_execution_reader(87, 86, row.executor_type())
            .unwrap_err()
            .status(),
        brz_http_server::StatusCode::NOT_FOUND,
    );
    for executor_type in [
        "generic_robot",
        "project_robot",
        "wegent_team",
        "collaboration_group_dispatch",
    ] {
        assert!(require_execution_reader(87, 86, executor_type).is_ok());
    }
}

#[test]
fn related_item_filter_renders_the_source_subqueries() {
    let sql = related_item_filter_sql(86);
    assert!(sql.contains("loop_items.created_by_user_id = 86"));
    assert!(sql.contains("loop_items.assignee_user_id = 86"));
    assert!(sql.contains("loop_items.resource_type IN ('execution')"));
    assert!(sql.contains("loop_items.resource_type IN ('collaborator')"));
    assert!(sql.contains("loop_items.resource_type IN ('chat_agent')"));
    assert!(sql.contains("'1970-01-01 00:00:01'"));
}
