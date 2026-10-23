// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Focused tests for the project execution queue read.

use chrono::NaiveDateTime;
use serde_json::json;

use super::*;
use crate::sql_test_support::KindQueryCapture;

fn normalize(sql: &str) -> String {
    sql.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[test]
fn query_defaults_to_active_statuses_and_the_recorded_order() {
    let filters = parse_filters(&ExecutionListQuery::default()).unwrap();
    let sql = normalize(&queue_statement(4712514671486395195, &filters));
    assert_eq!(
        sql,
        normalize(&format!(
            "SELECT {EXECUTION_COLUMNS} \nFROM loop_item_executions \n\
             WHERE loop_item_executions.cloud_project_id = '4712514671486395195' \
             AND loop_item_executions.status IN ('waiting_runtime', 'pending_approval', \
             'queued', 'claimed', 'running', 'cancel_requested') \
             ORDER BY loop_item_executions.priority_weight DESC, \
             loop_item_executions.queued_at ASC, loop_item_executions.id ASC \n LIMIT 200"
        ))
    );
}

#[test]
fn include_terminal_omits_the_active_status_filter() {
    let filters = parse_filters(&ExecutionListQuery {
        include_terminal: Some("true".to_string()),
        ..Default::default()
    })
    .unwrap();
    let sql = normalize(&queue_statement(4712514671486395195, &filters));
    assert_eq!(
        sql,
        normalize(&format!(
            "SELECT {EXECUTION_COLUMNS} \nFROM loop_item_executions \n\
             WHERE loop_item_executions.cloud_project_id = '4712514671486395195' \
             ORDER BY loop_item_executions.priority_weight DESC, \
             loop_item_executions.queued_at ASC, loop_item_executions.id ASC \n LIMIT 200"
        ))
    );
}

#[test]
fn filters_render_agent_assigner_and_status() {
    let filters = parse_filters(&ExecutionListQuery {
        agent_id: Some("agent-1".to_string()),
        assigner_user_id: Some("6177".to_string()),
        status: Some("queued".to_string()),
        include_terminal: Some("false".to_string()),
    })
    .unwrap();
    let sql = normalize(&queue_statement(1, &filters));
    assert!(sql.contains("AND loop_item_executions.agent_id = 'agent-1'"));
    assert!(sql.contains("AND loop_item_executions.assigner_user_id = 6177"));
    assert!(sql.contains("AND loop_item_executions.status = 'queued'"));
    assert!(!sql.contains("status IN"));
}

#[test]
fn empty_agent_and_status_values_do_not_filter() {
    let filters = parse_filters(&ExecutionListQuery {
        agent_id: Some(String::new()),
        status: Some(String::new()),
        ..Default::default()
    })
    .unwrap();
    assert!(filters.agent_id.is_none());
    assert!(filters.status.is_none());
    let sql = queue_statement(1, &filters);
    assert!(!sql.contains("agent_id ="));
    assert!(!sql.contains("status ="));
    assert!(sql.contains("status IN"));
}

#[test]
fn query_validation_matches_pydantic_errors() {
    let bad_int = parse_filters(&ExecutionListQuery {
        assigner_user_id: Some("abc".to_string()),
        ..Default::default()
    })
    .unwrap_err();
    assert_eq!(
        bad_int.status(),
        brz_http_server::StatusCode::UNPROCESSABLE_ENTITY
    );
    assert!(bad_int.validation_detail().contains("int_parsing"));

    let bad_bool = parse_filters(&ExecutionListQuery {
        include_terminal: Some(String::new()),
        ..Default::default()
    })
    .unwrap_err();
    assert!(bad_bool.validation_detail().contains("bool_parsing"));
}

fn row(payload: &str) -> ExecutionRow {
    ExecutionRow {
        id: 1,
        loop_item_id: Some("PRJD26304-1".to_string()),
        cloud_project_id: Some("4712514671486395195".to_string()),
        executor_owner_user_id: Some(6177),
        agent_id: Some("agent-1".to_string()),
        team_id: Some(0),
        backend_task_id: Some(0),
        automation_run_id: Some(String::new()),
        execution_environment: Some("local".to_string()),
        execution_device_id: Some(String::new()),
        runtime_instance_id: Some(String::new()),
        assigner_user_id: Some(6177),
        status: Some("queued".to_string()),
        priority_weight: Some(10),
        queued_at: Some(NaiveDateTime::default()),
        started_at: Some(NaiveDateTime::default()),
        completed_at: Some(NaiveDateTime::default()),
        lease_expires_at: Some(NaiveDateTime::default()),
        heartbeat_at: Some(NaiveDateTime::default()),
        claimed_at: Some(NaiveDateTime::default()),
        start_requested_at: Some(NaiveDateTime::default()),
        observed_at: Some(NaiveDateTime::default()),
        cancel_requested_at: Some(NaiveDateTime::default()),
        attempt_no: Some(1),
        previous_execution_id: Some(0),
        execution_scope: Some(String::new()),
        observed_state: Some("unconfirmed".to_string()),
        sync_state: Some("pending".to_string()),
        last_event_seq: Some(0),
        termination_reason: Some(String::new()),
        retry_attempt: Some(0),
        error_message: Some(String::new()),
        execution_note: Some(String::new()),
        approval_status: Some(String::new()),
        approved_by_user_id: Some(0),
        rejected_reason: Some(String::new()),
        runtime_device_id: Some(String::new()),
        runtime_task_id: Some(String::new()),
        execution_payload: Some(payload.to_string()),
        version: Some(1),
        created_at: Some(NaiveDateTime::default()),
        updated_at: Some(NaiveDateTime::default()),
    }
}

#[test]
fn view_projects_the_source_optional_fields() {
    let limits = HashMap::new();
    let view = ExecutionView::project(&row(""), Some(353932), &limits, 6177);
    assert_eq!(view.workspace_id.as_deref(), Some("353932"));
    assert_eq!(view.agent_id.as_deref(), Some("agent-1"));
    assert_eq!(view.team_id, None);
    assert_eq!(view.backend_task_id, None);
    assert_eq!(view.execution_device_id, None);
    assert_eq!(view.approval_status, None);
    assert_eq!(view.previous_execution_id, None);
    assert_eq!(view.approved_by_user_id, None);
    assert_eq!(view.executor_type, "project_robot");
    assert_eq!(view.display_state, "queued");
    assert_eq!(view.queued_at, None);
    assert_eq!(view.created_at.as_deref(), Some("1970-01-01T00:00:00"));
    assert_eq!(view.agent_max_concurrent_executions, 1);
    assert!(view.can_select_runtime);
    assert!(view.runner_routing.is_none());
}

#[test]
fn view_reads_the_runtime_selection_and_routed_queue_state() {
    let payload = r#"{"runtime_selection":{"executor_kind":"collaboration_group_dispatch","runner_routing":{"execution_policy":{"mode":"auto"}},"runtime_profile_id":"7","runtime_source":"user"}}"#;
    let mut limits = HashMap::new();
    limits.insert("agent-1".to_string(), 4);
    let view = ExecutionView::project(&row(payload), None, &limits, 6177);
    assert_eq!(view.executor_type, "collaboration_group_dispatch");
    assert_eq!(view.runtime_profile_id.as_deref(), Some("7"));
    assert_eq!(view.runtime_source.as_deref(), Some("user"));
    assert_eq!(view.agent_max_concurrent_executions, 4);
    assert!(!view.can_select_runtime);
    assert_eq!(
        view.runner_routing,
        Some(json!({"executor_kind": "collaboration_group_dispatch",
                    "runner_routing": {"execution_policy": {"mode": "auto"}},
                    "runtime_profile_id": "7",
                    "runtime_source": "user"}))
    );
}

#[test]
fn v1_payloads_use_the_whole_intent_as_the_selection() {
    let payload = r#"{"runtime_selection":"legacy","executor_kind":"generic_robot"}"#;
    let view = ExecutionView::project(&row(payload), None, &HashMap::new(), 1);
    assert_eq!(view.executor_type, "generic_robot");
    assert!(view.runner_routing.is_none());
}

#[tokio::test]
async fn agent_limits_match_the_source_query() {
    let mysql = KindQueryCapture::default();
    let rows = vec![row("")];
    let limits = agent_limits(&mysql, &rows).await.expect("captured");
    assert!(limits.is_empty());
    let queries = mysql.queries();
    assert_eq!(queries.len(), 1);
    assert_eq!(
        queries[0].sql,
        normalize(&format!(
            "SELECT {LOOP_ITEMS_COLUMNS} \nFROM loop_items \n\
             WHERE loop_items.id IN ('agent-1') \
             AND loop_items.resource_type IN ('chat_agent')"
        ))
    );
}

#[tokio::test]
async fn local_annotation_matches_the_source_query() {
    let mysql = KindQueryCapture::default();
    let rows = task_annotation_rows(&mysql, &["PRJD26304-1".to_string()], None)
        .await
        .expect("captured");
    assert!(rows.is_empty());
    let queries = mysql.queries();
    assert_eq!(
        queries[0].sql,
        normalize(&format!(
            "SELECT {LOOP_ITEMS_COLUMNS} \nFROM loop_items \n\
             WHERE loop_items.id IN ('PRJD26304-1') \
             AND loop_items.resource_type IN ('task')"
        ))
    );

    let mysql = KindQueryCapture::default();
    let visibility = visible_item_filter_sql(6177, "open");
    let _ = task_annotation_rows(&mysql, &["PRJD26304-1".to_string()], Some(&visibility))
        .await
        .expect("captured");
    let sql = mysql.queries()[0].sql.clone();
    assert!(sql.contains("coalesce(CASE JSON_EXTRACT(loop_items.metadata"));
    assert!(sql.ends_with("AND loop_items.resource_type IN ('task')"));
}
