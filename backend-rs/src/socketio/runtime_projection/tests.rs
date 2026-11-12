// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Focused tests for the runtime projection module.

use std::sync::{Arc, Mutex};

use brz_mysql::{FromMysqlRow, MysqlArgs, MysqlError, MysqlExecution};

use super::*;
use crate::loop_tasks::loop_repository::EXECUTION_COLUMNS;

#[test]
fn statements_bind_every_value_instead_of_inlining_literals() {
    let statement = execution_statement(2, 1, true, true);
    assert!(statement.contains("runtime_device_id IN (?, ?)"));
    assert!(statement.contains("runtime_task_id IN (?)"));
    assert!(statement.contains("executor_owner_user_id = ?"));
    assert!(!statement.contains("'d30dc060"));
    let streaming = streaming_candidate_statement(1);
    assert!(streaming.contains("runtime_device_id IN (?)"));
    assert!(streaming.contains("runtime_task_id = ?"));
}

#[test]
fn quoted_task_ids_cannot_reach_the_sql_text() {
    let statement = execution_statement(1, 1, false, true);
    assert!(!statement.contains("runtime_task_id = '"));
    let args = execution_args(&["a'b".to_owned()], &["c'd".to_owned()], None);
    assert_eq!(args.len(), 2);
}

/// `_streaming_activity_for_runtime` filters `metadata_json["kind"]`
/// (`project_chat/service.py:1610-1614`): an unset kind passes, a
/// `task_ai_subagent` kind is filtered out, and any other kind passes. The
/// `CASE ... WHEN 'null' THEN NULL` wrapper keeps a stored JSON string
/// `"null"` distinct from a stored JSON `null` while both read as unset.
#[test]
fn the_streaming_candidate_filters_the_metadata_kind_after_sender_type() {
    let statement = streaming_candidate_statement(1);
    let collapsed = statement.split_whitespace().collect::<Vec<_>>().join(" ");
    // Placement follows the recorded clause order: sender_type, metadata
    // kind, then status.
    let sender = collapsed
        .find("project_chat_messages.sender_type = 'agent'")
        .expect("sender_type clause");
    let kind = collapsed
        .find("CASE JSON_EXTRACT(project_chat_messages.metadata, '$.\\\"kind\\\"')")
        .expect("metadata kind clause");
    let status = collapsed
        .find("project_chat_messages.status IN ('pending', 'streaming')")
        .expect("status clause");
    assert!(sender < kind && kind < status, "{collapsed}");
    // The unset branch passes (`IS NULL`), the subagent kind is filtered out.
    assert!(collapsed.contains("END IS NULL"), "{collapsed}");
    assert!(
        collapsed.contains("END != 'task_ai_subagent'"),
        "{collapsed}"
    );
    // The string `"null"` is normalized to SQL NULL by the CASE wrapper, so it
    // cannot be confused with a stored JSON null, and both count as unset.
    assert_eq!(
        collapsed.matches("WHEN 'null' THEN NULL").count(),
        2,
        "{collapsed}"
    );
    assert_eq!(
        collapsed
            .matches(
                "ELSE JSON_UNQUOTE(JSON_EXTRACT(project_chat_messages.metadata, '$.\\\"kind\\\"'))"
            )
            .count(),
        2,
        "{collapsed}"
    );
    // The primary-key comparison stays `= ?` (the Source uses `==`).
    assert!(collapsed.contains("runtime_task_id = ?"), "{collapsed}");
}

#[test]
fn terminal_events_normalize_like_the_source() {
    let completed = json!({"data": {"status": "completed"}});
    assert_eq!(
        terminal_status("response.created", &completed),
        Some("completed")
    );
    // `cancel_requested` normalizes to `cancelrequested`, which is not a
    // cancelled status, so the event family decides.
    let cancel_requested = json!({"data": {"status": "cancel_requested"}});
    assert_eq!(
        terminal_status("response.incomplete", &cancel_requested),
        Some("failed")
    );
    let cancelled = json!({"data": {"status": "cancelled"}});
    assert_eq!(
        terminal_status("response.incomplete", &cancelled),
        Some("cancelled")
    );
    assert_eq!(
        terminal_status("response.incomplete", &json!({})),
        Some("failed")
    );
    assert_eq!(
        terminal_status("response.completed", &json!({})),
        Some("completed")
    );
    assert_eq!(
        terminal_status("runtime.task.cancelled", &json!({})),
        Some("cancelled")
    );
    assert_eq!(terminal_status("response.block.created", &json!({})), None);
}

#[test]
fn the_event_sequence_uses_python_int_coercion() {
    assert_eq!(event_seq(&json!({"eventSeq": 3})), Some(3));
    assert_eq!(event_seq(&json!({"eventSeq": "4"})), Some(4));
    assert_eq!(event_seq(&json!({"eventSeq": 0})), None);
    assert_eq!(event_seq(&json!({"eventSeq": true})), None);
    assert_eq!(event_seq(&json!({})), None);
}

#[test]
fn the_final_text_prefers_the_runtime_value() {
    let payload = json!({"data": {"value": "answer", "text": "other"}});
    assert_eq!(final_text(&payload).as_deref(), Some("answer"));
    let payload = json!({"data": {"response": {"output": []}}});
    assert_eq!(final_text(&payload), None);
}

/// A transaction that records every read's collapsed SQL and argument count.
#[derive(Clone, Default)]
struct RecordingTransaction {
    queries: Arc<Mutex<Vec<(String, usize)>>>,
}

impl RecordingTransaction {
    fn queries(&self) -> Vec<(String, usize)> {
        self.queries.lock().unwrap().clone()
    }

    fn record<S: AsRef<str>, A: MysqlArgs>(&mut self, sql: S, args: &A) {
        let collapsed = sql
            .as_ref()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        self.queries.lock().unwrap().push((collapsed, args.len()));
    }
}

impl MysqlTransaction for RecordingTransaction {
    async fn execute<S, A>(&mut self, _: S, _: A) -> MysqlResult<MysqlExecution>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
    {
        Ok(MysqlExecution {
            rows_affected: 0,
            last_insert_id: 0,
        })
    }

    async fn fetch_optional<S, A, T>(&mut self, sql: S, args: A) -> MysqlResult<Option<T>>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        self.record(sql, &args);
        Ok(None)
    }

    async fn fetch_one<S, A, T>(&mut self, _: S, _: A) -> MysqlResult<T>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        Err(MysqlError::RowNotFound)
    }

    fn fetch<'a, S, A, T>(
        &'a mut self,
        _: S,
        _: A,
    ) -> impl futures_util::Stream<Item = MysqlResult<T>> + Send + 'a
    where
        S: AsRef<str> + Send + 'a,
        A: MysqlArgs + Send + 'a,
        T: FromMysqlRow + Send + 'a,
    {
        futures_util::stream::empty()
    }

    async fn fetch_all<S, A, T>(&mut self, sql: S, args: A) -> MysqlResult<Vec<T>>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        self.record(sql, &args);
        Ok(Vec::new())
    }
}

fn runtime_identity(payload: Value) -> RuntimeIdentity<'static> {
    let payload = Box::leak(Box::new(payload));
    RuntimeIdentity {
        event_name: "response.block.created",
        runtime_task_id: "runtime-958444342".to_owned(),
        payload,
    }
}

#[tokio::test]
async fn a_projection_reads_the_execution_twice_before_the_chat_projection() {
    // The Source resolves the execution in `_project_chat_runtime_event_sync`
    // and `handle_runtime_event` re-reads it. A missing streaming activity
    // then falls back to `_open_activity_from_execution`, which resolves the
    // device aliases for the current owner and reads the execution with the
    // owner predicate (`project_chat/service.py:1384`, `:1637`, `:987`).
    // Every one of those reads is an observable dependency.
    let recorder = RecordingTransaction::default();
    let mut transaction = recorder.clone();
    let identity = runtime_identity(json!({"taskId": "runtime-958444342"}));
    let (projected, _) = project_in_transaction(
        &mut transaction,
        3246,
        "d30dc060-a1e9-40d6-bbfe-9cecf790f04d",
        &identity,
    )
    .await
    .expect("the projection runs");
    assert!(projected.is_none());

    let queries = recorder.queries();
    let statements = queries
        .iter()
        .map(|(sql, _)| sql.as_str())
        .collect::<Vec<_>>();
    assert_eq!(queries.len(), 7, "{statements:#?}");
    // identity, owner-scoped execution, identity again, execution again.
    assert!(statements[0].contains("FROM kinds"), "{}", statements[0]);
    // A legacy transport identity keeps the full owned-Device scan: no
    // `kinds.id` narrowing, one bound owner parameter.
    assert!(!statements[0].contains("AND kinds.id"), "{}", statements[0]);
    assert!(!statements[2].contains("AND kinds.id"), "{}", statements[2]);
    assert!(
        statements[1].contains("FROM loop_item_executions"),
        "{}",
        statements[1]
    );
    assert!(
        statements[1].contains("executor_owner_user_id = ?"),
        "{}",
        statements[1]
    );
    assert!(statements[2].contains("FROM kinds"), "{}", statements[2]);
    assert_eq!(statements[1], statements[3]);
    // streaming candidate, then the `_open_activity_from_execution` fallback:
    // owner-scoped identity resolution plus the owner-filtered
    // `include_initial_manager` read.
    assert!(
        statements[4].contains("FROM project_chat_messages"),
        "{}",
        statements[4]
    );
    assert!(statements[5].contains("FROM kinds"), "{}", statements[5]);
    assert!(
        statements[6].contains("FROM loop_item_executions"),
        "{}",
        statements[6]
    );
    assert!(
        statements[6].contains("executor_owner_user_id = ?"),
        "the fallback binds the socket call's owner: {}",
        statements[6]
    );
    assert!(
        !statements[6].to_uppercase().contains("LIMIT"),
        "the fallback keeps `query.all()` without LIMIT: {}",
        statements[6]
    );
    // identity (1), owner execution (3), identity (1), owner execution (3),
    // candidate (2), fallback identity (1), fallback execution (3).
    assert_eq!(
        queries.iter().map(|(_, args)| *args).collect::<Vec<_>>(),
        vec![1, 3, 1, 3, 2, 1, 3]
    );
}

#[tokio::test]
async fn a_record_route_without_its_row_returns_none_before_the_stream() {
    // `project_runtime_event` resolves the owned device for an App record
    // route (`project_chat/service.py:1252-1262`); when the record row is
    // missing it returns `None` before the streaming lookup. The execution
    // helper's submitted fallback is a separate path and must not be merged
    // with it.
    let recorder = RecordingTransaction::default();
    let mut transaction = recorder.clone();
    let identity = runtime_identity(json!({"taskId": "runtime-958444342"}));
    let (projected, _) =
        project_in_transaction(&mut transaction, 3246, "app-record-268663", &identity)
            .await
            .expect("the projection runs");
    assert!(projected.is_none());
    let queries = recorder.queries();
    assert_eq!(queries.len(), 5, "{:?}", queries);
    // Every identity read on the record route is the narrow
    // `filter_by(id=record_id)` shape from the Source: the base owned-Device
    // query plus `AND kinds.id = ?`, binding (owner, record id). The first
    // two calls (`project_in_transaction`) and the chat projection's read all
    // narrow, so the per-event read count is unchanged.
    for index in [0usize, 2, 4] {
        assert!(
            queries[index].0.contains("FROM kinds"),
            "{}",
            queries[index].0
        );
        assert!(
            queries[index].0.contains("AND kinds.id = ?"),
            "{}",
            queries[index].0
        );
        assert_eq!(queries[index].1, 2, "{:?}", queries[index]);
    }
    // The missing record row stops the chat projection before its streaming
    // candidate query.
    assert!(
        queries
            .iter()
            .all(|(sql, _)| !sql.contains("project_chat_messages")),
        "{:?}",
        queries
    );
}

#[test]
fn the_record_route_aliases_keep_the_source_order_and_dedup() {
    let device = DeviceKindRow {
        id: 268663,
        name: "electron-x".to_owned(),
        json: json!({
            "spec": {
                "deviceType": "app",
                "deviceId": "electron-x",
                "appDeviceId": "electron-x",
            }
        }),
    };
    assert_eq!(
        record_route_aliases(&device, "app-record-268663"),
        vec!["app-record-268663".to_owned(), "electron-x".to_owned()]
    );
}

#[test]
fn runtime_observation_replaces_unset_start_and_preserves_real_start() {
    let mut row = execution_row(None, "{}");
    let now = chrono::DateTime::from_timestamp(1_780_000_000, 0)
        .unwrap()
        .naive_utc();
    assert_eq!(row.observed_start(now), now);
    for sentinel in [0, 1] {
        row.started_at = chrono::DateTime::from_timestamp(sentinel, 0).map(|at| at.naive_utc());
        assert_eq!(row.observed_start(now), now);
    }
    let started = now - chrono::Duration::seconds(30);
    row.started_at = Some(started);
    assert_eq!(row.observed_start(now), started);
}

fn execution_row(runtime_task_id: Option<&str>, payload: &str) -> ExecutionRow {
    ExecutionRow {
        id: 41,
        loop_item_id: Some("issue-1".into()),
        cloud_project_id: Some("project-1".into()),
        executor_owner_user_id: Some(3),
        agent_id: Some(String::new()),
        team_id: Some(0),
        automation_run_id: Some("run-1".into()),
        execution_environment: Some("cloud".into()),
        execution_device_id: Some("device-1".into()),
        assigner_user_id: Some(3),
        status: Some("running".into()),
        priority_weight: Some(20),
        started_at: None,
        attempt_no: Some(1),
        execution_scope: Some("scope-1".into()),
        observed_state: Some("accepted".into()),
        start_requested_at: None,
        last_event_seq: None,
        termination_reason: None,
        retry_attempt: Some(0),
        max_retries: Some(1),
        execution_note: Some(String::new()),
        approval_status: Some(String::new()),
        approved_by_user_id: None,
        approved_at: None,
        runtime_device_id: Some("app-record-267161".into()),
        runtime_task_id: runtime_task_id.map(str::to_owned),
        execution_payload: Some(payload.to_owned()),
        version: Some(1),
    }
}

/// The default variant keeps the recorded `LIMIT 1` and binds the task id as
/// a one-element `IN` set, exactly like `runtime_task_id.in_(task_ids)`.
#[test]
fn the_default_variant_binds_the_task_set_with_limit() {
    let statement = execution_statement(2, 1, false, true);
    assert!(statement.contains("runtime_device_id IN (?, ?)"));
    assert!(statement.contains("runtime_task_id IN (?)"));
    assert!(statement.ends_with("ORDER BY loop_item_executions.id DESC \n LIMIT 1"));
    let args = execution_args(
        &["app-record-267161".to_owned(), "runtime-alias".to_owned()],
        &["runtime-151001115".to_owned()],
        None,
    );
    assert_eq!(args.len(), 3);
    assert!(matches!(args[2], StatementArg::Str(ref id) if id == "runtime-151001115"));
}

/// The `include_initial_manager` variant reads every candidate without
/// `LIMIT` and binds the manager base id next to the requested identity.
#[test]
fn the_manager_variant_reads_without_limit_and_expands_the_base_id() {
    let statement = execution_statement(1, 2, true, false);
    assert!(statement.contains("runtime_task_id IN (?, ?)"));
    assert!(statement.contains("executor_owner_user_id = ?"));
    assert!(!statement.to_uppercase().contains("LIMIT"));
    let task_ids = runtime_task_ids("runtime-9-manager-initial", true);
    assert_eq!(task_ids, vec!["runtime-9-manager-initial", "runtime-9"]);
    let args = execution_args(&["app-record-267161".to_owned()], &task_ids, Some(273));
    assert_eq!(args.len(), 4);
    assert!(matches!(args[3], StatementArg::Int(273)));
    assert_eq!(runtime_task_ids("runtime-9", true), vec!["runtime-9"]);
    assert_eq!(
        runtime_task_ids("runtime-9-manager-initial", false),
        vec!["runtime-9-manager-initial"]
    );
}

/// `include_initial_manager` keeps the first row whose runtime identity or
/// conversation identity equals the requested task; the manager suffix is
/// derived from `executor_kind = collaboration_group_dispatch`.
#[test]
fn the_manager_variant_matches_on_the_conversation_identity() {
    let payload = r#"{"runtime_selection":{"executor_kind":"collaboration_group_dispatch"}}"#;
    let group = execution_row(Some("runtime-9"), payload);
    assert_eq!(
        execution_conversation_task_id(&group),
        "runtime-9-manager-initial"
    );
    assert!(execution_matches_runtime_task(&group, "runtime-9"));
    assert!(execution_matches_runtime_task(
        &group,
        "runtime-9-manager-initial"
    ));
    assert!(!execution_matches_runtime_task(&group, "runtime-8"));
    let plain = execution_row(Some("runtime-9"), "{}");
    assert_eq!(execution_conversation_task_id(&plain), "runtime-9");
    assert!(execution_matches_runtime_task(&plain, "runtime-9"));
    assert!(!execution_matches_runtime_task(
        &plain,
        "runtime-9-manager-initial"
    ));
}

/// Thread metadata, Goal and lifecycle notifications are rejected before any
/// sequence or terminal handling, exactly like Source's first rule.
#[test]
fn goal_thread_and_turn_events_never_bind_the_execution() {
    for event in [
        "runtime.goal.created",
        "runtime.goal.updated",
        "thread/started",
        "runtime.turn.updated",
    ] {
        assert!(non_binding_runtime_event(event), "{event}");
    }
    for event in [
        "response.created",
        "runtime.turn.started",
        "response.completed",
    ] {
        assert!(!non_binding_runtime_event(event), "{event}");
    }
}

/// `_open_activity_from_execution`'s read carries the socket call's owner and
/// every resolved device alias, without `LIMIT` (`service.py:987`, `:1637`).
#[test]
fn the_open_activity_fallback_binds_the_owner_and_every_alias() {
    let device_ids = vec![
        "app-record-267161".to_owned(),
        "electron-267161".to_owned(),
        "runtime-151001115".to_owned(),
    ];
    let task_ids = runtime_task_ids("runtime-151001115", true);
    let statement = execution_statement(device_ids.len(), task_ids.len(), true, false);
    assert!(
        statement.contains("runtime_device_id IN (?, ?, ?)"),
        "{statement}"
    );
    assert!(statement.contains("runtime_task_id IN (?)"), "{statement}");
    assert!(
        statement.contains("executor_owner_user_id = ?"),
        "{statement}"
    );
    assert!(!statement.to_uppercase().contains("LIMIT"), "{statement}");
    let args = execution_args(&device_ids, &task_ids, Some(273));
    assert_eq!(args.len(), 5);
    assert!(matches!(args[3], StatementArg::Str(ref id) if id == "runtime-151001115"));
    assert!(matches!(args[4], StatementArg::Int(273)));
}

/// Non-binding Runtime events skip the second device and execution read: the
/// first execution read stays, but `handle_runtime_event`'s re-resolution and
/// re-read never run (`service.py:3243-3248`).
#[tokio::test]
async fn goal_thread_and_turn_events_skip_the_second_execution_read() {
    for event in [
        "runtime.goal.updated",
        "thread/metadata",
        "runtime.turn.updated",
    ] {
        let recorder = RecordingTransaction::default();
        let mut transaction = recorder.clone();
        let mut identity = runtime_identity(json!({"taskId": "runtime-958444342"}));
        identity.event_name = event;
        let (projected, _) = project_in_transaction(
            &mut transaction,
            3246,
            "d30dc060-a1e9-40d6-bbfe-9cecf790f04d",
            &identity,
        )
        .await
        .expect("the projection runs");
        assert!(projected.is_none(), "{event}");
        let queries = recorder.queries();
        let statements = queries
            .iter()
            .map(|(sql, _)| sql.as_str())
            .collect::<Vec<_>>();
        // identity + first execution, then the chat projection's candidate and
        // its fallback. The second identity/execution pair is skipped.
        assert_eq!(queries.len(), 5, "{event}: {statements:#?}");
        assert!(statements[0].contains("FROM kinds"), "{event}");
        assert!(
            statements[1].contains("FROM loop_item_executions"),
            "{event}"
        );
        assert!(
            statements[2].contains("FROM project_chat_messages"),
            "{event}"
        );
        assert!(statements[3].contains("FROM kinds"), "{event}");
        assert!(
            statements[4].contains("FROM loop_item_executions"),
            "{event}"
        );
        assert_eq!(
            queries.iter().map(|(_, args)| *args).collect::<Vec<_>>(),
            vec![1, 3, 2, 1, 3],
            "{event}"
        );
    }
}

/// One `project_chat_messages` row for the completion-identity tests.
fn completed_message(
    metadata: Value,
    status: &str,
    trigger: &str,
    project: &str,
    task: &str,
) -> Message {
    let at = chrono::NaiveDate::from_ymd_opt(1970, 1, 1)
        .expect("valid date")
        .and_hms_opt(0, 0, 0)
        .expect("valid time");
    Message {
        id: 1,
        message_id: "message-1".to_owned(),
        client_message_id: String::new(),
        project_id: project.to_owned(),
        task_id: task.to_owned(),
        sender_type: "agent".to_owned(),
        sender_id: "user-1".to_owned(),
        sender_name: "user".to_owned(),
        message_type: "text".to_owned(),
        content: "final".to_owned(),
        metadata: brz_mysql::Json(metadata),
        trigger_message_id: trigger.to_owned(),
        reply_to_message_id: String::new(),
        thread_root_message_id: String::new(),
        agent_id: String::new(),
        runtime_device_id: "device-1".to_owned(),
        runtime_task_id: "runtime-1".to_owned(),
        status: status.to_owned(),
        created_at: at,
        updated_at: at,
    }
}

/// The discovery statements keep the Source's clause order and only add the
/// completed status and `FOR UPDATE` for the post-discovery reload.
#[test]
fn the_completion_discovery_statements_match_the_source_filters() {
    let bound = super::activity::activity_statement(
        2,
        "project_chat_messages.trigger_message_id",
        false,
        false,
    );
    assert!(
        bound.starts_with(&format!("SELECT {} ", super::activity::ACTIVITY_COLUMNS)),
        "{bound}"
    );
    assert!(!bound.contains("SELECT *"), "{bound}");
    assert!(bound.contains("runtime_device_id IN (?, ?)"), "{bound}");
    assert!(bound.contains("runtime_task_id = ?"), "{bound}");
    assert!(bound.contains("sender_type = 'agent'"), "{bound}");
    assert!(
        bound.contains("project_chat_messages.deleted_at"),
        "{bound}"
    );
    assert!(!bound.contains("status = 'completed'"), "{bound}");
    assert!(!bound.contains("FOR UPDATE"), "{bound}");

    let locked = super::activity::activity_statement(
        1,
        "project_chat_messages.trigger_message_id",
        true,
        true,
    );
    assert!(locked.contains("status = 'completed'"), "{locked}");
    assert!(locked.trim_end().ends_with("FOR UPDATE"), "{locked}");
}

/// `_matches_completion_identity`: the bound turn wins, a different bound turn
/// never falls back to the trigger identity, and the unbound request-turn and
/// trigger identities are the only fallbacks.
#[test]
fn the_completion_identity_matches_the_source_predicates() {
    use super::activity::completion_identity_matches;

    let turn = Some("turn-1");
    let bound = completed_message(
        json!({"runtime_turn_id": "turn-1"}),
        "completed",
        "",
        "project-1",
        "task-1",
    );
    assert!(completion_identity_matches(&bound, turn, None, None));

    let other = completed_message(
        json!({"runtime_turn_id": "turn-2"}),
        "completed",
        "",
        "project-1",
        "task-1",
    );
    assert!(!completion_identity_matches(&other, turn, None, None));
    let other_with_trigger = completed_message(
        json!({"runtime_turn_id": "turn-2"}),
        "completed",
        "client-1",
        "project-1",
        "task-1",
    );
    assert!(!completion_identity_matches(
        &other_with_trigger,
        turn,
        Some("client-1"),
        None
    ));

    let unbound = completed_message(
        json!({"execution_id": 7, "runtime_completed_at": "2026-01-01T00:00:00Z"}),
        "completed",
        "client-1",
        "project-1",
        "task-1",
    );
    assert!(completion_identity_matches(
        &unbound,
        turn,
        Some("client-1"),
        None
    ));
    assert!(completion_identity_matches(
        &unbound,
        turn,
        None,
        Some("turn-1")
    ));
    let subagent = completed_message(
        json!({
            "execution_id": 7,
            "runtime_completed_at": "2026-01-01T00:00:00Z",
            "kind": "task_ai_subagent",
        }),
        "completed",
        "client-1",
        "project-1",
        "task-1",
    );
    assert!(!completion_identity_matches(
        &subagent,
        turn,
        Some("client-1"),
        None
    ));
    let streaming = completed_message(json!({}), "streaming", "", "project-1", "task-1");
    assert!(!completion_identity_matches(&streaming, turn, None, None));
    assert!(!completion_identity_matches(&bound, None, None, None));
}

/// `_runtime_event_is_stale` / `_record_runtime_sequence` keep the durable
/// sequence in the activity metadata as a string.
#[test]
fn the_runtime_event_sequence_guards_and_records_like_the_source() {
    use super::activity::{record_runtime_sequence, runtime_event_is_stale};

    let mut row = completed_message(
        json!({"runtime_event_sequence": "5"}),
        "completed",
        "",
        "project-1",
        "task-1",
    );
    assert!(runtime_event_is_stale(&row, Some(5), false));
    assert!(!runtime_event_is_stale(&row, Some(5), true));
    assert!(runtime_event_is_stale(&row, Some(4), false));
    assert!(!runtime_event_is_stale(&row, Some(6), false));
    assert!(!runtime_event_is_stale(&row, None, false));

    assert!(record_runtime_sequence(&mut row, Some(6)));
    assert_eq!(row.metadata.0["runtime_event_sequence"], json!("6"));
    assert!(!record_runtime_sequence(&mut row, Some(4)));
    assert_eq!(row.metadata.0["runtime_event_sequence"], json!("6"));
}

/// The `response.completed` discovery runs before the streaming fallback and
/// keeps the Source's `runtime_turn_id` + `trigger_message_id` pair.
#[tokio::test]
async fn response_completed_discovers_the_turn_activity_before_the_stream() {
    let recorder = RecordingTransaction::default();
    let mut transaction = recorder.clone();
    let payload = Box::leak(Box::new(json!({
        "taskId": "runtime-958444342",
        "subtaskId": "01a1ab02-e188-77e3-89e7-526affcbac2c",
        "clientUserMessageId": "queued-runtime-pane-1793870454285-0",
        "eventSeq": 9,
        "data": {"value": "final text"},
    })));
    let identity = RuntimeIdentity {
        event_name: "response.completed",
        runtime_task_id: "runtime-958444342".to_owned(),
        payload,
    };
    let projected = project_runtime_event(
        &mut transaction,
        3246,
        "d30dc060-a1e9-40d6-bbfe-9cecf790f04d",
        &identity,
        false,
        &mut Vec::new(),
    )
    .await
    .expect("the projection runs");
    assert!(projected.is_none());

    let queries = recorder.queries();
    let statements: Vec<&str> = queries.iter().map(|(sql, _)| sql.as_str()).collect();
    assert_eq!(queries.len(), 7, "{statements:#?}");
    // 1. the bound runtime_turn_id discovery, 2. its trigger fallback,
    // 3. the reconciled identity read, 4. the reconciled completed-execution
    // scan, 5. the streaming candidate, 6. the owner alias read, 7. the
    // fallback execution read.
    // The discovery reads the Source's exact 22-column projection, not `*`.
    assert!(
        statements[0].starts_with(&format!("SELECT {} ", super::activity::ACTIVITY_COLUMNS)),
        "{}",
        statements[0]
    );
    assert_eq!(
        statements[0].matches(" AS project_chat_messages_").count(),
        22,
        "the Source projects 22 columns: {}",
        statements[0]
    );
    assert!(
        statements[0].contains(
            "project_chat_messages.runtime_activity_key AS \
             project_chat_messages_runtime_activity_key, \
             project_chat_messages.status AS project_chat_messages_status, \
             project_chat_messages.created_at AS project_chat_messages_created_at, \
             project_chat_messages.updated_at AS project_chat_messages_updated_at, \
             project_chat_messages.deleted_at AS project_chat_messages_deleted_at FROM"
        ),
        "the Source's tail column order: {}",
        statements[0]
    );
    assert!(!statements[0].contains("SELECT *"));
    assert!(
        statements[0].contains("'$.\\\"runtime_turn_id\\\"'"),
        "{}",
        statements[0]
    );
    assert!(!statements[0].contains("status = 'completed'"));
    assert!(!statements[0].contains("FOR UPDATE"));
    assert_eq!(queries[0].1, 3, "one device alias, the task, the turn");
    assert!(
        statements[1].contains("project_chat_messages.trigger_message_id = ?"),
        "{}",
        statements[1]
    );
    assert!(
        statements[1].starts_with(&format!("SELECT {} ", super::activity::ACTIVITY_COLUMNS)),
        "the trigger fallback keeps the same projection: {}",
        statements[1]
    );
    assert!(
        statements[2].contains("FROM kinds"),
        "reconciled identity read: {}",
        statements[2]
    );
    // #362 reuses the already-verified 44-column execution projection, in
    // Source order.
    assert!(
        statements[3].starts_with(&format!("SELECT {EXECUTION_COLUMNS} ")),
        "{}",
        statements[3]
    );
    assert_eq!(
        statements[3].matches(" AS loop_item_executions_").count(),
        44,
        "the Source projects 44 execution columns"
    );
    assert!(
        statements[3].contains("loop_item_executions.status = 'completed'"),
        "{}",
        statements[3]
    );
    assert!(
        statements[3].contains("loop_item_executions.executor_owner_user_id = ?"),
        "{}",
        statements[3]
    );
    assert!(
        statements[3].ends_with("ORDER BY loop_item_executions.id DESC"),
        "{}",
        statements[3]
    );
    assert_eq!(queries[3].1, 3, "one device alias, the task, the owner");
    assert!(
        statements[4].starts_with("SELECT project_chat_messages.id AS project_chat_messages_id"),
        "{}",
        statements[4]
    );
    assert!(
        statements[4].contains("status IN ('pending', 'streaming')"),
        "{}",
        statements[4]
    );
}

/// One activity whose content is the reconciled placeholder, so the
/// `reconciled_activity_for_runtime` content gate passes.
fn reconciled_message(metadata: Value) -> Message {
    let mut row = completed_message(metadata, "completed", "", "project-1", "issue-1");
    row.content = "Runtime reconciled".to_owned();
    row
}

#[test]
fn streaming_chunks_preserve_execution_identity_without_a_prior_client_snapshot() {
    let row = completed_message(
        json!({"kind":"task_ai_response","execution_id":42,"runtime_turn_id":"reply-turn","run_status":"running","runtime_event_seq":9}),
        "streaming",
        "",
        "project-1",
        "issue-1",
    );
    let view = projected_delta_view(&row, "Live progress");
    assert_eq!(view["content"], "Live progress");
    assert_eq!(view["metadata"]["kind"], "task_ai_response");
    assert_eq!(view["metadata"]["execution_id"], 42);
    assert_eq!(view["metadata"]["runtime_turn_id"], "reply-turn");
    assert_eq!(view["metadata"]["run_status"], "running");
    assert_eq!(view["metadata"]["runtime_event_seq"], 9);
    assert_eq!(view["metadata"]["contentMode"], "delta");
    assert_eq!(projected_view(&row)["metadata"], row.metadata.0);
}

/// `reconciled_activity_for_runtime` returns the genuinely linked activity
/// when the activity's bound turn matches, or when an unbound activity's
/// execution turn matches; every other shape is refused.
#[test]
fn reconciled_candidate_returns_the_real_linked_activity() {
    use super::activity::{is_subagent_activity, raw_execution_id_matches, reconciled_candidate};

    let execution = execution_row(Some("runtime-151001115"), "{}");
    let execution_turn = "runtime-151001115-execution-41";

    let bound = reconciled_message(json!({"runtime_turn_id": "turn-1", "execution_id": 41}));
    let found = reconciled_candidate(Some(bound), &execution, "turn-1")
        .expect("the bound turn returns the linked activity");
    assert_eq!(found.id, 1);
    assert_eq!(found.content, "Runtime reconciled");
    assert!(
        reconciled_candidate(
            Some(reconciled_message(json!({"runtime_turn_id": "turn-1"}))),
            &execution,
            "turn-2",
        )
        .is_none()
    );

    let unbound = reconciled_message(json!({"execution_id": 41}));
    assert!(reconciled_candidate(Some(unbound), &execution, execution_turn).is_some());
    assert!(
        reconciled_candidate(
            Some(reconciled_message(json!({"execution_id": 41}))),
            &execution,
            "other-turn",
        )
        .is_none()
    );

    // Non-completed rows and rows that already carry real content never match.
    let streaming = completed_message(
        json!({"runtime_turn_id": "turn-1"}),
        "streaming",
        "",
        "project-1",
        "issue-1",
    );
    assert!(reconciled_candidate(Some(streaming), &execution, "turn-1").is_none());
    let mut finished = reconciled_message(json!({"runtime_turn_id": "turn-1"}));
    finished.content = "real final text".to_owned();
    assert!(reconciled_candidate(Some(finished), &execution, "turn-1").is_none());
    assert!(reconciled_candidate(None, &execution, "turn-1").is_none());

    // The runtime-row scan skips subagent activities.
    let mut subagent = reconciled_message(json!({"kind": "task_ai_subagent"}));
    assert!(is_subagent_activity(&subagent));
    subagent.metadata = brz_mysql::Json(json!({"kind": "task_ai_parent"}));
    assert!(!is_subagent_activity(&subagent));

    // `_linked_activity` uses raw `==`, not `str()` equality.
    let numeric = reconciled_message(json!({"execution_id": 41}));
    assert!(raw_execution_id_matches(&numeric, 41));
    let text = reconciled_message(json!({"execution_id": "41"}));
    assert!(!raw_execution_id_matches(&text, 41));
}
