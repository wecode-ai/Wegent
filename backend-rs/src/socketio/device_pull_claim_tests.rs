// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[test]
fn a_queued_reply_reuses_its_task_and_gets_its_own_turn() {
    let root = claim_preparation(17, json!({}), None);
    assert_eq!(root.runtime_task_id, "codex-queue-17");
    assert_eq!(root.runtime_turn_id, "codex-queue-17-execution-17");
    let reply = claim_preparation(
        18,
        json!({
            "origin_context": {"comment_continue_task_id": "codex-queue-17"}
        }),
        None,
    );
    assert_eq!(reply.runtime_task_id, root.runtime_task_id);
    assert_eq!(reply.runtime_turn_id, "codex-queue-17-execution-18");
}

#[test]
fn group_dispatch_binds_the_initial_manager_conversation() {
    let prepared = claim_preparation(
        17,
        json!({"runtime_selection":{"executor_kind":"collaboration_group_dispatch"}}),
        None,
    );
    assert_eq!(prepared.runtime_task_id, "codex-queue-17");
    assert_eq!(prepared.binding_task_id(), "codex-queue-17-manager-initial");
}

#[test]
fn pull_payload_uses_the_stable_task_and_the_compiled_execution_identity() {
    let prepared = claim_preparation(17, json!({}), None);
    let wire = super::super::device_pull_payload::wire_request(
        json!({"taskId":"old","runtime":"codex","message":"hello",
               "projectInstructions":"task rules","modelConfig":{"api_key":"fixture"}}),
        json!({"task_id":prepared.runtime_task_id,"subtask_id":prepared.runtime_turn_id,
               "user_id":42}),
        &prepared,
    );
    assert_eq!(wire["taskId"], "codex-queue-17");
    assert_eq!(
        wire["executionRequest"]["subtask_id"],
        "codex-queue-17-execution-17"
    );
    assert_eq!(wire["executionRequest"]["system_prompt"], "task rules");
    assert_eq!(wire["executionRequest"]["user_id"], 42);
    assert!(wire.get("modelConfig").is_none());
}

#[test]
fn claiming_rebinds_model_identity_without_persisting_provider_configuration() {
    let mut intent = json!({
        "runtime_request": {"deviceId":"old", "modelConfig":{"credential":"fixture"}, "message":"hello"}
    });
    bind_model(
        &mut intent,
        json!({"runner_routing":{"mode":"fixed"}}),
        json!({
            "model":"codex-native", "model_type":"runtime",
            "model_options":{"runnerModelProvider":"codex"}, "account_label":"account"
        }),
        42,
        "app-record-42",
    );
    assert_eq!(intent["runtime_selection"]["resolved_environment_id"], "42");
    assert_eq!(
        intent["runtime_selection"]["runner_routing"]["mode"],
        "fixed"
    );
    let request = &intent["runtime_request"];
    assert_eq!(request["deviceId"], "app-record-42");
    assert_eq!(request["modelSelection"]["modelName"], "codex-native");
    assert_eq!(request["message"], "hello");
    assert!(request.get("modelConfig").is_none());
}
use serde_json::json;

fn row(id: i64, scope: &str) -> QueueExecutionRow {
    QueueExecutionRow {
        id,
        loop_item_id: "PRJ-1".into(),
        cloud_project_id: "1112169888680727447".into(),
        executor_owner_user_id: 86,
        assigner_user_id: 86,
        agent_id: "6218611767877217315".into(),
        team_id: 0,
        automation_run_id: String::new(),
        execution_environment: "local".into(),
        execution_device_id: String::new(),
        runtime_device_id: String::new(),
        runtime_task_id: String::new(),
        status: "queued".into(),
        approval_status: "pending".into(),
        execution_payload: String::new(),
        error_message: String::new(),
        execution_note: String::new(),
        version: 1,
        start_requested_at: None,
        completed_at: None,
        execution_scope: scope.into(),
    }
}

/// `_next_claimable_candidate` keeps a row without a scope, and skips a
/// row whose scope another attempt still occupies.
#[test]
fn the_first_unoccupied_scope_wins() {
    let rows = [row(1, "project_robot:A"), row(2, "project_robot:B")];
    let occupied = ["project_robot:A".to_string()];
    let candidate = rows
        .iter()
        .find(|row| row.execution_scope.is_empty() || !occupied.contains(&row.execution_scope));
    assert_eq!(candidate.map(|row| row.id), Some(2));
    let unscoped = [row(3, "")];
    let occupied: [String; 0] = [];
    assert_eq!(
        unscoped
            .iter()
            .find(|row| row.execution_scope.is_empty() || !occupied.contains(&row.execution_scope))
            .map(|row| row.id),
        Some(3)
    );
}

/// The occupancy SQL keeps the source's capacity statuses, its non-empty
/// scope predicate, and the requested scope set.
#[test]
fn occupancy_uses_the_capacity_statuses() {
    let sql = occupied_scopes_sql("?,?");
    assert!(sql.contains("status IN ('claimed', 'running', 'cancel_requested')"));
    assert!(sql.contains("execution_scope != ''"));
    assert!(sql.contains("execution_scope IN (?,?)"));
}

/// `uses_runner_routing` follows the request's `runner_routing` object.
#[test]
fn runner_routing_is_detected_from_the_selection() {
    let mut queued = row(1, "project_robot:A");
    queued.execution_payload = json!({"runner_routing": {"execution_policy": {}}}).to_string();
    assert!(queued.execution().routed());
    queued.execution_payload = json!({"schema_version": 2, "runtime_selection": {}}).to_string();
    assert!(!queued.execution().routed());
}

#[test]
fn routed_group_requires_the_root_and_every_member_route() {
    let selection = json!({
        "runner_routing": {"model": "leader"},
        "group_runner_requirements": {
            "member-a": {"model": "a"},
            "member-b": {"model": "b"},
        },
    });
    let routes = model::runner_routes("root", &selection)
        .map(|(agent, route)| (agent, route["model"].as_str().unwrap()))
        .collect::<Vec<_>>();
    assert_eq!(
        routes,
        [("root", "leader"), ("member-a", "a"), ("member-b", "b")]
    );
}

/// The queue SQL keeps the source's predicates and ordering.
#[test]
fn the_queue_filter_uses_the_source_properties() {
    assert!(ASSIGNMENT_REQUEST_OBJECT_EXPR.contains("'$.\"assignment_request\"'"));
    assert!(ASSIGNMENT_REQUEST_OBJECT_EXPR.ends_with("= 'object', 0)"));
    assert!(USES_RUNNER_ROUTING_EXPR.contains("'$.\"runner_routing\"'"));
    assert!(USES_RUNNER_ROUTING_EXPR.ends_with("= 1"));

    let queue = queue_sql("?,?,?", false);
    assert!(queue.contains("execution_device_id IN (?,?,?)"));
    assert!(queue.contains("= 'object', 0) = 0"));
    assert!(!queue.contains("= 1 = 0"));
}

#[tokio::test]
#[ignore = "requires disposable loopback MySQL; invoked by Backend Rust CI"]
async fn device_queue_never_consumes_managed_teams() -> anyhow::Result<()> {
    crate::migrations::mysql_tests::isolated(async |mysql| {
        crate::migrations::mysql_tests::seed_collaboration(mysql).await?;
        for (id, environment, team) in [(1,"local",0), (2,"wegent",42), (3,"cloud",42)] {
            mysql.execute("INSERT INTO loop_item_executions(id,loop_item_id,cloud_project_id,executor_owner_user_id,status,execution_environment,execution_device_id,team_id,execution_payload,error_message) VALUES (?,'root','1001',7,'queued',?,'',?,'{}','')",(id,environment,team)).await?;
        }
        let rows: Vec<QueueExecutionRow> = mysql.fetch_all(queue_sql("?", false),(7,"device","local")).await?;
        assert_eq!(rows.iter().map(|row|row.execution().id).collect::<Vec<_>>(),vec![1]);
        Ok(())
    }).await
}
