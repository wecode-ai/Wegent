// Extracted from projection.rs to keep the module within the file-size bound.

use super::*;

fn naive(value: &str) -> chrono::NaiveDateTime {
    chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S").unwrap()
}

/// An execution row carrying the recorded run's fields.
fn execution_row(status: &str, agent_id: Option<&str>) -> ExecutionRow {
    ExecutionRow {
        id: 4,
        agent_id: agent_id.map(str::to_owned),
        // The source stores an unset team id as 0.
        team_id: Some(0),
        status: Some(status.to_string()),
        observed_state: Some("unconfirmed".to_string()),
        sync_state: Some("pending".to_string()),
        attempt_no: Some(1),
        last_event_seq: Some(0),
        queued_at: Some(naive("2026-08-10 03:45:20")),
        started_at: Some(naive("2026-08-10 03:45:20")),
        completed_at: Some(naive("2026-08-10 03:45:21")),
        // The source's MySQL unset sentinel.
        lease_expires_at: Some(naive("1970-01-01 00:00:00")),
        heartbeat_at: Some(naive("2026-08-10 03:45:21")),
        error_message: Some("Device did not accept the runtime RPC".to_string()),
        execution_note: Some(String::new()),
        approval_status: None,
        approved_by_user_id: None,
        approved_at: None,
        rejected_reason: None,
        runtime_device_id: Some("local-device".to_string()),
        runtime_task_id: Some("codex-queue-4".to_string()),
        updated_at: Some(naive("2026-08-17 17:07:30")),
    }
}

/// `execution_ai_state` issues the run's `Session.get(ProjectChatAgent,
/// agent_id)` read and projects the recorded execution fields.
#[tokio::test]
async fn execution_ai_state_reads_the_run_agent() {
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    let execution = execution_row("failed", Some("3658812874931794736"));
    let state = execution_ai_state(&mysql, &execution)
        .await
        .unwrap()
        .expect("a non-approval run carries an AI state");
    let queries = mysql.queries();
    assert_eq!(queries.len(), 1, "exactly one agent read: {queries:?}");
    assert!(
        queries[0]
            .sql
            .contains("loop_items.resource_type IN ('chat_agent')"),
        "{}",
        queries[0].sql
    );
    assert!(
        !queries[0].sql.contains(" AS loop_items_"),
        "the Session.get projection is unlabeled: {}",
        queries[0].sql
    );
    assert_eq!(state["run_id"], "exec-4");
    assert_eq!(state["status"], "failed");
    assert_eq!(state["agent_id"], "3658812874931794736");
    assert_eq!(state["started_at"], "2026-08-10T03:45:20");
    assert_eq!(state["last_error"], "Device did not accept the runtime RPC");
    // A zero team id is falsy in the source: no `kinds` lookup, and
    // `team_id` renders as null.
    assert_eq!(state["team_id"], serde_json::Value::Null);
    // `1970-01-01 00:00:00` is a MySQL unset sentinel, not a real time.
    assert_eq!(state["lease_expires_at"], serde_json::Value::Null);
}

/// `latest_for_item` selects the source's labeled full-entity projection, so
/// the derived `ExecutionRow` must decode the `loop_item_executions_*`
/// aliases. The SELECT list is the shared `EXECUTION_COLUMNS`, the same
/// projection `ExecutionFullRow` decodes; if it ever drifts to a bare
/// projection the derived row resolves no column.
#[tokio::test]
async fn latest_for_item_uses_the_labeled_execution_projection() {
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    let execution = ExecutionRow::latest_for_item(&mysql, "WEWORKBU0CEBB1-41")
        .await
        .expect("captured");
    assert!(execution.is_none(), "the capture returns no row");
    let queries = mysql.queries();
    assert_eq!(queries.len(), 1);
    let expected = format!(
        "SELECT {} FROM loop_item_executions WHERE \
         loop_item_executions.loop_item_id = 'WEWORKBU0CEBB1-41' \
         ORDER BY loop_item_executions.id DESC LIMIT 1",
        crate::loop_tasks::loop_repository::EXECUTION_COLUMNS
    );
    let expected = expected.split_whitespace().collect::<Vec<_>>().join(" ");
    assert_eq!(queries[0].sql, expected);
}

/// A `pending_approval` run has no AI state and reads no agent row.
#[tokio::test]
async fn execution_ai_state_skips_lookups_while_awaiting_approval() {
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    let execution = execution_row("pending_approval", Some("3658812874931794736"));
    assert!(
        execution_ai_state(&mysql, &execution)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        mysql.queries().is_empty(),
        "no read while awaiting approval"
    );
}

/// An agent-kind assignee label without a name resolves the display name
/// through `Session.get(ProjectChatAgent, id)`.
#[tokio::test]
async fn assignee_agent_label_without_a_name_reads_the_agent() {
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    let labels = vec!["wegent:assignee:agent:3658812874931794736".to_string()];
    let (user_id, name, agent_id, agent_name) =
        assignee_from_labels(&mysql, &labels).await.unwrap();
    assert_eq!((user_id, name), (None, None));
    assert_eq!(agent_id.as_deref(), Some("3658812874931794736"));
    // The capture returns no row, so the display name stays unresolved.
    assert_eq!(agent_name, None);
    let queries = mysql.queries();
    assert_eq!(queries.len(), 1);
    assert!(
        queries[0]
            .sql
            .contains("loop_items.resource_type IN ('chat_agent')"),
        "{}",
        queries[0].sql
    );
}

/// A user-kind assignee label without a name resolves the display name
/// through the unlabeled `Session.get(User, id)` projection.
#[tokio::test]
async fn assignee_user_label_without_a_name_reads_the_unlabeled_user() {
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    let labels = vec!["wegent:assignee:user:2300".to_string()];
    let (user_id, name, agent_id, agent_name) =
        assignee_from_labels(&mysql, &labels).await.unwrap();
    assert_eq!(user_id, Some(2300));
    assert_eq!(name, None);
    assert_eq!((agent_id, agent_name), (None, None));
    let queries = mysql.queries();
    assert_eq!(queries.len(), 1);
    assert!(
        queries[0]
            .sql
            .starts_with("SELECT users.id, users.user_name,"),
        "{}",
        queries[0].sql
    );
    assert!(
        !queries[0].sql.contains(" AS users_"),
        "the Session.get projection is unlabeled: {}",
        queries[0].sql
    );
    assert!(queries[0].sql.contains("WHERE users.id = 2300"));
}

#[test]
fn page_issue_status_from_labels() {
    let issue = PageIssue {
        number: Some(1),
        iid: None,
        title: None,
        _state: None,
        labels: serde_json::from_str(r#"["wegent:status:in_review"]"#).unwrap(),
        description: None,
        body: None,
        created_at: None,
        updated_at: None,
        closed_at: None,
        pull_request: None,
    };
    assert_eq!(issue.status(), "in_review");
}

#[test]
fn page_issue_status_defaults_to_pending() {
    let issue = PageIssue {
        number: Some(1),
        iid: None,
        title: None,
        _state: None,
        labels: serde_json::from_str("[]").unwrap(),
        description: None,
        body: None,
        created_at: None,
        updated_at: None,
        closed_at: None,
        pull_request: None,
    };
    assert_eq!(issue.status(), "pending");
}

#[test]
fn datetime_reformat_renders_single_offset_sign() {
    // Pydantic re-serializes the parsed timestamp with 6-digit
    // microseconds and the original offset: exactly one `+` before the
    // offset, never `++08:00`.
    assert_eq!(
        datetime_reformat("2026-09-10T19:51:51.762+08:00"),
        serde_json::json!("2026-09-10T19:51:51.762000+08:00")
    );
    assert_eq!(
        datetime_reformat("2026-09-10T19:51:51+08:00"),
        serde_json::json!("2026-09-10T19:51:51+08:00")
    );
    assert_eq!(
        datetime_reformat("2026-09-10T11:51:51.762Z"),
        serde_json::json!("2026-09-10T11:51:51.762000+00:00")
    );
}

/// The full `LoopItemResponse` field order and defaults, serialized to a
/// JSON object string. This is the canonical byte output the recorded
/// traffic expects; the typed struct must reproduce it exactly — every
/// field present, `None` as `null`, defaults at their schema values.
#[test]
fn loop_item_response_serializes_all_fields_in_schema_order() {
    let response = LoopItemResponse {
        id: "wg-1".to_string(),
        cloud_project_id: "123".to_string(),
        sequence_number: 1,
        parent_id: None,
        title: "t".to_string(),
        description: String::new(),
        status: "pending".to_string(),
        assignee_user_id: None,
        assignee_group_id: None,
        assignee_group_name: None,
        assignee_name: None,
        assignee_agent_id: None,
        assignee_agent_name: None,
        assignee_team_id: None,
        assignee_team_name: None,
        ai_state: None,
        execution_id: None,
        execution_state: None,
        execution_control_state: None,
        execution_observed_state: None,
        execution_sync_state: None,
        execution_attempt_no: None,
        execution_last_event_seq: None,
        can_approve: false,
        assignment_history: Vec::new(),
        status_history: Vec::new(),
        approval: None,
        queued_at: None,
        execution_note: None,
        execution_error: None,
        automation: None,
        workflow: None,
        execution_config: None,
        priority: "none".to_string(),
        due_at: None,
        sort_order: 1,
        tags: Vec::new(),
        created_by_user_id: 0,
        created_by_user_name: None,
        can_view_detail: true,
        security_level: "open".to_string(),
        can_edit: false,
        permissions: Permissions::default(),
        detail_loaded: false,
        content_revision: 1,
        activity_read_sequence: 0,
        is_unread: false,
        current_delivery_id: None,
        version: 1,
        created_at: "2026-09-10T19:51:51+08:00".to_string(),
        updated_at: "2026-09-10T19:51:51+08:00".to_string(),
        completed_at: None,
    };
    let serialized = serde_json::to_string(&response).unwrap();
    // Field order and defaults mirror the source `LoopItemResponse`
    // pydantic schema exactly; `null` for every unset Optional field.
    let expected = concat!(
        r#"{"id":"wg-1","cloud_project_id":"123","sequence_number":1,"parent_id":null,"#,
        r#""title":"t","description":"","status":"pending","assignee_user_id":null,"#,
        r#""assignee_group_id":null,"assignee_group_name":null,"assignee_name":null,"#,
        r#""assignee_agent_id":null,"assignee_agent_name":null,"#,
        r#""assignee_team_id":null,"assignee_team_name":null,"ai_state":null,"#,
        r#""execution_id":null,"execution_state":null,"execution_control_state":null,"#,
        r#""execution_observed_state":null,"execution_sync_state":null,"#,
        r#""execution_attempt_no":null,"execution_last_event_seq":null,"can_approve":false,"#,
        r#""assignment_history":[],"status_history":[],"approval":null,"queued_at":null,"#,
        r#""execution_note":null,"execution_error":null,"automation":null,"workflow":null,"#,
        r#""execution_config":null,"priority":"none","due_at":null,"sort_order":1,"tags":[],"#,
        r#""created_by_user_id":0,"created_by_user_name":null,"can_view_detail":true,"#,
        r#""security_level":"open","can_edit":false,"#,
        r#""permissions":{"edit_content":false,"comment":false,"assign":false,"execute":false},"#,
        r#""detail_loaded":false,"content_revision":1,"activity_read_sequence":0,"#,
        r#""is_unread":false,"#,
        r#""current_delivery_id":null,"version":1,"#,
        r#""created_at":"2026-09-10T19:51:51+08:00","updated_at":"2026-09-10T19:51:51+08:00","#,
        r#""completed_at":null}"#
    );
    assert_eq!(serialized, expected);
}

/// `completed_at` carries a value only when the status is `completed`;
/// otherwise it is `null` (never omitted).
#[test]
fn completed_at_is_present_and_null_when_not_completed() {
    let response = LoopItemResponse {
        id: "wg-1".to_string(),
        cloud_project_id: "123".to_string(),
        sequence_number: 1,
        parent_id: None,
        title: "t".to_string(),
        description: String::new(),
        status: "pending".to_string(),
        assignee_user_id: None,
        assignee_group_id: None,
        assignee_group_name: None,
        assignee_name: None,
        assignee_agent_id: None,
        assignee_agent_name: None,
        assignee_team_id: None,
        assignee_team_name: None,
        ai_state: None,
        execution_id: None,
        execution_state: None,
        execution_control_state: None,
        execution_observed_state: None,
        execution_sync_state: None,
        execution_attempt_no: None,
        execution_last_event_seq: None,
        can_approve: false,
        assignment_history: Vec::new(),
        status_history: Vec::new(),
        approval: None,
        queued_at: None,
        execution_note: None,
        execution_error: None,
        automation: None,
        workflow: None,
        execution_config: None,
        priority: "none".to_string(),
        due_at: None,
        sort_order: 1,
        tags: Vec::new(),
        created_by_user_id: 0,
        created_by_user_name: None,
        can_view_detail: true,
        security_level: "open".to_string(),
        can_edit: false,
        permissions: Permissions::default(),
        detail_loaded: false,
        content_revision: 1,
        activity_read_sequence: 0,
        is_unread: false,
        current_delivery_id: None,
        version: 1,
        created_at: "2026-09-10T19:51:51+08:00".to_string(),
        updated_at: "2026-09-10T19:51:51+08:00".to_string(),
        completed_at: None,
    };
    let serialized = serde_json::to_string(&response).unwrap();
    assert!(
        serialized.contains(r#""completed_at":null"#),
        "completed_at must be present as null, not omitted: {serialized}"
    );
    assert!(
        !serialized.contains(r#""completed_at":""#),
        "completed_at must not be an empty string: {serialized}"
    );
}

/// `due_at` is always `null` on the provider path (not omitted, not an
/// empty string), matching the source's `due_at: None`.
#[test]
fn due_at_is_null_not_omitted() {
    let response = LoopItemResponse {
        id: "wg-1".to_string(),
        cloud_project_id: "123".to_string(),
        sequence_number: 1,
        parent_id: None,
        title: "t".to_string(),
        description: String::new(),
        status: "pending".to_string(),
        assignee_user_id: None,
        assignee_group_id: None,
        assignee_group_name: None,
        assignee_name: None,
        assignee_agent_id: None,
        assignee_agent_name: None,
        assignee_team_id: None,
        assignee_team_name: None,
        ai_state: None,
        execution_id: None,
        execution_state: None,
        execution_control_state: None,
        execution_observed_state: None,
        execution_sync_state: None,
        execution_attempt_no: None,
        execution_last_event_seq: None,
        can_approve: false,
        assignment_history: Vec::new(),
        status_history: Vec::new(),
        approval: None,
        queued_at: None,
        execution_note: None,
        execution_error: None,
        automation: None,
        workflow: None,
        execution_config: None,
        priority: "none".to_string(),
        due_at: None,
        sort_order: 1,
        tags: Vec::new(),
        created_by_user_id: 0,
        created_by_user_name: None,
        can_view_detail: true,
        security_level: "open".to_string(),
        can_edit: false,
        permissions: Permissions::default(),
        detail_loaded: false,
        content_revision: 1,
        activity_read_sequence: 0,
        is_unread: false,
        current_delivery_id: None,
        version: 1,
        created_at: "2026-09-10T19:51:51+08:00".to_string(),
        updated_at: "2026-09-10T19:51:51+08:00".to_string(),
        completed_at: None,
    };
    let serialized = serde_json::to_string(&response).unwrap();
    assert!(
        serialized.contains(r#""due_at":null"#),
        "due_at must be present as null: {serialized}"
    );
}

/// When the provider emits no `created_at`/`updated_at`, the raw strings
/// are `""` and `datetime_reformat("")` yields an empty JSON string — not
/// `null` and not omitted. This matches the previous `json!(value)` path,
/// where `json!("")` serialized as `""`. The source pydantic schema types
/// `created_at`/`updated_at` as non-optional `datetime`, so an empty
/// string round-trips as the raw string the provider sent.
#[test]
fn empty_datetime_serializes_as_empty_string_not_null() {
    assert_eq!(datetime_reformat(""), serde_json::json!(""));
    // And within a full response, `created_at`/`updated_at` appear as
    // `""`, never `null`.
    let response = LoopItemResponse {
        id: "wg-1".to_string(),
        cloud_project_id: "123".to_string(),
        sequence_number: 1,
        parent_id: None,
        title: "t".to_string(),
        description: String::new(),
        status: "pending".to_string(),
        assignee_user_id: None,
        assignee_group_id: None,
        assignee_group_name: None,
        assignee_name: None,
        assignee_agent_id: None,
        assignee_agent_name: None,
        assignee_team_id: None,
        assignee_team_name: None,
        ai_state: None,
        execution_id: None,
        execution_state: None,
        execution_control_state: None,
        execution_observed_state: None,
        execution_sync_state: None,
        execution_attempt_no: None,
        execution_last_event_seq: None,
        can_approve: false,
        assignment_history: Vec::new(),
        status_history: Vec::new(),
        approval: None,
        queued_at: None,
        execution_note: None,
        execution_error: None,
        automation: None,
        workflow: None,
        execution_config: None,
        priority: "none".to_string(),
        due_at: None,
        sort_order: 1,
        tags: Vec::new(),
        created_by_user_id: 0,
        created_by_user_name: None,
        can_view_detail: true,
        security_level: "open".to_string(),
        can_edit: false,
        permissions: Permissions::default(),
        detail_loaded: false,
        content_revision: 1,
        activity_read_sequence: 0,
        is_unread: false,
        current_delivery_id: None,
        version: 1,
        created_at: datetime_reformat(""),
        updated_at: datetime_reformat(""),
        completed_at: None,
    };
    let serialized = serde_json::to_string(&response).unwrap();
    assert!(
        serialized.contains(r#""created_at":"","updated_at":""#),
        "empty datetimes must be empty strings, not null: {serialized}"
    );
    assert!(
        !serialized.contains(r#""created_at":null"#),
        "created_at must not be null for an empty raw value: {serialized}"
    );
}
